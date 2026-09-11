const fs = require('fs/promises');
const path = require('path');
const { randomBytes } = require('crypto');

function failure(status, message) {
    return Object.assign(new Error(message), { status });
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
        && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
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

function validateImportedRecords(entries) {
    const files = new Map(entries.map(entry => [entry.name, entry.data]));
    const index = files.get('data/travel_data.json');
    if (!index) throw failure(400, '备份缺少 data/travel_data.json。');
    let records;
    try { records = JSON.parse(Buffer.from(index).toString('utf8'));
    } catch { throw failure(400, '备份中的 data/travel_data.json 不是有效 JSON。'); }
    if (!Array.isArray(records)) throw failure(400, '备份中的旅行索引必须是数组。');
    records.forEach((record, indexValue) => {
        if (!record || typeof record !== 'object' || typeof record.desc_md !== 'string' || !files.has(record.desc_md)) {
            throw failure(400, `备份中的旅行记录第 ${indexValue + 1} 项缺少正文文件。`);
        }
        if (!Array.isArray(record.photos || [])) throw failure(400, `备份中的旅行记录第 ${indexValue + 1} 项照片列表无效。`);
        for (const photo of record.photos || []) {
            if (typeof record.photo_folder !== 'string' || typeof photo !== 'string' || !files.has(`${record.photo_folder}/${photo}`)) {
                throw failure(400, `备份中的旅行记录第 ${indexValue + 1} 项缺少照片文件。`);
            }
        }
    });
}

async function importDataArchive(root, archive) {
    const release = await acquireDataLock(root);
    const id = randomBytes(16).toString('hex');
    const stageRoot = path.join(root, `.travel-data-import-${id}`);
    const stageData = path.join(stageRoot, 'data');
    const currentData = path.join(root, 'data');
    const backupData = path.join(root, `.travel-data-backup-${id}`);
    let movedCurrent = false;
    try {
        const { readZip } = await import('./zip-archive.mjs');
        let entries;
        try { entries = readZip(archive); }
        catch (error) { throw failure(400, error.message); }
        if (!entries.length || entries.some(entry => !safeArchivePath(entry.name))) {
            throw failure(400, '备份只能包含 data/ 目录中的安全文件路径。');
        }
        validateImportedRecords(entries);
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
        return { files: entries.length };
    } finally {
        if (movedCurrent) await fs.rename(backupData, currentData).catch(() => {});
        await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
        await release();
    }
}

module.exports = { acquireDataLock, exportDataArchive, importDataArchive };
