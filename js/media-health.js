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
    const trash = [];
    const trashDir = path.join(root, 'data/media-trash');
    let hasTrash = true;
    try { await ordinaryPath(root, 'data/media-trash', true); }
    catch (error) { if (error.code === 'ENOENT') hasTrash = false; else throw error; }
    if (hasTrash) {
        for (const id of await fs.readdir(trashDir)) {
            if (!/^[a-f0-9]{32}$/.test(id)) throw failure('媒体回收区存在未知目录，请先手动检查。');
            let value;
            try {
                const manifest = await ordinaryPath(root, `data/media-trash/${id}/manifest.json`);
                value = JSON.parse(await fs.readFile(manifest, 'utf8'));
            } catch (error) {
                if (error.status === 403) throw error;
                throw failure(`回收区清单缺失或损坏，请保留并检查 data/media-trash/${id}，未执行清理。`);
            }
            if (!Array.isArray(value.files) || value.files.length > 50000 || new Set(value.files.map(file => file.path)).size !== value.files.length) throw failure('媒体回收清单无效。');
            for (const file of value.files) {
                await mediaPath(file.path);
                let original;
                try { original = await ordinaryPath(root, `data/media-trash/${id}/${file.path}`); }
                catch (error) { if (error.code === 'ENOENT') throw failure(`回收区文件缺失，请检查 data/media-trash/${id}，未执行清理。`); throw error; }
                const stat = await fs.stat(original);
                file.size = stat.size;
                file.modified = stat.mtimeMs;
            }
            trash.push({ id, createdAt: value.createdAt, files: value.files });
        }
    }
    const revision = createHash('sha256').update(JSON.stringify([records, files, trash])).digest('hex');
    return { revision, files, missing, trash, totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        unusedBytes: files.filter(file => !file.records.length).reduce((sum, file) => sum + file.size, 0),
        trashBytes: trash.flatMap(batch => batch.files).reduce((sum, file) => sum + file.size, 0) };
}

async function ensureParent(root, name) {
    for (const part of name.split('/').slice(0, -1).reduce((all, part) => [...all, all.length ? `${all.at(-1)}/${part}` : part], [])) {
        await fs.mkdir(path.join(root, part)).catch(error => { if (error.code !== 'EEXIST') throw error; });
        await ordinaryPath(root, part, true);
    }
}

async function manageMedia(root, payload) {
    const release = await acquireDataLock(root);
    try {
        const report = await scanMedia(root);
        if (payload?.revision !== report.revision) throw failure('媒体或引用已变化，请重新体检后再操作。');
        if (payload.action === 'trash') {
            if (!Array.isArray(payload.paths) || !payload.paths.length || new Set(payload.paths).size !== payload.paths.length) throw failure('请选择未引用的媒体文件。');
            const files = payload.paths.map(name => {
                const file = report.files.find(file => file.path === name && !file.records.length);
                if (!file) throw failure('所选文件仍被引用或已不存在，未执行清理。');
                return { path: file.path, size: file.size };
            });
            const id = randomBytes(16).toString('hex');
            const prefix = `data/media-trash/${id}`;
            const moved = [];
            try {
                for (const file of files) {
                    const target = `${prefix}/${file.path}`;
                    await ensureParent(root, target);
                    await fs.rename(await ordinaryPath(root, file.path), path.join(root, target));
                    moved.push(file);
                }
                await fs.writeFile(path.join(root, prefix, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), files }), { flag: 'wx' });
            } catch (error) {
                for (const file of moved.reverse()) await fs.rename(path.join(root, prefix, file.path), path.join(root, file.path));
                const target = path.resolve(root, prefix);
                if (target.startsWith(path.resolve(root, 'data/media-trash') + path.sep)) await fs.rm(target, { recursive: true, force: true });
                throw error;
            }
        } else if (['restore', 'purge'].includes(payload.action)) {
            const batch = report.trash.find(batch => batch.id === payload.id);
            if (!batch) throw failure('这批媒体已不存在，请重新体检。');
            if (payload.action === 'purge' && batch.files.some(file => report.missing.some(missing => missing.path === file.path))) {
                throw failure('回收区中的文件现在被记录引用，请先恢复这批文件，未永久删除。');
            }
            const prefix = `data/media-trash/${batch.id}`;
            if (payload.action === 'restore') {
                // 全部目标先检查；任一同名文件已存在时，整批不覆盖。
                for (const file of batch.files) {
                    await ensureParent(root, file.path);
                    try { await fs.lstat(path.join(root, file.path)); throw failure(`恢复目标已存在：${file.path}`); }
                    catch (error) { if (error.code !== 'ENOENT') throw error; }
                }
                const moved = [];
                try {
                    for (const file of batch.files) {
                        // 独占创建目标链接，避免检查后外部新文件被 rename 覆盖。
                        const source = await ordinaryPath(root, `${prefix}/${file.path}`);
                        await fs.link(source, path.join(root, file.path));
                        moved.push(file);
                    }
                } catch (error) {
                    for (const file of moved) await fs.unlink(path.join(root, file.path));
                    throw error;
                }
            }
            const target = path.resolve(root, prefix);
            if (!target.startsWith(path.resolve(root, 'data/media-trash') + path.sep)) throw failure('媒体回收目录无效。');
            await fs.rm(target, { recursive: true });
        } else throw failure('不支持这项媒体操作。');
        return scanMedia(root);
    } finally { await release(); }
}

module.exports = { scanMedia, manageMedia };
