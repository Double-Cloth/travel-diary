import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHandler } from '../js/server.js';
import { AUTH_PASSWORD, installAuth, login } from './helpers/auth.mjs';
import { listenOnFetchSafePort } from './helpers/http.mjs';
import { DRAFT_FORMAT } from '../js/record-input.mjs';

const require = createRequire(import.meta.url);
const { createAuthConfig } = require('../js/auth.js');

async function fixture(t, { configured = true, authSource } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-diary-auth-'));
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');
    if (authSource !== undefined) {
        await fs.mkdir(path.join(root, '.secrets'));
        await fs.writeFile(path.join(root, '.secrets/auth.json'), authSource);
    } else if (configured) {
        await installAuth(root);
    }
    const server = http.createServer(createHandler(root));
    const base = await listenOnFetchSafePort(server);
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    });
    return { base, root, server };
}

async function assertUnauthenticatedCapability(base, cookie = '') {
    const response = await fetch(`${base}/api/travel-records`, { headers: { Cookie: cookie } });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.authenticated, false);
    assert.equal(result.code, 'AUTH_REQUIRED');
    assert.deepEqual(result.methods, []);
    assert.equal(result.token, undefined);
    assert.equal(response.headers.get('cache-control'), 'no-store');
}

test('认证配置缺失或内容不完整时接口返回可直接展示的明确错误', async t => {
    await t.test('缺少 auth.json 时提示在页面创建密码', async t => {
        const { base, root } = await fixture(t, { configured: false });
        await fs.mkdir(path.join(root, '.secrets'));
        const response = await fetch(`${base}/api/travel-records`);
        const result = await response.json();
        assert.equal(response.status, 409);
        assert.equal(result.service, 'travel-diary-writer-v1');
        assert.equal(result.code, 'AUTH_SETUP_REQUIRED');
        assert.match(result.error, /当前页面创建新的 6 位数字密码/);
        assert.doesNotMatch(result.error, /npm run auth:set/);
    });

    await t.test('缺少必填字段时列出字段名称', async t => {
        const { base } = await fixture(t, { authSource: '{}' });
        const response = await fetch(`${base}/api/travel-records`);
        const result = await response.json();
        assert.equal(response.status, 503);
        assert.equal(result.code, 'AUTH_CONFIG_INVALID');
        assert.match(result.error, /内容不完整/);
        assert.match(result.error, /version/);
        assert.match(result.error, /hash/);
    });

    await t.test('JSON 损坏时提示重新创建配置', async t => {
        const { base } = await fixture(t, { authSource: '{invalid' });
        const response = await fetch(`${base}/api/travel-records`);
        const result = await response.json();
        assert.equal(response.status, 503);
        assert.equal(result.code, 'AUTH_CONFIG_INVALID');
        assert.match(result.error, /不是有效的 JSON 文件/);
        assert.match(result.error, /npm run auth:set/);
    });
});

test('本机首次设置接口创建密码、登录会话且不覆盖已有配置', async t => {
    const { base, root } = await fixture(t, { configured: false });
    const password = '483920';
    const setup = await fetch(`${base}/api/travel-auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ password })
    });
    const result = await setup.json();
    assert.equal(setup.status, 201);
    assert.equal(result.service, 'travel-diary-writer-v1');
    assert.equal(result.authenticated, true);
    assert.equal(result.token.length, 64);
    assert.match(setup.headers.get('set-cookie'), /HttpOnly/);
    const saved = JSON.parse(await fs.readFile(path.join(root, '.secrets/auth.json'), 'utf8'));
    assert.equal('password' in saved, false);

    const repeated = await fetch(`${base}/api/travel-auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ password: '590247' })
    });
    assert.equal(repeated.status, 409);
    assert.equal((await repeated.json()).code, 'AUTH_SETUP_ALREADY_COMPLETE');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, '.secrets/auth.json'), 'utf8')).hash, saved.hash);
});

test('首次设置接口拒绝弱密码和非同源页面', async t => {
    const weakFixture = await fixture(t, { configured: false });
    const weak = await fetch(`${weakFixture.base}/api/travel-auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: weakFixture.base },
        body: JSON.stringify({ password: '123456' })
    });
    assert.equal(weak.status, 400);
    assert.equal((await weak.json()).code, 'PASSWORD_TOO_WEAK');
    await assert.rejects(fs.access(path.join(weakFixture.root, '.secrets/auth.json')));

    const originFixture = await fixture(t, { configured: false });
    const withoutOrigin = await fetch(`${originFixture.base}/api/travel-auth/setup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '483920' })
    });
    assert.equal(withoutOrigin.status, 403);
    await assert.rejects(fs.access(path.join(originFixture.root, '.secrets/auth.json')));
});

test('能力端点不再公开令牌，登录后签发受限 HttpOnly 会话', async t => {
    const { base } = await fixture(t);
    const anonymous = await fetch(`${base}/api/travel-records`);
    assert.equal(anonymous.status, 200);
    const anonymousBody = await anonymous.json();
    assert.equal(anonymousBody.service, 'travel-diary-writer-v1');
    assert.equal(anonymousBody.token, undefined);
    assert.equal(anonymousBody.authenticated, false);
    assert.deepEqual(anonymousBody.methods, []);

    const missingOrigin = await fetch(`${base}/api/travel-auth`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: AUTH_PASSWORD })
    });
    assert.equal(missingOrigin.status, 403);
    const authenticated = await login(base);
    assert.equal(authenticated.response.status, 200);
    const setCookie = authenticated.response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.doesNotMatch(setCookie, /Max-Age|Expires/i);
    assert.doesNotMatch(setCookie, /; Secure/);
    assert.equal(authenticated.token.length, 64);

    await assertUnauthenticatedCapability(base);
    const capability = await fetch(`${base}/api/travel-records`, { headers: { Cookie: authenticated.cookie } });
    assert.equal(capability.status, 200);
    assert.equal((await capability.json()).authenticated, true);

    const logout = await fetch(`${base}/api/travel-auth`, {
        method: 'DELETE', headers: { Cookie: authenticated.cookie, Origin: base }
    });
    assert.equal(logout.status, 200);
    await assertUnauthenticatedCapability(base, authenticated.cookie);
});

test('会话跨请求复用但不会续期，到期后必须重新登录', async t => {
    const { base } = await fixture(t);
    const started = Date.now();
    let now = started;
    t.mock.method(Date, 'now', () => now);
    const authenticated = await login(base);
    assert.equal(authenticated.result.expiresIn, 8 * 60 * 60);
    const expiresAt = started + authenticated.result.expiresIn * 1000;
    for (now of [started + 1000, expiresAt - 1]) {
        const response = await fetch(`${base}/api/travel-records`, { headers: { Cookie: authenticated.cookie } });
        const result = await response.json();
        assert.equal(result.authenticated, true);
        assert.equal(result.token, authenticated.token);
    }
    now = expiresAt;
    await assertUnauthenticatedCapability(base, authenticated.cookie);
    const renewed = await login(base);
    assert.equal(renewed.response.status, 200);
    assert.notEqual(renewed.token, authenticated.token);
});

test('正常未登录探测不产生 HTTP 错误，但匿名写入仍拒绝且不修改档案', async t => {
    const { base, root } = await fixture(t);
    await assertUnauthenticatedCapability(base);
    for (const method of ['POST', 'PUT', 'DELETE']) {
        const response = await fetch(`${base}/api/travel-records`, {
            method,
            headers: { Origin: base, 'Content-Type': 'application/json' },
            body: '{}'
        });
        assert.equal(response.status, 401);
        assert.equal((await response.json()).code, 'AUTH_REQUIRED');
    }
    assert.equal(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'), '[]');
});

test('登录使用慢哈希验证，并在连续失败后限速', async t => {
    const { base } = await fixture(t);
    for (let index = 0; index < 5; index += 1) {
        const response = await fetch(`${base}/api/travel-auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: base },
            body: JSON.stringify({ password: `wrong-password-${index}` })
        });
        assert.equal(response.status, 401);
    }
    const blocked = await fetch(`${base}/api/travel-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ password: AUTH_PASSWORD })
    });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await blocked.json()).code, 'AUTH_RATE_LIMITED');
});

test('换密后旧会话立即失效', async t => {
    const { base, root } = await fixture(t);
    const authenticated = await login(base);
    assert.equal(authenticated.response.status, 200);
    const replacement = await createAuthConfig('590247');
    await fs.writeFile(path.join(root, '.secrets/auth.json'), `${JSON.stringify(replacement, null, 2)}\n`);
    await assertUnauthenticatedCapability(base, authenticated.cookie);
});

test('登录后可修改密码，自动签发新会话并使其他旧会话失效', async t => {
    const { base, root } = await fixture(t);
    const current = await login(base);
    const other = await login(base);
    const changed = await fetch(`${base}/api/travel-auth`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            Origin: base,
            Cookie: current.cookie,
            'X-Travel-Token': current.token
        },
        body: JSON.stringify({ password: '590247' })
    });
    const result = await changed.json();
    assert.equal(changed.status, 200);
    assert.equal(result.changed, true);
    assert.equal(result.authenticated, true);
    assert.equal(result.token.length, 64);
    const changedCookie = changed.headers.get('set-cookie')?.split(';', 1)[0] || '';
    assert.notEqual(changedCookie, current.cookie);
    await assertUnauthenticatedCapability(base, other.cookie);
    await assertUnauthenticatedCapability(base, current.cookie);
    assert.equal((await fetch(`${base}/api/travel-records`, { headers: { Cookie: changedCookie } })).status, 200);

    const saved = JSON.parse(await fs.readFile(path.join(root, '.secrets/auth.json'), 'utf8'));
    assert.equal('password' in saved, false);
    const oldLogin = await fetch(`${base}/api/travel-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ password: AUTH_PASSWORD })
    });
    assert.equal(oldLogin.status, 401);
    const newLogin = await fetch(`${base}/api/travel-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ password: '590247' })
    });
    assert.equal(newLogin.status, 200);
});

test('修改密码拒绝缺少会话、无效令牌、弱密码和当前密码', async t => {
    const { base } = await fixture(t);
    const authenticated = await login(base);
    const request = (password, headers = {}) => fetch(`${base}/api/travel-auth`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json', Origin: base,
            Cookie: authenticated.cookie,
            'X-Travel-Token': authenticated.token,
            ...headers
        },
        body: JSON.stringify({ password })
    });
    const anonymous = await fetch(`${base}/api/travel-auth`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ password: '590247' })
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await request('590247', { 'X-Travel-Token': 'invalid' })).status, 403);
    const weak = await request('123456');
    assert.equal(weak.status, 400);
    assert.equal((await weak.json()).code, 'PASSWORD_TOO_WEAK');
    const unchanged = await request(AUTH_PASSWORD);
    assert.equal(unchanged.status, 400);
    assert.equal((await unchanged.json()).code, 'PASSWORD_UNCHANGED');
});

test('认证接口兼容带 charset 的 JSON，并在读取前拒绝超大请求', async t => {
    const { base } = await fixture(t);
    const valid = await fetch(`${base}/api/travel-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Origin: base },
        body: JSON.stringify({ password: AUTH_PASSWORD })
    });
    assert.equal(valid.status, 200);
    const oversized = await fetch(`${base}/api/travel-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ password: '9'.repeat(5000) })
    });
    assert.equal(oversized.status, 413);
});

function jsonRequest(base, route, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request(`${base}${route}`, { method: 'POST', headers: {
            Origin: base, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked', ...headers
        } }, response => {
            let content = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { content += chunk; });
            response.on('error', reject);
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(content) }));
        });
        request.on('error', reject);
        request.setTimeout(5000, () => request.destroy(new Error('JSON 请求超时')));
        request.end(body);
    });
}

test('首次设密与登录对畸形和分块超限 JSON 返回 400 或 413，后续请求仍正常', async t => {
    for (const configured of [false, true]) {
        const { base } = await fixture(t, { configured });
        const route = configured ? '/api/travel-auth' : '/api/travel-auth/setup';
        assert.equal((await jsonRequest(base, route, '{')).status, 400);
        assert.equal((await jsonRequest(base, route, JSON.stringify({ password: '9'.repeat(5000) }))).status, 413);
        const response = await fetch(`${base}${route}`, {
            method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: AUTH_PASSWORD })
        });
        assert.equal(response.status, configured ? 200 : 201);
    }
});

test('JSON 上传期间注销后，记录写入、资料保存和备份选择均拒绝且不留暂存文件', async t => {
    const { base, root, server } = await fixture(t);
    const desc_md = 'data/travel-diary/2026/2026-11-04-audit.md';
    const record = { date: '2026-11-04', country: '中国', country_code: 'CN', locality: '苏州', desc_md, photos: [] };
    const index = JSON.stringify([record]);
    const markdown = '# 原标题\n\n原正文\n';
    await fs.mkdir(path.join(root, 'assets/catalogs'), { recursive: true });
    await fs.writeFile(path.join(root, 'assets/catalogs/countries.json'), JSON.stringify({ countries: [{ code: 'CN', name_zh: '中国' }] }));
    await fs.mkdir(path.join(root, 'data/travel-diary/2026'), { recursive: true });
    await fs.mkdir(path.join(root, 'data/profile'));
    await fs.writeFile(path.join(root, 'data/profile/owner-name.txt'), '原署名');
    await fs.writeFile(path.join(root, desc_md), markdown);
    await fs.writeFile(path.join(root, 'data/travel_data.json'), index);
    const draft = { format: DRAFT_FORMAT, requestId: 'a'.repeat(32), uploads: [], input: {
        date: record.date, country: record.country, country_code: record.country_code, admin_area: '', admin_area_type: '',
        locality: record.locality, locality_type: '', trip_id: '', title: '新标题', body: '新正文',
        desc_md, photo_folder: '', photos: [], video_folder: '', videos: []
    } };
    for (const [route, method, payload] of [
        ['/api/travel-profile', 'PUT', { name: '新署名' }],
        ['/api/travel-records', 'POST', { ...draft, input: { ...draft.input, desc_md: desc_md.replace('audit.md', 'new.md') } }],
        ['/api/travel-records', 'PUT', { originalDescMd: desc_md, draft }],
        ['/api/travel-records', 'DELETE', { desc_md }],
        ['/api/travel-data?mode=select', 'POST', { paths: [desc_md] }]
    ]) {
        const { cookie, token } = await login(base);
        // 等到服务端已读取认证并进入请求体迭代，再注销，避免依赖定时延迟。
        const reading = new Promise(resolve => server.once('request', request => {
            const onListener = event => {
                if (event !== 'readable') return;
                request.removeListener('newListener', onListener);
                resolve();
            };
            request.on('newListener', onListener);
        }));
        const body = JSON.stringify(payload);
        let upload;
        const responsePromise = new Promise((resolve, reject) => {
            upload = http.request(`${base}${route}`, { method, headers: {
                Origin: base, 'Content-Type': 'application/json', Cookie: cookie, 'X-Travel-Token': token,
                'Transfer-Encoding': 'chunked'
            } }, response => {
                response.resume();
                response.on('error', reject);
                response.on('end', () => resolve(response.statusCode));
            });
            upload.on('error', reject);
            upload.setTimeout(5000, () => upload.destroy(new Error('上传测试超时')));
            upload.write(body.slice(0, body.length >> 1));
        });
        await reading;
        assert.equal((await fetch(`${base}/api/travel-auth`, { method: 'DELETE', headers: { Cookie: cookie, Origin: base } })).status, 200);
        upload.end(body.slice(body.length >> 1));
        assert.equal(await responsePromise, 401, `${method} ${route}`);
        assert.equal(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'), index);
        assert.equal(await fs.readFile(path.join(root, desc_md), 'utf8'), markdown);
        assert.equal(await fs.readFile(path.join(root, 'data/profile/owner-name.txt'), 'utf8'), '原署名');
        assert.equal((await fs.readdir(root)).includes('.travel-data.lock'), false);
    }
    assert.deepEqual(await fs.readdir(path.join(root, 'data/travel-diary/2026')), ['2026-11-04-audit.md']);
});
