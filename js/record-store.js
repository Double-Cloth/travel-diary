const fs = require('fs/promises');
const path = require('path');
const { randomBytes } = require('crypto');

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
    } finally {
        await handle.close();
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
    const { record, markdown } = prepared;
    const dataDir = await checkedDirectory(root, ['data']);
    const indexFile = path.join(dataDir, 'travel_data.json');
    const lockFile = path.join(dataDir, '.travel-write.lock');
    let lock;
    try {
        lock = await fs.open(lockFile, 'wx');
    } catch (error) {
        if (error.code === 'EEXIST') throw failure(409, '另一条记录正在保存，请稍后重试；若服务器曾异常退出，请按维护文档检查写入锁。');
        throw error;
    }
    let temporaryFile;
    let createdMarkdown;
    try {
        await checkedFile(indexFile);
        const previous = await fs.readFile(indexFile, 'utf8');
        const records = JSON.parse(previous);
        if (!Array.isArray(records)) throw failure(409, '旅行索引不是数组，请先修复 data/travel_data.json。');
        const existing = records.find(item => typeof item.desc_md === 'string' && item.desc_md.endsWith(`-${payload.requestId}.md`));
        if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
            throw failure(409, '这份草稿已保存，但内容不同。请重新打开新增窗口创建另一条记录。');
        }
        const diaryDir = await checkedDirectory(root, ['data', 'travel-diary', record.date.slice(0, 4)], true);
        const diaryFile = path.join(diaryDir, path.basename(record.desc_md));
        if (existing) {
            await checkedFile(diaryFile);
            if (await fs.readFile(diaryFile, 'utf8') !== markdown) throw failure(409, '这份草稿已保存，但正文已改变，未覆盖现有文件。');
            return { record, alreadySaved: true };
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
        return { record, alreadySaved: false };
    } finally {
        if (temporaryFile) await fs.unlink(temporaryFile).catch(() => {});
        if (createdMarkdown) await fs.unlink(createdMarkdown).catch(() => {});
        await lock.close();
        await fs.unlink(lockFile);
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
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        const validHost = [`localhost:${req.socket.localPort}`, `127.0.0.1:${req.socket.localPort}`, `[::1]:${req.socket.localPort}`].includes(host);
        if (!local || !validHost || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
            send(403, { error: '仅允许通过本机 localhost 页面保存记录；局域网访问为只读。' });
            return;
        }
        if (req.method === 'GET') {
            send(200, { service: 'travel-diary-writer-v1', token });
            return;
        }
        if (req.method !== 'POST') {
            send(405, { error: '不支持该请求方法。' });
            return;
        }
        if (req.headers['x-travel-token'] !== token || req.headers['content-type'] !== 'application/json') {
            send(403, { error: '写入凭据无效，请保留草稿后重新打开窗口。' });
            return;
        }
        try {
            let size = 0;
            const chunks = [];
            for await (const chunk of req) {
                size += chunk.length;
                if (size > 512 * 1024) {
                    send(413, { error: '草稿过大，请将正文缩短到 100000 字符以内。' });
                    return;
                }
                chunks.push(chunk);
            }
            let payload;
            try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { throw failure(400, '草稿 JSON 格式无效。'); }
            const result = await saveRecord(root, payload);
            send(result.alreadySaved ? 200 : 201, { saved: true, ...result });
        } catch (error) {
            send(error.status || 500, { error: error.status ? error.message : '文件保存失败，请检查数据文件格式及目录写入权限。草稿仍保留，可下载后重试。' });
        }
    };
}

module.exports = { createRecordApi };
