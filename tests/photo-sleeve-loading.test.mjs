import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

globalThis.document = { addEventListener() {} };
const app = await loadBrowserModule(new URL('../js/app.js', import.meta.url), `
export { renderPhotoSleeveItem, loadPhotoSleeveMedia, handleMediaLoadError, releasePhotoSleeveMedia };
`);
delete globalThis.document;

function fixture() {
    const classes = new Set();
    const button = {
        dataset: { mediaSrc: 'data/photos/trip/loading.jpg', mediaKind: 'image', mediaName: 'loading.jpg' },
        classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
        setAttribute() {}, querySelector: () => ({ removeAttribute() {} })
    };
    const image = Object.assign(new EventTarget(), {
        isConnected: true, dataset: { src: '.cache/media-previews/photos/trip/loading.jpg.jpg' },
        naturalWidth: 640, closest: selector => selector === '.photo-sleeve-button' ? button : null,
        matches: () => true,
        getBoundingClientRect: () => ({ width: 160, height: 120, top: 0, bottom: 120, left: 0, right: 160 })
    });
    return { image, button, classes };
}

test('相册缩略图保持占位，收到 Blob 后仍等解码完成才显示', async t => {
    const previousFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = previousFetch; });
    let finishFetch, finishDecode, startDecode;
    const decoding = new Promise(resolve => { startDecode = resolve; });
    globalThis.fetch = () => new Promise(resolve => { finishFetch = resolve; });
    const { image, classes } = fixture();
    image.decode = () => new Promise(resolve => { finishDecode = resolve; startDecode(); });
    const ready = app.loadPhotoSleeveMedia(image, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(classes.has('is-media-ready'), false);
    finishFetch(new Response(new Blob(['preview']), { headers: { 'Content-Type': 'image/jpeg' } }));
    await decoding;
    assert.match(image.src, /^blob:/);
    assert.equal(classes.has('is-media-ready'), false);
    finishDecode();
    await ready;
    assert.equal(classes.has('is-media-ready'), true);
    app.releasePhotoSleeveMedia(image);
});

test('解码失败和节点移除都不会显示未就绪的图片，失败保留原文件入口', async t => {
    const previousFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = previousFetch; });
    globalThis.fetch = async () => new Response(new Blob(['preview']), { headers: { 'Content-Type': 'image/jpeg' } });
    const failed = fixture();
    failed.image.decode = async () => { throw new Error('解码失败'); };
    await assert.rejects(app.loadPhotoSleeveMedia(failed.image, false), /解码失败/);
    failed.classes.add('is-media-ready');
    app.handleMediaLoadError({ target: failed.image });
    assert.equal(failed.classes.has('is-media-ready'), false);
    assert.equal(failed.classes.has('is-media-error'), true);
    assert.match(failed.button.title, /点击查看原文件/);
    app.releasePhotoSleeveMedia(failed.image);

    const removed = fixture();
    removed.image.decode = async () => { removed.image.isConnected = false; };
    await app.loadPhotoSleeveMedia(removed.image, false);
    assert.equal(removed.classes.has('is-media-ready'), false);
    app.releasePhotoSleeveMedia(removed.image);
});

test('图片和视频预览共用纸色占位并保留可访问名称', () => {
    for (const kind of ['image', 'video']) {
        const html = app.renderPhotoSleeveItem({ kind, name: '旅途.jpg', src: 'data/photos/trip/loading.jpg', alt: '旅途照片' }, 0);
        assert.match(html, /photo-sleeve-loading" aria-hidden="true">加载中…/);
        assert.match(html, /alt="旅途照片"/);
        assert.match(html, /data-action="open-media-viewer"/);
        assert.doesNotMatch(html, /<img[^>]*\ssrc=/);
    }
});
