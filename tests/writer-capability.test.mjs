import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const { initializeWriterPassword, probeWriterService } = await loadBrowserModule(new URL('../js/writer-capability.js', import.meta.url));

test('写入服务探测只把明确的静态标记识别为静态页面', async t => {
    const previous = { window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.window = { location: { href: 'https://diary.example/' } };

    globalThis.fetch = async () => ({
        status: 200,
        json: async () => ({ service: 'travel-diary-static-v1', readonly: true })
    });
    await assert.rejects(probeWriterService(), error => error.code === 'STATIC_READONLY');

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
    globalThis.fetch = async () => ({
        status: 401,
        json: async () => ({
            service: 'travel-diary-writer-v1',
            authenticated: false,
            methods: [],
            writeMode: 'remote'
        })
    });

    const capability = await probeWriterService();
    assert.equal(capability.status, 401);
    assert.equal(capability.authenticated, false);
    assert.equal(capability.writeMode, 'remote');
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
