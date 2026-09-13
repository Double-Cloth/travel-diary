const fs = require('fs/promises');
const path = require('path');
const { randomBytes, timingSafeEqual } = require('crypto');
const { acquireDataLock, exportDataArchive, importDataArchive } = require('./data-archive.js');
const { PASSWORD_MAX_LENGTH, readAuthConfig, verifyPassword } = require('./auth.js');

function failure(status, message) {
    return Object.assign(new Error(message), { status });
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isValidHostHeader(host) {
    if (typeof host !== 'string' || !host || host !== host.trim() || host.length > 512) return false;
    try {
        const parsed = new URL(`http://${host}`);
        return Boolean(parsed.hostname)
            && !parsed.username
            && !parsed.password
            && parsed.pathname === '/'
            && !parsed.search
            && !parsed.hash;
    } catch {
        return false;
    }
}

function isMatchingHttpOrigin(host, origin) {
    if (!isValidHostHeader(host)) return false;
    if (!origin) return true;
    if (typeof origin !== 'string') return false;
    try {
        const parsedOrigin = new URL(origin);
        if (!['http:', 'https:'].includes(parsedOrigin.protocol)
            || parsedOrigin.origin !== origin
            || parsedOrigin.pathname !== '/'
            || parsedOrigin.username
            || parsedOrigin.password) return false;
        const hostAtOriginScheme = new URL(`${parsedOrigin.protocol}//${host}`);
        return hostAtOriginScheme.host === parsedOrigin.host;
    } catch {
        return false;
    }
}

function isWriterRequestAllowed(request, writeMode = 'local') {
    const host = request.host || '';
    if (writeMode === 'local') {
        const local = LOOPBACK_ADDRESSES.has(request.remoteAddress);
        const validHost = [
            `localhost:${request.localPort}`,
            `127.0.0.1:${request.localPort}`,
            `[::1]:${request.localPort}`
        ].includes(host);
        return local && validHost && (!request.origin || request.origin === `http://${host}`);
    }
    if (writeMode !== 'remote' || !isValidHostHeader(host)) return false;
    return isMatchingHttpOrigin(host, request.origin);
}

function equalCredential(actual, expected) {
    if (typeof actual !== 'string' || typeof expected !== 'string') return false;
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function readCookie(request, name) {
    const header = request.headers.cookie;
    if (typeof header !== 'string') return '';
    for (const part of header.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
        const value = part.slice(separator + 1).trim();
        return /^[a-f0-9]{64}$/.test(value) ? value : '';
    }
    return '';
}

async function readJsonBody(request, maximumBytes) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > maximumBytes) throw failure(413, '请求内容过大。');
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw failure(400, '请求 JSON 格式无效。');
    }
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

function createRecordApi(root, options = {}) {
    const writeMode = options.writeMode || 'local';
    if (!['local', 'remote'].includes(writeMode)) throw new Error(`不支持的写入模式：${writeMode}`);
    const sessions = new Map();
    const failures = new Map();
    const sessionLifetime = 8 * 60 * 60 * 1000;
    const failureWindow = 15 * 60 * 1000;
    const maximumFailures = 5;

    function currentSession(req, host) {
        const id = readCookie(req, 'travel_session');
        const session = id && sessions.get(id);
        if (!session || session.host !== host || session.expiresAt <= Date.now()) {
            if (id) sessions.delete(id);
            return null;
        }
        return session;
    }

    function clearExpiredState(now = Date.now()) {
        for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
        for (const [key, state] of failures) if (state.startedAt + failureWindow <= now) failures.delete(key);
    }

    function failureState(key, now = Date.now()) {
        const previous = failures.get(key);
        if (!previous || previous.startedAt + failureWindow <= now) return { startedAt: now, count: 0, active: 0 };
        return previous;
    }

    function finishLoginAttempt(key, outcome) {
        const state = failures.get(key);
        if (!state) return;
        const next = {
            ...state,
            active: Math.max(0, state.active - 1),
            count: outcome === 'success' ? 0 : state.count + (outcome === 'failure' ? 1 : 0)
        };
        if (!next.active && !next.count) failures.delete(key);
        else failures.set(key, next);
    }

    function sessionCookie(id, secure, maxAge = sessionLifetime / 1000) {
        return `travel_session=${id}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    }

    return async (req, res) => {
        const send = (status, value, headers = {}) => {
            res.writeHead(status, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                ...headers
            });
            res.end(JSON.stringify(value));
        };
        const host = req.headers.host || '';
        const requestUrl = new URL(req.url, 'http://localhost');
        const requestPath = requestUrl.pathname;
        const allowed = isWriterRequestAllowed({
            remoteAddress: req.socket.remoteAddress,
            localPort: req.socket.localPort,
            host,
            origin: req.headers.origin
        }, writeMode);
        if (!allowed) {
            send(403, { error: writeMode === 'local'
                ? '当前服务器仅允许通过本机 localhost 或回环地址写入；远程页面为只读。'
                : '写入请求的 Host 或 Origin 与当前站点不匹配。' });
            return;
        }

        clearExpiredState();
        const session = currentSession(req, host);
        if (requestPath === '/api/travel-auth') {
            if (req.method === 'DELETE') {
                const id = readCookie(req, 'travel_session');
                if (id) sessions.delete(id);
                send(200, { authenticated: false }, { 'Set-Cookie': sessionCookie('', false, 0) });
                return;
            }
            if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') {
                send(405, { error: '认证接口仅支持 JSON 登录请求。' }, { Allow: 'POST, DELETE' });
                return;
            }
            if (!req.headers.origin) {
                send(403, { error: '认证请求必须来自当前站点页面。' });
                return;
            }
            const failureKey = `${req.socket.remoteAddress || 'unknown'}\n${host}`;
            const state = failureState(failureKey);
            if (state.count + state.active >= maximumFailures) {
                const retryAfter = Math.max(1, Math.ceil((state.startedAt + failureWindow - Date.now()) / 1000));
                send(429, { error: '登录失败次数过多，请稍后重试。' }, { 'Retry-After': String(retryAfter) });
                return;
            }
            let attemptReserved = false;
            try {
                const payload = await readJsonBody(req, 4096);
                const config = await readAuthConfig(root, { requireProduction: writeMode === 'remote' });
                const reservedState = failureState(failureKey);
                if (reservedState.count + reservedState.active >= maximumFailures) {
                    const retryAfter = Math.max(1, Math.ceil((reservedState.startedAt + failureWindow - Date.now()) / 1000));
                    send(429, { error: '登录失败次数过多，请稍后重试。' }, { 'Retry-After': String(retryAfter) });
                    return;
                }
                failures.set(failureKey, { ...reservedState, active: reservedState.active + 1 });
                attemptReserved = true;
                const password = typeof payload?.password === 'string' ? payload.password : '';
                if (password.length > PASSWORD_MAX_LENGTH || !await verifyPassword(config, password)) {
                    finishLoginAttempt(failureKey, 'failure');
                    attemptReserved = false;
                    send(401, { error: '访问口令不正确。', code: 'AUTH_INVALID' });
                    return;
                }
                finishLoginAttempt(failureKey, 'success');
                attemptReserved = false;
                const id = randomBytes(32).toString('hex');
                const token = randomBytes(32).toString('hex');
                sessions.set(id, { host, token, expiresAt: Date.now() + sessionLifetime });
                const secure = req.headers.origin.startsWith('https://');
                send(200, {
                    service: 'travel-diary-writer-v1', authenticated: true, token,
                    methods: ['POST', 'PUT', 'DELETE'], writeMode, expiresIn: sessionLifetime / 1000
                }, { 'Set-Cookie': sessionCookie(id, secure) });
            } catch (error) {
                if (attemptReserved) finishLoginAttempt(failureKey, 'error');
                const status = error.code === 'AUTH_NOT_PRODUCTION_READY' || error.code === 'AUTH_CONFIG_INVALID'
                    ? 503
                    : (error.status || 500);
                send(status, { error: error.message || '认证服务暂时不可用。', ...(error.code ? { code: error.code } : {}) });
            }
            return;
        }
        if (requestPath === '/api/travel-records' && req.method === 'GET') {
            if (!session) {
                send(401, { service: 'travel-diary-writer-v1', authenticated: false, methods: [], writeMode, code: 'AUTH_REQUIRED' });
                return;
            }
            send(200, {
                service: 'travel-diary-writer-v1', authenticated: true, token: session.token,
                methods: ['POST', 'PUT', 'DELETE'], writeMode
            });
            return;
        }
        if (requestPath === '/api/travel-data') {
            if (!session) {
                send(401, { error: '登录会话已失效，请重新输入访问口令。', code: 'AUTH_REQUIRED' });
                return;
            }
            if (req.method !== 'GET' && req.method !== 'HEAD'
                && !equalCredential(req.headers['x-travel-token'], session.token)) {
                send(403, { error: '数据操作凭据无效，请刷新页面后重试。' });
                return;
            }
            try {
                if (req.method === 'GET' || req.method === 'HEAD') {
                    const archive = await exportDataArchive(root, { includeAuth: true });
                    const today = new Date().toISOString().slice(0, 10);
                    res.writeHead(200, {
                        'Content-Type': 'application/zip',
                        'Content-Length': archive.length,
                        'Content-Disposition': `attachment; filename="travel-diary-data-${today}.zip"`,
                        'Cache-Control': 'no-store',
                        'X-Content-Type-Options': 'nosniff'
                    });
                    res.end(req.method === 'HEAD' ? undefined : archive);
                    return;
                }
                if (req.method === 'POST' && req.headers['content-type'] === 'application/zip') {
                    const chunks = [];
                    for await (const chunk of req) chunks.push(chunk);
                    const result = await importDataArchive(root, Buffer.concat(chunks), {
                        requireProductionAuth: writeMode === 'remote'
                    });
                    sessions.clear();
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
        if (!session) {
            send(401, { error: '登录会话已失效，请重新输入访问口令。', code: 'AUTH_REQUIRED' });
            return;
        }
        if (!equalCredential(req.headers['x-travel-token'], session.token)
            || req.headers['content-type'] !== 'application/json') {
            send(403, { error: '写入凭据无效，请保留草稿后重新打开窗口。' });
            return;
        }
        try {
            const payload = await readJsonBody(req, 128 * 1024 * 1024);
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

module.exports = { createRecordApi, isMatchingHttpOrigin, isValidHostHeader, isWriterRequestAllowed };
