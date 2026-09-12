const fs = require('fs/promises');
const path = require('path');
const { randomBytes } = require('crypto');

function failure(status, message, code) {
    return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

async function acquireDataLock(root) {
    const lockFile = path.join(root, '.travel-data.lock');
    let handle;
    try {
        handle = await fs.open(lockFile, 'wx');
    } catch (error) {
        if (error.code === 'EEXIST') throw failure(409, '另一项数据操作正在进行，请稍后重试；若服务器曾异常退出，请按维护文档检查数据锁。');
        throw error;
    }
    return async () => {
        await handle.close();
        await fs.unlink(lockFile).catch(() => {});
    };
}

function safeArchivePath(name) {
    if (!name.startsWith('data/') || /[\u0000-\u001f\u007f:]/.test(name) || name.includes('\\')) return false;
    const parts = name.split('/');
    return parts.length > 1 && parts.every(part => part && part !== '.' && part !== '..'
        && !/[. ]$/.test(part)
        && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}

function isValidDateString(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isSafeAsciiFileName(name) {
    return typeof name === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
        && !name.includes('..')
        && !name.endsWith('.')
        && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);
}

function decodeUtf8(data, fileName) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
        throw failure(400, `备份中的 ${fileName} 不是有效的 UTF-8 文本。`);
    }
}

function parseJsonFile(data, fileName) {
    try {
        return JSON.parse(decodeUtf8(data, fileName));
    } catch (error) {
        if (error.status) throw error;
        throw failure(400, `备份中的 ${fileName} 不是有效 JSON。`);
    }
}

function validateTextField(record, recordNumber, field, { required = false } = {}) {
    const value = record[field];
    if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)
        || (required && !value.trim())) {
        throw failure(400, `备份中的旅行记录第 ${recordNumber} 项 ${field} 字段无效。`);
    }
    return value;
}

async function collectFiles(directory, prefix = 'data') {
    const entries = [];
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        const filePath = path.join(directory, item.name);
        const archivePath = `${prefix}/${item.name}`;
        const stat = await fs.lstat(filePath);
        if (stat.isSymbolicLink()) throw failure(403, `数据目录包含链接，无法导出：${archivePath}`);
        if (stat.isDirectory()) entries.push(...await collectFiles(filePath, archivePath));
        else if (stat.isFile()) entries.push({ name: archivePath, data: await fs.readFile(filePath) });
        else throw failure(400, `数据目录包含不支持的文件类型：${archivePath}`);
    }
    return entries;
}

async function exportDataArchive(root) {
    const release = await acquireDataLock(root);
    try {
        const dataDir = path.join(root, 'data');
        const stat = await fs.lstat(dataDir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure(403, 'data 必须是项目内的普通目录。');
        const entries = await collectFiles(dataDir);
        if (!entries.length) throw failure(400, 'data 目录为空，无法导出。');
        const { createZip } = await import('./zip-archive.mjs');
        return Buffer.from(createZip(entries));
    } finally {
        await release();
    }
}

async function verifyCurrentPassword(root, password) {
    const passwordFile = path.join(root, 'data/password.json');
    let stat;
    let config;
    try {
        stat = await fs.lstat(passwordFile);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw failure(403, '当前访问密码配置必须是普通文件。');
        }
        config = parseJsonFile(await fs.readFile(passwordFile), '当前 data/password.json');
    } catch (error) {
        if (error.status) throw error;
        throw failure(409, '当前访问密码配置不存在或无法读取，请先修复 data/password.json。');
    }
    const configuredPassword = typeof config === 'string' ? config : config?.password;
    if (typeof configuredPassword !== 'string' || !/^\d{6}$/.test(configuredPassword)) {
        throw failure(409, '当前访问密码配置无效，密码必须是 6 位数字。');
    }
    if (password !== configuredPassword) {
        throw failure(403, '当前访问密码不正确，未导入任何数据。', 'CURRENT_PASSWORD_INVALID');
    }
}

function validateImportedRecords(entries) {
    const files = new Map(entries.map(entry => [entry.name, entry.data]));
    const index = files.get('data/travel_data.json');
    if (!index) throw failure(400, '备份缺少 data/travel_data.json。');
    const records = parseJsonFile(index, 'data/travel_data.json');
    if (!Array.isArray(records)) throw failure(400, '备份中的旅行索引必须是数组。');
    if (records.length > 10000) throw failure(400, '备份中的旅行记录不能超过 10000 条。');
    const markdownPaths = new Set();
    records.forEach((record, indexValue) => {
        const recordNumber = indexValue + 1;
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项必须是对象。`);
        }
        const date = validateTextField(record, recordNumber, 'date', { required: true });
        if (!isValidDateString(date)) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项 date 必须是有效的 YYYY-MM-DD 日期。`);
        }
        validateTextField(record, recordNumber, 'country', { required: true });
        const countryCode = validateTextField(record, recordNumber, 'country_code', { required: true });
        if (!/^[A-Z]{2}$/.test(countryCode)) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项 country_code 必须是两个大写字母。`);
        }
        validateTextField(record, recordNumber, 'admin_area');
        validateTextField(record, recordNumber, 'locality', { required: true });
        for (const field of ['admin_area_type', 'locality_type', 'trip_id']) {
            if (record[field] != null) validateTextField(record, recordNumber, field);
        }
        const markdownPath = validateTextField(record, recordNumber, 'desc_md', { required: true });
        const diaryPrefix = `data/travel-diary/${date.slice(0, 4)}/${date}-`;
        const markdownName = markdownPath.slice(`data/travel-diary/${date.slice(0, 4)}/`.length);
        if (!markdownPath.startsWith(diaryPrefix) || !markdownPath.endsWith('.md') || !isSafeAsciiFileName(markdownName)) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项正文路径无效。`);
        }
        if (markdownPaths.has(markdownPath)) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项重复引用正文文件。`);
        }
        markdownPaths.add(markdownPath);
        if (!files.has(markdownPath)) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项缺少正文文件。`);
        }
        decodeUtf8(files.get(markdownPath), markdownPath);

        const photoFolder = validateTextField(record, recordNumber, 'photo_folder');
        if (photoFolder && (!photoFolder.startsWith('data/photos/')
            || !photoFolder.slice('data/photos/'.length).split('/').every(isSafeAsciiFileName))) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项照片目录无效。`);
        }
        if (!Array.isArray(record.photos) || record.photos.length > 1000) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项照片列表无效。`);
        }
        if (record.photos.length && !photoFolder) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项包含照片但未设置照片目录。`);
        }
        for (const photo of record.photos) {
            if (!isSafeAsciiFileName(photo) || !files.has(`${photoFolder}/${photo}`)) {
                throw failure(400, `备份中的旅行记录第 ${recordNumber} 项缺少照片文件或照片文件名无效。`);
            }
        }
    });
}

function ensureImportedPassword(entries, password) {
    const passwordEntry = entries.find(entry => entry.name === 'data/password.json');
    if (passwordEntry) {
        const config = parseJsonFile(passwordEntry.data, 'data/password.json');
        const configuredPassword = typeof config === 'string' ? config : config?.password;
        if (typeof configuredPassword !== 'string' || !/^\d{6}$/.test(configuredPassword)) {
            throw failure(400, '备份中的 data/password.json 无效，密码必须是 6 位数字。');
        }
        return false;
    }
    if (entries.some(entry => entry.name.toLocaleLowerCase('en-US') === 'data/password.json')) {
        throw failure(400, '备份中的密码配置路径大小写无效，应为 data/password.json。');
    }
    if (!password) {
        throw failure(428, '备份中未包含访问密码，请设置 6 位数字密码后继续导入。', 'IMPORT_PASSWORD_REQUIRED');
    }
    if (typeof password !== 'string' || !/^\d{6}$/.test(password)) {
        throw failure(400, '新访问密码必须是 6 位数字。');
    }
    entries.push({
        name: 'data/password.json',
        data: Buffer.from(`${JSON.stringify({ password }, null, 2)}\n`)
    });
    return true;
}

async function importDataArchive(root, archive, options = {}) {
    const release = await acquireDataLock(root);
    const id = randomBytes(16).toString('hex');
    const stageRoot = path.join(root, `.travel-data-import-${id}`);
    const stageData = path.join(stageRoot, 'data');
    const currentData = path.join(root, 'data');
    const backupData = path.join(root, `.travel-data-backup-${id}`);
    let movedCurrent = false;
    try {
        await verifyCurrentPassword(root, options.currentPassword);
        const { readZip } = await import('./zip-archive.mjs');
        let entries;
        try { entries = readZip(archive); }
        catch (error) { throw failure(400, error.message); }
        if (!entries.length || entries.some(entry => !safeArchivePath(entry.name))) {
            throw failure(400, '备份只能包含 data/ 目录中的安全文件路径。');
        }
        const portablePaths = new Set(entries.map(entry => entry.name.toLocaleLowerCase('en-US')));
        if (portablePaths.size !== entries.length) {
            throw failure(400, '备份包含仅大小写不同的重复路径，无法安全导入。');
        }
        validateImportedRecords(entries);
        const passwordCreated = ensureImportedPassword(entries, options.password);
        await fs.mkdir(stageData, { recursive: true });
        for (const entry of entries) {
            const relative = entry.name.slice('data/'.length);
            const target = path.join(stageData, ...relative.split('/'));
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, entry.data, { flag: 'wx' });
        }
        const currentStat = await fs.lstat(currentData);
        if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) throw failure(403, '当前 data 必须是项目内的普通目录。');
        await fs.rename(currentData, backupData);
        movedCurrent = true;
        try {
            await fs.rename(stageData, currentData);
        } catch (error) {
            await fs.rename(backupData, currentData);
            movedCurrent = false;
            throw error;
        }
        movedCurrent = false;
        await fs.rm(backupData, { recursive: true, force: true }).catch(() => {});
        return { files: entries.length, passwordCreated };
    } finally {
        if (movedCurrent) await fs.rename(backupData, currentData).catch(() => {});
        await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
        await release();
    }
}

module.exports = { acquireDataLock, exportDataArchive, importDataArchive };
