const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { fileSource } = require('./file-stream.js');

async function ordinaryPath(root, name, directory = false) {
    let target = root;
    const parts = name.split('/');
    for (const [index, part] of parts.entries()) {
        if (!part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part)) throw new Error('数据路径无效。');
        target = path.join(target, part);
        const stat = await fs.lstat(target);
        const last = index === parts.length - 1;
        if (stat.isSymbolicLink() || (last && !directory ? !stat.isFile() : !stat.isDirectory())) {
            throw Object.assign(new Error('数据路径必须是项目内的普通文件或目录。'), { status: 403 });
        }
    }
    return target;
}

async function readRecords(root) {
    const { identifyRecords } = await import('./record-identity.mjs');
    const file = await ordinaryPath(root, 'data/travel_data.json');
    const records = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(records) || records.length > 10000) throw new Error('旅行索引无效。');
    return identifyRecords(records);
}

async function inventory(root) {
    const { recordFilePaths } = await import('./record-backup.mjs');
    const { describeRecords } = await import('./record-diff.mjs');
    const records = await readRecords(root);
    const entries = [];
    for (const name of recordFilePaths(records)) {
        if (!/^data\/(travel-diary|photos|videos)\//.test(name)) throw new Error('记录引用路径无效。');
        try { entries.push({ name, data: await fileSource(await ordinaryPath(root, name)) }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return describeRecords(records, entries);
}

async function readBackupState(root) {
    try {
        const file = await ordinaryPath(root, '.cache/backup-state.json');
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!value || !value.records || typeof value.records !== 'object' || Array.isArray(value.records)) {
            throw new Error('备份比较基准损坏，请清除缓存后重新备份。');
        }
        return value;
    } catch (error) { if (error.code === 'ENOENT') return { records: {} }; throw error; }
}

async function rememberBackup(root, snapshot) {
    const state = await readBackupState(root);
    await fs.mkdir(path.join(root, '.cache'), { recursive: true });
    await ordinaryPath(root, '.cache', true);
    const records = await readRecords(root);
    const next = { records: {}, confirmedAt: new Date().toISOString() };
    for (const record of records) {
        const fingerprint = snapshot[record.record_id] || state.records[record.record_id];
        if (fingerprint) next.records[record.record_id] = fingerprint;
    }
    const temporary = path.join(root, '.cache', `backup-state-${randomBytes(16).toString('hex')}.tmp`);
    try {
        await fs.writeFile(temporary, JSON.stringify(next), { flag: 'wx' });
        await fs.rename(temporary, path.join(root, '.cache/backup-state.json'));
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return next;
}

module.exports = { ordinaryPath, readRecords, inventory, readBackupState, rememberBackup };
