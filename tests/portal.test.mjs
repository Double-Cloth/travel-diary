import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadRuntimeConfig } from '../js/runtime-config.js';
import { normalizeBasePath, normalizePublicOrigin } from '../js/deployment-config.js';
import { createHandler, ensureDataStructure, parseArgs } from '../js/server.js';
import { AUTH_PASSWORD, installAuth } from './helpers/auth.mjs';
import { listenOnFetchSafePort } from './helpers/http.mjs';

async function fixture(t, basePath = '/') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-portal-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await ensureDataStructure(root);
    await installAuth(root);
    await fs.writeFile(path.join(root, 'travel-diary.config.json'), JSON.stringify({
        server: { basePath, publicOrigin: 'https://diary.example:63445', writeMode: 'remote' },
        mediaPreviews: { enabled: false }
    }));
    const server = http.createServer(createHandler(root));
    const address = await listenOnFetchSafePort(server);
    t.after(() => new Promise(resolve => server.close(resolve)));
    const request = (route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
        const req = http.request(address + route, {
            method, headers: { Host: 'diary.example:63445', Origin: 'https://diary.example:63445', ...headers }
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const login = password => request('/api/travel-auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { password: password ?? AUTH_PASSWORD }
    });
    return { root, request, login };
}

test('公开路径和 Origin 严格校验，支持多级前缀及 HTTPS 端口规范化', () => {
    for (const [input, expected] of [['/', '/'], ['/diary/', '/diary'], ['/travel/log', '/travel/log']]) {
        assert.equal(normalizeBasePath(input), expected);
    }
    for (const invalid of ['', null, 'diary', '//diary', '/diary//', '/a/../b', '/a/./b', '/%64iary',
        '/diary?x', '/diary#x', '/diary;Path=/', '/diary\\api', '/日记', '/a\r\n', '/a b', '/'.repeat(257)]) {
        assert.throws(() => normalizeBasePath(invalid), /basePath/);
    }
    assert.equal(normalizePublicOrigin(''), '');
    assert.equal(normalizePublicOrigin('https://diary.example:63445'), 'https://diary.example:63445');
    assert.equal(normalizePublicOrigin('https://DIARY.example:443'), 'https://diary.example');
    for (const invalid of ['http://diary.example', 'https://diary.example/', 'https://diary.example/diary',
        'https://user:secret@diary.example', 'https://@diary.example', 'https://diary.example?x',
        'https://diary.example#x', 'https://diary.example:65536', 'https://diary.example:0', 'https://diary.example:', '*', null]) {
        assert.throws(() => normalizePublicOrigin(invalid), /publicOrigin/);
    }
});

test('公开配置在环境变量、JSON 与 CLI 中使用同一校验和优先级', async t => {
    const { root } = await fixture(t);
    const config = loadRuntimeConfig(root, { TRAVEL_BASE_PATH: '/travel/', TRAVEL_PUBLIC_ORIGIN: 'https://new.example:443' });
    assert.equal(config.server.basePath, '/travel');
    assert.deepEqual(config.server.allowedOrigins, ['https://new.example']);
    assert.deepEqual(parseArgs(['--dir', root, '--allowed-origin=https://override.example']).allowedOrigins, ['https://override.example']);
    for (const environment of [{ TRAVEL_BASE_PATH: '/..' }, { TRAVEL_PUBLIC_ORIGIN: 'https://a/path' }]) {
        assert.throws(() => loadRuntimeConfig(root, environment), /环境变量 TRAVEL_/);
    }
    await fs.writeFile(path.join(root, 'travel-diary.config.json'), JSON.stringify({
        server: { publicOrigin: 'https://diary.example:63445', writeMode: 'local' }
    }));
    assert.deepEqual(parseArgs(['--dir', root, '--write-mode=remote']).allowedOrigins, ['https://diary.example:63445']);
    assert.doesNotThrow(() => createHandler(root, { writeMode: 'remote', generateMediaPreviews: false }));
    await fs.writeFile(path.join(root, 'travel-diary.config.json'), '{"server":{"basePath":"/../"}}');
    assert.throws(() => loadRuntimeConfig(root, {}), /配置文件.*无效/);
});

for (const basePath of ['/', '/diary/', '/travel/log']) {
    test(`${basePath} 登录、刷新、换密、会话失效与注销使用固定 Cookie Path`, async t => {
        const { request, login } = await fixture(t, basePath);
        const cookiePath = `${basePath === '/' ? '' : basePath.replace(/\/$/, '')}/api`;
        const session = await login();
        assert.equal(session.status, 200);
        assert.ok(session.headers['set-cookie'][0].includes(`Path=${cookiePath}; HttpOnly; SameSite=Strict`));
        assert.match(session.headers['set-cookie'][0], /; Secure$/);
        const cookie = session.headers['set-cookie'][0].split(';')[0];
        const token = JSON.parse(session.body).token;
        const headers = { Cookie: cookie, 'X-Travel-Token': token, 'Content-Type': 'application/json' };
        assert.equal(JSON.parse((await request('/api/travel-records', { headers })).body).authenticated, true);
        const changed = await request('/api/travel-auth', { method: 'PUT', headers, body: { password: '590247' } });
        assert.equal(changed.status, 200, changed.body.toString());
        assert.ok(changed.headers['set-cookie'][0].includes(`Path=${cookiePath};`));
        assert.equal(JSON.parse((await request('/api/travel-records', { headers })).body).authenticated, false);
        const renewed = await login('590247');
        assert.equal(renewed.status, 200);
        const nextHeaders = { ...headers, Cookie: renewed.headers['set-cookie'][0].split(';')[0],
            'X-Travel-Token': JSON.parse(renewed.body).token, 'X-Forwarded-Prefix': '/evil' };
        const logout = await request('/api/travel-auth', { method: 'DELETE', headers: nextHeaders });
        assert.equal(logout.status, 200);
        assert.ok(logout.headers['set-cookie'][0].includes(`Path=${cookiePath};`));
        assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
        assert.equal(JSON.parse((await request('/api/travel-records', { headers: nextHeaders })).body).authenticated, false);
        assert.equal((await login('590247')).status, 200);
    });
}

test('带端口来源仍要求 Host、Origin、会话和写入令牌，伪造代理头无效', async t => {
    const { request } = await fixture(t, '/diary');
    for (const headers of [
        { Host: 'diary.example' }, { Origin: 'https://diary.example' }, { Origin: 'https://evil.example:63445' },
        { Host: 'evil.example', 'X-Forwarded-Host': 'diary.example:63445', 'X-Forwarded-Proto': 'https',
            Forwarded: 'host=diary.example:63445;proto=https' }
    ]) {
        const response = await request('/api/travel-auth', { method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers }, body: { password: AUTH_PASSWORD } });
        assert.equal(response.status, 403);
    }
    assert.equal((await request('/api/travel-records', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: {} })).status, 401);
});

test('剥离前缀后目录重定向保留公开路径、编码与查询，媒体 Range 不变', async t => {
    const { root, request } = await fixture(t, '/travel');
    await fs.mkdir(path.join(root, 'data/photos/测试 100%'));
    const redirected = await request('/data/photos/%E6%B5%8B%E8%AF%95%20100%25?x=a%26b');
    assert.equal(redirected.status, 301);
    assert.equal(redirected.headers.location, '/travel/data/photos/%E6%B5%8B%E8%AF%95%20100%25/?x=a%26b');
    await fs.writeFile(path.join(root, 'data/videos/test.mp4'), '0123456789');
    const range = await request('/data/videos/test.mp4', { headers: { Range: 'bytes=2-5' } });
    assert.equal(range.status, 206);
    assert.equal(range.body.toString(), '2345');
    assert.equal(range.headers['content-range'], 'bytes 2-5/10');
    for (const route of ['/data/%2e%2e/.secrets/auth.json', '/data/%00', '/data/%2e%2e/%2e%2e/outside']) {
        assert.notEqual((await request(route)).status, 200);
    }
});
