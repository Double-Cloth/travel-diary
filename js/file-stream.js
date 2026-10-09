const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

async function fileSource(file, start = 0, size = null) {
    const { ByteSource, ZIP_CHUNK_BYTES, updateCrc } = await import('./zip-stream.mjs');
    if (size === null) size = (await fsp.stat(file)).size;
    const source = new ByteSource(size, async (offset, length) => {
        const handle = await fsp.open(file, 'r');
        try {
            const bytes = Buffer.alloc(length);
            let read = 0;
            while (read < length) {
                const result = await handle.read(bytes, read, length - read, start + offset + read);
                if (!result.bytesRead) throw new Error('文件读取不完整。');
                read += result.bytesRead;
            }
            return bytes;
        } finally { await handle.close(); }
    });
    source.slice = (offset, length) => {
        const part = new ByteSource(length, (position, count) => source.read(offset + position, count));
        part.chunks = () => chunks(part, start + offset);
        return part;
    };
    async function* chunks(part, offset) {
        let crc = 0xffffffff;
        if (part.size) {
            const stream = fs.createReadStream(file, { start: offset, end: offset + part.size - 1, highWaterMark: ZIP_CHUNK_BYTES });
            let bytesRead = 0;
            for await (const bytes of stream) {
                bytesRead += bytes.length;
                if (part.checksum !== undefined) crc = updateCrc(crc, bytes);
                yield bytes;
            }
            if (bytesRead !== part.size) throw new Error('文件读取不完整。');
        }
        if (part.checksum !== undefined && ((crc ^ 0xffffffff) >>> 0) !== part.checksum) throw Object.assign(new Error('ZIP 文件校验失败。'), { status: 400 });
    }
    source.chunks = () => chunks(source, start);
    return source;
}

async function writeSource(file, source) {
    const { sourceOf } = await import('./zip-stream.mjs');
    source = sourceOf(source);
    await pipeline(Readable.from(source.chunks()), fs.createWriteStream(file, { flags: 'wx' }));
}

// 请求先落到项目内独占临时文件；成功、校验失败与断线都由调用方清理。
async function receiveArchive(root, request, maximumBytes) {
    const file = path.join(root, `.travel-upload-${randomBytes(16).toString('hex')}.tmp`);
    const handle = await fsp.open(file, 'wx', 0o600);
    let bytes = 0;
    const limiter = new Transform({
        transform(chunk, encoding, callback) {
            bytes += chunk.length;
            callback(bytes > maximumBytes ? Object.assign(new Error('请求内容过大。'), { status: 413 }) : null, chunk);
        }
    });
    try {
        // 不把 IncomingMessage 放入 pipeline，超限时仍可返回明确的 413。
        const input = Readable.from(request.iterator({ destroyOnReturn: false }));
        await pipeline(input, limiter, handle.createWriteStream());
        await handle.close();
        return { source: await fileSource(file), cleanup: () => fsp.unlink(file).catch(() => {}) };
    } catch (error) {
        await handle.close().catch(() => {});
        await fsp.unlink(file).catch(() => {});
        throw error;
    }
}

module.exports = { fileSource, writeSource, receiveArchive };
