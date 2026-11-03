const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { ordinaryPath, readRecords } = require('./record-inventory.js');

const BASE = '.cache/recycle-bin';
const failure = message => Object.assign(new Error(message), { status: 409 });

function safeDataPath(name) {
    if (typeof name !== 'string' || !name.startsWith('data/') || name.split('/').some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part))) throw failure('回收站中的文件路径无效。');
    return name;
}

async function ensureParent(root, name) {
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index++) {
        const directory = parts.slice(0, index).join('/');
        await fs.mkdir(path.join(root, directory)).catch(error => { if (error.code !== 'EEXIST') throw error; });
        await ordinaryPath(root, directory, true);
    }
}

async function dataFiles(root, directory = 'data') {
    let source;
    try { source = await ordinaryPath(root, directory, true); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const files = [];
    for (const item of await fs.readdir(source, { withFileTypes: true })) {
        const name = `${directory}/${item.name}`;
        if (item.isDirectory() && !item.isSymbolicLink()) files.push(...await dataFiles(root, name));
        else { await ordinaryPath(root, name); files.push({ path: name }); }
    }
    return files;
}

async function migrateLegacyTrash(root) {
    let directory;
    try { directory = await ordinaryPath(root, 'data/media-trash', true); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const id of await fs.readdir(directory)) {
        if (!/^[a-f0-9]{32}$/.test(id)) throw failure('旧媒体回收区有未知内容，请先检查 data/media-trash。');
        const source = await ordinaryPath(root, `data/media-trash/${id}`, true);
        let targetId = id;
        await ensureParent(root, `${BASE}/manifest.json`);
        while (true) {
            try { await fs.mkdir(path.join(root, BASE, targetId)); break; }
            catch (error) { if (error.code !== 'EEXIST') throw error; targetId = randomBytes(16).toString('hex'); }
        }
        await fs.rmdir(path.join(root, BASE, targetId));
        await fs.rename(source, path.join(root, BASE, targetId));
    }
    await fs.rmdir(directory);
}

async function discardRecycle(root, id) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw failure('回收项目无效。');
    let directory;
    try { directory = await ordinaryPath(root, `${BASE}/${id}`, true); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await fs.rm(directory, { recursive: true });
}

// 调用方持有数据锁，先完整留存，再提交删除；失败时可以丢弃本次留存。
async function captureRecycle(root, { title, kind = 'files', records = [], mediaReferences = [], files }) {
    await migrateLegacyTrash(root);
    if (kind === 'snapshot') files = await dataFiles(root);
    const id = randomBytes(16).toString('hex');
    const prefix = `${BASE}/${id}`;
    const manifest = { id, kind, title, records, mediaReferences, createdAt: new Date().toISOString(), files: [] };
    try {
        await ensureParent(root, `${prefix}/manifest.json`);
        for (const file of files || []) {
            safeDataPath(file.path);
            let source;
            try { source = await ordinaryPath(root, file.source || file.path); }
            catch (error) { if (error.code === 'ENOENT' && file.optional) continue; throw error; }
            const target = `${prefix}/${file.path}`;
            await ensureParent(root, target);
            await fs.copyFile(source, path.join(root, target), fs.constants.COPYFILE_EXCL);
            manifest.files.push({ path: file.path, size: (await fs.stat(source)).size });
        }
        await fs.writeFile(path.join(root, prefix, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
        return id;
    } catch (error) { await discardRecycle(root, id); throw error; }
}

async function readRecycleBin(root) {
    await migrateLegacyTrash(root);
    let directory;
    try { directory = await ordinaryPath(root, BASE, true); }
    catch (error) { if (error.code === 'ENOENT') return { revision: '', items: [], totalBytes: 0 }; throw error; }
    const items = [];
    for (const id of await fs.readdir(directory)) {
        if (!/^[a-f0-9]{32}$/.test(id)) throw failure('回收站存在未知目录，请先检查。');
        let value;
        try { value = JSON.parse(await fs.readFile(await ordinaryPath(root, `${BASE}/${id}/manifest.json`), 'utf8')); }
        catch (error) { if (error.status === 403) throw error; throw failure('回收站清单缺失或损坏，请保留文件并检查。'); }
        if (!value || !Array.isArray(value.files) || value.files.some(file => !file || typeof file.path !== 'string')
            || value.files.length > 50000 || new Set(value.files.map(file => file.path.toLowerCase())).size !== value.files.length
            || (value.kind && !['files', 'record', 'snapshot', 'version'].includes(value.kind)) || (value.records && !Array.isArray(value.records))
            || (value.mediaReferences && (!Array.isArray(value.mediaReferences) || value.mediaReferences.some(record => !record || typeof record.desc_md !== 'string')))) throw failure('回收站清单无效。');
        for (const file of value.files) {
            safeDataPath(file.path);
            let source;
            try { source = await ordinaryPath(root, `${BASE}/${id}/${file.path}`); }
            catch (error) { if (error.code === 'ENOENT') throw failure('回收站文件缺失，请保留现有内容并检查。'); throw error; }
            const stat = await fs.stat(source);
            file.size = stat.size;
            file.modified = stat.mtimeMs;
        }
        items.push({ ...value, id, kind: value.kind || 'files', title: value.title || '清理的媒体', records: value.records || [] });
    }
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { items, currentRecords: await readRecords(root), totalBytes: items.flatMap(item => item.files).reduce((sum, file) => sum + file.size, 0),
        revision: createHash('sha256').update(JSON.stringify(items)).digest('hex') };
}

async function fileDigest(file) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return hash.digest('hex');
}

async function recycleFile(root, id, name) {
    if (!/^[a-f0-9]{32}$/.test(id || '')) throw failure('回收项目无效。');
    safeDataPath(name);
    const manifest = JSON.parse(await fs.readFile(await ordinaryPath(root, `${BASE}/${id}/manifest.json`), 'utf8'));
    if (!Array.isArray(manifest.files) || !manifest.files.some(file => file.path === name)) throw failure('该文件不属于这个回收项目。');
    return ordinaryPath(root, `${BASE}/${id}/${name}`);
}

async function restoreFiles(root, item, targetDescMd) {
    const current = await readRecords(root);
    const { matchRecord } = await import('./record-identity.mjs');
    for (const record of item.records) if (matchRecord(record, current)) throw failure('这篇日记已存在，请先处理当前记录再恢复，未覆盖任何内容。');
    const next = current.map(record => ({ ...record }));
    const paths = new Set(item.files.map(file => file.path));
    let references = item.mediaReferences || [];
    // 旧回收项目没有关联信息，由用户明确指定日记，避免猜测或替换整份索引。
    if (targetDescMd) {
        if (item.kind !== 'files' || references.length) throw failure('这个项目无需指定恢复日记。');
        const target = next.find(record => record.desc_md === targetDescMd);
        if (!target) throw failure('目标日记已不存在，请刷新后重试。');
        const saved = { ...target };
        for (const [folder, list, prefix] of [['photo_folder', 'photos', 'data/photos/'], ['video_folder', 'videos', 'data/videos/']]) {
            const files = item.files.filter(file => file.path.startsWith(prefix));
            if (new Set(files.map(file => path.posix.dirname(file.path))).size > 1) throw failure('这些附件来自不同目录，请分别恢复文件后在日记中添加。');
            saved[folder] = files.length ? path.posix.dirname(files[0].path) : '';
            saved[list] = files.map(file => path.posix.basename(file.path));
        }
        references = [saved];
    } else if (item.kind === 'files' && !references.length && item.title === '编辑日记时移除的媒体') {
        throw failure('这份旧媒体没有保存日记关联，请先选择恢复到哪篇日记。');
    }
    for (const saved of references) {
        const target = matchRecord(saved, next);
        if (!target) throw failure('关联日记已删除，请先恢复日记，再恢复附件。');
        for (const [folder, list] of [['photo_folder', 'photos'], ['video_folder', 'videos']]) {
            const restored = (saved[list] || []).filter(name => paths.has(`${saved[folder]}/${name}`));
            if (!restored.length) continue;
            // 一个列表只对应一个目录，不能用旧目录覆盖已有附件的目录。
            const prefix = list === 'photos' ? 'data/photos' : 'data/videos';
            const destination = target[folder] || saved[folder];
            if (!destination?.startsWith(prefix + '/') && destination !== prefix) throw failure('关联日记的媒体目录无效。');
            if (destination !== saved[folder]) throw failure('媒体目录已改变，请先将日记的媒体目录改回原位置再恢复。');
            restored.forEach(name => safeDataPath(`${saved[folder]}/${name}`));
            const existing = target[list] || [];
            const merged = [...existing];
            restored.forEach(name => {
                if (!merged.includes(name)) merged.splice(Math.min((saved[list] || []).indexOf(name), merged.length), 0, name);
            });
            target[folder] = destination;
            target[list] = merged;
        }
    }
    const copies = [];
    for (const file of item.files) {
        await ensureParent(root, file.path);
        try {
            await ordinaryPath(root, file.path);
            // 共用媒体可能仍在原位置，字节相同时直接复用。
            const [before, saved] = await Promise.all([fileDigest(path.join(root, file.path)), fileDigest(path.join(root, BASE, item.id, file.path))]);
            if (before !== saved) throw failure(`恢复目标已存在且内容不同：${file.path}`);
        } catch (error) { if (error.code === 'ENOENT') copies.push(file); else throw error; }
    }
    const created = [];
    let temporary;
    try {
        for (const file of copies) {
            await fs.copyFile(await ordinaryPath(root, `${BASE}/${item.id}/${file.path}`), path.join(root, file.path), fs.constants.COPYFILE_EXCL);
            created.push(file.path);
        }
        if (item.records.length || JSON.stringify(next) !== JSON.stringify(current)) {
            temporary = path.join(root, `data/.recycle-restore-${randomBytes(16).toString('hex')}.tmp`);
            await fs.writeFile(temporary, JSON.stringify([...next, ...item.records], null, 2) + '\n', { flag: 'wx' });
            await ordinaryPath(root, 'data/travel_data.json');
            await fs.rename(temporary, path.join(root, 'data/travel_data.json'));
        }
    } catch (error) { for (const name of created) await fs.unlink(path.join(root, name)); throw error; }
    finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
}

async function restoreVersion(root, item) {
    const files = [];
    for (const file of item.files) {
        await ensureParent(root, file.path);
        try { await ordinaryPath(root, file.path); files.push({ path: file.path }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const protection = files.length ? await captureRecycle(root, { kind: 'version', title: '恢复前的文件', files }) : null;
    const moved = [];
    const created = [];
    try {
        for (const file of files) {
            const original = await ordinaryPath(root, file.path);
            const temporary = `${original}.recycle-${randomBytes(16).toString('hex')}.bak`;
            await fs.rename(original, temporary);
            moved.push({ original, temporary });
        }
        for (const file of item.files) {
            await fs.copyFile(await ordinaryPath(root, `${BASE}/${item.id}/${file.path}`), path.join(root, file.path), fs.constants.COPYFILE_EXCL);
            created.push(path.join(root, file.path));
        }
    } catch (error) {
        for (const file of created) await fs.unlink(file);
        for (const file of moved.reverse()) await fs.rename(file.temporary, file.original);
        if (protection) await discardRecycle(root, protection);
        throw error;
    }
    for (const file of moved) await fs.unlink(file.temporary);
}

async function restoreSnapshot(root, item) {
    if (!item.files.some(file => file.path === 'data/travel_data.json')) throw failure('这份整站数据缺少日记目录，无法恢复。');
    const id = randomBytes(16).toString('hex');
    const stage = `.travel-recycle-${id}`;
    let moved = false;
    let installed = false;
    try {
        await fs.mkdir(path.join(root, stage, 'data'), { recursive: true });
        for (const file of item.files) {
            const target = `${stage}/${file.path}`;
            await ensureParent(root, target);
            await fs.copyFile(await ordinaryPath(root, `${BASE}/${item.id}/${file.path}`), path.join(root, target), fs.constants.COPYFILE_EXCL);
        }
        const protection = await captureRecycle(root, { kind: 'snapshot', title: '恢复前的数据' });
        try {
            await ordinaryPath(root, 'data', true);
            await fs.rename(path.join(root, 'data'), path.join(root, stage, 'previous'));
            moved = true;
            await fs.rename(path.join(root, stage, 'data'), path.join(root, 'data'));
            installed = true;
        } catch (error) {
            if (moved && !installed) { await fs.rename(path.join(root, stage, 'previous'), path.join(root, 'data')); moved = false; }
            await discardRecycle(root, protection);
            throw error;
        }
    } finally {
        if (!moved || installed) await fs.rm(path.join(root, stage), { recursive: true, force: true });
    }
}

async function manageRecycleBin(root, payload) {
    const release = await require('./data-archive.js').acquireDataLock(root);
    try {
        const report = await readRecycleBin(root);
        if (payload?.revision !== report.revision) throw failure('回收站已变化，请刷新后重试。');
        if (payload.action === 'clear' || payload.action === 'purge') {
            const items = payload.action === 'clear' ? report.items : report.items.filter(item => item.id === payload.id);
            const { recordFilePaths } = await import('./record-backup.mjs');
            const referenced = recordFilePaths(await readRecords(root));
            // 先检查全部项目，避免清空到一半才发现仍被日记依赖的文件。
            for (const item of items) for (const file of item.files) {
                if (!referenced.has(file.path)) continue;
                try { await ordinaryPath(root, file.path); }
                catch (error) { if (error.code === 'ENOENT') throw failure('回收站文件现在被记录引用，请先恢复，未永久删除。'); throw error; }
            }
            if (payload.action === 'clear') {
                for (const item of items) await discardRecycle(root, item.id);
                return readRecycleBin(root);
            }
        }
        const item = report.items.find(item => item.id === payload.id);
        if (!item) throw failure('这个回收项目已不存在，请刷新。');
        if (payload.action === 'restore') {
            if (item.kind === 'snapshot') await restoreSnapshot(root, item);
            else if (item.kind === 'version') await restoreVersion(root, item);
            else await restoreFiles(root, item, payload.targetDescMd);
        } else if (payload.action !== 'purge') throw failure('不支持这项回收站操作。');
        await discardRecycle(root, item.id);
        return readRecycleBin(root);
    } finally { await release(); }
}

module.exports = { captureRecycle, discardRecycle, readRecycleBin, manageRecycleBin, migrateLegacyTrash, recycleFile };
