const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { fileSource, fileVersion } = require('./file-stream.js');

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

async function readFileSignatures(root) {
    try {
        const file = await ordinaryPath(root, '.cache/record-signatures.json');
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        if (value?.version !== 1 || !Array.isArray(value.files)) return new Map();
        return new Map(value.files.filter(item => item && typeof item.path === 'string'
            && typeof item.version === 'string' && typeof item.signature === 'string' && /^\d+:\d+$/.test(item.signature))
            .map(item => [item.path, item]));
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return new Map(); throw error; }
}

async function rememberFileSignatures(root, entries, signatures, previous = null) {
    const files = previous || await readFileSignatures(root);
    for (const { name, data } of entries) {
        if (data.fileVersion && signatures[name]) {
            files.set(name, { path: name, version: data.fileVersion, signature: signatures[name] });
        }
    }
    const { recordFilePaths } = await import('./record-backup.mjs');
    const referenced = recordFilePaths(await readRecords(root));
    await fs.mkdir(path.join(root, '.cache'), { recursive: true });
    await ordinaryPath(root, '.cache', true);
    const temporary = path.join(root, '.cache', `record-signatures-${randomBytes(16).toString('hex')}.tmp`);
    try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, files: [...files.values()].filter(file => referenced.has(file.path)) }), { flag: 'wx' });
        await fs.rename(temporary, path.join(root, '.cache/record-signatures.json'));
    } finally { await fs.unlink(temporary).catch(() => {}); }
}

async function inventory(root, { backedUp, signal } = {}) {
    const { recordFilePaths } = await import('./record-backup.mjs');
    const { describeRecords, fileSignature } = await import('./record-diff.mjs');
    const records = await readRecords(root);
    signal?.throwIfAborted();
    // 新增记录必定需要导出，首次备份及未备份的记录无需读取附件。
    const checked = backedUp ? records.filter(record => backedUp[record.record_id]) : records;
    if (!checked.length) return { records, signatures: {}, fingerprints: {} };
    const previous = await readFileSignatures(root);
    const entries = [];
    const signatures = {};
    const names = [...recordFilePaths(checked)];
    let next = 0;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(8, names.length) }, async () => {
        while (next < names.length) {
            signal?.throwIfAborted();
            const name = names[next++];
            if (!/^data\/(travel-diary|photos|videos)\//.test(name)) throw new Error('记录引用路径无效。');
            try {
                const file = await ordinaryPath(root, name);
                const data = await fileSource(file);
                const cached = previous.get(name);
                if (cached?.version === data.fileVersion) signatures[name] = cached.signature;
                else {
                    signatures[name] = await fileSignature(data, { signal });
                    if (fileVersion(await fs.stat(file, { bigint: true })) !== data.fileVersion) {
                        throw Object.assign(new Error('文件在检查期间发生变化，请重试。'), { status: 409 });
                    }
                }
                entries.push({ name, data });
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }));
    const failed = workers.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const result = await describeRecords(checked, entries, { signal, signatures });
    signal?.throwIfAborted();
    // 签名缓存可重建，缓存写入失败不影响本次检查结果。
    await rememberFileSignatures(root, entries, result.signatures, previous).catch(() => {});
    return { ...result, records };
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

async function rememberBackup(root, snapshot, { entries = [], signatures = {} } = {}) {
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
    // 复用导出流已经计算的 CRC，避免下一次检查再次读取全部媒体。
    if (entries.length) await rememberFileSignatures(root, entries, signatures).catch(() => {});
    return next;
}

module.exports = { ordinaryPath, readRecords, inventory, readBackupState, rememberBackup };
