const fs = require('fs/promises');
const path = require('path');
const { randomBytes } = require('crypto');
const { acquireDataLock, exportDataArchive, importDataArchive } = require('./data-archive.js');

function failure(status, message) {
    return Object.assign(new Error(message), { status });
}

// 写入路径逐层检查，禁止通过链接或 junction 改写项目外的文件。
async function checkedDirectory(root, parts, create = false) {
    let current = root;
    for (const part of parts) {
        current = path.join(current, part);
        if (create) await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure(403, '数据目录必须是项目内的普通目录。');
    }
    return current;
}

async function checkedFile(file) {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw failure(403, '数据文件必须是普通文件，不能是链接。');
}

async function writeSynced(file, content) {
    const handle = await fs.open(file, 'wx');
    try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
    } catch (error) {
        await handle.close().catch(() => {});
        await fs.unlink(file).catch(() => {});
        throw error;
    } finally {
        await handle.close();
    }
}

async function resolveMarkdownFile(root, markdownPath, createDirectory = false) {
    const { isSafeAsciiFileName } = await import('./slug.mjs');
    const match = typeof markdownPath === 'string'
        ? markdownPath.match(/^data\/travel-diary\/(\d{4})\/([^/]+\.md)$/)
        : null;
    if (!match || !isSafeAsciiFileName(match[2])) throw failure(400, '旅行正文路径无效。');
    const directory = await checkedDirectory(root, ['data', 'travel-diary', match[1]], createDirectory);
    return path.join(directory, match[2]);
}

async function replaceIndex(dataDir, indexFile, previous, records) {
    let temporaryFile = path.join(dataDir, `.travel-write-${randomBytes(16).toString('hex')}.tmp`);
    try {
        await writeSynced(temporaryFile, JSON.stringify(records, null, 2) + '\n');
        await checkedFile(indexFile);
        if (await fs.readFile(indexFile, 'utf8') !== previous) throw failure(409, '旅行索引在保存期间被修改，请重试。');
        await fs.rename(temporaryFile, indexFile);
        temporaryFile = null;
    } finally {
        if (temporaryFile) await fs.unlink(temporaryFile).catch(() => {});
    }
}

async function stageRecordPhotos(root, record, uploads, sourcePhotos) {
    const createdPhotos = [];
    let createdPhotoDir;
    const rollback = async () => {
        for (const photo of createdPhotos) await fs.unlink(photo).catch(() => {});
        if (createdPhotoDir) await fs.rmdir(createdPhotoDir).catch(() => {});
    };

    if (!uploads.length) {
        if (!record.photos.length) return { rollback };
        try {
            const photoDir = await checkedDirectory(root, record.photo_folder.split('/'));
            for (const photo of record.photos) await checkedFile(path.join(photoDir, photo));
        } catch (error) {
            if (error.status) throw error;
            throw failure(400, '照片目录或文件不存在、不可读。请先将照片放入项目对应目录，再保存记录。');
        }
        return { rollback };
    }

    const photoContents = [];
    if (sourcePhotos.names.length) {
        const sourceDir = await checkedDirectory(root, sourcePhotos.folder.split('/'));
        for (const name of sourcePhotos.names) {
            await checkedFile(path.join(sourceDir, name));
            photoContents.push(await fs.readFile(path.join(sourceDir, name)));
        }
    }
    for (const photo of uploads) {
        const buffer = Buffer.from(photo.data, 'base64');
        if (buffer.toString('base64') !== photo.data) throw failure(400, '照片编码无效。');
        photoContents.push(buffer);
    }

    const parent = await checkedDirectory(root, ['data', 'photos'], true);
    const photoDir = path.join(parent, path.basename(record.photo_folder));
    try {
        await fs.mkdir(photoDir);
        createdPhotoDir = photoDir;
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await checkedDirectory(root, record.photo_folder.split('/'));
    }

    try {
        for (let index = 0; index < record.photos.length; index += 1) {
            if (index < sourcePhotos.names.length && sourcePhotos.folder === record.photo_folder
                && record.photos[index] === sourcePhotos.names[index]) continue;
            const photoPath = path.join(photoDir, record.photos[index]);
            const handle = await fs.open(photoPath, 'wx');
            createdPhotos.push(photoPath);
            try { await handle.writeFile(photoContents[index]); await handle.sync(); }
            finally { await handle.close(); }
        }
        return { rollback };
    } catch (error) {
        await rollback();
        if (error.code === 'EEXIST') throw failure(409, '目标照片文件已存在，未覆盖。请调整照片文件名后重试。');
        throw error;
    }
}

async function saveRecord(root, payload) {
    const { prepareRecord } = await import('./record-input.mjs');
    const catalog = JSON.parse(await fs.readFile(path.join(root, 'assets/catalogs/countries.json'), 'utf8'));
    let prepared;
    try {
        prepared = prepareRecord(payload, catalog.countries);
    } catch (error) {
        throw failure(400, error.message);
    }
    const { record, markdown, uploads, sourcePhotos } = prepared;
    const photoContents = [];
    const dataDir = await checkedDirectory(root, ['data']);
    const indexFile = path.join(dataDir, 'travel_data.json');
    const releaseLock = await acquireDataLock(root);
    let temporaryFile;
    let createdMarkdown;
    let createdPhotoDir;
    const createdPhotos = [];
    try {
        await checkedFile(indexFile);
        const previous = await fs.readFile(indexFile, 'utf8');
        const records = JSON.parse(previous);
        if (!Array.isArray(records)) throw failure(409, '旅行索引不是数组，请先修复 data/travel_data.json。');
        const existing = records.find(item => item.desc_md === record.desc_md);
        if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
            throw failure(409, '这份草稿已保存，但内容不同。请重新打开新增窗口创建另一条记录。');
        }
        const diaryDir = await checkedDirectory(root, ['data', 'travel-diary', record.date.slice(0, 4)], true);
        const diaryFile = path.join(diaryDir, path.basename(record.desc_md));
        if (uploads.length) {
            if (sourcePhotos.names.length) {
                const sourceDir = await checkedDirectory(root, sourcePhotos.folder.split('/'));
                for (const name of sourcePhotos.names) {
                    await checkedFile(path.join(sourceDir, name));
                    photoContents.push(await fs.readFile(path.join(sourceDir, name)));
                }
            }
            for (const photo of uploads) {
                const buffer = Buffer.from(photo.data, 'base64');
                if (buffer.toString('base64') !== photo.data) throw failure(400, '照片编码无效。');
                photoContents.push(buffer);
            }
        }
        if (existing) {
            await checkedFile(diaryFile);
            if (await fs.readFile(diaryFile, 'utf8') !== markdown) throw failure(409, '这份草稿已保存，但正文已改变，未覆盖现有文件。');
            if (uploads.length) {
                const photoDir = await checkedDirectory(root, record.photo_folder.split('/'));
                for (let index = 0; index < record.photos.length; index += 1) {
                    const photoPath = path.join(photoDir, record.photos[index]);
                    await checkedFile(photoPath);
                    if (!(await fs.readFile(photoPath)).equals(photoContents[index])) throw failure(409, '已保存照片与本次所选内容不同，未覆盖现有文件。');
                }
            }
            return { record, alreadySaved: true };
        }
        if (uploads.length) {
            const parent = await checkedDirectory(root, ['data', 'photos'], true);
            const photoDir = path.join(parent, path.basename(record.photo_folder));
            try {
                await fs.mkdir(photoDir);
                createdPhotoDir = photoDir;
            }
            catch (error) {
                if (error.code !== 'EEXIST') throw error;
                await checkedDirectory(root, record.photo_folder.split('/'));
            }
            for (let index = 0; index < record.photos.length; index += 1) {
                if (index < sourcePhotos.names.length && sourcePhotos.folder === record.photo_folder
                    && record.photos[index] === sourcePhotos.names[index]) continue;
                const photoPath = path.join(photoDir, record.photos[index]);
                const handle = await fs.open(photoPath, 'wx');
                createdPhotos.push(photoPath);
                try { await handle.writeFile(photoContents[index]); await handle.sync(); }
                finally { await handle.close(); }
            }
        } else if (record.photos.length) {
            try {
                const photoDir = await checkedDirectory(root, record.photo_folder.split('/'));
                for (const photo of record.photos) await checkedFile(path.join(photoDir, photo));
            } catch (error) {
                if (error.status) throw error;
                throw failure(400, '照片目录或文件不存在、不可读。请先将照片放入项目对应目录，再保存记录。');
            }
        }
        try {
            // 先独占创建文件，只有创建成功才允许失败时回滚。
            const handle = await fs.open(diaryFile, 'wx');
            createdMarkdown = diaryFile;
            try {
                await handle.writeFile(markdown, 'utf8');
                await handle.sync();
            } finally {
                await handle.close();
            }
        } catch (error) {
            if (error.code === 'EEXIST') throw failure(409, '目标日记文件已存在，未覆盖。请保留草稿并检查文件。');
            throw error;
        }
        temporaryFile = path.join(dataDir, `.travel-write-${randomBytes(16).toString('hex')}.tmp`);
        await writeSynced(temporaryFile, JSON.stringify([...records, record], null, 2) + '\n');
        await checkedFile(indexFile);
        if (await fs.readFile(indexFile, 'utf8') !== previous) throw failure(409, '旅行索引在保存期间被修改，请重试。');
        await fs.rename(temporaryFile, indexFile);
        temporaryFile = null;
        createdMarkdown = null;
        createdPhotos.length = 0;
        createdPhotoDir = null;
        return { record, alreadySaved: false };
    } finally {
        if (temporaryFile) await fs.unlink(temporaryFile).catch(() => {});
        if (createdMarkdown) await fs.unlink(createdMarkdown).catch(() => {});
        for (const photo of createdPhotos) await fs.unlink(photo).catch(() => {});
        if (createdPhotoDir) await fs.rmdir(createdPhotoDir).catch(() => {});
        await releaseLock();
    }
}

async function updateRecord(root, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || typeof payload.originalDescMd !== 'string' || payload.originalDescMd.length > 200) {
        throw failure(400, '缺少要修改的旅行记录标识。');
    }
    const { prepareRecord } = await import('./record-input.mjs');
    const catalog = JSON.parse(await fs.readFile(path.join(root, 'assets/catalogs/countries.json'), 'utf8'));
    let prepared;
    try {
        prepared = prepareRecord(payload.draft, catalog.countries);
    } catch (error) {
        throw failure(400, error.message);
    }

    const { record, markdown, uploads, sourcePhotos } = prepared;
    const dataDir = await checkedDirectory(root, ['data']);
    const indexFile = path.join(dataDir, 'travel_data.json');
    const releaseLock = await acquireDataLock(root);
    let photoStage;
    let temporaryMarkdown;
    let backupMarkdown;
    let createdMarkdown;
    let oldDiaryFile;
    let newDiaryFile;
    let committed = false;
    try {
        await checkedFile(indexFile);
        const previous = await fs.readFile(indexFile, 'utf8');
        const records = JSON.parse(previous);
        if (!Array.isArray(records)) throw failure(409, '旅行索引不是数组，请先修复 data/travel_data.json。');
        const matches = records.map((item, index) => ({ item, index }))
            .filter(({ item }) => item && item.desc_md === payload.originalDescMd);
        if (matches.length !== 1) throw failure(409, matches.length ? '记录标识不唯一，无法安全修改。' : '原旅行记录已不存在，请刷新页面后重试。');

        const { item: existing, index } = matches[0];
        const conflicting = records.some((item, itemIndex) => itemIndex !== index && item?.desc_md === record.desc_md);
        if (conflicting) throw failure(409, '目标正文路径已被另一条旅行记录使用。');
        const recordFields = new Set([
            'date', 'country', 'country_code', 'admin_area', 'admin_area_type', 'locality',
            'locality_type', 'trip_id', 'desc_md', 'photo_folder', 'photos'
        ]);
        const preserved = Object.fromEntries(Object.entries(existing).filter(([key]) => !recordFields.has(key)));
        const updatedRecord = { ...preserved, ...record };
        oldDiaryFile = await resolveMarkdownFile(root, payload.originalDescMd);
        newDiaryFile = await resolveMarkdownFile(root, record.desc_md, true);
        await checkedFile(oldDiaryFile);
        const oldMarkdown = await fs.readFile(oldDiaryFile, 'utf8');
        if (JSON.stringify(existing) === JSON.stringify(updatedRecord) && oldMarkdown === markdown && !uploads.length) {
            return { record: updatedRecord, alreadySaved: true };
        }

        photoStage = await stageRecordPhotos(root, record, uploads, sourcePhotos);
        if (newDiaryFile === oldDiaryFile) {
            if (oldMarkdown !== markdown) {
                temporaryMarkdown = path.join(path.dirname(newDiaryFile), `.travel-edit-${randomBytes(16).toString('hex')}.tmp`);
                const backupPath = path.join(path.dirname(oldDiaryFile), `.travel-edit-${randomBytes(16).toString('hex')}.bak`);
                await writeSynced(temporaryMarkdown, markdown);
                await fs.rename(oldDiaryFile, backupPath);
                // 只有原正文已移入备份，回滚时才允许替换目标文件。
                backupMarkdown = backupPath;
                await fs.rename(temporaryMarkdown, newDiaryFile);
                temporaryMarkdown = null;
            }
        } else {
            try {
                await writeSynced(newDiaryFile, markdown);
                createdMarkdown = newDiaryFile;
            } catch (error) {
                if (error.code === 'EEXIST') throw failure(409, '目标日记文件已存在，未覆盖。请调整正文路径后重试。');
                throw error;
            }
        }

        const nextRecords = [...records];
        nextRecords[index] = updatedRecord;
        await replaceIndex(dataDir, indexFile, previous, nextRecords);
        committed = true;
        if (backupMarkdown) await fs.unlink(backupMarkdown).catch(() => {});
        backupMarkdown = null;
        if (oldDiaryFile !== newDiaryFile) await fs.unlink(oldDiaryFile).catch(() => {});
        createdMarkdown = null;
        return { record: updatedRecord, alreadySaved: false };
    } finally {
        if (!committed) {
            if (temporaryMarkdown) await fs.unlink(temporaryMarkdown).catch(() => {});
            if (backupMarkdown) {
                await fs.unlink(oldDiaryFile).catch(() => {});
                await fs.rename(backupMarkdown, oldDiaryFile).catch(() => {});
            }
            if (createdMarkdown) await fs.unlink(createdMarkdown).catch(() => {});
            if (photoStage) await photoStage.rollback();
        }
        await releaseLock();
    }
}

async function deleteRecord(root, payload) {
    const markdownPath = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload.desc_md
        : '';
    if (typeof markdownPath !== 'string' || !markdownPath || markdownPath.length > 200) {
        throw failure(400, '缺少要删除的旅行记录标识。');
    }

    const dataDir = await checkedDirectory(root, ['data']);
    const indexFile = path.join(dataDir, 'travel_data.json');
    const releaseLock = await acquireDataLock(root);
    let diaryFile;
    let backupMarkdown;
    let committed = false;
    try {
        await checkedFile(indexFile);
        const previous = await fs.readFile(indexFile, 'utf8');
        const records = JSON.parse(previous);
        if (!Array.isArray(records)) throw failure(409, '旅行索引不是数组，请先修复 data/travel_data.json。');
        const matches = records.map((item, index) => ({ item, index }))
            .filter(({ item }) => item && item.desc_md === markdownPath);
        if (matches.length !== 1) throw failure(409, matches.length ? '记录标识不唯一，无法安全删除。' : '旅行记录已不存在，请刷新页面后重试。');

        const { item: deletedRecord, index } = matches[0];
        try {
            diaryFile = await resolveMarkdownFile(root, markdownPath);
            await checkedFile(diaryFile);
            const backupPath = path.join(path.dirname(diaryFile), `.travel-delete-${randomBytes(16).toString('hex')}.bak`);
            await fs.rename(diaryFile, backupPath);
            backupMarkdown = backupPath;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        await replaceIndex(dataDir, indexFile, previous, records.filter((_, itemIndex) => itemIndex !== index));
        committed = true;
        if (backupMarkdown) await fs.unlink(backupMarkdown).catch(() => {});
        backupMarkdown = null;
        return { record: deletedRecord };
    } finally {
        if (!committed && backupMarkdown) await fs.rename(backupMarkdown, diaryFile).catch(() => {});
        await releaseLock();
    }
}

function createRecordApi(root) {
    const token = randomBytes(32).toString('hex');
    return async (req, res) => {
        const send = (status, value) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(value));
        };
        const host = req.headers.host || '';
        const requestUrl = new URL(req.url, 'http://localhost');
        const requestPath = requestUrl.pathname;
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        const validHost = [`localhost:${req.socket.localPort}`, `127.0.0.1:${req.socket.localPort}`, `[::1]:${req.socket.localPort}`].includes(host);
        if (!local || !validHost || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
            send(403, { error: '仅允许通过本机 localhost 页面保存记录；局域网访问为只读。' });
            return;
        }
        if (requestPath === '/api/travel-records' && req.method === 'GET') {
            send(200, { service: 'travel-diary-writer-v1', token, methods: ['POST', 'PUT', 'DELETE'] });
            return;
        }
        if (requestPath === '/api/travel-data') {
            if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-travel-token'] !== token) {
                send(403, { error: '数据操作凭据无效，请刷新页面后重试。' });
                return;
            }
            try {
                if (req.method === 'GET' || req.method === 'HEAD') {
                    const archive = await exportDataArchive(root);
                    const today = new Date().toISOString().slice(0, 10);
                    res.writeHead(200, {
                        'Content-Type': 'application/zip',
                        'Content-Length': archive.length,
                        'Content-Disposition': `attachment; filename="travel-diary-data-${today}.zip"`,
                        'Cache-Control': 'no-store'
                    });
                    res.end(req.method === 'HEAD' ? undefined : archive);
                    return;
                }
                if (req.method === 'POST' && req.headers['content-type'] === 'application/zip') {
                    const chunks = [];
                    for await (const chunk of req) chunks.push(chunk);
                    const result = await importDataArchive(root, Buffer.concat(chunks), {
                        currentPassword: req.headers['x-travel-current-password'],
                        password: req.headers['x-travel-import-password']
                    });
                    send(200, { imported: true, ...result });
                    return;
                }
                send(405, { error: '数据备份仅支持 ZIP 导入与导出。' });
            } catch (error) {
                send(error.status || 500, {
                    error: error.status ? error.message : '全部数据操作失败，请检查目录权限、磁盘空间和备份文件。',
                    ...(error.code ? { code: error.code } : {})
                });
            }
            return;
        }
        if (!['POST', 'PUT', 'DELETE'].includes(req.method)) {
            send(405, { error: '不支持该请求方法。' });
            return;
        }
        if (req.headers['x-travel-token'] !== token || req.headers['content-type'] !== 'application/json') {
            send(403, { error: '写入凭据无效，请保留草稿后重新打开窗口。' });
            return;
        }
        try {
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
            }
            let payload;
            try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { throw failure(400, '草稿 JSON 格式无效。'); }
            if (req.method === 'PUT') {
                const result = await updateRecord(root, payload);
                send(200, { saved: true, updated: true, ...result });
                return;
            }
            if (req.method === 'DELETE') {
                const result = await deleteRecord(root, payload);
                send(200, { deleted: true, ...result });
                return;
            }
            const result = await saveRecord(root, payload);
            send(result.alreadySaved ? 200 : 201, { saved: true, ...result });
        } catch (error) {
            send(error.status || 500, { error: error.status ? error.message : '文件保存失败，请检查数据文件格式及目录写入权限。草稿仍保留，可下载后重试。' });
        }
    };
}

module.exports = { createRecordApi };
