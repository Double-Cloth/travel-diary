import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHandler } from '../js/server.js';
import { createZip, readZip } from '../js/zip-archive.mjs';
import { AUTH_CONFIG, installAuth, login } from './helpers/auth.mjs';

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
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    if (root && path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('travel-diary-archive-api-')) {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('动态全量导出必须登录，并包含 data 与认证哈希配置', async () => {
    assert.equal((await fetch(`${base}/api/travel-data`)).status, 401);
    const { cookie } = await login(base);
    const exported = await fetch(`${base}/api/travel-data`, { headers: { Cookie: cookie } });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type'), /application\/zip/);
    const entries = readZip(new Uint8Array(await exported.arrayBuffer()));
    assert.equal(entries.some(entry => entry.name === record.desc_md), true);
    assert.equal(entries.some(entry => entry.name === '.secrets/auth.json'), true);
    assert.equal(entries.some(entry => entry.name === 'data/password.json'), false);
    const config = JSON.parse(Buffer.from(entries.find(entry => entry.name === '.secrets/auth.json').data).toString('utf8'));
    assert.equal(config.hash, AUTH_CONFIG.hash);
    assert.equal('password' in config, false);
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
        headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': token, Cookie: cookie, Origin: base },
        body: archive
    });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).imported, true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8')), [record]);
    assert.equal((await fetch(`${base}/api/travel-records`, { headers: { Cookie: cookie } })).status, 401);
});

test('旧数据备份不含认证配置时保留当前配置，非法认证配置会被拒绝', async () => {
    const first = await login(base);
    const legacyArchive = createZip([{ name: 'data/travel_data.json', data: '[]' }]);
    const legacyImport = await fetch(`${base}/api/travel-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': first.token, Cookie: first.cookie, Origin: base },
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
        headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': second.token, Cookie: second.cookie, Origin: base },
        body: invalid
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /认证配置无效/);
});
