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

function authFailure(message, code = 'AUTH_CONFIG_INVALID') {
    return Object.assign(new Error(message), { code });
}

function validatePassword(password) {
    if (typeof password !== 'string' || !/^\d{6}$/.test(password)) {
        throw authFailure('访问密码必须为 6 位数字。', 'PASSWORD_POLICY_INVALID');
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
    if (!config || typeof config !== 'object' || Array.isArray(config)
        || config.version !== 1 || config.algorithm !== 'scrypt'
        || config.keyLength !== HASH_LENGTH
        || config.cost?.N !== SCRYPT_OPTIONS.N || config.cost?.r !== SCRYPT_OPTIONS.r || config.cost?.p !== SCRYPT_OPTIONS.p) {
        throw authFailure('认证配置格式或 scrypt 参数无效。');
    }
    decodeBase64(config.salt, 16, 'salt');
    decodeBase64(config.hash, HASH_LENGTH, 'hash');
    const productionReady = config.policy?.format === 'digits'
        && config.policy?.length === PASSWORD_LENGTH
        && config.policy?.productionReady === true;
    if (requireProduction && !productionReady) {
        throw authFailure('remote write mode 要求使用后端生成的 6 位数字密码配置，请先运行 npm run auth:set。', 'AUTH_NOT_PRODUCTION_READY');
    }
    return { ...config, productionReady };
}

async function readAuthConfig(root, options = {}) {
    const secretsDir = path.join(root, '.secrets');
    const authFile = path.join(secretsDir, 'auth.json');
    try {
        const [directoryStat, fileStat] = await Promise.all([fs.lstat(secretsDir), fs.lstat(authFile)]);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()
            || fileStat.isSymbolicLink() || !fileStat.isFile()) {
            throw authFailure('认证配置必须位于项目内的普通 .secrets/auth.json 文件中。');
        }
        if (options.requireProduction && process.platform !== 'win32') {
            await fs.chmod(secretsDir, 0o700);
            await fs.chmod(authFile, 0o600);
        }
        const config = JSON.parse(await fs.readFile(authFile, 'utf8'));
        return validateAuthConfig(config, options);
    } catch (error) {
        if (error.code?.startsWith('AUTH_')) throw error;
        throw authFailure('无法读取 .secrets/auth.json，请先运行 npm run auth:set。');
    }
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
        policy: { format: 'digits', length: PASSWORD_LENGTH, productionReady: true }
    };
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
    readAuthConfig,
    validateAuthConfig,
    validatePassword,
    verifyPassword
};
