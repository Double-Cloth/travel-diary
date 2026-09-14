const fs = require('fs/promises');
const path = require('path');
const { randomBytes, scrypt, timingSafeEqual } = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(scrypt);
const AUTH_RELATIVE_PATH = '.secrets/auth.json';
const PASSWORD_LENGTH = 6;
const PASSWORD_MAX_LENGTH = PASSWORD_LENGTH;
const SCRYPT_OPTIONS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const HASH_LENGTH = 32;
const COMMON_PASSWORDS = new Set([
    '000001', '112233', '121212', '123123', '131452', '321321',
    '520520', '521521', '666888', '775852', '888666'
]);

function authFailure(message, code = 'AUTH_CONFIG_INVALID') {
    return Object.assign(new Error(message), { code });
}

function validatePassword(password) {
    if (typeof password !== 'string' || !/^\d{6}$/.test(password)) {
        throw authFailure('访问密码必须为 6 位数字。', 'PASSWORD_POLICY_INVALID');
    }
    const ascending = '012345678901234';
    const descending = '987654321098765';
    if (/^(\d)\1{5}$/.test(password)
        || /^(.{2})\1{2}$/.test(password)
        || /^(.{3})\1$/.test(password)
        || ascending.includes(password)
        || descending.includes(password)
        || COMMON_PASSWORDS.has(password)) {
        throw authFailure('访问密码不能使用连续、重复或常见数字组合。', 'PASSWORD_TOO_WEAK');
    }
    return password;
}

function decodeBase64(value, expectedLength, field) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw authFailure(`认证配置中的 ${field} 无效。`);
    }
    const buffer = Buffer.from(value, 'base64');
    if (buffer.length !== expectedLength || buffer.toString('base64') !== value) {
        throw authFailure(`认证配置中的 ${field} 无效。`);
    }
    return buffer;
}

function validateAuthConfig(config, { requireProduction = false } = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw authFailure('.secrets/auth.json 的内容必须是 JSON 对象。');
    }
    const requiredFields = ['version', 'algorithm', 'salt', 'hash', 'keyLength', 'cost', 'cost.N', 'cost.r', 'cost.p'];
    const missingFields = requiredFields.filter(field => {
        const parts = field.split('.');
        let value = config;
        return parts.some(part => {
            if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) return true;
            value = value[part];
            return false;
        });
    });
    if (missingFields.length) {
        throw authFailure(`.secrets/auth.json 内容不完整，缺少必填字段：${missingFields.join('、')}。`);
    }
    if (config.version !== 1) throw authFailure('认证配置中的 version 必须为 1。');
    if (config.algorithm !== 'scrypt') throw authFailure('认证配置中的 algorithm 必须为 scrypt。');
    if (config.keyLength !== HASH_LENGTH) throw authFailure(`认证配置中的 keyLength 必须为 ${HASH_LENGTH}。`);
    if (config.cost.N !== SCRYPT_OPTIONS.N || config.cost.r !== SCRYPT_OPTIONS.r || config.cost.p !== SCRYPT_OPTIONS.p) {
        throw authFailure(`认证配置中的 scrypt cost 参数必须为 N=${SCRYPT_OPTIONS.N}、r=${SCRYPT_OPTIONS.r}、p=${SCRYPT_OPTIONS.p}。`);
    }
    decodeBase64(config.salt, 16, 'salt');
    decodeBase64(config.hash, HASH_LENGTH, 'hash');
    const productionReady = config.policy?.format === 'digits'
        && config.policy?.length === PASSWORD_LENGTH
        && config.policy?.productionReady === true
        && config.policy?.commonPatternsRejected === true;
    if (requireProduction && !productionReady) {
        throw authFailure('认证配置中的 policy 内容不完整或不正确；remote write mode 要求使用后端生成的 6 位数字密码配置，请运行 npm run auth:set 重新创建。', 'AUTH_NOT_PRODUCTION_READY');
    }
    return { ...config, productionReady };
}

async function readAuthConfig(root, options = {}) {
    const secretsDir = path.join(root, '.secrets');
    const authFile = path.join(secretsDir, 'auth.json');
    let directoryStat;
    try {
        directoryStat = await fs.lstat(secretsDir);
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw authFailure('未找到 .secrets 目录。服务器启动时会自动创建该目录；随后可在本机页面创建 6 位数字访问密码。', 'AUTH_CONFIG_MISSING');
        }
        throw authFailure('无法访问 .secrets 目录，请检查目录权限。', 'AUTH_CONFIG_UNREADABLE');
    }
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw authFailure('.secrets 必须是项目内的普通目录，不能是文件或符号链接。');
    }

    let fileStat;
    try {
        fileStat = await fs.lstat(authFile);
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw authFailure('尚未创建 .secrets/auth.json。请先以 local 模式启动，并在本机页面创建 6 位数字访问密码。', 'AUTH_CONFIG_MISSING');
        }
        throw authFailure('无法访问 .secrets/auth.json，请检查文件权限。', 'AUTH_CONFIG_UNREADABLE');
    }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw authFailure('.secrets/auth.json 必须是项目内的普通文件，不能是目录或符号链接。');
    }

    try {
        if (options.requireProduction && process.platform !== 'win32') {
            await fs.chmod(secretsDir, 0o700);
            await fs.chmod(authFile, 0o600);
        }
    } catch {
        throw authFailure('无法设置 .secrets/auth.json 的安全权限，请检查文件所有者和权限。', 'AUTH_CONFIG_UNREADABLE');
    }

    let source;
    try {
        source = await fs.readFile(authFile, 'utf8');
    } catch (error) {
        throw authFailure('无法读取 .secrets/auth.json，请检查文件权限。', 'AUTH_CONFIG_UNREADABLE');
    }
    let config;
    try {
        config = JSON.parse(source);
    } catch {
        throw authFailure('.secrets/auth.json 不是有效的 JSON 文件，请运行 npm run auth:set 重新创建。');
    }
    return validateAuthConfig(config, options);
}

async function createAuthConfig(password) {
    validatePassword(password);
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, HASH_LENGTH, SCRYPT_OPTIONS);
    return {
        version: 1,
        algorithm: 'scrypt',
        salt: salt.toString('base64'),
        hash: Buffer.from(hash).toString('base64'),
        keyLength: HASH_LENGTH,
        cost: { N: SCRYPT_OPTIONS.N, r: SCRYPT_OPTIONS.r, p: SCRYPT_OPTIONS.p },
        policy: {
            format: 'digits', length: PASSWORD_LENGTH, productionReady: true,
            commonPatternsRejected: true
        }
    };
}

async function initializeAuthConfig(root, password) {
    const config = await createAuthConfig(password);
    const secretsDir = path.join(root, '.secrets');
    const authFile = path.join(secretsDir, 'auth.json');
    await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
    const directoryStat = await fs.lstat(secretsDir);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw authFailure('.secrets 必须是项目内的普通目录，不能是文件或符号链接。');
    }
    await fs.chmod(secretsDir, 0o700).catch(() => {});

    let handle;
    let created = false;
    let writeError;
    try {
        handle = await fs.open(authFile, 'wx', 0o600);
        created = true;
        await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
        await handle.sync();
    } catch (error) {
        if (error.code === 'EEXIST') {
            throw authFailure('访问密码已经创建，请直接输入现有密码。', 'AUTH_SETUP_ALREADY_COMPLETE');
        }
        writeError = error;
    } finally {
        if (handle) await handle.close().catch(() => {});
    }
    if (writeError) {
        if (created) await fs.unlink(authFile).catch(() => {});
        throw authFailure('无法创建 .secrets/auth.json，请检查目录权限和磁盘空间。', 'AUTH_CONFIG_UNREADABLE');
    }
    await fs.chmod(authFile, 0o600).catch(() => {});
    return config;
}

async function verifyPassword(config, password) {
    const validConfig = validateAuthConfig(config);
    const salt = decodeBase64(validConfig.salt, 16, 'salt');
    const expected = decodeBase64(validConfig.hash, HASH_LENGTH, 'hash');
    const candidate = typeof password === 'string' && /^\d{6}$/.test(password)
        ? password
        : '\0invalid-password';
    const actual = Buffer.from(await scryptAsync(candidate, salt, HASH_LENGTH, SCRYPT_OPTIONS));
    return timingSafeEqual(actual, expected) && candidate === password;
}

module.exports = {
    AUTH_RELATIVE_PATH,
    PASSWORD_MAX_LENGTH,
    PASSWORD_LENGTH,
    SCRYPT_OPTIONS,
    createAuthConfig,
    initializeAuthConfig,
    readAuthConfig,
    validateAuthConfig,
    validatePassword,
    verifyPassword
};
