const fs = require('fs/promises');
const path = require('path');
const { existsSync } = require('fs');
const { execFile } = require('child_process');
const { createHash, randomBytes } = require('crypto');
const { promisify } = require('util');

const execute = promisify(execFile);
const MAXIMUM_PREVIEW_BYTES = 2 * 1024 * 1024;

function failure(status, message) {
    return Object.assign(new Error(message), { status });
}

function sourceForPreview(urlPath) {
    const match = /^\/data\/previews\/(photos|videos)\/(.+)\.jpg$/.exec(urlPath);
    if (!match || !/\.(jpe?g|png|gif|webp|mp4|m4v|mov|webm|ogv|ogg)$/i.test(match[2])) return null;
    const source = `data/${match[1]}/${match[2]}`;
    if (/[\u0000-\u001f\u007f\\:]/.test(source)
        || !source.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part))) return null;
    return source;
}

// 逐级检查目录，不允许通过符号链接或 junction 读取、写入项目外文件。
async function safePath(root, relative, createParents = false) {
    const parts = relative.split('/');
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
        current = path.join(current, parts[index]);
        const isParent = index < parts.length - 1;
        if (createParents && isParent) await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
        let stat;
        try { stat = await fs.lstat(current); }
        catch (error) {
            if (createParents && !isParent && error.code === 'ENOENT') return current;
            throw error;
        }
        if (stat.isSymbolicLink() || (isParent && !stat.isDirectory()) || (!isParent && !stat.isFile())) {
            throw failure(403, '媒体路径必须是项目内的普通文件。');
        }
    }
    return current;
}

function fingerprint(stat) {
    return `jpeg-640-q5-v1:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function findFfmpeg(root) {
    const local = path.join(root, '.cache', 'tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    return process.env.TRAVEL_FFMPEG_PATH || (existsSync(local) ? local : 'ffmpeg');
}

async function renderPreview(source, ffmpegPath) {
    const { stdout } = await execute(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
        '-protocol_whitelist', 'file,pipe',
        '-format_whitelist', 'jpeg_pipe,png_pipe,webp_pipe,gif,mov,matroska,webm,ogg',
        '-i', source, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn',
        '-vf', "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease,setsar=1",
        '-threads', '1', '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'
    ], { encoding: 'buffer', timeout: 20000, maxBuffer: MAXIMUM_PREVIEW_BYTES, windowsHide: true });
    if (!stdout.length) throw failure(422, '无法生成媒体预览。');
    return stdout;
}

function createMediaPreviewStore(root, options = {}) {
    const pending = new Map();
    const waiting = [];
    let active = 0;
    const render = options.render || (source => renderPreview(source, options.ffmpegPath || findFfmpeg(root)));

    async function generate(source, destination, signature) {
        if (active >= 2) await new Promise(resolve => waiting.push(resolve));
        active += 1;
        try {
            const image = await render(source);
            if (!Buffer.isBuffer(image) || image.length > MAXIMUM_PREVIEW_BYTES || image[0] !== 0xff || image[1] !== 0xd8) {
                throw failure(422, '媒体预览不是有效的 JPEG。');
            }
            if (fingerprint(await fs.stat(source)) !== signature) throw failure(409, '媒体已更新，请重试。');
            const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
            try {
                await fs.writeFile(temporary, image, { flag: 'wx' });
                await fs.rename(temporary, destination);
                await fs.writeFile(`${destination}.json`, JSON.stringify({ signature }));
            } finally { await fs.unlink(temporary).catch(() => {}); }
            return image;
        } finally {
            active -= 1;
            waiting.shift()?.();
        }
    }

    return async function getPreview(urlPath) {
        const relativeSource = sourceForPreview(urlPath);
        if (!relativeSource) throw failure(400, '无效的媒体预览路径。');
        const source = await safePath(root, relativeSource);
        const signature = fingerprint(await fs.stat(source));
        const destination = await safePath(root, urlPath.slice(1), true);
        const metadata = await safePath(root, `${urlPath.slice(1)}.json`, true);
        const etag = `"${createHash('sha256').update(relativeSource + signature).digest('hex')}"`;
        try {
            if (JSON.parse(await fs.readFile(metadata, 'utf8')).signature === signature) {
                const stat = await fs.stat(destination);
                if (stat.size <= MAXIMUM_PREVIEW_BYTES) return { image: await fs.readFile(destination), etag };
            }
        } catch (error) {
            if (!['ENOENT', undefined].includes(error.code)) throw error;
        }
        if (!pending.has(destination)) {
            if (pending.size >= 64) throw failure(503, '媒体预览繁忙，请稍后重试。');
            pending.set(destination, generate(source, destination, signature).finally(() => pending.delete(destination)));
        }
        try { return { image: await pending.get(destination), etag }; }
        catch (error) {
            if (error.status) throw error;
            throw failure(503, '无法生成预览，请检查 FFmpeg 配置和媒体编码。');
        }
    };
}

module.exports = { createMediaPreviewStore, sourceForPreview, findFfmpeg };
