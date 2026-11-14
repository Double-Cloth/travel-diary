import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadBrowserModule } from './helpers/browser-modules.mjs';
import { listenOnFetchSafePort } from './helpers/http.mjs';

const { authenticateWriter, changeWriterPassword, initializeWriterPassword, probeWriterService } = await loadBrowserModule(new URL('../js/writer-capability.js', import.meta.url));
const { verifyBackupPassword } = await loadBrowserModule(new URL('../js/backup-password.js', import.meta.url));

test('清空回收站仅接受服务明确声明的支持状态', async t => {
    const previous = { window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.window = { location: { href: 'https://diary.example/' } };
    let recycleClear;
    globalThis.fetch = async () => ({ status: 200, json: async () => ({ service: 'travel-diary-writer-v1', recycleClear }) });
    assert.equal((await probeWriterService()).recycleClear, false);
    recycleClear = true;
    assert.equal((await probeWriterService()).recycleClear, true);
});

test('写入服务探测拒绝旧只读标记、未知响应及连接失败', async t => {
    const previous = { window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.window = { location: { href: 'https://diary.example/' } };

    globalThis.fetch = async () => ({
        status: 200,
        json: async () => ({ service: 'travel-diary-static-v1', readonly: true })
    });
    await assert.rejects(probeWriterService(), error => error.code === 'WRITER_INVALID_RESPONSE');

    globalThis.fetch = async () => ({ status: 404, json: async () => { throw new Error('Not Found'); } });
    await assert.rejects(probeWriterService(), error => error.code === 'WRITER_INVALID_RESPONSE');

    globalThis.fetch = async () => { throw new Error('连接超时'); };
    await assert.rejects(probeWriterService(), error => error.code === 'WRITER_UNREACHABLE');

    globalThis.fetch = async () => ({ status: 200, json: async () => ({ unexpected: true }) });
    await assert.rejects(probeWriterService(), error => error.code === 'WRITER_INVALID_RESPONSE');
});

test('检测到未登录的动态写入服务时仍返回服务能力并要求后续认证', async t => {
    const previous = { window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.window = { location: { href: 'https://diary.example/' } };
    for (const status of [200, 401]) {
        globalThis.fetch = async () => ({
            ok: status === 200,
            status,
            json: async () => ({
                service: 'travel-diary-writer-v1',
                authenticated: false,
                methods: [],
                writeMode: 'remote'
            })
        });

        const capability = await probeWriterService();
        assert.equal(capability.status, status);
        assert.equal(capability.authenticated, false);
        assert.equal(capability.token, undefined);
        assert.equal(capability.methods.size, 0);
        assert.equal(capability.writeMode, 'remote');
    }
});

test('写入服务认证配置异常时保留服务端错误码和明确提示', async t => {
    const previous = { window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.window = { location: { href: 'https://diary.example/' } };
    globalThis.fetch = async () => ({
        ok: false,
        status: 503,
        json: async () => ({
            service: 'travel-diary-writer-v1',
            code: 'AUTH_CONFIG_INVALID',
            error: '.secrets/auth.json 内容不完整，请运行 npm run auth:set 修复。'
        })
    });

    await assert.rejects(probeWriterService(), error => {
        assert.equal(error.code, 'AUTH_CONFIG_INVALID');
        assert.match(error.message, /npm run auth:set/);
        return true;
    });
});

test('真实媒体同步、混合排序、删除缺失引用及回收站批量操作能力必须由服务明确声明', async t => {
    const previous = { window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.window = { location: { href: 'http://localhost:9000/' } };
    for (const flag of [undefined, false, 'true', true]) {
        globalThis.fetch = async () => ({
            ok: true, status: 200,
            json: async () => ({ service: 'travel-diary-writer-v1', authenticated: true, token: 'test', methods: ['PUT'], syncMediaFiles: flag, mediaOrder: flag, mixedMediaOrder: flag, mediaReferenceRemoval: flag, recycleSelection: flag, recyclePurgeSelection: flag })
        });
        const capability = await probeWriterService();
        assert.equal(capability.syncMediaFiles, flag === true);
        assert.equal(capability.mediaOrder, flag === true);
        assert.equal(capability.mixedMediaOrder, flag === true);
        assert.equal(capability.mediaReferenceRemoval, flag === true);
        assert.equal(capability.recycleSelection, flag === true);
        assert.equal(capability.recyclePurgeSelection, flag === true);
    }
});

test('写入服务未设置密码时保留首次设置状态', async t => {
    const previous = { window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.window = { location: { href: 'http://localhost:9000/' } };
    globalThis.fetch = async () => ({
        ok: false,
        status: 409,
        json: async () => ({
            service: 'travel-diary-writer-v1',
            code: 'AUTH_SETUP_REQUIRED',
            error: '尚未设置访问密码，请在当前页面创建。'
        })
    });
    await assert.rejects(probeWriterService(), error => {
        assert.equal(error.code, 'AUTH_SETUP_REQUIRED');
        assert.doesNotMatch(error.message, /npm run auth:set/);
        return true;
    });
});

test('首次设置密码提交到专用同源接口并返回写入能力', async t => {
    const previous = { window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.window = { location: { href: 'http://localhost:9000/#cover' } };
    let request;
    globalThis.fetch = async (endpoint, options) => {
        request = { endpoint: endpoint.href, options };
        return {
            ok: true,
            status: 201,
            json: async () => ({
                service: 'travel-diary-writer-v1', authenticated: true,
                token: 'a'.repeat(64), methods: ['POST', 'PUT', 'DELETE'], writeMode: 'local'
            })
        };
    };
    const capability = await initializeWriterPassword('483920');
    assert.equal(request.endpoint, 'http://localhost:9000/api/travel-auth/setup');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(request.options.body), { password: '483920' });
    assert.equal(capability.authenticated, true);
    assert.equal(capability.token, 'a'.repeat(64));
});

test('修改密码使用现有会话令牌并接收更新后的写入能力', async t => {
    const previous = { window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.window = { location: { href: 'http://localhost:9000/#archive' } };
    let request;
    globalThis.fetch = async (endpoint, options) => {
        request = { endpoint: endpoint.href, options };
        return {
            ok: true,
            status: 200,
            json: async () => ({
                service: 'travel-diary-writer-v1', authenticated: true, changed: true,
                token: 'b'.repeat(64), methods: ['POST', 'PUT', 'DELETE'], writeMode: 'local'
            })
        };
    };
    const capability = await changeWriterPassword('590247', {
        authenticated: true,
        token: 'a'.repeat(64)
    });
    assert.equal(request.endpoint, 'http://localhost:9000/api/travel-auth');
    assert.equal(request.options.method, 'PUT');
    assert.equal(request.options.headers['X-Travel-Token'], 'a'.repeat(64));
    assert.equal(request.options.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(request.options.body), { password: '590247' });
    assert.equal(capability.token, 'b'.repeat(64));
});

test('认证及备份验证遇到中断、网关错误和无效响应时保留服务故障信息', async t => {
    const previous = { window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.window = { location: { href: 'http://localhost:9000/' } };
    const capability = { authenticated: true, token: 'test-token' };
    const entries = [{ name: '.secrets/auth.json', data: '{}' }];
    const requests = [
        () => probeWriterService(),
        () => authenticateWriter('483920'),
        () => initializeWriterPassword('483920'),
        () => changeWriterPassword('590247', capability),
        () => verifyBackupPassword(entries, capability, '483920')
    ];
    for (const request of requests) {
        globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
        await assert.rejects(request(), error => error.code === 'WRITER_UNREACHABLE');
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new TypeError('terminated'); } });
        await assert.rejects(request(), error => error.code === 'WRITER_UNREACHABLE');
        globalThis.fetch = async () => new Response('<html>Bad Gateway</html>', { status: 502 });
        await assert.rejects(request(), error => error.code === 'WRITER_UNAVAILABLE');
        globalThis.fetch = async () => Response.json({ error: '服务维护中。' }, { status: 503 });
        await assert.rejects(request(), { code: 'WRITER_UNAVAILABLE', message: '服务维护中。' });
        for (const value of [null, [], 'ok']) {
            globalThis.fetch = async () => Response.json(value);
            await assert.rejects(request(), error => error.code === 'WRITER_INVALID_RESPONSE');
        }
    }
});

test('服务端明确返回的认证错误码在登录和备份预验证中保留', async t => {
    const previous = { window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.window = { location: { href: 'http://localhost:9000/' } };
    for (const code of ['AUTH_INVALID', 'AUTH_RATE_LIMITED', 'AUTH_CONFIG_INVALID']) {
        globalThis.fetch = async () => Response.json({ error: '验证未通过。', code }, { status: 503 });
        await assert.rejects(authenticateWriter('483920'), { code });
    }
    globalThis.fetch = async () => Response.json({ error: '备份密码不正确。', code: 'BACKUP_PASSWORD_INVALID' }, { status: 403 });
    await assert.rejects(verifyBackupPassword([{ name: '.secrets/auth.json', data: '{}' }], { token: 'test' }, '483920'),
        { code: 'BACKUP_PASSWORD_INVALID' });
});

test('认证响应体停滞同样受请求超时限制，服务恢复后可重新验证', async t => {
    const previous = globalThis.window;
    t.after(() => { globalThis.window = previous; });
    let stalled = true;
    const server = createServer((request, response) => {
        request.resume();
        response.setHeader('Content-Type', 'application/json');
        if (stalled) response.write('{"service":');
        else response.end(JSON.stringify({ service: 'travel-diary-writer-v1', authenticated: true, token: 'restored' }));
    });
    const base = await listenOnFetchSafePort(server);
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    globalThis.window = { location: { href: `${base}/` } };
    await assert.rejects(authenticateWriter('483920', 100), { code: 'WRITER_UNREACHABLE' });
    stalled = false;
    assert.equal((await authenticateWriter('483920')).token, 'restored');
});
