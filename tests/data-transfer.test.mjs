import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';
import { MAXIMUM_ARCHIVE_BYTES } from '../js/file-limits.mjs';
import { createZip } from './helpers/zip-archive.mjs';
import { AUTH_CONFIG, AUTH_PASSWORD } from './helpers/auth.mjs';

function backupFile(entries = [{ name: 'data/travel_data.json', data: '[]' }]) {
    return Object.assign(new Blob([createZip(entries)]), { name: 'backup.zip' });
}

async function waitForDialog(dialog) {
    for (let attempt = 0; attempt < 100 && !dialog.open; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(dialog.open, true);
}

async function confirmImportRisk(transfer, confirmation) {
    const pending = transfer.chooseImport();
    assert.equal(confirmation.open, true);
    assert.match(confirmation.querySelector('#dataImportConfirmDescription').textContent, /替换全部日记.*回收站.*可以恢复/);
    assert.equal(confirmation.querySelector('[data-import-file-summary]').hidden, true);
    confirmation.events.click({ target: { closest: selector => selector === '[data-import-confirm]' } });
    await pending;
}

const { createDataTransfer } = await loadBrowserModule(new URL('../js/data-transfer.js', import.meta.url));

test('导入已提交但页面刷新失败时明确提示成功，正常重试刷新后清除旧提示', async t => {
    const nodes = [];
    const output = { textContent: '', focus() {} };
    function node() {
        const children = new Map();
        return {
            events: {}, open: false,
            classList: { add() {}, remove() {} },
            setAttribute() {}, focus() {}, click() {},
            addEventListener(name, handler) { this.events[name] = handler; },
            querySelectorAll() { return []; },
            querySelector(selector) {
                if (!children.has(selector)) children.set(selector, node());
                return children.get(selector);
            },
            showModal() { this.open = true; }, close() { this.open = false; }
        };
    }
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.document = {
        createElement() { const element = node(); nodes.push(element); return element; },
        body: { append() {} }, querySelector: () => output
    };
    globalThis.window = { location: { hostname: 'diary.example', href: 'https://diary.example/' } };
    globalThis.fetch = async (_, options) => ({
        ok: true,
        status: 200,
        json: async () => options?.headers?.['Content-Type'] === 'application/zip'
            ? { imported: true }
            : {
                service: 'travel-diary-writer-v1',
                authenticated: options?.method === 'POST',
                token: options?.method === 'POST' ? 'test' : undefined,
                methods: ['POST', 'PUT', 'DELETE']
            }
    });
    let refreshFails = true;
    const transfer = createDataTransfer(async () => { if (refreshFails) throw new Error('模拟刷新失败'); });
    const [input, confirmation, success, passwordDialog] = nodes;
    async function authorizeImport() {
        await confirmImportRisk(transfer, confirmation);
        for (let index = 0; index < 6; index += 1) {
            passwordDialog.events.click({
                target: {
                    closest: selector => selector === '[data-password-key]'
                        ? { dataset: { passwordKey: '8' } }
                        : null
                }
            });
        }
        await new Promise(resolve => setImmediate(resolve));
    }
    async function importFile() {
        await authorizeImport();
        input.files = [backupFile()];
        const pending = input.events.change();
        await waitForDialog(confirmation);
        confirmation.events.click({ target: { closest: selector => selector === '[data-import-confirm]' } });
        await pending;
        assert.equal(success.open, true);
    }
    await importFile();
    assert.match(success.querySelector('#dataImportSuccessDescription').textContent, /数据已导入，页面刷新失败/);
    assert.match(output.textContent, /手动刷新/);
    success.close();
    refreshFails = false;
    await importFile();
    assert.equal(success.querySelector('#dataImportSuccessDescription').textContent, '全部旅行数据已更新。');
    assert.equal(output.textContent, '');
    success.close();
    await authorizeImport();
    input.files = [{ name: 'too-large.zip', size: MAXIMUM_ARCHIVE_BYTES + 1 }];
    await input.events.change();
    assert.equal(confirmation.open, false);
    assert.match(output.textContent, /不能超过 102400 MiB/);
});

test('动态导出地址要求写入 API，静态页面仍拒绝全部数据导入', async t => {
    const nodes = [];
    const output = { textContent: '', focus() {} };
    function node() {
        const children = new Map();
        return {
            events: {}, open: false,
            classList: { add() {}, remove() {}, toggle() {} },
            setAttribute() {}, focus() {}, click() {},
            addEventListener(name, handler) { this.events[name] = handler; },
            querySelectorAll() { return []; },
            querySelector(selector) {
                if (!children.has(selector)) children.set(selector, node());
                return children.get(selector);
            },
            showModal() { this.open = true; }, close() { this.open = false; }
        };
    }
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.document = {
        createElement() { const element = node(); nodes.push(element); return element; },
        body: { append() {} }, querySelector: () => output, activeElement: null
    };
    globalThis.window = { location: { hostname: 'diary.example', href: 'https://diary.example/' } };
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ service: 'travel-diary-writer-v1', authenticated: true, token: 'remote-token', methods: ['POST', 'PUT', 'DELETE'] })
    });
    const writable = createDataTransfer(async () => {});
    assert.equal(await writable.getExportHref(), 'https://diary.example/api/travel-data');

    globalThis.window.location = { hostname: 'static.example', href: 'https://static.example/' };
    globalThis.fetch = async () => ({
        status: 200,
        ok: true,
        json: async () => ({ service: 'travel-diary-static-v1', readonly: true })
    });
    const readonly = createDataTransfer(async () => {});
    await assert.rejects(readonly.getExportHref(), error => error.code === 'STATIC_READONLY');
    const readonlyConfirmation = nodes.filter(item => item.className === 'data-import-confirm entry-sheet').at(-1);
    await confirmImportRisk(readonly, readonlyConfirmation);
    const feedbackDialog = nodes.find(item => item.className === 'feedback-dialog entry-sheet');
    const readonlyPasswordDialog = nodes.filter(item => item.className === 'record-password entry-sheet').at(-1);
    assert.ok(feedbackDialog, '静态导入失败应创建站内反馈弹窗');
    assert.equal(feedbackDialog.open, true);
    assert.equal(feedbackDialog.querySelector('[data-feedback-label]').textContent, '只读模式');
    assert.equal(feedbackDialog.querySelector('[data-feedback-title]').textContent, '当前站点为静态页面');
    assert.equal(feedbackDialog.querySelector('[data-feedback-message]').textContent, '当前站点为静态只读页面，不提供全部数据导入。');
    assert.equal(output.textContent, '');
    assert.equal(readonlyPasswordDialog.open, false);
    feedbackDialog.events.click({
        target: { closest: selector => selector === '[data-feedback-confirm]' ? {} : null }
    });
});

test('动态认证失效、网络中断与异常 API 响应不会降级为静态备份', async t => {
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    function node() {
        const children = new Map();
        return {
            classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener() {},
            querySelectorAll: () => [],
            querySelector(selector) { if (!children.has(selector)) children.set(selector, node()); return children.get(selector); },
            removeAttribute() {}, remove() {}, append() {}
        };
    }
    globalThis.document = { createElement: node, body: { append() {} }, querySelector: () => null };
    globalThis.window = { location: { href: 'https://diary.example/' } };
    const transfer = createDataTransfer(async () => {});
    for (const code of ['AUTH_REQUIRED', 'WRITER_INVALID_RESPONSE', 'WRITER_UNREACHABLE']) {
        let requests = 0;
        globalThis.fetch = async url => {
            requests += 1;
            assert.equal(url.pathname, '/api/travel-records');
            if (code === 'WRITER_UNREACHABLE') throw new TypeError('网络中断');
            return new Response(JSON.stringify(code === 'AUTH_REQUIRED'
                ? { service: 'travel-diary-writer-v1', authenticated: false } : {}));
        };
        await assert.rejects(transfer.exportAll(), error => error.code === code);
        assert.equal(requests, 1);
    }
});

test('导入缺少媒体文件的备份后提示缺失数量但保留旅行数据', async t => {
    const nodes = [];
    const output = { textContent: '', focus() {} };
    function node() {
        const children = new Map();
        return {
            events: {}, open: false,
            classList: { add() {}, remove() {}, toggle() {} },
            setAttribute() {}, focus() {}, click() {},
            addEventListener(name, handler) { this.events[name] = handler; },
            querySelectorAll() { return []; },
            querySelector(selector) {
                if (!children.has(selector)) children.set(selector, node());
                return children.get(selector);
            },
            showModal() { this.open = true; }, close() { this.open = false; }
        };
    }
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.document = {
        createElement() { const element = node(); nodes.push(element); return element; },
        body: { append() {} }, querySelector: () => output, activeElement: null
    };
    globalThis.window = { location: { hostname: 'diary.example', href: 'https://diary.example/' } };
    globalThis.fetch = async (_, options) => ({
        ok: true,
        json: async () => options?.headers?.['Content-Type'] === 'application/zip'
            ? { imported: true, missingMediaReferences: 2 }
            : { service: 'travel-diary-writer-v1', authenticated: true, token: 'test', methods: ['POST', 'PUT', 'DELETE'] }
    });
    const transfer = createDataTransfer(async () => {});
    const [input, confirmation, success, passwordDialog] = nodes;

    await confirmImportRisk(transfer, confirmation);
    for (let index = 0; index < 6; index += 1) {
        passwordDialog.events.click({
            target: { closest: selector => selector === '[data-password-key]' ? { dataset: { passwordKey: '8' } } : null }
        });
    }
    await new Promise(resolve => setImmediate(resolve));
    input.files = [backupFile()];
    const pending = input.events.change();
    await waitForDialog(confirmation);
    confirmation.events.click({ target: { closest: selector => selector === '[data-import-confirm]' } });
    await pending;

    assert.match(success.querySelector('#dataImportSuccessDescription').textContent, /2 个图片或视频引用缺少对应文件/);
    assert.equal(output.textContent, '');
});

test('清空全部数据使用认证令牌并在服务端成功后刷新页面数据', async t => {
    const output = { textContent: '' };
    function node() {
        const children = new Map();
        return {
            events: {}, open: false,
            classList: { add() {}, remove() {}, toggle() {} },
            setAttribute() {}, focus() {}, click() {},
            addEventListener(name, handler) { this.events[name] = handler; },
            querySelectorAll() { return []; },
            querySelector(selector) {
                if (!children.has(selector)) children.set(selector, node());
                return children.get(selector);
            },
            showModal() { this.open = true; }, close() { this.open = false; }
        };
    }
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.document = {
        createElement: () => node(),
        body: { append() {} },
        querySelector: () => output,
        activeElement: null
    };
    globalThis.window = { location: { href: 'https://diary.example/' } };
    let refreshed = 0;
    globalThis.fetch = async (url, options) => {
        assert.equal(url.href, 'https://diary.example/api/travel-data');
        assert.equal(options.method, 'DELETE');
        assert.equal(options.headers['X-Travel-Token'], 'clear-token');
        return { ok: true, json: async () => ({ cleared: true }) };
    };

    const result = await createDataTransfer(async () => { refreshed += 1; })
        .clearAll({ authenticated: true, token: 'clear-token' });
    assert.deepEqual(result, { refreshFailed: false });
    assert.equal(refreshed, 1);
    assert.equal(output.textContent, '');
});

test('完整导入复用当前会话，仅在备份配置不同时追加询问，密码错误不上传；可重试、取消和重新导入', async t => {
    const nodes = [];
    const output = { textContent: '', focus() {} };
    function node() {
        const children = new Map();
        return {
            events: {}, open: false,
            remove() { this.removed = true; },
            classList: { add() {}, remove() {}, toggle() {} },
            setAttribute() {}, focus() {}, click() {},
            addEventListener(name, handler) { this.events[name] = handler; },
            querySelectorAll() { return []; },
            querySelector(selector) {
                if (!children.has(selector)) children.set(selector, node());
                return children.get(selector);
            },
            showModal() { this.open = true; }, close() { this.open = false; }
        };
    }
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, requestAnimationFrame: globalThis.requestAnimationFrame };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.document = {
        createElement() { const element = node(); nodes.push(element); return element; },
        body: { append() {} }, querySelector: () => output, activeElement: null
    };
    globalThis.window = { location: { href: 'https://diary.example/' } };
    globalThis.requestAnimationFrame = callback => callback();
    let uploads = 0;
    let probes = 0;
    let selections = 0;
    let refreshed = 0;
    let backupPassword = '590247';
    globalThis.fetch = async (url, options) => {
        if (String(url).includes('mode=verify-backup')) {
            assert.equal(Object.hasOwn(options.headers, 'X-Travel-Current-Password'), false);
            assert.equal(JSON.parse(options.body).auth.algorithm, 'scrypt');
            const valid = backupPassword === AUTH_PASSWORD || options.headers['X-Travel-Backup-Password'] === backupPassword;
            return { ok: valid, status: valid ? 200 : 403, json: async () => valid
                ? { verified: true } : { error: '备份密码不正确。', code: 'BACKUP_PASSWORD_INVALID' } };
        }
        if (options?.headers?.['Content-Type'] !== 'application/zip') {
            probes += 1;
            return { ok: true, json: async () => ({ service: 'travel-diary-writer-v1', authenticated: true, token: 'test', methods: ['POST', 'PUT', 'DELETE'] }) };
        }
        uploads += 1;
        const activeProgress = nodes.filter(item => item.className?.includes('operation-progress') && !item.removed);
        assert.equal(activeProgress.length, 1, '上传开始后才显示唯一进度');
        assert.equal(Object.hasOwn(options.headers, 'X-Travel-Current-Password'), false);
        const valid = backupPassword === AUTH_PASSWORD || options.headers['X-Travel-Backup-Password'] === backupPassword;
        return { ok: valid, json: async () => valid ? { imported: true, authPreserved: false } : { error: '备份密码不正确。' } };
    };
    const transfer = createDataTransfer(async () => { refreshed += 1; });
    const [input, confirmation, success, currentGate, backupGate] = nodes;
    input.click = () => { selections += 1; };
    const digits = (gate, password) => {
        for (const digit of password) gate.events.click({
            target: { closest: selector => selector === '[data-password-key]' ? { dataset: { passwordKey: digit } } : null }
        });
    };
    const begin = async () => {
        const progressCount = nodes.filter(item => item.className?.includes('operation-progress')).length;
        await confirmImportRisk(transfer, confirmation);
        assert.equal(currentGate.open, false, '有效会话直接选择文件，不再询问当前密码');
        input.files = [backupFile([
            { name: 'data/travel_data.json', data: '[]' },
            { name: '.secrets/auth.json', data: JSON.stringify(AUTH_CONFIG) }
        ])];
        const pending = input.events.change();
        await waitForDialog(confirmation);
        assert.equal(confirmation.querySelector('#dataImportConfirmTitle').textContent, '核对所选备份');
        assert.equal(confirmation.querySelector('[data-import-file-summary]').hidden, false);
        assert.match(confirmation.querySelector('#dataImportConfirmDescription').textContent, /访问密码.*恢复为备份时的密码/);
        assert.equal(backupGate.open, false);
        assert.equal(nodes.filter(item => item.className?.includes('operation-progress')).length, progressCount, '风险确认、当前密码与文件核对阶段不创建进度');
        return { pending };
    };
    const cancelled = transfer.chooseImport();
    assert.equal(confirmation.open, true);
    assert.equal(currentGate.open, false);
    assert.equal(probes, 0);
    assert.equal(selections, 0);
    await transfer.chooseImport();
    assert.equal(currentGate.open, false);
    confirmation.events.cancel({ preventDefault() {} });
    await cancelled;
    assert.equal(probes, 0);
    assert.equal(selections, 0);
    const first = await begin();
    assert.equal(selections, 1);
    assert.equal(uploads, 0);
    confirmation.events.click({ target: { closest: selector => selector === '[data-import-confirm]' } });
    await waitForDialog(backupGate);
    assert.equal(uploads, 0);
    digits(backupGate, AUTH_PASSWORD);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(backupGate.open, true);
    assert.match(backupGate.querySelector('[data-password-status]').textContent, /备份密码不正确/);
    assert.equal(refreshed, 0);
    assert.equal(nodes.filter(item => item.className?.includes('operation-progress') && !item.removed).length, 0, '密码错误重试时不遗留上传浮层');
    digits(backupGate, '590247');
    await first.pending;
    assert.equal(refreshed, 1);
    assert.equal(success.open, true);
    assert.match(success.querySelector('#dataImportSuccessDescription').textContent, /访问密码已恢复为备份时的密码/);
    success.close();

    const second = await begin();
    confirmation.events.click({ target: { closest: selector => selector === '[data-import-confirm]' } });
    await waitForDialog(backupGate);
    backupGate.events.cancel({ preventDefault() {} });
    await second.pending;
    assert.equal(uploads, 1);
    assert.equal(output.textContent, '备份导入已取消。');
    const third = await begin();
    confirmation.events.cancel({ preventDefault() {} });
    await third.pending;
    assert.equal(uploads, 1);

    nodes.filter(item => item.className?.includes('operation-progress')).forEach(item => item.remove());
    backupPassword = AUTH_PASSWORD;
    const same = await begin();
    confirmation.events.click({ target: { closest: selector => selector === '[data-import-confirm]' } });
    await same.pending;
    assert.equal(backupGate.open, false, '同密码不弹出第二个密码窗口');
    assert.equal(uploads, 2);
    assert.equal(refreshed, 2);
});
