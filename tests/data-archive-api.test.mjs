import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHandler } from '../js/server.js';
import { createZip } from '../js/zip-archive.mjs';
import { readZipSource } from '../js/zip-stream.mjs';
import { AUTH_CONFIG, AUTH_PASSWORD, installAuth, login } from './helpers/auth.mjs';
import { listenOnFetchSafePort } from './helpers/http.mjs';
import { createRequire } from 'node:module';

const { createAuthConfig } = createRequire(import.meta.url)('../js/auth.js');

let root;
let server;
let base;
const record = { date: '2026-09-11', country: '中国', country_code: 'CN', admin_area: '江苏省', locality: '苏州市', desc_md: 'data/travel-diary/2026/2026-09-11-suzhou.md', photo_folder: '', photos: [] };

before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-diary-archive-api-'));
    await fs.mkdir(path.join(root, 'data/travel-diary/2026'), { recursive: true });
    await fs.writeFile(path.join(root, 'data/travel_data.json'), JSON.stringify([record]));
    await fs.writeFile(path.join(root, record.desc_md), '# 苏州\n');
    await installAuth(root);
    server = http.createServer(createHandler(root));
    base = await listenOnFetchSafePort(server);
});

after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    if (root && path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('travel-diary-archive-api-')) {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('动态全量导出必须登录，且包含认证配置', async () => {
    assert.equal((await fetch(`${base}/api/travel-data`)).status, 401);
    const { cookie } = await login(base);
    const exported = await fetch(`${base}/api/travel-data`, { headers: { Cookie: cookie } });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type'), /application\/zip/);
    const entries = await readZipSource(new Uint8Array(await exported.arrayBuffer()));
    assert.equal(entries.some(entry => entry.name === record.desc_md), true);
    assert.equal(entries.some(entry => entry.name === '.secrets/auth.json'), true);
    assert.equal(entries.some(entry => entry.name === 'data/password.json'), false);
});

test('登录会话与写入令牌共同保护导入，成功后失效全部旧会话', async () => {
    const { cookie, token } = await login(base);
    const exported = await fetch(`${base}/api/travel-data`, { headers: { Cookie: cookie } });
    const archive = new Uint8Array(await exported.arrayBuffer());
    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');

    const noSession = await fetch(`${base}/api/travel-data`, {
        method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': token, Origin: base }, body: archive
    });
    assert.equal(noSession.status, 401);
    const noToken = await fetch(`${base}/api/travel-data`, {
        method: 'POST', headers: { 'Content-Type': 'application/zip', Cookie: cookie, Origin: base }, body: archive
    });
    assert.equal(noToken.status, 403);

    const imported = await fetch(`${base}/api/travel-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': token, Cookie: cookie, Origin: base,
            'X-Travel-Current-Password': AUTH_PASSWORD, 'X-Travel-Backup-Password': AUTH_PASSWORD },
        body: archive
    });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).imported, true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8')), [record]);
    const capability = await fetch(`${base}/api/travel-records`, { headers: { Cookie: cookie } });
    assert.equal(capability.status, 200);
    const capabilityBody = await capability.json();
    assert.equal(capabilityBody.authenticated, false);
    assert.equal(capabilityBody.token, undefined);
});

test('新旧数据备份按内容恢复或保留认证配置', async () => {
    const first = await login(base);
    const legacyArchive = createZip([{ name: 'data/travel_data.json', data: '[]' }]);
    const legacyImport = await fetch(`${base}/api/travel-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': first.token, Cookie: first.cookie, Origin: base,
            'X-Travel-Current-Password': AUTH_PASSWORD },
        body: legacyArchive
    });
    assert.equal(legacyImport.status, 200);
    assert.equal((await legacyImport.json()).authPreserved, true);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, '.secrets/auth.json'), 'utf8')).hash, AUTH_CONFIG.hash);

    const second = await login(base);
    const invalid = createZip([
        { name: 'data/travel_data.json', data: '[]' },
        { name: '.secrets/auth.json', data: '{}' }
    ]);
    const response = await fetch(`${base}/api/travel-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': second.token, Cookie: second.cookie, Origin: base,
            'X-Travel-Current-Password': AUTH_PASSWORD, 'X-Travel-Backup-Password': AUTH_PASSWORD },
        body: invalid
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, '.secrets/auth.json'), 'utf8')).hash, AUTH_CONFIG.hash);
});

test('导入分别校验当前密码和不同的备份密码，失败不覆盖，成功恢复备份密码', async () => {
    const backupPassword = '590247';
    const backupConfig = await createAuthConfig(backupPassword);
    const archive = createZip([
        { name: 'data/travel_data.json', data: '[]' },
        { name: '.secrets/auth.json', data: JSON.stringify(backupConfig) }
    ]);
    const { cookie, token } = await login(base);
    const originalData = await fs.readFile(path.join(root, 'data/travel_data.json'));
    const originalAuth = await fs.readFile(path.join(root, '.secrets/auth.json'));
    const importWith = (currentPassword, password) => fetch(`${base}/api/travel-data`, {
        method: 'POST', body: archive,
        headers: {
            'Content-Type': 'application/zip', Cookie: cookie, Origin: base, 'X-Travel-Token': token,
            ...(currentPassword !== undefined ? { 'X-Travel-Current-Password': currentPassword } : {}),
            ...(password !== undefined ? { 'X-Travel-Backup-Password': password } : {})
        }
    });
    for (const [currentPassword, password, code] of [
        [undefined, backupPassword, 'CURRENT_PASSWORD_INVALID'],
        ['829401', backupPassword, 'CURRENT_PASSWORD_INVALID'],
        [AUTH_PASSWORD, undefined, 'BACKUP_PASSWORD_INVALID'],
        [AUTH_PASSWORD, AUTH_PASSWORD, 'BACKUP_PASSWORD_INVALID']
    ]) {
        const response = await importWith(currentPassword, password);
        assert.equal(response.status, 403);
        assert.equal((await response.json()).code, code);
        assert.deepEqual(await fs.readFile(path.join(root, 'data/travel_data.json')), originalData);
        assert.deepEqual(await fs.readFile(path.join(root, '.secrets/auth.json')), originalAuth);
        assert.equal((await fs.readdir(root)).some(name => name.startsWith('.travel-')), false);
    }
    const response = await importWith(AUTH_PASSWORD, backupPassword);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).authPreserved, false);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, '.secrets/auth.json'))).hash, backupConfig.hash);
    const capability = await fetch(`${base}/api/travel-records`, { headers: { Cookie: cookie } });
    assert.equal((await capability.json()).authenticated, false);
    const authenticated = await fetch(`${base}/api/travel-auth`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ password: backupPassword })
    });
    assert.equal(authenticated.status, 200);
    await installAuth(root);
});

test('备份密码失败 5 次后限速，重新登录不能绕过', async t => {
    const limitedServer = http.createServer(createHandler(root));
    const limitedBase = await listenOnFetchSafePort(limitedServer);
    t.after(async () => {
        limitedServer.closeAllConnections();
        await new Promise(resolve => limitedServer.close(resolve));
    });
    const archive = createZip([
        { name: 'data/travel_data.json', data: '[]' },
        { name: '.secrets/auth.json', data: JSON.stringify(AUTH_CONFIG) }
    ]);
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const { cookie, token } = await login(limitedBase);
        const response = await fetch(`${limitedBase}/api/travel-data`, {
            method: 'POST', body: archive,
            headers: {
                'Content-Type': 'application/zip', Cookie: cookie, Origin: limitedBase, 'X-Travel-Token': token,
                'X-Travel-Current-Password': AUTH_PASSWORD, 'X-Travel-Backup-Password': '590247'
            }
        });
        assert.equal(response.status, attempt < 5 ? 403 : 429);
        if (attempt === 5) {
            assert.equal((await response.json()).code, 'AUTH_RATE_LIMITED');
            assert.ok(Number(response.headers.get('retry-after')) > 0);
        }
    }
});

test('清空全部数据要求会话与写入令牌，并保留访问密码', async () => {
    await fs.mkdir(path.join(root, 'data/travel-diary/2026'), { recursive: true });
    await fs.mkdir(path.join(root, 'data/photos/temporary'), { recursive: true });
    await fs.writeFile(path.join(root, 'data/travel_data.json'), JSON.stringify([record]));
    await fs.writeFile(path.join(root, record.desc_md), '# 苏州\n');
    await fs.writeFile(path.join(root, 'data/photos/temporary/photo.png'), 'photo');
    const authBefore = await fs.readFile(path.join(root, '.secrets/auth.json'));
    const { cookie, token } = await login(base);

    assert.equal((await fetch(`${base}/api/travel-data`, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(`${base}/api/travel-data`, {
        method: 'DELETE', headers: { Cookie: cookie, Origin: base }
    })).status, 403);
    const response = await fetch(`${base}/api/travel-data`, {
        method: 'DELETE', headers: { Cookie: cookie, Origin: base, 'X-Travel-Token': token }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cleared: true, authPreserved: true });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8')), []);
    await assert.rejects(fs.access(path.join(root, record.desc_md)));
    await assert.rejects(fs.access(path.join(root, 'data/photos/temporary/photo.png')));
    assert.deepEqual(await fs.readFile(path.join(root, '.secrets/auth.json')), authBefore);
});
