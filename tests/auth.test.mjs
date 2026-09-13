import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHandler } from '../js/server.js';
import { AUTH_PASSWORD, installAuth, login } from './helpers/auth.mjs';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-diary-auth-'));
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');
    await installAuth(root);
    const server = http.createServer(createHandler(root));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    });
    return { base };
}

test('能力端点不再公开令牌，登录后签发受限 HttpOnly 会话', async t => {
    const { base } = await fixture(t);
    const anonymous = await fetch(`${base}/api/travel-records`);
    assert.equal(anonymous.status, 401);
    const anonymousBody = await anonymous.json();
    assert.equal(anonymousBody.service, 'travel-diary-writer-v1');
    assert.equal(anonymousBody.token, undefined);

    const missingOrigin = await fetch(`${base}/api/travel-auth`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: AUTH_PASSWORD })
    });
    assert.equal(missingOrigin.status, 403);
    const authenticated = await login(base);
    assert.equal(authenticated.response.status, 200);
    const setCookie = authenticated.response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.doesNotMatch(setCookie, /; Secure/);
    assert.equal(authenticated.token.length, 64);

    assert.equal((await fetch(`${base}/api/travel-records`)).status, 401);
    const capability = await fetch(`${base}/api/travel-records`, { headers: { Cookie: authenticated.cookie } });
    assert.equal(capability.status, 200);
    assert.equal((await capability.json()).authenticated, true);

    const logout = await fetch(`${base}/api/travel-auth`, {
        method: 'DELETE', headers: { Cookie: authenticated.cookie, Origin: base }
    });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(`${base}/api/travel-records`, { headers: { Cookie: authenticated.cookie } })).status, 401);
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
});
