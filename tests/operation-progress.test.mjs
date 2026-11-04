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
            append(child) { child.parentNode = this; }, remove() { this.removed = true; }, click() { this.clicked = true; },
            showPopover() { this.popoverShown = true; },
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

test('准备阶段不挂载进度，实际处理时选择当前模态窗口，移除后不会重新出现', t => {
    const nodes = installEnvironment(t);
    const progress = createOperationProgress('多步骤导入');
    const root = nodes[0];
    assert.equal(root.parentNode, undefined);
    assert.equal(root.popoverShown, undefined);
    const modal = { open: true, append(child) { child.parentNode = this; } };
    document.querySelector = () => modal;
    progress.phase('正在写入…');
    assert.equal(root.parentNode, modal);
    assert.equal(root.popoverShown, true);
    progress.remove();
    root.popoverShown = false;
    progress.update(1, 2);
    assert.equal(root.popoverShown, false);
    const preparation = createOperationProgress('权限检查');
    preparation.fail(new Error('验证未通过'));
    assert.equal(nodes[1].parentNode, undefined);
});

test('数值进度、未知长度和服务器等待阶段切换正确，失败后不显示完成', t => {
    const nodes = installEnvironment(t);
    const progress = createOperationProgress('上传媒体');
    progress.phase('正在上传…');
    const root = nodes[0];
    assert.match(root.className, /operation-progress-floating/);
    assert.equal(root.parentNode, document.body);
    assert.equal(root.popoverShown, true);
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

test('模态窗口内的进度也进入悬浮顶层，完成提示仍可关闭', t => {
    const nodes = installEnvironment(t);
    const modal = { open: true, append(child) { child.parentNode = this; } };
    document.querySelector = () => modal;
    const progress = createOperationProgress('导入草稿');
    progress.update(0, 2, '正在导入…', 'files');
    const root = nodes[0];
    assert.equal(root.parentNode, modal);
    assert.match(root.className, /operation-progress-floating/);
    assert.equal(root.attributes.popover, 'manual');
    assert.equal(root.popoverShown, true);
    progress.complete('草稿已导入');
    const dismiss = root.querySelector('[data-progress-dismiss]');
    assert.equal(dismiss.hidden, false);
    dismiss.events.click();
    assert.equal(root.removed, true);
});

test('取消中止操作并保留取消结果，服务器提交期间不能取消', t => {
    const nodes = installEnvironment(t);
    const progress = createOperationProgress('上传视频');
    const root = nodes[0];
    progress.setCancelable(false);
    progress.cancel();
    assert.equal(progress.signal.aborted, false);
    progress.setCancelable(true);
    root.querySelector('[data-progress-cancel]').events.click();
    assert.equal(progress.signal.aborted, true);
    assert.throws(() => progress.throwIfCancelled(), { name: 'AbortError' });
    progress.phase('不应继续上传');
    assert.equal(root.querySelector('[data-progress-message]').textContent, '正在取消…');
    progress.fail(progress.signal.reason);
    progress.complete('不应显示成功');
    assert.equal(root.attributes['data-state'], 'cancelled');
    assert.equal(root.querySelector('[data-progress-message]').textContent, '操作已取消。');
    assert.equal(root.querySelector('[data-progress-cancel]').hidden, true);
    assert.equal(root.querySelector('[data-progress-dismiss]').hidden, false);
});

test('密码窗口关闭后进度移回页面，移除提示时解除窗口监听', t => {
    const nodes = installEnvironment(t);
    const listeners = new Map();
    const modal = {
        open: true, append(child) { child.parentNode = this; },
        addEventListener(name, listener) { listeners.set(name, listener); },
        removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); }
    };
    document.querySelector = () => modal;
    const progress = createOperationProgress('导入部分记录');
    progress.phase('正在合并…');
    progress.complete('已合并');
    modal.open = false;
    listeners.get('close')();
    assert.equal(nodes[0].parentNode, document.body);
    assert.equal(nodes[0].attributes['data-state'], 'complete');
    assert.equal(listeners.size, 0);
    progress.remove();
    modal.open = true;
    const retry = createOperationProgress('重试导入');
    retry.phase('正在整理…');
    assert.equal(listeners.size, 1);
    retry.remove();
    assert.equal(listeners.size, 0);
});

test('上传取消会真正中止 XHR，已取消的上传不发送，完成后移除监听', async t => {
    installEnvironment(t);
    let xhr;
    let sent = 0;
    let aborted = 0;
    globalThis.XMLHttpRequest = class {
        constructor() { xhr = this; this.upload = {}; }
        open() {} setRequestHeader() {}
        send() { sent += 1; }
        abort() { aborted += 1; this.onabort(); }
    };
    const controller = new AbortController();
    const pending = uploadWithProgress('/video', { body: new Blob(['video']), signal: controller.signal });
    controller.abort(new DOMException('操作已取消。', 'AbortError'));
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(aborted, 1);
    await assert.rejects(uploadWithProgress('/video', { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(sent, 1);
    const completed = new AbortController();
    const success = uploadWithProgress('/video', { signal: completed.signal });
    xhr.status = 200;
    xhr.onload();
    await success;
    completed.abort();
    assert.equal(aborted, 1);
});

test('取消下载停止网络和后续保存，放弃已写入的临时文件', async t => {
    const nodes = installEnvironment(t);
    const progress = createOperationProgress('下载视频');
    let fetchedSignal;
    let discarded = false;
    let closed = false;
    let sourceCancelled = false;
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({
        write: async () => progress.cancel(),
        close: async () => { closed = true; },
        abort: async () => { discarded = true; }
    }) });
    globalThis.fetch = async (_, options) => {
        fetchedSignal = options.signal;
        return new Response(new ReadableStream({
            pull(controller) { controller.enqueue(Uint8Array.of(1)); },
            cancel() { sourceCancelled = true; }
        }));
    };
    assert.deepEqual(await downloadWithProgress('/video', 'video.mp4', progress), { cancelled: true });
    assert.equal(fetchedSignal.aborted, true);
    assert.equal(sourceCancelled, true);
    assert.equal(discarded, true);
    assert.equal(closed, false);
    assert.equal(nodes[0].attributes['data-state'], 'cancelled');
    assert.equal(nodes.some(node => node.clicked), false);
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

test('选择下载保存位置时不显示进度，确认后开始传输，取消选择不显示浮层', async t => {
    const nodes = installEnvironment(t);
    const progress = createOperationProgress('下载备份');
    let choose;
    let fetched = false;
    window.showSaveFilePicker = () => new Promise(resolve => { choose = resolve; });
    globalThis.fetch = async () => { fetched = true; return new Response('backup'); };
    const pending = downloadWithProgress('/backup.zip', 'backup.zip', progress);
    assert.equal(nodes[0].parentNode, undefined);
    assert.equal(fetched, false);
    choose({ createWritable: async () => ({ write() {}, close() {} }) });
    await pending;
    assert.equal(fetched, true);
    assert.equal(nodes[0].popoverShown, true);
    assert.equal(nodes[0].attributes['data-state'], 'complete');
    fetched = false;
    const cancelled = createOperationProgress('取消下载');
    window.showSaveFilePicker = async () => { throw new DOMException('取消', 'AbortError'); };
    assert.deepEqual(await downloadWithProgress('/backup.zip', 'backup.zip', cancelled), { cancelled: true });
    assert.equal(fetched, false);
    assert.equal(nodes[1].parentNode, undefined);
    assert.equal(nodes[1].popoverShown, undefined);
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

function installNetworkEvents() {
    const listeners = new Map();
    window.addEventListener = (type, listener) => listeners.set(type, listener);
    window.removeEventListener = (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); };
    return listeners;
}

test('上传停滞会中止 XHR，只有实际字节进展重置时限，失败后不再回调', async t => {
    installEnvironment(t);
    const listeners = installNetworkEvents();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let xhr;
    let aborted = 0;
    let uploaded = 0;
    globalThis.XMLHttpRequest = class {
        constructor() { xhr = this; this.upload = {}; }
        open() {} setRequestHeader() {} send() {}
        abort() { aborted += 1; this.onabort(); }
    };
    const pending = uploadWithProgress('/backup', { idleTimeout: 100 }, undefined, () => uploaded += 1);
    t.mock.timers.tick(90);
    xhr.upload.onprogress({ loaded: 1, total: 100, lengthComputable: true });
    t.mock.timers.tick(90);
    assert.equal(aborted, 0);
    xhr.upload.onprogress({ loaded: 1, total: 100, lengthComputable: true });
    t.mock.timers.tick(11);
    await assert.rejects(pending, /没有传输进展.*另开页面核对/);
    assert.equal(aborted, 1);
    assert.equal(listeners.size, 0);
    xhr.upload.onload();
    assert.equal(uploaded, 0);
});

test('上传完成后允许长校验，但断网会结束等待并提示先核对结果，重试仍可完成', async t => {
    installEnvironment(t);
    const listeners = installNetworkEvents();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let xhr;
    globalThis.XMLHttpRequest = class {
        constructor() { xhr = this; this.upload = {}; }
        open() {} setRequestHeader() {} send() {} abort() { this.onabort(); }
    };
    const pending = uploadWithProgress('/backup', { idleTimeout: 100 });
    xhr.upload.onload();
    t.mock.timers.tick(1000);
    assert.equal(listeners.size, 1);
    listeners.get('offline')();
    await assert.rejects(pending, /操作结果尚未确认.*另开页面核对/);
    assert.equal(listeners.size, 0);
    const retry = uploadWithProgress('/backup', {});
    xhr.status = 200;
    xhr.onload();
    assert.equal((await retry).ok, true);
    assert.equal(listeners.size, 0);
});

test('已离线不发送上传，总时限仍限制服务器响应等待', async t => {
    installEnvironment(t);
    installNetworkEvents();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let xhr;
    let sends = 0;
    globalThis.XMLHttpRequest = class {
        constructor() { xhr = this; this.upload = {}; }
        open() {} setRequestHeader() {} send() { sends += 1; } abort() { this.onabort(); }
    };
    window.navigator = { onLine: false };
    await assert.rejects(uploadWithProgress('/backup', {}), /网络连接中断/);
    assert.equal(sends, 0);
    window.navigator.onLine = true;
    const pending = uploadWithProgress('/backup', { timeout: 100 });
    xhr.upload.onload();
    t.mock.timers.tick(101);
    await assert.rejects(pending, /传输超时.*另开页面核对/);
});

test('下载停滞或突然离线会停止网络、丢弃临时文件并解除监听', async t => {
    installEnvironment(t);
    const listeners = installNetworkEvents();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const offline of [false, true]) {
        let aborted = false;
        let closed = false;
        let sourceCancelled = false;
        let signal;
        const progress = progressLog();
        window.showSaveFilePicker = async () => ({ createWritable: async () => ({
            write() {}, close() { closed = true; }, abort() { aborted = true; }
        }) });
        globalThis.fetch = async (_, options) => {
            signal = options.signal;
            return new Response(new ReadableStream({
                start(controller) { controller.enqueue(Uint8Array.of(1)); },
                cancel() { sourceCancelled = true; }
            }), { headers: { 'Content-Length': '100' } });
        };
        const pending = downloadWithProgress('/video', 'video.mp4', progress, { idleTimeout: 100 });
        await new Promise(resolve => setImmediate(resolve));
        if (offline) listeners.get('offline')();
        else t.mock.timers.tick(101);
        await assert.rejects(pending, offline ? /下载连接中断/ : /没有传输进展/);
        assert.equal(signal.aborted, true);
        assert.equal(sourceCancelled, true);
        assert.equal(aborted, true);
        assert.equal(closed, false);
        assert.equal(listeners.size, 0);
        assert.equal(progress.calls.some(call => call[0] === 'complete'), false);
    }
});

test('下载等待响应头也检测停滞，取消与超时分别保留结果', async t => {
    installEnvironment(t);
    const listeners = installNetworkEvents();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    globalThis.fetch = () => new Promise(() => {});
    const pending = downloadWithProgress('/video', 'video.mp4', progressLog(), { idleTimeout: 100 });
    t.mock.timers.tick(101);
    await assert.rejects(pending, /没有传输进展/);
    assert.equal(listeners.size, 0);
    const controller = new AbortController();
    const cancelled = downloadWithProgress('/video', 'video.mp4', progressLog(), { signal: controller.signal });
    controller.abort(new DOMException('操作已取消。', 'AbortError'));
    assert.deepEqual(await cancelled, { cancelled: true });
    assert.equal(listeners.size, 0);
});

test('长度不足或超出声明的下载不提交文件，压缩响应按解码后的流处理', async t => {
    const nodes = installEnvironment(t);
    let aborted = 0;
    let closed = 0;
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({
        write() {}, close() { closed += 1; }, abort() { aborted += 1; }
    }) });
    for (const length of ['2', '10', '0']) {
        globalThis.fetch = async () => new Response('video', { headers: { 'Content-Length': length } });
        const progress = progressLog();
        await assert.rejects(downloadWithProgress('/video', 'video.mp4', progress), /下载不完整|下载长度/);
        assert.equal(progress.calls.some(call => call[0] === 'complete'), false);
    }
    assert.equal(aborted, 3);
    assert.equal(closed, 0);
    assert.equal(nodes.some(node => node.clicked), false);
    globalThis.fetch = async () => new Response('video', { headers: { 'Content-Length': '2', 'Content-Encoding': 'gzip' } });
    await downloadWithProgress('/video', 'video.mp4', progressLog());
    assert.equal(closed, 1);
});

test('备份允许较长的服务端准备，收到响应后仍检测传输停滞', async t => {
    installEnvironment(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let respond;
    let signal;
    globalThis.fetch = (_, options) => {
        signal = options.signal;
        return new Promise(resolve => { respond = resolve; });
    };
    const pending = downloadWithProgress('/backup', 'backup.zip', progressLog(), { idleTimeout: 100, responseTimeout: 1000 });
    t.mock.timers.tick(500);
    assert.equal(signal.aborted, false, '准备阶段不受传输停滞时限限制');
    respond(new Response(new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(1)); } })));
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(101);
    await assert.rejects(pending, /没有传输进展/);
});

test('外网离线不阻止回环地址的本机上传，远程地址仍拒绝发送', async t => {
    installEnvironment(t);
    const listeners = installNetworkEvents();
    window.navigator = { onLine: false };
    let xhr;
    let sent = 0;
    globalThis.XMLHttpRequest = class {
        constructor() { xhr = this; this.upload = {}; }
        open() {} setRequestHeader() {} send() { sent += 1; } abort() { this.onabort(); }
    };
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        const pending = uploadWithProgress(`http://${host}:9000/backup`, {});
        assert.equal(listeners.size, 0);
        xhr.status = 200;
        xhr.onload();
        assert.equal((await pending).ok, true);
    }
    await assert.rejects(uploadWithProgress('https://diary.example/backup', {}), /网络连接中断/);
    assert.equal(sent, 3);
});
