import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createMediaPreviewStore, sourceForPreview } from '../js/media-preview-store.js';
import { createHandler } from '../js/server.js';
import { getMediaPreviewUrl } from '../js/media-preview.mjs';
import { listenOnFetchSafePort } from './helpers/http.mjs';

async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'travel-preview-'));
    t.after(async () => {
        if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('travel-preview-')) {
            await rm(root, { recursive: true, force: true });
        }
    });
    await mkdir(path.join(root, 'data/photos/trip'), { recursive: true });
    await writeFile(path.join(root, 'data/photos/trip/image.png'), 'original');
    return root;
}

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const previewPath = '/data/previews/photos/trip/image.png.jpg';

test('预览路径保留扩展名、编码和目录，拒绝外部地址与路径穿越', () => {
    assert.equal(getMediaPreviewUrl('data/photos/trip/a%20b.png'), 'data/previews/photos/trip/a%20b.png.jpg');
    assert.equal(getMediaPreviewUrl('blob:local'), '');
    assert.equal(sourceForPreview(previewPath), 'data/photos/trip/image.png');
    for (const value of ['/data/previews/photos/../secret.png.jpg', '/data/previews/videos/a\\b.mp4.jpg',
        '/data/previews/photos/x.txt.jpg', '/data/previews/profile/a.png.jpg']) assert.equal(sourceForPreview(value), null);
});

test('相同资源并发只生成一次，缓存跨实例复用且原文件变化后失效', async t => {
    const root = await fixture(t);
    let calls = 0;
    const options = { render: async () => { calls += 1; return jpeg; } };
    const getPreview = createMediaPreviewStore(root, options);
    const results = await Promise.all(Array.from({ length: 8 }, () => getPreview(previewPath)));
    assert.equal(calls, 1);
    assert.ok(results.every(result => result.image.equals(jpeg) && result.etag === results[0].etag));
    await createMediaPreviewStore(root, options)(previewPath);
    assert.equal(calls, 1);
    await writeFile(path.join(root, 'data/photos/trip/image.png'), 'updated-original');
    const updated = await getPreview(previewPath);
    assert.equal(calls, 2);
    assert.notEqual(updated.etag, results[0].etag);
    assert.equal(await readFile(path.join(root, 'data/photos/trip/image.png'), 'utf8'), 'updated-original');
});

test('原文件缺失、转码失败或预览目录为链接时不返回原文件', async t => {
    const root = await fixture(t);
    const getPreview = createMediaPreviewStore(root, { render: async () => { throw new Error('FFmpeg missing'); } });
    await assert.rejects(getPreview(previewPath), { status: 503 });
    await assert.rejects(getPreview('/data/previews/photos/trip/missing.png.jpg'), { code: 'ENOENT' });
    await rm(path.join(root, 'data/previews'), { recursive: true });
    await symlink(path.join(root, 'data/photos'), path.join(root, 'data/previews'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(getPreview(previewPath), { status: 403 });
});

test('HTTP 预览支持 ETag、HEAD，原视频保留分段读取', async t => {
    const root = await fixture(t);
    await mkdir(path.join(root, 'data/videos/trip'), { recursive: true });
    await writeFile(path.join(root, 'data/videos/trip/video.mp4'), '0123456789');
    const server = http.createServer(createHandler(root, { mediaPreview: { render: async () => jpeg } }));
    const base = await listenOnFetchSafePort(server);
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const response = await fetch(base + previewPath);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
    const cached = await fetch(base + previewPath, { headers: { 'If-None-Match': response.headers.get('etag') } });
    assert.equal(cached.status, 304);
    const head = await fetch(base + previewPath, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(jpeg.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const video = await fetch(base + '/data/videos/trip/video.mp4', { headers: { Range: 'bytes=3-5' } });
    assert.equal(video.status, 206);
    assert.equal(await video.text(), '345');
    const missing = await fetch(base + '/data/previews/videos/trip/missing.mp4.jpg');
    assert.equal(missing.status, 404);
});
