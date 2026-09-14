import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const { probeWriterService } = await loadBrowserModule(new URL('../js/writer-capability.js', import.meta.url));

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
