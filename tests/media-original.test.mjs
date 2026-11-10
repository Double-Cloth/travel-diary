import test from 'node:test';
import assert from 'node:assert/strict';

let moduleId = 0;
const imageResponse = () => new Response(new Blob(['original'], { type: 'image/jpeg' }));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function originalModule(t, fetch) {
    t.mock.method(globalThis, 'fetch', fetch);
    const module = await import(`../js/media-original.mjs?original-test=${++moduleId}`);
    t.after(() => module.clearOriginalImageCache());
    return module;
}

test('打开原图后缓存 Blob 与 URL，重复查看与并发打开共用一次读取', async t => {
    const calls = [];
    const original = await originalModule(t, async source => { calls.push(source); return imageResponse(); });
    assert.deepEqual(calls, []);
    const first = { isConnected: true }, second = { isConnected: true };
    await Promise.all([original.loadOriginalImage(first, '/first.jpg'), original.loadOriginalImage(second, '/first.jpg')]);
    assert.match(first.src, /^blob:/);
    assert.equal(second.src, first.src);
    assert.equal(await (await fetchBlob(first.src)).text(), 'original');
    await original.loadOriginalImage({ isConnected: true }, '/first.jpg');
    assert.deepEqual(calls, ['/first.jpg']);
});

// 保留原生 fetch，以核对缓存 URL 实际持有的原图内容。
const fetchBlob = globalThis.fetch.bind(globalThis);

test('原图独立按最近使用顺序保留 32 张，淘汰与清空释放 URL', async t => {
    const calls = [], revoked = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    t.mock.method(URL, 'revokeObjectURL', url => { revoked.push(url); revoke(url); });
    const original = await originalModule(t, async source => { calls.push(source); return imageResponse(); });
    const images = Array.from({ length: 33 }, () => ({ isConnected: true }));
    for (let index = 0; index < 32; index++) await original.loadOriginalImage(images[index], `/${index}.jpg`);
    await original.loadOriginalImage({ isConnected: true }, '/0.jpg');
    await original.loadOriginalImage(images[32], '/32.jpg');
    assert.deepEqual(revoked, [images[1].src]);
    await original.loadOriginalImage({ isConnected: true }, '/0.jpg');
    assert.equal(calls.length, 33);
    await original.loadOriginalImage({ isConnected: true }, '/1.jpg');
    assert.equal(calls.length, 34);
    original.clearOriginalImageCache();
    assert.equal(revoked.length, 34);
    const again = { isConnected: true };
    await original.loadOriginalImage(again, '/0.jpg');
    assert.notEqual(again.src, images[0].src);
    assert.equal(calls.length, 35);
});

test('128 MiB 容量淘汰最久未用原图，超大图片直接显示并保留现有缓存', async t => {
    const calls = [];
    const original = await originalModule(t, async source => {
        calls.push(source);
        const blob = new Blob(['original']);
        Object.defineProperty(blob, 'size', { value: source === '/oversized.jpg' ? 129 * 1024 ** 2 : 64 * 1024 ** 2 });
        return { ok: true, headers: new Headers(), blob: async () => blob };
    });
    for (const source of ['/0.jpg', '/1.jpg', '/0.jpg', '/2.jpg', '/0.jpg']) {
        await original.loadOriginalImage({ isConnected: true }, source);
    }
    assert.equal(calls.length, 3);
    const oversized = { isConnected: true };
    await original.loadOriginalImage(oversized, '/oversized.jpg');
    assert.equal(oversized.src, '/oversized.jpg');
    await original.loadOriginalImage({ isConnected: true }, '/0.jpg');
    assert.equal(calls.length, 4);
    await original.loadOriginalImage({ isConnected: true }, '/1.jpg');
    assert.equal(calls.length, 5);
});

test('声明超大原图不读取 Blob，本地临时地址不重复读取', async t => {
    const original = await originalModule(t, async () => ({
        ok: true, headers: new Headers({ 'Content-Length': String(129 * 1024 ** 2) }),
        blob() { assert.fail('不应读取超大原图 Blob'); }
    }));
    const image = { isConnected: true };
    await original.loadOriginalImage(image, '/large.jpg');
    assert.equal(image.src, '/large.jpg');
    globalThis.fetch = () => assert.fail('本地临时地址不发请求');
    await original.loadOriginalImage(image, 'blob:pending-upload');
    assert.equal(image.src, 'blob:pending-upload');
});

test('读取失败回退原地址，同一节点再次打开可以重试', async t => {
    let calls = 0;
    const original = await originalModule(t, async () => ++calls === 1 ? new Response(null, { status: 503 }) : imageResponse());
    const image = { isConnected: true };
    await original.loadOriginalImage(image, '/retry.jpg');
    assert.equal(image.src, '/retry.jpg');
    await original.loadOriginalImage(image, '/retry.jpg');
    assert.match(image.src, /^blob:/);
    assert.equal(calls, 2);
});

test('缓存失效后旧请求不能覆盖新缓存，也不能回写旧节点', async t => {
    let finish;
    const original = await originalModule(t, () => new Promise(resolve => { finish = resolve; }));
    const oldImage = { isConnected: true };
    const old = original.loadOriginalImage(oldImage, '/changed.jpg');
    original.clearOriginalImageCache();
    globalThis.fetch = async () => imageResponse();
    const current = { isConnected: true };
    await original.loadOriginalImage(current, '/changed.jpg');
    finish(imageResponse());
    await old;
    const again = { isConnected: true };
    await original.loadOriginalImage(again, '/changed.jpg');
    assert.equal(again.src, current.src);
    assert.equal(oldImage.src, undefined);
});

test('快速切换与关闭后，延迟返回的原图不改写新图片或已移除节点', async t => {
    const finish = new Map();
    const original = await originalModule(t, source => new Promise(resolve => { finish.set(source, resolve); }));
    const image = { isConnected: true }, removed = { isConnected: true };
    const first = original.loadOriginalImage(image, '/first.jpg');
    const second = original.loadOriginalImage(image, '/second.jpg');
    const closed = original.loadOriginalImage(removed, '/removed.jpg');
    removed.isConnected = false;
    finish.get('/second.jpg')(imageResponse());
    await second;
    const current = image.src;
    finish.get('/first.jpg')(imageResponse());
    finish.get('/removed.jpg')(imageResponse());
    await Promise.all([first, closed]);
    assert.equal(image.src, current);
    assert.equal(removed.src, undefined);
    await tick();
});
