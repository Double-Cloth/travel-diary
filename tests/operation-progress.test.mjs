import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const { createOperationProgress, uploadWithProgress, downloadWithProgress } = await loadBrowserModule(new URL('../js/operation-progress.js', import.meta.url));

function installEnvironment(t) {
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, XMLHttpRequest: globalThis.XMLHttpRequest };
    t.after(() => Object.assign(globalThis, previous));
    const created = [];
    function node() {
        const children = new Map();
        return {
            events: {}, attributes: {}, hidden: false,
            append() {}, remove() { this.removed = true; }, click() { this.clicked = true; },
            setAttribute(name, value) { this.attributes[name] = value; },
            removeAttribute(name) { delete this.attributes[name]; if (name === 'value') delete this.value; },
            addEventListener(name, callback) { this.events[name] = callback; },
            querySelector(selector) {
                if (!children.has(selector)) children.set(selector, node());
                return children.get(selector);
            }
        };
    }
    globalThis.document = { body: node(), querySelector: () => null, createElement: () => { const item = node(); created.push(item); return item; } };
    globalThis.window = {};
    return created;
}

function progressLog() {
    const calls = [];
    return Object.fromEntries(['phase', 'update', 'complete', 'fail', 'remove'].map(name => [name, (...args) => calls.push([name, ...args])]).concat([['calls', calls]]));
}

test('数值进度、未知长度和服务器等待阶段切换正确，失败后不显示完成', t => {
    const nodes = installEnvironment(t);
    const progress = createOperationProgress('上传媒体');
    const root = nodes[0];
    const bar = root.querySelector('[data-progress-bar]');
    assert.equal(bar.value, undefined);
    progress.update(50, 100, '上传中');
    assert.equal(bar.value, 50);
    progress.phase('服务器正在保存');
    assert.equal(bar.value, undefined);
    progress.update(1234, 0, '读取中');
    assert.equal(bar.value, undefined);
    assert.match(root.querySelector('[data-progress-detail]').textContent, /1.2 KiB/);
    progress.fail(new Error('连接中断'));
    progress.complete('不应覆盖失败');
    assert.equal(root.attributes['data-state'], 'error');
    assert.equal(root.querySelector('[data-progress-message]').textContent, '连接中断');
    assert.equal(bar.hidden, true);
    root.querySelector('[data-progress-dismiss]').events.click();
    assert.equal(root.removed, true);
});

test('上传使用原始文件和认证头，上传完成与服务器返回成功分开', async t => {
    installEnvironment(t);
    let xhr;
    globalThis.XMLHttpRequest = class {
        constructor() { xhr = this; this.upload = {}; this.headers = {}; }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(name, value) { this.headers[name] = value; }
        send(body) { this.body = body; }
    };
    const file = new Blob(['video']);
    const events = [];
    let resolved = false;
    const pending = uploadWithProgress('/api/travel-records', {
        method: 'PUT', headers: { 'X-Travel-Token': 'test-token' }, body: file
    }, (loaded, total) => events.push([loaded, total]), () => events.push('waiting')).then(value => { resolved = true; return value; });
    assert.equal(xhr.body, file);
    assert.equal(xhr.method, 'PUT');
    assert.equal(xhr.headers['X-Travel-Token'], 'test-token');
    xhr.upload.onprogress({ loaded: 2, total: 5, lengthComputable: true });
    xhr.upload.onprogress({ loaded: 5, lengthComputable: false });
    xhr.upload.onload();
    await Promise.resolve();
    assert.equal(resolved, false);
    assert.deepEqual(events, [[2, 5], [5, 0], 'waiting']);
    xhr.status = 409;
    xhr.responseText = '{"error":"记录已发生变更"}';
    xhr.onload();
    const response = await pending;
    assert.equal(response.ok, false);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: '记录已发生变更' });
    const timeout = uploadWithProgress('/api/test', { body: file });
    xhr.ontimeout();
    await assert.rejects(timeout, /传输超时/);
});

test('下载按分块写盘，在文件关闭后才报告成功', async t => {
    installEnvironment(t);
    const progress = progressLog();
    const written = [];
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({
        write: async chunk => { written.push(...chunk); },
        close: async () => { assert.equal(progress.calls.some(call => call[0] === 'complete'), false); }
    }) });
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(Uint8Array.of(1, 2));
        controller.enqueue(Uint8Array.of(3, 4));
        controller.close();
    } }), { headers: { 'Content-Length': '4' } });
    await downloadWithProgress('/media.mp4', 'media.mp4', progress);
    assert.deepEqual(written, [1, 2, 3, 4]);
    assert.deepEqual(progress.calls.filter(call => call[0] === 'update').map(call => call.slice(1, 3)), [[0, 4], [2, 4], [4, 4]]);
    assert.equal(progress.calls.at(-1)[0], 'complete');
});

test('下载中断会放弃未完成文件，取消保存对话框不发起请求', async t => {
    installEnvironment(t);
    let aborted = false;
    let fetched = false;
    const progress = progressLog();
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({ abort: async () => { aborted = true; } }) });
    globalThis.fetch = async () => { fetched = true; return new Response(new ReadableStream({ start(controller) { controller.error(new Error('连接中断')); } })); };
    await assert.rejects(downloadWithProgress('/media.mp4', 'media.mp4', progress), /连接中断/);
    assert.equal(aborted, true);
    assert.equal(progress.calls.some(call => call[0] === 'complete'), false);
    assert.equal(progress.calls.at(-1)[0], 'fail');
    fetched = false;
    window.showSaveFilePicker = async () => { throw new DOMException('取消', 'AbortError'); };
    assert.deepEqual(await downloadWithProgress('/media.mp4', 'media.mp4', progress), { cancelled: true });
    assert.equal(fetched, false);
});

test('不支持直接写盘时，超大下载交给浏览器且不缓存整份文件或伪报成功', async t => {
    const nodes = installEnvironment(t);
    let cancelled = false;
    const progress = progressLog();
    globalThis.fetch = async () => ({ ok: true, headers: new Headers({ 'Content-Length': String(40 * 1024 ** 3) }),
        body: { cancel: async () => { cancelled = true; }, getReader: () => { throw new Error('不应读取巨大文件'); } }
    });
    assert.deepEqual(await downloadWithProgress('/backup.zip', 'backup.zip', progress), { handedOff: true });
    assert.equal(cancelled, true);
    assert.equal(nodes[0].href, '/backup.zip');
    assert.equal(nodes[0].clicked, true);
    assert.equal(progress.calls.some(call => call[0] === 'complete'), false);
});

test('未知长度下载在流结束前不虚构百分比，HTTP 错误保留服务端说明', async t => {
    installEnvironment(t);
    const progress = progressLog();
    globalThis.fetch = async () => new Response('image');
    await downloadWithProgress('/image.jpg', 'image.jpg', progress);
    assert.equal(progress.calls.filter(call => call[0] === 'update').every(call => call[2] === 0), true);
    globalThis.fetch = async () => new Response('{"error":"会话已失效"}', { status: 401 });
    await assert.rejects(downloadWithProgress('/backup.zip', 'backup.zip', progressLog()), /会话已失效/);
});
