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
            setAttribute() {}, focus() {},
            addEventListener(name, handler) { this.events[name] = handler; },
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
    globalThis.window = { location: { hostname: 'localhost', href: 'http://localhost:9000/' } };
    globalThis.fetch = async (_, options) => ({
        ok: true, json: async () => options?.method === 'POST' ? { imported: true } : { token: 'test' }
    });
    let refreshFails = true;
    createDataTransfer(async () => { if (refreshFails) throw new Error('模拟刷新失败'); });
    const [input, confirmation, success] = nodes;
    async function importFile() {
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
