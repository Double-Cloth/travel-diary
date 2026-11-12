const { serializeRecords } = require('./record-order.js');
const fs = require('fs/promises');
const path = require('path');
const { randomBytes } = require('crypto');
const { fileSource, writeSource } = require('./file-stream.js');
const { AUTH_RELATIVE_PATH, validateAuthConfig, verifyBackupAccess } = require('./auth.js');

const DEFAULT_PROFILE_PICTURE = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=',
    'base64'
);

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
    if (name === AUTH_RELATIVE_PATH) return true;
    if (!name.startsWith('data/') || /[\u0000-\u001f\u007f:<>"|?*]/.test(name) || name.includes('\\')) return false;
    const parts = name.split('/');
    return parts.length > 1 && parts.every(part => part && part !== '.' && part !== '..'
        && !/[. ]$/.test(part)
        && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}

function validatePortablePaths(entries, status, message) {
    const paths = new Map();
    for (const entry of entries) {
        const parts = entry.name.split('/');
        for (let length = 1; length <= parts.length; length += 1) {
            const name = parts.slice(0, length).join('/');
            const key = name.toLowerCase();
            const isFile = length === parts.length;
            const previous = paths.get(key);
            if (previous && (previous.name !== name || previous.isFile || isFile)) throw failure(status, message);
            paths.set(key, { name, isFile });
        }
    }
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
    const value = !required && record[field] == null ? '' : record[field];
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
        else if (stat.isFile()) entries.push({ name: archivePath, data: await fileSource(filePath) });
        else throw failure(400, `数据目录包含不支持的文件类型：${archivePath}`);
    }
    return entries;
}

async function exportDataArchive(root, selectedPaths = null, { signal } = {}) {
    const release = await acquireDataLock(root);
    let handedOff = false;
    try {
        signal?.throwIfAborted();
        const dataDir = path.join(root, 'data');
        const stat = await fs.lstat(dataDir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure(403, 'data 必须是项目内的普通目录。');
        await require('./recycle-bin.js').migrateLegacyTrash(root);
        let entries = await collectFiles(dataDir);
        if (!entries.length) throw failure(400, 'data 目录为空，无法导出。');
        const secretsDir = path.join(root, '.secrets');
        await fs.mkdir(secretsDir, { recursive: true });
        const secretsDirStat = await fs.lstat(secretsDir);
        if (secretsDirStat.isSymbolicLink() || !secretsDirStat.isDirectory()) {
            throw failure(403, '.secrets 必须是项目内的普通目录。');
        }
        await fs.chmod(secretsDir, 0o700).catch(() => {});
        const authFile = path.join(root, ...AUTH_RELATIVE_PATH.split('/'));
        let authStat;
        try { authStat = await fs.lstat(authFile); }
        catch (error) {
            if (error.code === 'ENOENT') throw failure(503, '缺少 .secrets/auth.json，请先启动本机页面并执行任一写入操作创建访问密码。', 'AUTH_NOT_CONFIGURED');
            throw error;
        }
        if (authStat.isSymbolicLink() || !authStat.isFile()) {
            throw failure(403, '.secrets/auth.json 必须是项目内的普通文件。');
        }
        const authData = await fs.readFile(authFile);
        try { validateAuthConfig(parseJsonFile(authData, `当前 ${AUTH_RELATIVE_PATH}`)); }
        catch (error) {
            throw failure(503, '认证配置无效，请先运行 npm run auth:set 创建新的访问密码。', error.code);
        }
        entries.push({ name: AUTH_RELATIVE_PATH, data: authData });
        const recordsWithIds = await require('./record-inventory.js').readRecords(root);
        entries = entries.map(entry => entry.name === 'data/travel_data.json'
            ? { ...entry, data: Buffer.from(serializeRecords(recordsWithIds)) } : entry);
        if (selectedPaths !== null) {
            const { readBackupRecords, selectBackupRecords, recordBackupEntries } = await import('./record-backup.mjs');
            try {
                const records = selectBackupRecords(await readBackupRecords(entries), selectedPaths);
                entries = recordBackupEntries(entries, records, { includeAuth: true });
                await validateImportedRecords(entries);
            } catch (error) { throw failure(error.status || 400, error.message); }
        }
        const { createZipStream, zipStreamSize } = await import('./zip-stream.mjs');
        const size = zipStreamSize(entries);
        const { MAXIMUM_ARCHIVE_BYTES } = await import('./file-limits.mjs');
        if (size > MAXIMUM_ARCHIVE_BYTES) throw failure(413, '备份不能超过 100 GiB。');
        const { recordFingerprint } = await import('./record-diff.mjs');
        const { readBackupRecords } = await import('./record-backup.mjs');
        const records = await readBackupRecords(entries);
        const signatures = {};
        const snapshot = {};
        let completed = 0;
        // 复用打包时的 CRC，不在下载前再次扫描全部媒体；快照在流结束前补齐。
        const stream = createZipStream(entries, { signal, onEntry: async ({ name, size, checksum }) => {
            signatures[name] = `${size}:${checksum}`;
            completed += 1;
            if (completed === entries.length) {
                for (const record of records) {
                    signal?.throwIfAborted();
                    snapshot[record.record_id] = await recordFingerprint(record, signatures);
                }
            }
        } });
        signal?.throwIfAborted();
        handedOff = true;
        return { stream, size, release, snapshot };
    } finally {
        if (!handedOff) await release();
    }
}

async function validateImportedRecords(entries) {
    const [{ isValidDateString }, { isSafeAsciiFileName }, { MAXIMUM_RECORD_MEDIA_ITEMS }] = await Promise.all([
        import('./analytics.mjs'), import('./slug.mjs'), import('./file-limits.mjs')
    ]);
    const files = new Map(entries.map(entry => [entry.name, entry.data]));
    const index = files.get('data/travel_data.json');
    if (!index) throw failure(400, '备份缺少 data/travel_data.json。');
    const records = parseJsonFile(index, 'data/travel_data.json');
    if (!Array.isArray(records)) throw failure(400, '备份中的旅行索引必须是数组。');
    if (records.length > 10000) throw failure(400, '备份中的旅行记录不能超过 10000 条。');
    const markdownPaths = new Set();
    const recordIds = new Set();
    let missingMediaReferences = 0;
    for (const [indexValue, record] of records.entries()) {
        const recordNumber = indexValue + 1;
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项必须是对象。`);
        }
        const { validRecordIdentity, recordIdentity } = await import('./record-identity.mjs');
        if (!validRecordIdentity(recordIdentity(record)) || recordIds.has(recordIdentity(record))) {
            throw failure(400, '备份中的记录固定标识无效或重复。');
        }
        recordIds.add(recordIdentity(record));
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
        const { readSourceText } = await import('./zip-stream.mjs');
        decodeUtf8(await readSourceText(files.get(markdownPath)), markdownPath);

        const photoFolder = validateTextField(record, recordNumber, 'photo_folder');
        if (photoFolder && (!photoFolder.startsWith('data/photos/')
            || !photoFolder.slice('data/photos/'.length).split('/').every(isSafeAsciiFileName))) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项照片目录无效。`);
        }
        const photos = record.photos == null ? [] : record.photos;
        if (!Array.isArray(photos) || photos.length > MAXIMUM_RECORD_MEDIA_ITEMS) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项照片列表无效。`);
        }
        if (photos.length && !photoFolder) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项包含照片但未设置照片目录。`);
        }
        for (const photo of photos) {
            if (!isSafeAsciiFileName(photo)) {
                throw failure(400, `备份中的旅行记录第 ${recordNumber} 项照片文件名无效。`);
            }
            if (!files.has(`${photoFolder}/${photo}`)) missingMediaReferences += 1;
        }

        const videoFolder = record.video_folder == null ? '' : validateTextField(record, recordNumber, 'video_folder');
        if (videoFolder && (!videoFolder.startsWith('data/videos/')
            || !videoFolder.slice('data/videos/'.length).split('/').every(isSafeAsciiFileName))) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项视频目录无效。`);
        }
        const videos = record.videos == null ? [] : record.videos;
        if (!Array.isArray(videos) || videos.length > MAXIMUM_RECORD_MEDIA_ITEMS) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项视频列表无效。`);
        }
        if (videos.length && !videoFolder) {
            throw failure(400, `备份中的旅行记录第 ${recordNumber} 项包含视频但未设置视频目录。`);
        }
        for (const video of videos) {
            if (!isSafeAsciiFileName(video)) {
                throw failure(400, `备份中的旅行记录第 ${recordNumber} 项视频文件名无效。`);
            }
            if (!files.has(`${videoFolder}/${video}`)) missingMediaReferences += 1;
        }
    }
    return { missingMediaReferences };
}

async function validateCurrentAuth(root, options = {}) {
    const currentAuthFile = path.join(root, ...AUTH_RELATIVE_PATH.split('/'));
    const stat = await fs.lstat(currentAuthFile);
    if (stat.isSymbolicLink() || !stat.isFile()) throw failure(403, '当前认证配置必须是项目内的普通文件。');
    const data = await fs.readFile(currentAuthFile);
    validateAuthConfig(parseJsonFile(data, `当前 ${AUTH_RELATIVE_PATH}`), {
        requireProduction: options.requireProductionAuth === true
    });
}

async function mergeRecordEntries(root, incoming) {
    const { readBackupRecords, recordFilePaths } = await import('./record-backup.mjs');
    const { sourceOf } = await import('./zip-stream.mjs');
    const current = await collectFiles(path.join(root, 'data'));
    const records = await readBackupRecords(current);
    const { matchRecord, recordIdentity } = await import('./record-identity.mjs');
    const selected = await readBackupRecords(incoming);
    if (!selected.length) throw failure(400, '备份中没有可导入的记录。');
    const matches = new Map();
    for (const record of selected) {
        let previous;
        try { previous = matchRecord(record, records); }
        catch (error) { throw failure(409, error.message); }
        if (previous && [...matches.values()].includes(previous)) throw failure(409, '多条备份记录指向同一篇日记，无法合并。');
        matches.set(record, previous);
    }
    const planEntry = incoming.find(entry => entry.name === 'data/record-merge.json');
    if (planEntry) {
        const { readSourceText } = await import('./zip-stream.mjs');
        const plan = parseJsonFile(await readSourceText(sourceOf(planEntry.data)), planEntry.name);
        if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).length !== selected.length
            || Object.values(plan).some(value => value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))) {
            throw failure(400, '记录差异预览清单无效，请重新选择备份。');
        }
        const current = await require('./record-inventory.js').inventory(root);
        for (const record of selected) {
            const previous = matches.get(record);
            const actual = previous ? current.fingerprints[recordIdentity(previous)] : null;
            if (!Object.hasOwn(plan, record.desc_md) || plan[record.desc_md] !== actual) {
                throw failure(409, '预览后当前记录已变化，请重新选择备份并核对差异。');
            }
        }
    }
    const selectedPaths = new Set([...matches.values()].filter(Boolean).map(record => record.desc_md));
    const untouched = records.filter(record => !selectedPaths.has(record.desc_md));
    const protectedFiles = recordFilePaths(untouched);
    const replacedFiles = recordFilePaths(records.filter(record => selectedPaths.has(record.desc_md)));
    const allowed = recordFilePaths(selected);
    const entries = new Map(current.map(entry => [entry.name, entry]));
    for (const entry of incoming) {
        if (!allowed.has(entry.name)) continue;
        const previous = entries.get(entry.name);
        if (previous && (protectedFiles.has(entry.name) || !replacedFiles.has(entry.name))) {
            const { createHash } = require('node:crypto');
            const digest = async data => {
                const hash = createHash('sha256');
                for await (const chunk of sourceOf(data).chunks()) hash.update(chunk);
                return hash.digest('hex');
            };
            if (await digest(previous.data) !== await digest(entry.data)) {
                const reason = protectedFiles.has(entry.name) ? '被未选中的记录共用' : '与已有独立文件重名';
                throw failure(409, `文件 ${entry.name} ${reason}且内容不同，请先调整文件名再导入。`);
            }
        }
        entries.set(entry.name, entry);
    }
    const replacements = new Map(selected.map(record => [matches.get(record)?.desc_md || record.desc_md,
        { ...record, record_id: recordIdentity(matches.get(record) || record) }]));
    const merged = records.map(record => replacements.get(record.desc_md) || record);
    merged.push(...selected.filter(record => !matches.get(record)).map(record => replacements.get(record.desc_md)));
    // 路径变动后移除旧正文；旧媒体仍保留，交由媒体体检显式清理。
    for (const record of selected) {
        const previous = matches.get(record);
        if (previous && previous.desc_md !== record.desc_md && !protectedFiles.has(previous.desc_md)) entries.delete(previous.desc_md);
    }
    entries.set('data/travel_data.json', { name: 'data/travel_data.json', data: Buffer.from(serializeRecords(merged)) });
    const { compareBackup, describeRecords } = await import('./record-diff.mjs');
    const comparisons = await compareBackup(selected, incoming, await describeRecords([...matches.values()].filter(Boolean), current));
    const replacedRecords = selected.filter(record => matches.get(record) && comparisons.get(record.desc_md).status !== 'same').map(record => matches.get(record));
    return { entries: [...entries.values()], addedRecords: selected.filter(record => !matches.get(record)).length,
        updatedRecords: selected.filter(record => matches.get(record)).length, replacedRecords };
}

async function importDataArchive(root, archive, options = {}) {
    const release = await acquireDataLock(root);
    const id = randomBytes(16).toString('hex');
    const stageRoot = path.join(root, `.travel-data-import-${id}`);
    const stageData = path.join(stageRoot, 'data');
    const currentData = path.join(root, 'data');
    const backupData = path.join(root, `.travel-data-backup-${id}`);
    let movedData = false;
    let installedData = false;
    let recycleId;
    let recycledCommitted = false;
    try {
        await options.authorize?.();
        const { readZipSource, readSourceText } = await import('./zip-stream.mjs');
        let entries;
        try {
            entries = await readZipSource(archive);
            for (const entry of entries) {
                if (entry.name === 'data/travel_data.json' || entry.name === AUTH_RELATIVE_PATH) entry.data = await readSourceText(entry.data);
            }
        }
        catch (error) { throw failure(400, error.message); }
        const authEntries = entries.filter(entry => entry.name.toLocaleLowerCase('en-US') === AUTH_RELATIVE_PATH);
        if (authEntries.length > 1 || (authEntries.length === 1 && authEntries[0].name !== AUTH_RELATIVE_PATH)) {
            throw failure(400, `备份中的认证配置路径无效，应为 ${AUTH_RELATIVE_PATH}。`);
        }
        let authEntry = authEntries[0] || null;
        const { RECORD_BACKUP_PATH, RECORD_BACKUP_FORMAT } = await import('./record-backup.mjs');
        const marker = entries.find(entry => entry.name === RECORD_BACKUP_PATH);
        if (marker) {
            const metadata = parseJsonFile(await readSourceText(marker.data), RECORD_BACKUP_PATH);
            if (metadata.format !== RECORD_BACKUP_FORMAT) throw failure(400, '部分记录备份的格式无效。');
            if (!options.mergeRecords) throw failure(400, '这是部分记录备份，请使用「导入部分记录」，避免覆盖全部数据。');
        }
        // 兼容旧备份中的明文密码文件，但不再静默丢弃当前版本导出的认证配置。
        entries = entries.filter(entry => entry.name !== 'data/password.json');
        if (!entries.length || entries.some(entry => !safeArchivePath(entry.name))) {
            throw failure(400, `备份只能包含 data/ 和 ${AUTH_RELATIVE_PATH} 下的安全文件路径。`);
        }
        validatePortablePaths(entries, 400, '备份包含大小写冲突或文件与目录重名的路径，无法安全导入。');
        let validation;
        try { validation = await validateImportedRecords(entries); }
        catch (error) { throw failure(error.status || 400, error.message); }
        if (authEntry) {
            let backupConfig;
            try {
                backupConfig = validateAuthConfig(parseJsonFile(authEntry.data, AUTH_RELATIVE_PATH), {
                    requireProduction: options.requireProductionAuth === true
                });
            } catch (error) {
                if (error.status) throw error;
                throw failure(400, `备份中的 ${AUTH_RELATIVE_PATH} 无效。`, error.code);
            }
            if (!await verifyBackupAccess(backupConfig, options.backupPassword, options.authenticatedAuthConfig)) {
                throw failure(403, '密码不正确，请输入导出这份备份时使用的访问密码。', 'BACKUP_PASSWORD_INVALID');
            }
        } else {
            await validateCurrentAuth(root, options);
        }
        await require('./recycle-bin.js').migrateLegacyTrash(root);
        let mergeResult;
        if (options.mergeRecords) {
            mergeResult = await mergeRecordEntries(root, entries);
            entries = mergeResult.entries;
            authEntry = null;
            // 合并后的完整目录同样要检查跨平台路径冲突，避免覆盖未选中的文件。
            validatePortablePaths(entries, 409, '导入文件与当前数据存在大小写或文件目录路径冲突。');
            validation = await validateImportedRecords(entries);
        }
        // 所有恢复都保存固定标识，旧备份也能在后续改名后识别为同一记录。
        const indexEntry = entries.find(entry => entry.name === 'data/travel_data.json');
        const { identifyRecords } = await import('./record-identity.mjs');
        indexEntry.data = Buffer.from(serializeRecords(identifyRecords(parseJsonFile(indexEntry.data, indexEntry.name))));
        entries = entries.filter(entry => entry.name !== 'data/record-merge.json');
        const stageSecrets = path.join(stageRoot, '.secrets');
        const currentSecrets = path.join(root, '.secrets');
        const backupSecrets = path.join(root, `.travel-secrets-backup-${id}`);
        await fs.mkdir(stageData, { recursive: true });
        for (const entry of entries) {
            if (entry.name === AUTH_RELATIVE_PATH) continue;
            const target = path.join(stageData, ...entry.name.slice('data/'.length).split('/'));
            await fs.mkdir(path.dirname(target), { recursive: true });
            try { await writeSource(target, entry.data); }
            catch (error) { throw failure(error.status || (error.code ? 500 : 400), error.message); }
        }
        if (authEntry) {
            await fs.mkdir(stageSecrets, { recursive: true });
            await fs.writeFile(path.join(stageSecrets, 'auth.json'), authEntry.data, { flag: 'wx', mode: 0o600 });
        }
        await options.authorize?.();
        const currentStat = await fs.lstat(currentData);
        if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
            throw failure(403, '当前 data 必须是项目内的普通目录。');
        }
        if (authEntry) {
            let secretsStat;
            try { secretsStat = await fs.lstat(currentSecrets); }
            catch (error) {
                if (error.code !== 'ENOENT') throw error;
                await fs.mkdir(currentSecrets, { recursive: true });
                secretsStat = await fs.lstat(currentSecrets);
            }
            if (secretsStat.isSymbolicLink() || !secretsStat.isDirectory()) {
                throw failure(403, '.secrets 必须是项目内的普通目录。');
            }
        }
        let movedSecrets = false;
        let installedSecrets = false;
        if (mergeResult?.replacedRecords.length) {
            const { recordFilePaths } = await import('./record-backup.mjs');
            recycleId = await require('./recycle-bin.js').captureRecycle(root, { kind: 'record', title: '导入部分记录前的日记', records: identifyRecords(mergeResult.replacedRecords),
                files: [...recordFilePaths(mergeResult.replacedRecords)].map(name => ({ path: name, optional: true })) });
        } else if (!mergeResult) recycleId = await require('./recycle-bin.js').captureRecycle(root, { kind: 'snapshot', title: '导入全部数据前的数据' });
        await fs.rename(currentData, backupData);
        movedData = true;
        try {
            await fs.rename(stageData, currentData);
            installedData = true;
            if (authEntry) {
                await fs.rename(currentSecrets, backupSecrets);
                movedSecrets = true;
                await fs.rename(stageSecrets, currentSecrets);
                installedSecrets = true;
            }
            await require('./recycle-bin.js').migrateLegacyTrash(root);
        } catch (error) {
            if (installedSecrets) await fs.rm(currentSecrets, { recursive: true, force: true });
            if (movedSecrets) await fs.rename(backupSecrets, currentSecrets).catch(() => {});
            if (installedData) await fs.rm(currentData, { recursive: true, force: true });
            await fs.rename(backupData, currentData);
            movedData = false;
            throw error;
        }
        movedData = false;
        recycledCommitted = true;
        movedSecrets = false;
        await fs.rm(backupData, { recursive: true, force: true }).catch(() => {});
        await fs.rm(backupSecrets, { recursive: true, force: true }).catch(() => {});
        return { files: entries.length, authPreserved: !authEntry, ...validation,
            ...(mergeResult ? { merged: true, addedRecords: mergeResult.addedRecords, updatedRecords: mergeResult.updatedRecords } : {}) };
    } finally {
        try {
            if (recycleId && !recycledCommitted) await require('./recycle-bin.js').discardRecycle(root, recycleId);
            if (movedData) await fs.rename(backupData, currentData).catch(() => {});
            await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
        } finally { await release(); }
    }
}

async function collectMovableEntries(directory, relativePath = '') {
    const directories = [];
    const leaves = [];
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        const itemRelativePath = relativePath ? path.join(relativePath, item.name) : item.name;
        const itemPath = path.join(directory, item.name);
        const stat = await fs.lstat(itemPath);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
            directories.push(itemRelativePath);
            const nested = await collectMovableEntries(itemPath, itemRelativePath);
            directories.push(...nested.directories);
            leaves.push(...nested.leaves);
        } else {
            leaves.push(itemRelativePath);
        }
    }
    return { directories, leaves };
}

async function moveDirectoryContents(sourceRoot, targetRoot) {
    const { directories, leaves } = await collectMovableEntries(sourceRoot);
    const movedLeaves = [];
    await fs.mkdir(targetRoot, { recursive: true });
    try {
        for (const directory of directories) {
            await fs.mkdir(path.join(targetRoot, directory), { recursive: true });
        }
        for (const leaf of leaves) {
            await fs.rename(path.join(sourceRoot, leaf), path.join(targetRoot, leaf));
            movedLeaves.push(leaf);
        }
        for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
            await fs.rmdir(path.join(sourceRoot, directory));
        }
    } catch (error) {
        for (const leaf of movedLeaves.reverse()) {
            await fs.mkdir(path.dirname(path.join(sourceRoot, leaf)), { recursive: true }).catch(() => {});
            await fs.rename(path.join(targetRoot, leaf), path.join(sourceRoot, leaf)).catch(() => {});
        }
        for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
            await fs.rmdir(path.join(targetRoot, directory)).catch(() => {});
        }
        throw error;
    }
}

function isWindowsRenameContention(error) {
    return process.platform === 'win32' && ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code);
}

async function pathExists(target) {
    try {
        await fs.stat(target);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

async function clearTravelData(root) {
    const release = await acquireDataLock(root);
    const id = randomBytes(16).toString('hex');
    const stageRoot = path.join(root, `.travel-data-clear-${id}`);
    const stageData = path.join(stageRoot, 'data');
    const currentData = path.join(root, 'data');
    const backupData = path.join(root, `.travel-data-backup-${id}`);
    let movedData = false;
    let recycleId;
    let recycledCommitted = false;
    try {
        const currentStat = await fs.lstat(currentData);
        if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
            throw failure(403, '当前 data 必须是项目内的普通目录。');
        }

        await Promise.all([
            fs.mkdir(path.join(stageData, 'travel-diary'), { recursive: true }),
            fs.mkdir(path.join(stageData, 'photos'), { recursive: true }),
            fs.mkdir(path.join(stageData, 'videos'), { recursive: true }),
            fs.mkdir(path.join(stageData, 'profile'), { recursive: true })
        ]);
        await Promise.all([
            fs.writeFile(path.join(stageData, 'travel_data.json'), '[]\n', { flag: 'wx' }),
            fs.writeFile(path.join(stageData, 'profile', 'profile-picture.png'), DEFAULT_PROFILE_PICTURE, { flag: 'wx' })
        ]);

        recycleId = await require('./recycle-bin.js').captureRecycle(root, { kind: 'snapshot', title: '清空前的全部数据' });
        try {
            await fs.rename(currentData, backupData);
            movedData = true;
        } catch (error) {
            if (!isWindowsRenameContention(error)) throw error;
            // Windows 会在图片或视频仍被浏览器读取时拒绝重命名父目录；逐文件搬移可保留回滚能力。
            await moveDirectoryContents(currentData, backupData);
            movedData = true;
        }
        try {
            if (await pathExists(currentData)) {
                await moveDirectoryContents(stageData, currentData);
            } else {
                await fs.rename(stageData, currentData);
            }
        } catch (error) {
            const currentExists = await pathExists(currentData);
            if (currentExists) await moveDirectoryContents(backupData, currentData);
            else await fs.rename(backupData, currentData);
            movedData = false;
            throw error;
        }
        movedData = false;
        recycledCommitted = true;
        await fs.rm(backupData, { recursive: true, force: true }).catch(() => {});
        return { authPreserved: true };
    } finally {
        try {
            if (recycleId && !recycledCommitted) await require('./recycle-bin.js').discardRecycle(root, recycleId);
            if (movedData) {
                const currentExists = await pathExists(currentData);
                if (currentExists) await moveDirectoryContents(backupData, currentData).catch(() => {});
                else await fs.rename(backupData, currentData).catch(() => {});
            }
            await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
        } finally { await release(); }
    }
}

module.exports = { acquireDataLock, clearTravelData, exportDataArchive, importDataArchive };
