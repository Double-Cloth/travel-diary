import test from 'node:test';
import assert from 'node:assert/strict';

let moduleId = 0;
async function previewModule(t, overrides = {}) {
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, globalThis[key]]));
    Object.assign(globalThis, overrides);
    const module = await import(`../js/media-preview.mjs?lazy-test=${++moduleId}`);
    t.after(() => { module.clearMediaPreviewCache(); Object.assign(globalThis, previous); });
    return module;
}

const imageResponse = () => new Response(new Blob(['thumbnail'], { type: 'image/jpeg' }), { headers: { 'Content-Type': 'image/jpeg' } });
const hostResponse = () => new Response(null, { headers: { 'X-Travel-Media-Cache': 'disk-v1' } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('重新挂载缩略图复用 Blob URL，清空缓存后重新读取，同一图片不会重复设置 src', async t => {
    const calls = [];
    const preview = await previewModule(t, { fetch: async url => { calls.push(url); return url === 'index.html' ? hostResponse() : imageResponse(); } });
    const first = { isConnected: true }, second = { isConnected: true };
    const source = 'data/photos/trip/reused.png';
    await preview.loadMediaPreview(first, source, 'image');
    await preview.loadMediaPreview(second, source, 'image');
    assert.equal(first.src, second.src);
    assert.equal(calls.length, 2, '仅主机探测和首次缩略图读取');
    first.src = 'unchanged';
    await preview.loadMediaPreview(first, source, 'image');
    assert.equal(first.src, 'unchanged');
    preview.clearMediaPreviewCache();
    await preview.loadMediaPreview(first, source, 'image');
    assert.notEqual(first.src, second.src);
    assert.equal(calls.length, 3);
});

test('排队期间离开视口的预览不发请求，另一个可见使用者仍可共享同一路径', async t => {
    const calls = [], finish = [];
    const preview = await previewModule(t, { fetch: async url => {
        if (url === 'index.html') return hostResponse();
        calls.push(url);
        if (calls.length <= 2) return new Promise(resolve => finish.push(() => resolve(imageResponse())));
        return imageResponse();
    } });
    const first = preview.getMediaPreviewBlob('data/photos/trip/first.png', 'image');
    const second = preview.getMediaPreviewBlob('data/photos/trip/second.png', 'image');
    await tick();
    let visible = true;
    const skipped = preview.getMediaPreviewBlob('data/photos/trip/skipped.png', 'image', () => visible);
    const shared = preview.getMediaPreviewBlob('data/photos/trip/shared.png', 'image', () => false);
    const needed = preview.getMediaPreviewBlob('data/photos/trip/shared.png', 'image', () => true);
    visible = false;
    const rejected = assert.rejects(skipped, { name: 'AbortError' });
    finish.forEach(resolve => resolve());
    await Promise.all([first, second, rejected]);
    assert.equal(await shared, await needed);
    assert.equal(calls.some(url => url.includes('skipped')), false);
    assert.equal(calls.filter(url => url.includes('shared')).length, 1);
    await preview.getMediaPreviewBlob('data/photos/trip/skipped.png', 'image');
    assert.equal(calls.filter(url => url.includes('skipped')).length, 1, '取消后再次显示仍能读取');
});

test('容量限制按最近使用顺序淘汰，失败请求可以重试，保存新缩略图替换内存旧值', async t => {
    const calls = [];
    const preview = await previewModule(t, { fetch: async (url, options) => {
        if (url === 'index.html') return hostResponse();
        calls.push(url);
        if (options.method === 'HEAD' || options.method === 'PUT') return new Response(null, { status: 204 });
        return imageResponse();
    } });
    const source = index => `data/photos/trip/${index}.png`;
    for (let index = 0; index < 256; index++) await preview.getMediaPreviewBlob(source(index), 'image');
    await preview.getMediaPreviewBlob(source(0), 'image');
    await preview.getMediaPreviewBlob(source(256), 'image');
    const count = calls.length;
    await preview.getMediaPreviewBlob(source(0), 'image');
    assert.equal(calls.length, count, '最近访问的缩略图保留');
    await preview.getMediaPreviewBlob(source(1), 'image');
    assert.equal(calls.length, count + 1, '最久未用的缩略图重新读取');
    const saved = new Blob(['updated'], { type: 'image/jpeg' });
    await preview.saveMediaPreview(source(0), saved);
    assert.equal(await preview.getMediaPreviewBlob(source(0), 'image'), saved);
    globalThis.fetch = async () => new Response(null, { status: 503 });
    await assert.rejects(preview.getMediaPreviewBlob(source('failure'), 'image'));
    globalThis.fetch = async () => imageResponse();
    assert.equal((await preview.getMediaPreviewBlob(source('failure'), 'image')).size, 9);
});

test('缓存失效期间完成的旧请求不会覆盖新一轮缩略图', async t => {
    let finish;
    const preview = await previewModule(t, { fetch: async url => url === 'index.html' ? hostResponse() : new Promise(resolve => { finish = resolve; }) });
    const source = 'data/photos/trip/changed.png';
    const old = preview.getMediaPreviewBlob(source, 'image');
    await tick();
    preview.clearMediaPreviewCache();
    globalThis.fetch = async () => new Response(new Blob(['updated']), { headers: { 'Content-Type': 'image/jpeg' } });
    const updated = await preview.getMediaPreviewBlob(source, 'image');
    finish(imageResponse());
    await old;
    assert.equal(await preview.getMediaPreviewBlob(source, 'image'), updated);
});

test('缩略图缓存检查期间离开视口时，不继续下载原文件生成预览', async t => {
    let visible = true;
    const preview = await previewModule(t, {
        fetch: async url => {
            if (url === 'index.html') return hostResponse();
            visible = false;
            return new Response(null, { status: 204 });
        },
        document: { createElement() { assert.fail('屏外媒体不应读取原文件'); } }
    });
    await assert.rejects(preview.getMediaPreviewBlob('data/photos/trip/no-longer-visible.png', 'image', () => visible), { name: 'AbortError' });
});

test('可见性同时考虑屏幕边界、隐藏祖先和滚动容器裁切', async t => {
    const preview = await previewModule(t, { innerWidth: 1200, innerHeight: 800, getComputedStyle: node => node.style || {} });
    const target = { isConnected: true, closest: () => null,
        getBoundingClientRect: () => ({ width: 80, height: 60, top: 100, bottom: 160, left: 100, right: 180 }) };
    assert.equal(preview.isMediaPreviewVisible(target), true);
    target.parentElement = { style: { overflowY: 'auto' }, getBoundingClientRect: () => ({ top: 200, bottom: 400 }) };
    assert.equal(preview.isMediaPreviewVisible(target), false);
    target.parentElement.style = { visibility: 'hidden' };
    assert.equal(preview.isMediaPreviewVisible(target), false);
    target.parentElement = null;
    target.getBoundingClientRect = () => ({ width: 80, height: 60, top: 800, bottom: 860, left: 100, right: 180 });
    assert.equal(preview.isMediaPreviewVisible(target), false, '仅贴视口边缘不算显示');
    target.getBoundingClientRect = () => ({ width: 80, height: 60, top: 100, bottom: 160, left: 1200, right: 1280 });
    assert.equal(preview.isMediaPreviewVisible(target), false);
});

test('共用观察器只启动可见项，删除旧 DOM 后解除观察，空闲时释放观察器', async t => {
    const observers = [], mutations = [];
    const preview = await previewModule(t, {
        innerWidth: 1200, innerHeight: 800, document: { documentElement: {} },
        IntersectionObserver: class {
            constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
            observe(target) { this.targets.add(target); }
            unobserve(target) { this.targets.delete(target); }
            disconnect() { this.targets.clear(); this.stopped = true; }
        },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; mutations.push(this); }
            observe() {}
            disconnect() { this.stopped = true; }
        }
    });
    const target = { isConnected: true, getBoundingClientRect: () => ({ width: 80, height: 60, top: 900, bottom: 960 }) };
    let loads = 0;
    const stop = preview.observeMediaVisibility(target, () => loads++);
    const removed = { ...target };
    preview.observeMediaVisibility(removed, () => assert.fail('已移除的项目不应加载'));
    assert.equal(observers.length, 1);
    observers[0].callback([{ target, isIntersecting: true }]);
    assert.equal(loads, 0);
    removed.isConnected = false;
    mutations[0].callback();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(observers[0].targets.has(removed), false);
    target.getBoundingClientRect = () => ({ width: 80, height: 60, top: 100, bottom: 160 });
    observers[0].callback([{ target, isIntersecting: true }]);
    assert.equal(loads, 1);
    assert.equal(observers[0].stopped, true);
    assert.equal(mutations[0].stopped, true);
    stop();
});

test('不支持 IntersectionObserver 时仍等待滚动显示，不回退为全量加载', async t => {
    const events = new EventTarget();
    const preview = await previewModule(t, {
        IntersectionObserver: undefined, innerWidth: 1200, innerHeight: 800,
        addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events)
    });
    const target = { isConnected: true, getBoundingClientRect: () => ({ width: 80, height: 60, top: 900, bottom: 960 }) };
    let loads = 0;
    preview.observeMediaVisibility(target, () => loads++);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(loads, 0);
    target.getBoundingClientRect = () => ({ width: 80, height: 60, top: 100, bottom: 160 });
    events.dispatchEvent(new Event('scroll'));
    events.dispatchEvent(new Event('scroll'));
    assert.equal(loads, 1);
});

test('异步创建的列表项在挂载前不会被误清理，挂载后正常加载', async t => {
    const preview = await previewModule(t, { IntersectionObserver: undefined, innerWidth: 1200, innerHeight: 800 });
    const target = { isConnected: false, getBoundingClientRect: () => ({ width: 80, height: 60, top: 100, bottom: 160 }) };
    let loads = 0;
    preview.observeMediaVisibility(target, () => loads++);
    await Promise.resolve();
    target.isConnected = true;
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(loads, 1);
});
