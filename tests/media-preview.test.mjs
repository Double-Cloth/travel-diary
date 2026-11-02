import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createMediaPreviewStore, sourceForPreview, isPreviewJpeg } from '../js/media-preview-store.js';
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

// 最小尺寸头用于验证服务端的格式与尺寸边界，真实解码另由浏览器验证。
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xd9]);
const previewPath = '/.cache/media-previews/photos/trip/image.png.jpg';

test('预览放到 .cache，保留扩展名与 URL 编码并拒绝路径穿越', () => {
    assert.equal(getMediaPreviewUrl('data/photos/trip/a%20b.png'), '.cache/media-previews/photos/trip/a%20b.png.jpg');
    assert.equal(getMediaPreviewUrl('blob:local'), '');
    assert.equal(sourceForPreview(previewPath), 'data/photos/trip/image.png');
    for (const value of ['/.cache/media-previews/photos/../secret.png.jpg', '/.cache/media-previews/videos/a\\b.mp4.jpg',
        '/.cache/media-previews/photos/x.txt.jpg', '/.cache/media-previews/profile/a.png.jpg']) assert.equal(sourceForPreview(value), null);
});

test('缓存缺失不读取原文件，保存后跨实例复用，源变更拒绝旧预览', async t => {
    const root = await fixture(t);
    const store = createMediaPreviewStore(root);
    const empty = await store.get(previewPath);
    assert.equal(empty.image, null);
    await Promise.all(Array.from({ length: 8 }, () => store.put(previewPath, jpeg, empty.etag)));
    const cached = await createMediaPreviewStore(root).get(previewPath);
    assert.deepEqual(cached.image, jpeg);
    assert.equal(cached.etag, empty.etag);
    assert.deepEqual(await readFile(path.join(root, previewPath)), jpeg);
    await assert.rejects(access(path.join(root, 'data/previews')), { code: 'ENOENT' });
    await writeFile(path.join(root, 'data/photos/trip/image.png'), 'updated-original');
    const updated = await store.get(previewPath);
    assert.equal(updated.image, null);
    assert.notEqual(updated.etag, cached.etag);
    await assert.rejects(store.put(previewPath, jpeg, cached.etag), { status: 409 });
    await store.put(previewPath, jpeg, updated.etag);
    assert.equal(await readFile(path.join(root, 'data/photos/trip/image.png'), 'utf8'), 'updated-original');
});

test('拒绝超大、非 JPEG 和过大尺寸的缓存，拒绝链接目录', async t => {
    const root = await fixture(t);
    const store = createMediaPreviewStore(root);
    assert.equal(isPreviewJpeg(jpeg), true);
    const oversized = Buffer.from(jpeg);
    oversized.writeUInt16BE(641, 9);
    for (const image of [oversized, Buffer.alloc(2 * 1024 * 1024 + 1), Buffer.from('not jpeg')]) {
        await assert.rejects(store.put(previewPath, image, ''), { status: 422 });
    }
    await assert.rejects(store.get('/.cache/media-previews/photos/trip/missing.png.jpg'), { code: 'ENOENT' });
    await mkdir(path.join(root, '.cache'));
    await symlink(path.join(root, 'data'), path.join(root, '.cache/media-previews'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.get(previewPath), { status: 403 });
    await assert.rejects(store.put(previewPath, jpeg, ''), { status: 403 });
});

test('HTTP 自动缓存接口只接受同源小型预览，支持 ETag、HEAD 和源文件失效', async t => {
    const root = await fixture(t);
    await mkdir(path.join(root, 'data/videos/trip'), { recursive: true });
    await writeFile(path.join(root, 'data/videos/trip/video.mp4'), '0123456789');
    const server = http.createServer(createHandler(root));
    const base = await listenOnFetchSafePort(server);
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const missing = await fetch(base + previewPath);
    assert.equal(missing.status, 204);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    const headers = { Origin: base, 'Content-Type': 'image/jpeg', 'If-Match': missing.headers.get('etag') };
    const put = (extra = {}, body = jpeg) => fetch(base + previewPath, { method: 'PUT', headers: { ...headers, ...extra }, body });
    assert.equal((await put({ Origin: 'https://example.org' })).status, 403);
    assert.equal((await put({ 'Content-Type': 'text/html' })).status, 415);
    assert.equal((await put({ 'If-Match': 'stale' })).status, 409);
    assert.equal((await put({}, Buffer.from('invalid'))).status, 422);
    assert.equal((await put()).status, 204);
    const response = await fetch(base + previewPath);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
    assert.equal((await fetch(base + previewPath, { headers: { 'If-None-Match': response.headers.get('etag') } })).status, 304);
    const head = await fetch(base + previewPath, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(jpeg.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    await writeFile(path.join(root, 'data/photos/trip/image.png'), 'updated-original');
    assert.equal((await fetch(base + previewPath)).status, 204);
    assert.equal((await fetch(base + '/.cache/tools/private.txt')).status, 403);
    const video = await fetch(base + '/data/videos/trip/video.mp4', { headers: { Range: 'bytes=3-5' } });
    assert.equal(video.status, 206);
    assert.equal(await video.text(), '345');
});
