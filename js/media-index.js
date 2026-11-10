const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { ordinaryPath } = require('./record-inventory.js');
const { fileSource } = require('./file-stream.js');

async function digestSource(source) {
    const hash = createHash('sha256');
    for await (const chunk of source.chunks()) hash.update(chunk);
    return hash.digest('hex');
}

function fileVersion(stat) {
    return [stat.size, stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs, stat.dev, stat.ino];
}

// 调用方持有统一数据锁。只为本批大小相同的候选读取内容，其余文件保留元数据。
async function readMediaIndex(root, sizes) {
    await fs.mkdir(path.join(root, '.cache')).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await ordinaryPath(root, '.cache', true);
    let previous = new Map();
    try {
        const file = await ordinaryPath(root, '.cache/media-index.json');
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        if (value?.version === 1 && Array.isArray(value.files)) {
            previous = new Map(value.files.filter(item => item && typeof item.path === 'string'
                && Array.isArray(item.version) && /^[a-f0-9]{64}$/.test(item.digest)).map(item => [item.path, item]));
        }
    } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    const files = [];
    async function walk(folder) {
        let directory;
        try { directory = await ordinaryPath(root, folder, true); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const name = `${folder}/${entry.name}`;
            if (entry.isDirectory() && !entry.isSymbolicLink()) {
                await walk(name);
                continue;
            }
            const file = await ordinaryPath(root, name);
            const version = fileVersion(await fs.stat(file));
            const cached = previous.get(name);
            let digest = cached && JSON.stringify(cached.version) === JSON.stringify(version) ? cached.digest : null;
            if (!digest && sizes.has(version[0])) {
                digest = await digestSource(await fileSource(file));
                if (JSON.stringify(fileVersion(await fs.stat(file))) !== JSON.stringify(version)) {
                    throw Object.assign(new Error('媒体在检测期间发生变化，请重试。'), { status: 409 });
                }
            }
            files.push({ path: name, version, digest });
        }
    }
    await walk('data/photos');
    await walk('data/videos');
    const temporary = path.join(root, '.cache', `media-index-${randomBytes(16).toString('hex')}.tmp`);
    try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, files }), { flag: 'wx' });
        await fs.rename(temporary, path.join(root, '.cache/media-index.json'));
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return files;
}

module.exports = { digestSource, readMediaIndex };
