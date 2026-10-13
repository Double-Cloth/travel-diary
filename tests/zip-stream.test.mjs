import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { createZip } from './helpers/zip-archive.mjs';
import { ByteSource, ZIP_CHUNK_BYTES, createZipStream, createZipBlob, readZipSource, readSourceText, sourceOf, zipStreamSize } from '../js/zip-stream.mjs';
import { createDraftBlob, readRecordSource } from '../js/draft-archive.mjs';
import { installAuth } from './helpers/auth.mjs';

const require = createRequire(import.meta.url);
const { receiveArchive, fileSource } = require('../js/file-stream.js');
const { importDataArchive, exportDataArchive } = require('../js/data-archive.js');

async function collect(stream) {
    const parts = [];
    for await (const chunk of stream) parts.push(chunk);
    return Buffer.concat(parts);
}

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-diary-stream-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');
    await installAuth(root);
    return root;
}

test('ZIP64 流与 Blob 包含正确 CRC、长度和数据描述符，并兼容旧 ZIP', async () => {
    const entries = [{ name: '清单.json', data: '记录内容' }, { name: 'media/video.mp4', data: Uint8Array.of(1, 2, 3) }];
    const streamed = await collect(createZipStream(entries));
    assert.equal(streamed.length, zipStreamSize(entries));
    const blob = await createZipBlob(entries);
    for (const archive of [streamed, blob, createZip(entries)]) {
        const parsed = await readZipSource(archive);
        assert.deepEqual(parsed.map(entry => entry.name), entries.map(entry => entry.name));
        assert.equal(new TextDecoder().decode(await readSourceText(parsed[0].data)), '记录内容');
        assert.deepEqual(await collect(parsed[1].data.chunks()), Buffer.from([1, 2, 3]));
    }
});

test('随机读取解析跨越 4 GiB 与 40 GiB 的条目和目录，不分配巨大缓冲区', async () => {
    const template = await collect(createZipStream([{ name: 'video.mp4', data: Uint8Array.of(7) }]));
    const dataStart = 30 + 9 + 20;
    for (const size of [0xffffffff, 4 * 1024 ** 3 + 1, 40 * 1024 ** 3]) {
        const suffix = Buffer.from(template.subarray(dataStart + 1));
        const suffixView = new DataView(suffix.buffer, suffix.byteOffset, suffix.length);
        const centralStart = dataStart + size + 24;
        // 描述符、中央目录扩展字段及 ZIP64 尾部使用真正的 64 位大小与偏移。
        suffixView.setBigUint64(8, BigInt(size), true);
        suffixView.setBigUint64(16, BigInt(size), true);
        const extra = 24 + 46 + 9 + 4;
        suffixView.setBigUint64(extra, BigInt(size), true);
        suffixView.setBigUint64(extra + 8, BigInt(size), true);
        const zip64 = 24 + 46 + 9 + 28;
        suffixView.setBigUint64(zip64 + 48, BigInt(centralStart), true);
        // 定位记录指向 ZIP64 结束记录。
        suffixView.setBigUint64(zip64 + 56 + 8, BigInt(dataStart + size + zip64), true);
        const prefix = Buffer.from(template.subarray(0, dataStart));
        const prefixView = new DataView(prefix.buffer, prefix.byteOffset, prefix.length);
        prefixView.setBigUint64(30 + 9 + 4, BigInt(size), true);
        prefixView.setBigUint64(30 + 9 + 12, BigInt(size), true);
        let largestRead = 0;
        const source = new ByteSource(dataStart + size + suffix.length, async (offset, length) => {
            largestRead = Math.max(largestRead, length);
            const bytes = new Uint8Array(length);
            for (const [position, segment] of [[0, prefix], [dataStart + size, suffix]]) {
                const first = Math.max(position, offset);
                const end = Math.min(position + segment.length, offset + length);
                if (end > first) bytes.set(segment.subarray(first - position, end - position), first - offset);
            }
            return bytes;
        });
        const parsed = await readZipSource(source);
        assert.equal(parsed[0].data.size, size);
        assert.ok(largestRead <= 65557);
    }
});

test('源按 1 MiB 分块，迭代取消后不继续读取完整媒体', async () => {
    let reads = 0;
    const source = new ByteSource(32 * 1024 ** 3, async (offset, length) => {
        reads += 1;
        assert.ok(length <= ZIP_CHUNK_BYTES);
        return new Uint8Array(length);
    });
    const stream = createZipStream([{ name: 'video.mp4', data: source }]);
    for (let index = 0; index < 4; index += 1) await stream.next();
    await stream.return();
    assert.equal(reads, 1);
});

test('ZIP64 拒绝不安全数值、损坏定位、本地头和描述符，文本限制在读取前生效', async () => {
    const original = await collect(createZipStream([{ name: 'file.txt', data: '内容' }]));
    const dataStart = 30 + 8 + 20;
    const descriptor = dataStart + Buffer.byteLength('内容');
    const central = descriptor + 24;
    const mutations = [
        view => view.setUint32(14, 12345, true),
        view => view.setUint32(descriptor + 4, 12345, true),
        view => view.setBigUint64(central + 46 + 8 + 4, 2n ** 53n, true),
        view => view.setUint32(original.length - 22 - 20, 0, true),
        view => view.setUint32(central + 34, 1, true),
        view => view.setUint16(central + 10, 8, true)
    ];
    for (const mutate of mutations) {
        const archive = Buffer.from(original);
        mutate(new DataView(archive.buffer, archive.byteOffset, archive.length));
        await assert.rejects(readZipSource(archive), /ZIP/);
    }
    const text = new ByteSource(16 * 1024 ** 2 + 1, async () => { throw new Error('不应读取'); });
    await assert.rejects(readSourceText(text), /16 MiB/);
});

test('流式导入拒绝损坏 CRC，保持原数据和认证并清理暂存目录', async t => {
    const root = await fixture(t);
    const archive = await collect(createZipStream([
        { name: 'data/travel_data.json', data: '[]' },
        { name: 'data/videos/video.mp4', data: Uint8Array.of(1, 2, 3, 4) }
    ]));
    const second = archive.indexOf(Buffer.from('data/videos/video.mp4'));
    archive[second + 'data/videos/video.mp4'.length + 20] ^= 255;
    await assert.rejects(importDataArchive(root, archive), /校验失败/);
    assert.equal(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'), '[]');
    assert.deepEqual((await fs.readdir(root)).sort(), ['.secrets', 'data']);
});

test('临时上传超限和断线后删除文件，成功上传可随机读取与清理', async t => {
    const root = await fixture(t);
    const received = await receiveArchive(root, Readable.from([Buffer.from('abc')]), 3);
    assert.equal(Buffer.from(await received.source.read(1, 2)).toString(), 'bc');
    await received.cleanup();
    await assert.rejects(receiveArchive(root, Readable.from([Buffer.from('abcd')]), 3), error => error.status === 413);
    async function* interrupted() { yield Buffer.from('abc'); throw new Error('连接中断'); }
    await assert.rejects(receiveArchive(root, Readable.from(interrupted()), 10), /连接中断/);
    assert.deepEqual((await fs.readdir(root)).sort(), ['.secrets', 'data']);
});

test('没有 Content-Length 的 HTTP 上传超限时仍可返回 413 并清理文件', async t => {
    const root = await fixture(t);
    const server = http.createServer(async (request, response) => {
        try {
            const archive = await receiveArchive(root, request, 3);
            await archive.cleanup();
            response.end('成功');
        } catch (error) {
            response.writeHead(error.status || 500, { Connection: 'close' });
            response.end(error.message);
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const status = await new Promise((resolve, reject) => {
        const request = http.request(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject);
        request.end('abcd');
    });
    assert.equal(status, 413);
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.travel-upload-')), false);
});

test('导出持有数据锁直至完成或取消，HEAD 准备不读取媒体内容', async t => {
    const root = await fixture(t);
    const handle = await fs.open(path.join(root, 'data/large.mp4'), 'w');
    await handle.truncate(5 * 1024 ** 3);
    await handle.close();
    const archive = await exportDataArchive(root);
    assert.ok(archive.size > 5 * 1024 ** 3);
    await assert.rejects(exportDataArchive(root), error => error.status === 409);
    await archive.release();
    const next = await exportDataArchive(root);
    await next.release();
    assert.equal((await fileSource(path.join(root, 'data/large.mp4'))).size, 5 * 1024 ** 3);
});

test('草稿 Blob 保留媒体源、修改快照与进度，导入分块校验 CRC', async () => {
    const data = sourceOf(new Blob([Buffer.from('\0\0\0\x18ftypisom', 'binary'), new Uint8Array(2 * ZIP_CHUNK_BYTES)]));
    data.head = await data.read(0, 12);
    let progress = 0;
    const draft = {
        format: 'travel-diary-draft-v4', requestId: 'a'.repeat(32),
        input: { date: '2026-10-09', country: '中国', country_code: 'CN', locality: '苏州', title: '旅途', body: '', admin_area: '', admin_area_type: '', locality_type: '', trip_id: '', desc_md: '', photo_folder: '', photos: [], video_folder: '', videos: [] },
        uploads: [{ id: 'b'.repeat(32), name: 'movie.mp4', data }]
    };
    const blob = await createDraftBlob(draft, { originalDescMd: 'old.md', expected: { markdown: '原文' } }, bytes => { progress = bytes; });
    const result = await readRecordSource(blob, { verifyMedia: true });
    assert.equal(result.originalDescMd, 'old.md');
    assert.equal(result.expected.markdown, '原文');
    assert.equal(result.draft.uploads[0].data.size, data.size);
    assert.ok(result.draft.uploads[0].data.blob instanceof Blob);
    assert.ok(progress >= data.size);
    // 未改变的 Blob 再次打包复用校验结果，不重新扫描媒体。
    const read = data.read;
    data.read = async () => { throw new Error('重复打包不应读取完整媒体'); };
    const repeated = await createDraftBlob(draft);
    assert.ok(repeated.size > data.size);
    data.read = read;
});
