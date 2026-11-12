import { resolveObjectURL } from 'node:buffer';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const { createOperationProgress, uploadWithProgress, downloadWithProgress, saveBlobDownload } = await loadBrowserModule(new URL('../js/operation-progress.js', import.meta.url));
const { uploadProfilePicture } = await loadBrowserModule(new URL('../js/profile-picture.js', import.meta.url));

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
    return Object.fromEntries(['phase', 'update', 'handOff', 'complete', 'fail', 'remove'].map(name => [name, (...args) => calls.push([name, ...args])]).concat([['calls', calls]]));
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

test('浏览器接管后显示不定进度，6 秒后自动收起且支持提前关闭提示', t => {
    const nodes = installEnvironment(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const progress = createOperationProgress('导出全部数据');
    progress.update(50, 100, '正在下载…');
    progress.handOff();
    const root = nodes[0];
    const bar = root.querySelector('[data-progress-bar]');
    assert.equal(root.parentNode, document.body);
    assert.equal(root.popoverShown, true);
    assert.equal(root.attributes['data-state'], 'browser-managed');
    assert.equal(bar.value, undefined);
    assert.equal(bar.hidden, false);
    assert.equal(root.querySelector('[data-progress-cancel]').hidden, true);
    assert.equal(root.querySelector('[data-progress-dismiss]').hidden, false);
    assert.match(root.querySelector('[data-progress-detail]').textContent, /浏览器下载列表/);
    progress.cancel();
    progress.complete('已完成');
    progress.fail(new Error('已失败'));
    progress.update(100, 100);
    t.mock.timers.tick(5999);
    assert.equal(root.removed, undefined);
    assert.equal(progress.signal.aborted, false);
    assert.equal(root.querySelector('[data-progress-message]').textContent, '已交给浏览器下载');
    t.mock.timers.tick(1);
    assert.equal(root.removed, true);
    assert.equal(progress.signal.aborted, false);
    const next = createOperationProgress('下载原视频');
    next.handOff();
    nodes[1].querySelector('[data-progress-dismiss]').events.click();
    assert.equal(nodes[1].removed, true);
    t.mock.timers.tick(6000);
    assert.equal(next.signal.aborted, false);
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

test('XHR 零状态和损坏的响应提示核对结果，服务端业务错误仍可读取', async t => {
    installEnvironment(t);
    let xhr;
    let uploaded = 0;
    globalThis.XMLHttpRequest = class {
        constructor() { xhr = this; this.upload = {}; }
        open() {} setRequestHeader() {} send() {}
    };
    const interrupted = uploadWithProgress('/backup', {}, undefined, () => uploaded += 1);
    xhr.upload.onload();
    xhr.upload.onload();
    assert.equal(uploaded, 1);
    xhr.status = 0;
    xhr.onload();
    await assert.rejects(interrupted, /操作结果尚未确认.*另开页面核对/);
    for (const body of ['{"saved":', '<html>Bad Gateway</html>', 'null', '[]']) {
        const pending = uploadWithProgress('/backup', {});
        xhr.status = 200;
        xhr.responseText = body;
        xhr.onload();
        await assert.rejects((await pending).json(), /响应中断或无法识别.*另开页面核对/);
    }
    const rejected = uploadWithProgress('/backup', {});
    xhr.status = 403;
    xhr.responseText = '{"error":"备份密码不正确。","code":"BACKUP_PASSWORD_INVALID"}';
    xhr.onload();
    assert.equal((await (await rejected).json()).code, 'BACKUP_PASSWORD_INVALID');
});

test('Fetch 上传持续监测响应体，断网后清理监听且恢复后可重试', async t => {
    installEnvironment(t);
    const listeners = installNetworkEvents();
    globalThis.XMLHttpRequest = undefined;
    let signal;
    let finishBody;
    let uploaded = 0;
    globalThis.fetch = async (_, options) => {
        signal = options.signal;
        return { ok: true, status: 200, json: () => new Promise(resolve => { finishBody = resolve; }) };
    };
    const pending = uploadWithProgress('/backup', {}, undefined, () => uploaded += 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(uploaded, 1);
    assert.equal(listeners.size, 1);
    listeners.get('offline')();
    await assert.rejects(pending, /操作结果尚未确认.*另开页面核对/);
    assert.equal(signal.aborted, true);
    assert.equal(listeners.size, 0);
    finishBody({ imported: true });
    globalThis.fetch = async () => Response.json({ imported: true });
    const retry = await uploadWithProgress('/backup', {}, undefined, () => uploaded += 1);
    assert.deepEqual(await retry.json(), { imported: true });
    assert.equal(uploaded, 2);
    assert.equal(listeners.size, 0);
});

test('Fetch 上传的响应体超时和异常响应保留中断提示，取消保留 AbortError', async t => {
    installEnvironment(t);
    const listeners = installNetworkEvents();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    globalThis.XMLHttpRequest = undefined;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
    const pending = uploadWithProgress('/backup', { timeout: 100 });
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(101);
    await assert.rejects(pending, /传输超时.*另开页面核对/);
    assert.equal(listeners.size, 0);
    const controller = new AbortController();
    const cancelled = uploadWithProgress('/backup', { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new DOMException('操作已取消。', 'AbortError'));
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.equal(listeners.size, 0);
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(uploadWithProgress('/backup', {}), /另开页面核对/);
    globalThis.fetch = async () => new Response('<html>Bad Gateway</html>', { status: 502 });
    await assert.rejects(uploadWithProgress('/backup', {}), /响应中断或无法识别.*另开页面核对/);
    assert.equal(listeners.size, 0);
});

test('头像上传保留中断及无法确认结果的提示，超时和主动取消各自恢复', async t => {
    installEnvironment(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    window.location = { href: 'http://localhost:9000/' };
    let xhr;
    globalThis.XMLHttpRequest = class {
        constructor() { xhr = this; this.upload = {}; }
        open() {} setRequestHeader() {} send() {} abort() { this.onabort(); }
    };
    const capability = { token: 'test', methods: new Set(['PUT']) };
    const interrupted = uploadProfilePicture({ data: 'png' }, capability);
    xhr.onerror();
    await assert.rejects(interrupted, /操作结果尚未确认.*另开页面核对/);
    const invalid = uploadProfilePicture({ data: 'png' }, capability);
    xhr.status = 502;
    xhr.responseText = '<html>Bad Gateway</html>';
    xhr.onload();
    await assert.rejects(invalid, /响应中断或无法识别.*另开页面核对/);
    const timedOut = uploadProfilePicture({ data: 'png' }, capability);
    t.mock.timers.tick(30001);
    await assert.rejects(timedOut, /传输超时.*另开页面核对/);
    const controller = new AbortController();
    const cancelled = uploadProfilePicture({ data: 'png' }, capability, undefined, undefined, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
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

test('所有 URL 下载无论大小均只预检 HEAD 后交给浏览器，保留文件名和查询参数', async t => {
    const nodes = installEnvironment(t);
    window.showSaveFilePicker = () => { throw new Error('下载不应创建网页文件流'); };
    for (const length of ['4', String(256 * 1024 ** 2), null, 'invalid']) {
        const progress = progressLog();
        let requests = 0;
        globalThis.fetch = async (url, options) => {
            requests++;
            assert.equal(url, '/backup?selection=test');
            assert.equal(options.method, 'HEAD');
            assert.equal(options.credentials, 'same-origin');
            return { ok: true, headers: new Headers(length === null ? {} : { 'Content-Length': length }),
                body: { getReader() { throw new Error('预检不应读取正文'); } } };
        };
        assert.deepEqual(await downloadWithProgress('/backup?selection=test', 'backup.zip', progress), { handedOff: true });
        assert.equal(requests, 1);
        assert.equal(nodes.at(-1).href, '/backup?selection=test');
        assert.equal(nodes.at(-1).download, 'backup.zip');
        assert.equal(nodes.at(-1).clicked, true);
        assert.equal(nodes.at(-1).removed, true);
        assert.deepEqual(progress.calls, [['handOff']]);
    }
});

test('预检失败、断网或取消不触发浏览器下载，也不报告完成', async t => {
    const nodes = installEnvironment(t);
    const listeners = installNetworkEvents();
    for (const status of [401, 403, 404, 409, 500]) {
        const progress = progressLog();
        globalThis.fetch = async () => new Response(null, { status });
        await assert.rejects(downloadWithProgress('/backup', 'backup.zip', progress), new RegExp(`HTTP ${status}`));
        assert.equal(progress.calls.at(-1)[0], 'fail');
    }
    globalThis.fetch = () => new Promise(() => {});
    const offline = downloadWithProgress('/backup', 'backup.zip', progressLog());
    listeners.get('offline')();
    await assert.rejects(offline, /下载准备中断/);
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await downloadWithProgress('/backup', 'backup.zip', progressLog(), { signal: controller.signal }), { cancelled: true });
    assert.equal(nodes.some(node => node.clicked), false);
    assert.equal(listeners.size, 0);
});

test('备份预检允许较长准备，浏览器接管后释放网页监听及计时器', async t => {
    const nodes = installEnvironment(t);
    const listeners = installNetworkEvents();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let respond;
    let signal;
    globalThis.fetch = (_, options) => {
        signal = options.signal;
        return new Promise(resolve => { respond = resolve; });
    };
    const progress = progressLog();
    const pending = downloadWithProgress('/backup', 'backup.zip', progress, { idleTimeout: 100, responseTimeout: 1000 });
    t.mock.timers.tick(500);
    assert.equal(signal.aborted, false);
    respond(new Response(null));
    assert.deepEqual(await pending, { handedOff: true });
    assert.equal(listeners.size, 0);
    t.mock.timers.tick(8 * 60 * 60 * 1000);
    assert.equal(signal.aborted, false);
    assert.equal(nodes[0].clicked, true);
    assert.deepEqual(progress.calls, [['handOff']]);
});

test('本地 Blob 下载也统一显示浏览器接管提示，延迟释放 URL 且取消不下载', t => {
    const nodes = installEnvironment(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const blob = new Blob(['草稿与原媒体']);
    const progress = createOperationProgress('导出草稿');
    saveBlobDownload(blob, 'draft.zip', progress);
    const url = nodes[1].href;
    assert.equal(nodes[1].download, 'draft.zip');
    assert.equal(nodes[1].clicked, true);
    assert.equal(nodes[0].attributes['data-state'], 'browser-managed');
    assert.ok(resolveObjectURL(url));
    t.mock.timers.tick(6000);
    assert.equal(nodes[0].removed, true);
    assert.ok(resolveObjectURL(url));
    t.mock.timers.tick(54000);
    assert.equal(resolveObjectURL(url), undefined);
    const cancelled = createOperationProgress('取消导出');
    cancelled.cancel();
    const count = nodes.length;
    assert.throws(() => saveBlobDownload(blob, 'cancelled.zip', cancelled), /取消/);
    assert.equal(nodes.length, count);
});
