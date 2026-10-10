import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const { createPasswordGate } = await loadBrowserModule(new URL('../js/record-password.js', import.meta.url));

function installDialogEnvironment(t) {
    const nodes = [];
    function node() {
        const children = new Map();
        return {
            events: {}, open: false,
            classList: { add() {}, remove() {}, toggle() {} },
            setAttribute() {}, focus() {},
            addEventListener(name, handler) { this.events[name] = handler; },
            querySelectorAll() { return []; },
            querySelector(selector) {
                if (!children.has(selector)) children.set(selector, node());
                return children.get(selector);
            },
            showModal() { this.open = true; }, close() { this.open = false; }
        };
    }
    const previous = {
        document: globalThis.document, window: globalThis.window,
        fetch: globalThis.fetch, requestAnimationFrame: globalThis.requestAnimationFrame
    };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.document = {
        createElement() { const element = node(); nodes.push(element); return element; },
        body: { append() {} }, querySelector: () => null
    };
    globalThis.window = { location: { href: 'http://localhost:9000/#ledger' } };
    globalThis.requestAnimationFrame = callback => callback();
    return nodes;
}

async function enterPassword(dialog) {
    for (const key of '483920') {
        dialog.events.keydown({ key, preventDefault() {}, stopPropagation() {} });
    }
    // 验证由键盘事件异步触发，等待请求和回调完成。
    await new Promise(resolve => setImmediate(resolve));
}

test('标准登录不把记录上下文传作超时时间，验证成功后仍传回原记录', async t => {
    const nodes = installDialogEnvironment(t);
    const requests = [];
    globalThis.fetch = async (endpoint, options) => {
        requests.push({ endpoint: endpoint.href, options });
        return {
            ok: true, status: 200,
            json: async () => ({
                service: 'travel-diary-writer-v1',
                authenticated: options.method === 'POST',
                token: options.method === 'POST' ? 'test-token' : undefined,
                methods: ['POST', 'PUT', 'DELETE'], writeMode: 'local'
            })
        };
    };
    for (const context of [undefined, { desc_md: 'data/travel-diary/2026/test.md' }]) {
        let verified;
        const open = createPasswordGate((...args) => { verified = args; });
        const dialog = nodes.at(-1);
        await open(context);
        assert.equal(dialog.open, true);
        await enterPassword(dialog);
        assert.ok(verified, dialog.querySelector('[data-password-status]').textContent);
        assert.equal(verified[0].authenticated, true);
        assert.equal(verified[0].token, 'test-token');
        assert.equal(verified[1], context);
        assert.equal(verified[2], '483920');
        assert.equal(dialog.open, false);
        const request = requests.at(-1);
        assert.equal(request.endpoint, 'http://localhost:9000/api/travel-auth');
        assert.equal(request.options.method, 'POST');
        assert.equal(request.options.credentials, 'same-origin');
        assert.equal(request.options.signal instanceof AbortSignal, true);
        assert.deepEqual(JSON.parse(request.options.body), { password: '483920' });
    }
});

test('自定义备份密码验证仍接收密码和导入上下文', async t => {
    const nodes = installDialogEnvironment(t);
    globalThis.fetch = async () => { assert.fail('自定义验证不应调用标准认证接口'); };
    const context = { file: 'backup.zip', token: 'import-token' };
    const capability = { authenticated: true, token: 'backup-token' };
    let verifierArgs;
    let verifiedArgs;
    const open = createPasswordGate((...args) => { verifiedArgs = args; }, {
        verifyPassword: async (...args) => { verifierArgs = args; return capability; }
    });
    const dialog = nodes.at(-1);
    await open(context);
    await enterPassword(dialog);
    assert.deepEqual(verifierArgs, ['483920', context]);
    assert.deepEqual(verifiedArgs, [capability, context, '483920']);
    assert.equal(dialog.open, false);
});
