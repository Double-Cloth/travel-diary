const { serializeRecords } = require('./record-order.js');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { ordinaryPath, readRecords } = require('./record-inventory.js');

const BASE = '.cache/recycle-bin';
const failure = message => Object.assign(new Error(message), { status: 409 });
const digestCache = new Map();

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
async function captureRecycle(root, { title, kind = 'files', records = [], mediaReferences = [], displayRecords = [], files }) {
    await migrateLegacyTrash(root);
    if (kind === 'snapshot') files = await dataFiles(root);
    const id = randomBytes(16).toString('hex');
    const prefix = `${BASE}/${id}`;
    const manifest = { id, kind, title, records, mediaReferences, createdAt: new Date().toISOString(), files: [] };
    if (displayRecords.length) manifest.displayRecords = displayRecords;
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
            || (value.mediaReferences && (!Array.isArray(value.mediaReferences) || value.mediaReferences.some(record => !record || typeof record.desc_md !== 'string')))
            || (value.displayRecords && (!Array.isArray(value.displayRecords) || value.displayRecords.some(record => !record || typeof record.desc_md !== 'string')))) throw failure('回收站清单无效。');
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
    // 整站批次从自身的索引读取展示归属，清空当前数据后仍可按日记浏览。
    for (const item of items.filter(item => item.files.some(file => file.path === 'data/travel_data.json'))) {
        const source = await fs.readFile(await ordinaryPath(root, `${BASE}/${item.id}/data/travel_data.json`), 'utf8');
        let index;
        try { index = JSON.parse(source); }
        catch (error) { if (error instanceof SyntaxError) continue; throw error; }
        if (Array.isArray(index)) item.displayRecords = index.filter(record => record && typeof record.desc_md === 'string');
    }
    return { items, currentRecords: await readRecords(root), totalBytes: items.flatMap(item => item.files).reduce((sum, file) => sum + file.size, 0),
        revision: createHash('sha256').update(JSON.stringify(items)).digest('hex') };
}

async function fileDigest(file) {
    const stamp = async () => {
        const stat = await fs.stat(file, { bigint: true });
        return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
    };
    const version = await stamp();
    const cached = digestCache.get(file);
    if (cached?.version === version) return cached.digest;
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    if (await stamp() !== version) throw failure('比较期间文件已变化，请重新预览。');
    const digest = hash.digest('hex');
    // 大小、纳秒时间戳和文件身份共同校验缓存，限制条目数避免长期占用内存。
    digestCache.delete(file);
    digestCache.set(file, { version, digest });
    if (digestCache.size > 10000) digestCache.delete(digestCache.keys().next().value);
    return digest;
}

async function recycleFile(root, id, name) {
    if (!/^[a-f0-9]{32}$/.test(id || '')) throw failure('回收项目无效。');
    safeDataPath(name);
    const manifest = JSON.parse(await fs.readFile(await ordinaryPath(root, `${BASE}/${id}/manifest.json`), 'utf8'));
    if (!Array.isArray(manifest.files) || !manifest.files.some(file => file.path === name)) throw failure('该文件不属于这个回收项目。');
    return ordinaryPath(root, `${BASE}/${id}/${name}`);
}

async function restoredRecords(root, item, targetDescMd, replace = false, records) {
    const current = records || await readRecords(root);
    const { matchRecord } = await import('./record-identity.mjs');
    for (const record of item.records) if (!replace && matchRecord(record, current)) throw failure('这篇日记已存在，请先处理当前记录再恢复，未覆盖任何内容。');
    const next = current.map(record => ({ ...record }));
    const files = item.files.map(file => ({ ...file, sourcePath: file.path }));
    let references = item.mediaReferences || [];
    // 旧回收项目没有关联信息，由用户明确指定日记，避免猜测或替换整份索引。
    if (targetDescMd) {
        if (item.kind !== 'files' || references.length) throw failure('这个项目无需指定恢复日记。');
        const target = next.find(record => record.desc_md === targetDescMd);
        if (!target) throw failure('目标日记已不存在，请刷新后重试。');
        const saved = { ...target };
        for (const [folder, list, prefix] of [['photo_folder', 'photos', 'data/photos/'], ['video_folder', 'videos', 'data/videos/']]) {
            const media = files.filter(file => file.path.startsWith(prefix));
            const destination = target[folder] || (media.length ? path.posix.dirname(media[0].path) : '');
            if (media.length && destination !== prefix.slice(0, -1) && !destination.startsWith(prefix)) throw failure('目标日记的媒体目录无效。');
            if (new Set(media.map(file => path.posix.basename(file.path).toLowerCase())).size !== media.length) throw failure('所选附件存在同名文件，请分别恢复后在日记中添加。');
            for (const file of media) file.path = safeDataPath(`${destination}/${path.posix.basename(file.path)}`);
            saved[folder] = destination;
            saved[list] = media.map(file => path.posix.basename(file.path));
        }
        references = [saved];
    } else if (item.kind === 'files' && !references.length && item.title === '编辑日记时移除的媒体') {
        throw failure('这份旧媒体没有保存日记关联，请先选择恢复到哪篇日记。');
    }
    const paths = new Set(files.map(file => file.path));
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
    for (const record of item.records) {
        const previous = matchRecord(record, next);
        if (previous) next[next.indexOf(previous)] = { ...record, record_id: previous.record_id };
        else next.push(record);
    }
    return { current, next, files };
}

async function restoreFiles(root, item, targetDescMd) {
    const { current, next, files } = await restoredRecords(root, item, targetDescMd);
    const copies = [];
    for (const file of files) {
        await ensureParent(root, file.path);
        try {
            await ordinaryPath(root, file.path);
            // 共用媒体可能仍在原位置，字节相同时直接复用。
            const [before, saved] = await Promise.all([fileDigest(path.join(root, file.path)), fileDigest(await ordinaryPath(root, `${BASE}/${item.id}/${file.sourcePath}`))]);
            if (before !== saved) throw failure(`恢复目标已存在且内容不同：${file.path}`);
        } catch (error) { if (error.code === 'ENOENT') copies.push(file); else throw error; }
    }
    const created = [];
    let temporary;
    try {
        for (const file of copies) {
            await fs.copyFile(await ordinaryPath(root, `${BASE}/${item.id}/${file.sourcePath}`), path.join(root, file.path), fs.constants.COPYFILE_EXCL);
            created.push(file.path);
        }
        if (item.records.length || JSON.stringify(next) !== JSON.stringify(current)) {
            temporary = path.join(root, `data/.recycle-restore-${randomBytes(16).toString('hex')}.tmp`);
            await fs.writeFile(temporary, serializeRecords(next), { flag: 'wx' });
            await ordinaryPath(root, 'data/travel_data.json');
            await fs.rename(temporary, path.join(root, 'data/travel_data.json'));
        }
    } catch (error) { for (const name of created) await fs.unlink(path.join(root, name)); throw error; }
    finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
}

async function restoreVersion(root, item, records, sources = new Map()) {
    // 将附件与索引放在同一回滚范围，任何一步失败都还原当前文件。
    const incoming = [...item.files];
    for (let index = 0; index < incoming.length; index++) {
        const file = incoming[index];
        if (file.path !== 'data/travel_data.json') continue;
        const content = file.content ?? await fs.readFile(await ordinaryPath(root,
            sources.get(file.path) || `${BASE}/${item.id}/${file.path}`), 'utf8');
        incoming[index] = { ...file, content: serializeRecords(JSON.parse(content)) };
    }
    if (records) {
        if (incoming.some(file => file.path === 'data/travel_data.json')) throw failure('附件恢复不能替换整份日记目录。');
        incoming.push({ path: 'data/travel_data.json', content: serializeRecords(records) });
    }
    const files = [];
    for (const file of incoming) {
        await ensureParent(root, file.path);
        try { await ordinaryPath(root, file.path); files.push({ path: file.path }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const { recordFilePaths } = await import('./record-backup.mjs');
    const paths = new Set(files.map(file => file.path));
    const displayRecords = (await readRecords(root)).filter(record => [...recordFilePaths([record])].some(name => paths.has(name)));
    const protection = files.length ? await captureRecycle(root, { kind: 'version', title: '恢复前的文件', displayRecords, files }) : null;
    const moved = [];
    const created = [];
    try {
        for (const file of files) {
            const original = await ordinaryPath(root, file.path);
            const temporary = `${original}.recycle-${randomBytes(16).toString('hex')}.bak`;
            await fs.rename(original, temporary);
            moved.push({ original, temporary });
        }
        for (const file of incoming) {
            if (file.content !== undefined) await fs.writeFile(path.join(root, file.path), file.content, { flag: 'wx' });
            else await fs.copyFile(await ordinaryPath(root, sources.get(file.path) || `${BASE}/${item.id}/${file.path}`), path.join(root, file.path), fs.constants.COPYFILE_EXCL);
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
        const stagedIndex = path.join(root, stage, 'data/travel_data.json');
        await fs.writeFile(stagedIndex, serializeRecords(JSON.parse(await fs.readFile(stagedIndex, 'utf8'))));
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

// 预览与提交比较同一份磁盘状态，连未被索引引用的文件也纳入检查。
async function restoreToken(root, item, targetDescMd, revision, digests = new Map()) {
    const hash = createHash('sha256').update(JSON.stringify([revision, item.id, targetDescMd || '']));
    for (const [prefix, files] of [['', await dataFiles(root)], [`${BASE}/${item.id}/`, item.files]]) {
        for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
            const source = await ordinaryPath(root, prefix + file.path);
            const digest = await fileDigest(source);
            digests.set(prefix + file.path, digest);
            hash.update(JSON.stringify([prefix, file.path, digest]));
        }
    }
    return hash.digest('hex');
}

async function previewRestore(root, item, targetDescMd, revision) {
    const { fileSource } = require('./file-stream.js');
    const { compareBackup, describeRecords } = await import('./record-diff.mjs');
    const { recordFilePaths } = await import('./record-backup.mjs');
    const { matchRecord, identifyRecords } = await import('./record-identity.mjs');
    const { readSourceText, sourceOf } = await import('./zip-stream.mjs');
    const digests = new Map();
    const previewToken = await restoreToken(root, item, targetDescMd, revision, digests);
    const current = await readRecords(root);
    const before = new Map();
    for (const file of await dataFiles(root)) before.set(file.path, await fileSource(await ordinaryPath(root, file.path)));
    const after = item.kind === 'snapshot' ? new Map() : new Map(before);
    let files = item.files.map(file => ({ ...file, sourcePath: file.path }));
    const text = async source => source ? new TextDecoder('utf-8', { fatal: true }).decode(await readSourceText(sourceOf(source))) : '';
    let next;
    if (item.kind !== 'snapshot' && item.kind !== 'version') ({ next, files } = await restoredRecords(root, item, targetDescMd, true));
    for (const file of files) after.set(file.path, await fileSource(await ordinaryPath(root, `${BASE}/${item.id}/${file.sourcePath}`)));
    if (item.kind === 'snapshot' || item.kind === 'version') {
        if (!after.has('data/travel_data.json')) throw failure('这份数据缺少日记目录，无法恢复。');
        next = identifyRecords(JSON.parse(await text(after.get('data/travel_data.json'))));
    }
    const entries = files => [...files].map(([name, data]) => ({ name, data }));
    // 复用令牌校验的 SHA-256，未被覆盖的文件沿用同一签名，无需再流式读取媒体。
    const beforeSignatures = Object.fromEntries([...before.keys()].map(name => [name, digests.get(name)]));
    const afterSignatures = { ...beforeSignatures };
    for (const file of files) afterSignatures[file.path] = digests.get(`${BASE}/${item.id}/${file.sourcePath}`);
    const comparisons = await compareBackup(next, entries(after), await describeRecords(current, entries(before), { signatures: beforeSignatures }), { signatures: afterSignatures });
    const changes = [];
    for (const record of next) {
        const comparison = comparisons.get(record.desc_md);
        if (comparison.status === 'same') continue;
        if (comparison.status === 'conflict') throw failure(comparison.message);
        comparison.currentMarkdown = await text(before.get(comparison.previous?.desc_md));
        changes.push({ record, comparison });
    }
    for (const record of current) {
        if (next.some(incoming => matchRecord(incoming, [record]))) continue;
        changes.push({ record: { desc_md: record.desc_md }, comparison: {
            status: 'removed', previous: record, fields: Object.keys(record).filter(key => key !== 'record_id'),
            currentMarkdown: await text(before.get(record.desc_md)), markdown: '', markdownChanged: true,
            media: [...recordFilePaths([record])].filter(name => name !== record.desc_md),
            previousMediaPaths: recordFilePaths([record]), incomingMediaPaths: new Set()
        } });
    }
    // 个人资料、无引用文件及旧版本文件，同样使用共享的文本和附件差异视图。
    const covered = new Set(changes.flatMap(({ record, comparison }) => [record.desc_md, comparison.previous?.desc_md, ...comparison.media]));
    for (const name of new Set([...before.keys(), ...after.keys()])) {
        if (name === 'data/travel_data.json' || covered.has(name)) continue;
        const left = before.get(name);
        const right = after.get(name);
        if (left === right || (left && right && beforeSignatures[name] === afterSignatures[name])) continue;
        const isText = /\.(md|json|txt)$/i.test(name);
        changes.push({ record: { desc_md: name }, comparison: {
            status: !left ? 'added' : !right ? 'removed' : 'changed', fields: [],
            currentMarkdown: isText ? await text(left) : '', markdown: isText ? await text(right) : '', markdownChanged: isText,
            media: isText ? [] : [name], previousMediaPaths: new Set(left ? [name] : []), incomingMediaPaths: new Set(right ? [name] : [])
        } });
    }
    // Sets 必须显式序列化；after 中未被回收文件覆盖的附件仍从当前位置读取。
    return { previewToken, changes: changes.map(({ record, comparison }) => ({ record, comparison: {
        ...comparison, previousMediaPaths: [...comparison.previousMediaPaths], incomingMediaPaths: [...comparison.incomingMediaPaths]
    } })), savedPaths: files.map(file => file.path), savedFiles: files.map(({ path, sourcePath }) => ({ path, sourcePath })) };
}

// 全部预览先通过校验，再将文件与合并后的目录放进同一个回滚范围。
async function restoreSelected(root, report, selections) {
    if (!Array.isArray(selections) || !selections.length || selections.length > report.items.length
        || new Set(selections.map(selection => selection?.id)).size !== selections.length) throw failure('请选择有效且不重复的回收项目。');
    const plans = [];
    for (const selection of selections) {
        const item = report.items.find(item => item.id === selection?.id);
        if (!item || !selection.previewToken) throw failure('所选项目缺少恢复预览，请刷新后重新选择。');
        if (await restoreToken(root, item, selection.targetDescMd, report.revision) !== selection.previewToken) throw failure('预览后内容已变化，请重新预览再恢复，未覆盖任何内容。');
        plans.push({ item, targetDescMd: selection.targetDescMd });
    }
    if (plans.length === 1 && (plans[0].item.kind === 'snapshot' || plans[0].item.kind === 'version')) {
        const { item } = plans[0];
        if (item.kind === 'snapshot') await restoreSnapshot(root, item);
        else await restoreVersion(root, item);
    } else {
        if (plans.some(({ item }) => item.kind === 'snapshot' || item.files.some(file => file.path === 'data/travel_data.json'))) throw failure('整站数据或包含日记目录的旧版本需要单独恢复，请调整选择。');
        const { matchRecord } = await import('./record-identity.mjs');
        const current = await readRecords(root);
        let next = current;
        const files = new Map();
        const owners = [];
        for (const { item, targetDescMd } of plans) {
            const references = targetDescMd ? current.filter(record => record.desc_md === targetDescMd) : item.mediaReferences || [];
            for (const record of [...item.records, ...references]) {
                const full = item.records.includes(record);
                if (owners.some(owner => matchRecord(record, [owner.record]) && (full || owner.full))) throw failure('所选项目包含同一篇日记的不同恢复内容，请分别恢复。');
                owners.push({ record, full });
            }
            let restored = item.files.map(file => ({ ...file, sourcePath: file.path }));
            if (item.kind !== 'version') ({ next, files: restored } = await restoredRecords(root, item, targetDescMd, true, next));
            for (const file of restored) {
                const source = `${BASE}/${item.id}/${file.sourcePath}`;
                const key = file.path.toLowerCase();
                const previous = files.get(key);
                if (previous && (previous.path !== file.path || await fileDigest(await ordinaryPath(root, previous.source)) !== await fileDigest(await ordinaryPath(root, source)))) throw failure(`所选项目包含同一文件的不同版本，请分别恢复：${file.path}`);
                files.set(key, { ...file, source });
            }
        }
        await restoreVersion(root, { files: [...files.values()] }, JSON.stringify(current) === JSON.stringify(next) ? undefined : next,
            new Map([...files.values()].map(file => [file.path, file.source])));
    }
    for (const { item } of plans) await discardRecycle(root, item.id);
    return readRecycleBin(root);
}

async function manageRecycleBin(root, payload) {
    const release = await require('./data-archive.js').acquireDataLock(root);
    try {
        const report = await readRecycleBin(root);
        if (payload?.revision !== report.revision) throw failure('回收站已变化，请刷新后重试。');
        if (payload.action === 'restore-selected') return await restoreSelected(root, report, payload.selections);
        if (payload.action === 'clear' || payload.action === 'purge' || payload.action === 'purge-selected') {
            if (payload.action === 'purge-selected' && (!Array.isArray(payload.ids) || !payload.ids.length
                || payload.ids.length > report.items.length || new Set(payload.ids).size !== payload.ids.length
                || payload.ids.some(id => !report.items.some(item => item.id === id)))) throw failure('请选择有效且不重复的回收项目，刷新后重试。');
            const items = payload.action === 'clear' ? report.items : report.items.filter(item => payload.action === 'purge-selected' ? payload.ids.includes(item.id) : item.id === payload.id);
            const { recordFilePaths } = await import('./record-backup.mjs');
            const referenced = recordFilePaths(await readRecords(root));
            // 先检查全部所选项目，避免删除到一半才发现仍被日记依赖的文件。
            for (const item of items) for (const file of item.files) {
                if (!referenced.has(file.path)) continue;
                try { await ordinaryPath(root, file.path); }
                catch (error) { if (error.code === 'ENOENT') throw failure('回收站文件现在被记录引用，请先恢复，未永久删除。'); throw error; }
            }
            if (payload.action !== 'purge') {
                for (const item of items) await discardRecycle(root, item.id);
                return readRecycleBin(root);
            }
        }
        const item = report.items.find(item => item.id === payload.id);
        if (!item) throw failure('这个回收项目已不存在，请刷新。');
        if (payload.action === 'preview') return await previewRestore(root, item, payload.targetDescMd, report.revision);
        if (payload.action === 'restore') {
            if (payload.previewToken) {
                const token = await restoreToken(root, item, payload.targetDescMd, report.revision);
                if (token !== payload.previewToken) throw failure('预览后内容已变化，请重新预览再恢复，未覆盖任何内容。');
            }
            if (item.kind === 'snapshot') await restoreSnapshot(root, item);
            else if (item.kind === 'version') await restoreVersion(root, item);
            else if (payload.previewToken) {
                const { current, next, files } = await restoredRecords(root, item, payload.targetDescMd, true);
                await restoreVersion(root, { files }, JSON.stringify(current) === JSON.stringify(next) ? undefined : next,
                    new Map(files.map(file => [file.path, `${BASE}/${item.id}/${file.sourcePath}`])));
            } else await restoreFiles(root, item, payload.targetDescMd);
        } else if (payload.action !== 'purge') throw failure('不支持这项回收站操作。');
        await discardRecycle(root, item.id);
        return readRecycleBin(root);
    } finally { await release(); }
}

module.exports = { captureRecycle, discardRecycle, readRecycleBin, manageRecycleBin, migrateLegacyTrash, recycleFile };
