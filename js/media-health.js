const { serializeRecords } = require('./record-order.js');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { ordinaryPath, readRecords } = require('./record-inventory.js');
const { acquireDataLock } = require('./data-archive.js');

function failure(message) { return Object.assign(new Error(message), { status: 409 }); }

async function mediaPath(name) {
    const { isSafeAsciiFileName } = await import('./slug.mjs');
    if (typeof name !== 'string' || !/^data\/(photos|videos)\//.test(name)
        || !name.split('/').every(isSafeAsciiFileName)) throw failure('媒体路径无效。');
    return name;
}

async function walk(root, name) {
    let directory;
    try { directory = await ordinaryPath(root, name, true); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const files = [];
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        const child = `${name}/${item.name}`;
        if (item.isDirectory() && !item.isSymbolicLink()) files.push(...await walk(root, child));
        else {
            const file = await ordinaryPath(root, child);
            const stat = await fs.stat(file);
            files.push({ path: child, size: stat.size, modified: stat.mtimeMs });
        }
    }
    return files;
}

async function scanMedia(root) {
    const records = await readRecords(root);
    const { recordFilePaths } = await import('./record-backup.mjs');
    const references = new Map();
    for (const record of records) {
        for (const name of recordFilePaths([record])) {
            if (!/^data\/(photos|videos)\//.test(name)) continue;
            await mediaPath(name);
            const owners = references.get(name) || [];
            owners.push({ record_id: record.record_id, date: record.date, locality: record.locality, desc_md: record.desc_md });
            references.set(name, owners);
        }
    }
    const files = [...await walk(root, 'data/photos'), ...await walk(root, 'data/videos')]
        .sort((a, b) => a.path.localeCompare(b.path)).map(file => ({ ...file, records: references.get(file.path) || [] }));
    const present = new Set(files.map(file => file.path));
    const missing = [...references].filter(([name]) => !present.has(name)).map(([name, owners]) => ({ path: name, records: owners }));
    const recycled = await require('./recycle-bin.js').readRecycleBin(root);
    const trash = recycled.items.filter(item => item.kind === 'files');
    const revision = createHash('sha256').update(JSON.stringify([records, files, trash])).digest('hex');
    return { revision, files, missing, trash, totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        unusedBytes: files.filter(file => !file.records.length).reduce((sum, file) => sum + file.size, 0),
        trashBytes: trash.flatMap(batch => batch.files).reduce((sum, file) => sum + file.size, 0) };
}

async function manageMedia(root, payload) {
    if (['restore', 'purge'].includes(payload?.action)) {
        const report = await scanMedia(root);
        if (payload.revision !== report.revision) throw failure('媒体或引用已变化，请重新检查。');
        const recycled = await require('./recycle-bin.js').readRecycleBin(root);
        await require('./recycle-bin.js').manageRecycleBin(root, { ...payload, revision: recycled.revision });
        return scanMedia(root);
    }
    const release = await acquireDataLock(root);
    let recycleId;
    const moved = [];
    try {
        const report = await scanMedia(root);
        if (payload?.revision !== report.revision) throw failure('媒体或引用已变化，请重新检查后再操作。');
        if (payload.action === 'remove-missing') {
            if (!Array.isArray(payload.paths) || !payload.paths.length || new Set(payload.paths).size !== payload.paths.length) throw failure('请选择要删除引用的缺失文件。');
            const missing = new Set(report.missing.map(file => file.path));
            if (payload.paths.some(name => !missing.has(name))) throw failure('所选文件已存在或不再被引用，未删除引用。');
            const removed = new Set(payload.paths);
            const records = await readRecords(root);
            for (const record of records) {
                for (const [folder, list] of [['photo_folder', 'photos'], ['video_folder', 'videos']]) {
                    if (Array.isArray(record[list])) record[list] = record[list].filter(name => !removed.has(`${record[folder]}/${name}`));
                }
            }
            const temporary = path.join(root, `data/.media-references-${randomBytes(16).toString('hex')}.tmp`);
            try {
                await fs.writeFile(temporary, serializeRecords(records), { flag: 'wx' });
                await ordinaryPath(root, 'data/travel_data.json');
                await fs.rename(temporary, path.join(root, 'data/travel_data.json'));
            } finally { await fs.unlink(temporary).catch(() => {}); }
            return await scanMedia(root);
        }
        if (payload.action !== 'trash' || !Array.isArray(payload.paths) || !payload.paths.length || new Set(payload.paths).size !== payload.paths.length) throw failure('请选择未引用的媒体文件。');
        const files = payload.paths.map(name => {
            const file = report.files.find(file => file.path === name && !file.records.length);
            if (!file) throw failure('所选文件仍被引用或已不存在，未执行清理。');
            return { path: file.path };
        });
        recycleId = await require('./recycle-bin.js').captureRecycle(root, { title: '清理的媒体', files });
        try {
            for (const file of files) {
                const source = await ordinaryPath(root, file.path);
                const temporary = `${source}.travel-trash-${randomBytes(16).toString('hex')}.bak`;
                await fs.rename(source, temporary);
                moved.push({ source, temporary });
            }
        } catch (error) {
            for (const file of moved.reverse()) await fs.rename(file.temporary, file.source);
            await require('./recycle-bin.js').discardRecycle(root, recycleId);
            throw error;
        }
        for (const file of moved) await fs.unlink(file.temporary);
        return scanMedia(root);
    } finally { await release(); }
}

module.exports = { scanMedia, manageMedia };
