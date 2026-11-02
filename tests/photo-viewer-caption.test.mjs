import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

globalThis.document = { addEventListener() {} };
const app = await loadBrowserModule(new URL('../js/app.js', import.meta.url), `
export { renderPhotoViewerCaption, formatMediaFileSize, updatePhotoViewerFileSize };
`);
delete globalThis.document;

test('文件名保留完整提示和尾部，正确转义特殊字符及 Unicode 字符', () => {
    const name = '旅途📷<照片>"_20261101.jpg';
    const html = app.renderPhotoViewerCaption({ name, alt: `日记 · ${name}`, src: '/photo.jpg' });
    assert.ok(html.includes('title="旅途📷&lt;照片&gt;&quot;_20261101.jpg"'));
    assert.match(html, /photo-viewer-caption-title[^>]*>日记<\/span>/);
    assert.equal((html.match(/photo-viewer-caption-separator/g) || []).length, 2);
    assert.match(html, /photo-viewer-filename-tail[^>]*>20261101\.jpg<\/span>/);
    assert.match(html, /data-photo-viewer-size/);
    assert.ok(!html.includes('\uFFFD'));
    const short = app.renderPhotoViewerCaption({ name: 'a.jpg', alt: '日记 · a.jpg' });
    assert.match(short, /photo-viewer-filename-tail[^>]*>a\.jpg<\/span>/);
    const untitled = app.renderPhotoViewerCaption({ name: 'a.jpg', alt: 'a.jpg' });
    assert.equal((untitled.match(/photo-viewer-caption-separator/g) || []).length, 1);
    assert.ok(!untitled.includes('photo-viewer-caption-title'));
});

test('文件大小按字节单位格式化，包括零字节及大文件', () => {
    for (const [bytes, expected] of [
        [0, '0 B'], [999, '999 B'], [1024, '1 KB'], [1536, '1.5 KB'],
        [1048576, '1 MB'], [12345678, '11.77 MB'], [3 * 1024 ** 3, '3 GB']
    ]) assert.equal(app.formatMediaFileSize(bytes), expected);
});

test('图片和视频均以 HEAD 读取大小，重复查看复用缓存', async t => {
    const previousFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = previousFetch; });
    const calls = [];
    globalThis.fetch = async (src, options) => {
        calls.push({ src, options });
        return new Response(null, { headers: { 'Content-Length': src.endsWith('.mp4') ? '1048576' : '0' } });
    };
    for (const [src, expected] of [['/cached.jpg', '0 B'], ['/cached.mp4', '1 MB']]) {
        const label = { isConnected: true, textContent: '' };
        await app.updatePhotoViewerFileSize({ src }, label);
        assert.equal(label.textContent, expected);
        await app.updatePhotoViewerFileSize({ src }, label);
        assert.equal(label.textContent, expected);
    }
    assert.equal(calls.length, 2);
    assert.ok(calls.every(({ options }) => options.method === 'HEAD' && options.credentials === 'same-origin' && options.signal));
});

test('待上传文件直接读取 Blob 大小，不对临时地址发起网络请求', async t => {
    const previousFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = previousFetch; });
    globalThis.fetch = async () => { assert.fail('本地 Blob 不应发起网络请求'); };
    const label = { isConnected: true, textContent: '' };
    await app.updatePhotoViewerFileSize({ src: 'blob:pending-upload', blob: new Blob(['hello']) }, label);
    assert.equal(label.textContent, '5 B');
});

test('缺失或无效长度、HTTP 错误及网络失败显示大小未知，之后可重试', async t => {
    const previousFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = previousFetch; });
    const failures = [
        () => new Response(null),
        () => new Response(null, { headers: { 'Content-Length': '-1' } }),
        () => new Response(null, { headers: { 'Content-Length': 'abc' } }),
        () => new Response(null, { headers: { 'Content-Length': '9007199254740992' } }),
        () => new Response(null, { status: 404, headers: { 'Content-Length': '100' } }),
        () => { throw new Error('网络失败'); }
    ];
    for (const [index, failure] of failures.entries()) {
        const photo = { src: `/retry-${index}.jpg` };
        const label = { isConnected: true, textContent: '' };
        globalThis.fetch = async () => failure();
        await app.updatePhotoViewerFileSize(photo, label);
        assert.equal(label.textContent, '大小未知');
        globalThis.fetch = async () => new Response(null, { headers: { 'Content-Length': '2048' } });
        await app.updatePhotoViewerFileSize(photo, label);
        assert.equal(label.textContent, '2 KB');
    }
});

test('关闭或切换后，延迟返回的大小不会改写已移除节点或其他文件', async t => {
    const previousFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = previousFetch; });
    let finish;
    globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
    const oldLabel = { isConnected: true, textContent: '读取大小中…' };
    const currentLabel = { isConnected: true, textContent: '新文件' };
    const pending = app.updatePhotoViewerFileSize({ src: '/slow.jpg' }, oldLabel);
    oldLabel.isConnected = false;
    finish(new Response(null, { headers: { 'Content-Length': '1024' } }));
    await pending;
    assert.equal(oldLabel.textContent, '读取大小中…');
    assert.equal(currentLabel.textContent, '新文件');
});
