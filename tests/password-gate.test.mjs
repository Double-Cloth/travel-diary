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

test('验证中服务中断或返回网关错误时可在原窗口重试并保留操作上下文', async t => {
    const nodes = installDialogEnvironment(t);
    let failure = 'interrupted';
    let calls = 0;
    const context = { desc_md: 'data/travel-diary/2026/test.md' };
    globalThis.fetch = async (_, options) => {
        if (options.method === 'POST' && failure === 'interrupted') {
            return { ok: true, status: 200, json: async () => { throw new TypeError('terminated'); } };
        }
        if (options.method === 'POST' && failure === 'gateway') return new Response('Bad Gateway', { status: 502 });
        return Response.json({ service: 'travel-diary-writer-v1',
            authenticated: options.method === 'POST', token: options.method === 'POST' ? 'restored' : undefined });
    };
    const open = createPasswordGate((capability, verifiedContext) => {
        calls += 1;
        assert.equal(capability.token, 'restored');
        assert.equal(verifiedContext, context);
    });
    const dialog = nodes.at(-1);
    await open(context);
    const count = nodes.length;
    for (failure of ['interrupted', 'gateway']) {
        await enterPassword(dialog);
        assert.equal(dialog.open, true);
        assert.equal(calls, 0);
        assert.equal(nodes.length, count);
        assert.match(dialog.querySelector('[data-password-status]').textContent, /连接中断/);
    }
    failure = '';
    await enterPassword(dialog);
    assert.equal(calls, 1);
    assert.equal(dialog.open, false);
});

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

test('首次登录后跨入口复用会话，失效时重新验证，失败的操作不触发密码窗口', async t => {
    const nodes = installDialogEnvironment(t);
    let authenticated = false;
    let logins = 0;
    const calls = [];
    globalThis.fetch = async (_endpoint, options) => {
        if (options.method === 'POST') { authenticated = true; logins += 1; }
        return { ok: true, status: 200, json: async () => ({
            service: 'travel-diary-writer-v1', authenticated,
            token: authenticated ? 'session-token' : undefined, methods: ['POST', 'PUT', 'DELETE']
        }) };
    };
    const openFirst = createPasswordGate((...args) => { calls.push(args); });
    const firstDialog = nodes.at(-1);
    await openFirst('first');
    assert.equal(firstDialog.open, true);
    await enterPassword(firstDialog);
    assert.equal(logins, 1);

    const openOther = createPasswordGate((...args) => { calls.push(args); });
    const otherDialog = nodes.at(-1);
    await openOther('other');
    assert.equal(otherDialog.open, false);
    assert.equal(calls.at(-1)[0].token, 'session-token');
    assert.equal(calls.at(-1)[1], 'other');
    assert.equal(calls.at(-1)[2], undefined, '会话复用不缓存明文密码');
    assert.equal(logins, 1);

    const failing = createPasswordGate(() => { throw new Error('操作失败'); });
    const failingDialog = nodes.at(-1);
    await failing();
    assert.equal(failingDialog.open, false);
    assert.equal(logins, 1);

    authenticated = false;
    await openOther('expired');
    assert.equal(otherDialog.open, true);
    assert.equal(calls.length, 2);
    await enterPassword(otherDialog);
    assert.equal(logins, 2);
    assert.equal(calls.at(-1)[1], 'expired');
});

test('复用会话仍先确认危险操作，且执行期间重复点击不会再次执行', async t => {
    const nodes = installDialogEnvironment(t);
    const events = [];
    let confirmed = false;
    let finish;
    globalThis.fetch = async () => {
        events.push('probe');
        return { ok: true, status: 200, json: async () => ({
            service: 'travel-diary-writer-v1', authenticated: true, token: 'session-token'
        }) };
    };
    const open = createPasswordGate(async () => {
        events.push('action');
        await new Promise(resolve => { finish = resolve; });
    }, { beforePrompt: () => { events.push('confirm'); return confirmed; } });
    const dialog = nodes.at(-1);
    await open();
    assert.deepEqual(events, ['confirm']);
    confirmed = true;
    const pending = open();
    await new Promise(resolve => setImmediate(resolve));
    await open();
    assert.deepEqual(events, ['confirm', 'confirm', 'probe', 'action']);
    assert.equal(dialog.open, false);
    finish();
    await pending;
});

test('点击先确认风险，取消及重复点击不探测服务，确认后才验证密码并执行原操作', async t => {
    const nodes = installDialogEnvironment(t);
    const requests = [];
    const confirmations = [];
    let finishConfirmation;
    let verified;
    globalThis.fetch = async (endpoint, options) => {
        requests.push(endpoint.href);
        return {
            ok: true, status: 200,
            json: async () => ({
                service: 'travel-diary-writer-v1',
                authenticated: options.method === 'POST',
                token: options.method === 'POST' ? 'test-token' : undefined,
                methods: ['POST', 'PUT', 'DELETE']
            })
        };
    };
    const open = createPasswordGate((...args) => { verified = args; }, {
        beforePrompt: context => {
            confirmations.push(context);
            return new Promise(resolve => { finishConfirmation = resolve; });
        }
    });
    const dialog = nodes.at(-1);
    const original = { id: 'original' };
    const ignored = { id: 'ignored' };
    const cancelled = open(original);
    assert.deepEqual(confirmations, [original]);
    assert.equal(dialog.open, false);
    assert.equal(requests.length, 0);
    await open(ignored);
    assert.deepEqual(confirmations, [original]);
    finishConfirmation(false);
    await cancelled;
    assert.equal(requests.length, 0);
    assert.equal(dialog.open, false);
    assert.equal(verified, undefined);

    const accepted = open(original);
    finishConfirmation(true);
    await accepted;
    assert.equal(requests.length, 1);
    assert.equal(dialog.open, true);
    assert.equal(verified, undefined);
    await enterPassword(dialog);
    assert.equal(requests.length, 2);
    assert.equal(verified[1], original);
    assert.equal(dialog.open, false);

    const reopened = open(ignored);
    assert.deepEqual(confirmations, [original, original, ignored]);
    assert.equal(dialog.open, false);
    finishConfirmation(false);
    await reopened;
    assert.equal(requests.length, 2);
});

test('首次设密与静态只读处理都在危险确认之后', async t => {
    const nodes = installDialogEnvironment(t);
    for (const setupRequired of [true, false]) {
        const events = [];
        globalThis.fetch = async () => {
            events.push('probe');
            return {
                ok: !setupRequired, status: setupRequired ? 409 : 200,
                json: async () => setupRequired
                    ? { service: 'travel-diary-writer-v1', code: 'AUTH_SETUP_REQUIRED' }
                    : { service: 'travel-diary-static-v1', readonly: true }
            };
        };
        const open = createPasswordGate(() => assert.fail('尚未输入密码，不应执行操作'), {
            beforePrompt: () => { events.push('confirm'); return true; },
            onStatic: () => { events.push('static'); }
        });
        const dialog = nodes.at(-1);
        await open();
        assert.deepEqual(events, setupRequired ? ['confirm', 'probe'] : ['confirm', 'probe', 'static']);
        assert.equal(dialog.open, setupRequired);
        if (setupRequired) {
            assert.equal(dialog.querySelector('[data-password-note]').textContent, '请输入新的 6 位数字密码。');
            dialog.events.cancel({ preventDefault() {} });
        }
    }
});
