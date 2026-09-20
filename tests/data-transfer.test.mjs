import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

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
        await transfer.chooseImport();
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
        input.files = [{ name: 'backup.zip' }];
        const pending = input.events.change();
        assert.equal(confirmation.open, true);
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
});

test('导出和导入都要求写入 API，静态页面不提供全部数据备份', async t => {
    const nodes = [];
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
    await readonly.chooseImport();
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

    await transfer.chooseImport();
    for (let index = 0; index < 6; index += 1) {
        passwordDialog.events.click({
            target: { closest: selector => selector === '[data-password-key]' ? { dataset: { passwordKey: '8' } } : null }
        });
    }
    await new Promise(resolve => setImmediate(resolve));
    input.files = [{ name: 'backup.zip' }];
    const pending = input.events.change();
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
