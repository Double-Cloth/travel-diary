const fs = require('fs/promises');
const path = require('path');
const { createHash, randomBytes } = require('crypto');
const MAXIMUM_PREVIEW_BYTES = 2 * 1024 * 1024;

function failure(status, message) {
    return Object.assign(new Error(message), { status });
}

function sourceForPreview(urlPath) {
    const match = /^\/\.cache\/media-previews\/(photos|videos)\/(.+)\.jpg$/.exec(urlPath);
    if (!match || !/\.(jpe?g|png|gif|webp|mp4|m4v|mov|webm|ogv|ogg)$/i.test(match[2])) return null;
    const source = `data/${match[1]}/${match[2]}`;
    if (/[\u0000-\u001f\u007f\\:]/.test(source)
        || !source.split('/').every(part => part && !part.startsWith('.') && !/[. ]$/.test(part))) return null;
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
    return `canvas-640-v1:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function isPreviewJpeg(image) {
    if (!Buffer.isBuffer(image) || image.length > MAXIMUM_PREVIEW_BYTES
        || image[0] !== 0xff || image[1] !== 0xd8
        || image.at(-2) !== 0xff || image.at(-1) !== 0xd9) return false;
    let offset = 2;
    while (offset + 4 < image.length) {
        if (image[offset++] !== 0xff) return false;
        const marker = image[offset++];
        const length = image.readUInt16BE(offset);
        if (length < 2 || offset + length > image.length) return false;
        if (marker === 0xc0 || marker === 0xc2) {
            if (length < 8) return false;
            const height = image.readUInt16BE(offset + 3);
            const width = image.readUInt16BE(offset + 5);
            return width > 0 && height > 0 && width <= 640 && height <= 640;
        }
        if (marker === 0xda) return false;
        offset += length;
    }
    return false;
}

function createMediaPreviewStore(root) {
    const pending = new Map();
    async function locate(urlPath, createParents = false) {
        const relativeSource = sourceForPreview(urlPath);
        if (!relativeSource) throw failure(400, '无效的媒体预览路径。');
        const source = await safePath(root, relativeSource);
        const signature = fingerprint(await fs.stat(source));
        const etag = `"${createHash('sha256').update(relativeSource + signature).digest('hex')}"`;
        return { source, signature, etag, destination: createParents
            ? await safePath(root, urlPath.slice(1), true) : null };
    }
    return {
      async get(urlPath) {
        const { signature, etag } = await locate(urlPath);
        try {
            const metadata = await safePath(root, `${urlPath.slice(1)}.json`);
            if ((await fs.stat(metadata)).size <= 4096 && JSON.parse(await fs.readFile(metadata, 'utf8'))?.signature === signature) {
                const destination = await safePath(root, urlPath.slice(1));
                const stat = await fs.stat(destination);
                if (stat.size <= MAXIMUM_PREVIEW_BYTES) {
                    const image = await fs.readFile(destination);
                    if (isPreviewJpeg(image)) return { image, etag };
                }
            }
        } catch (error) {
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        return { image: null, etag };
      },
      async put(urlPath, image, expectedEtag) {
        if (!isPreviewJpeg(image)) throw failure(422, '预览必须为最长边不超过 640px 的 JPEG。');
        if (pending.has(urlPath)) {
            await pending.get(urlPath);
            if ((await locate(urlPath)).etag !== expectedEtag) throw failure(409, '媒体已更新，请重新生成预览。');
            return;
        }
        if (pending.size >= 16) throw failure(503, '媒体预览繁忙，请稍后重试。');
        const task = (async () => {
            const { source, signature, etag, destination } = await locate(urlPath, true);
            if (expectedEtag !== etag) throw failure(409, '媒体已更新，请重新生成预览。');
            const metadata = await safePath(root, `${urlPath.slice(1)}.json`, true);
            const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
            try {
                await fs.writeFile(temporary, image, { flag: 'wx' });
                if (fingerprint(await fs.stat(source)) !== signature) throw failure(409, '媒体已更新，请重试。');
                await fs.rename(temporary, destination);
                await fs.writeFile(metadata, JSON.stringify({ signature }));
            } finally { await fs.unlink(temporary).catch(() => {}); }
        })();
        pending.set(urlPath, task);
        try { await task; } finally { pending.delete(urlPath); }
      }
    };
}

module.exports = { createMediaPreviewStore, sourceForPreview, isPreviewJpeg, MAXIMUM_PREVIEW_BYTES };
