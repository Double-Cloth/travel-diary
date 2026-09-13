import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHandler } from '../js/server.js';
import { DRAFT_FORMAT } from '../js/record-input.mjs';
import { readZip } from '../js/zip-archive.mjs';
import { AUTH_PASSWORD, installAuth } from './helpers/auth.mjs';

let root;
let server;
let port;
let token;
let cookie;
const siteHost = 'diary.example';
const httpsOrigin = `https://${siteHost}`;
const countries = [{ code: 'CN', name_zh: '中国' }];

function draft(id, input = {}) {
    return {
        format: DRAFT_FORMAT,
        requestId: id.repeat(32),
        uploads: [],
        input: {
            date: '2026-09-13',
            country_code: 'CN',
            country: '',
            admin_area: '江苏省',
            admin_area_type: '',
            locality: `远程地点-${id}`,
            locality_type: '',
            trip_id: '',
            title: '远程日记',
            body: '通过同站点远程写入。',
            desc_md: '',
            photo_folder: '',
            photos: [],
            ...input
        }
    };
}

function request({ pathname = '/api/travel-records', method = 'GET', host = siteHost, origin = httpsOrigin, headers = {}, body }) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: pathname,
            method,
            headers: { Host: host, ...(origin ? { Origin: origin } : {}), ...headers }
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

const json = response => JSON.parse(response.body.toString('utf8'));
async function authenticate(origin = httpsOrigin, host = siteHost) {
    const body = Buffer.from(JSON.stringify({ password: AUTH_PASSWORD }));
    const response = await request({
        pathname: '/api/travel-auth', method: 'POST', origin, host,
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }, body
    });
    return {
        response,
        token: json(response).token,
        cookie: response.headers['set-cookie']?.[0].split(';', 1)[0] || ''
    };
}
const mutate = (method, value, options = {}) => {
    const body = Buffer.from(JSON.stringify(value));
    return request({
        method,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
            'X-Travel-Token': token,
            Cookie: cookie,
            ...options.headers
        },
        host: options.host,
        origin: options.origin,
        body
    });
};

before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-diary-remote-write-'));
    await fs.mkdir(path.join(root, 'assets/catalogs'), { recursive: true });
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    await fs.writeFile(path.join(root, 'assets/catalogs/countries.json'), JSON.stringify({ countries }));
    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');
    await installAuth(root);
    server = http.createServer(createHandler(root, { writeMode: 'remote' }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = server.address().port;
    ({ token, cookie } = await authenticate());
});

after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    if (root && path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('travel-diary-remote-write-')) {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('remote 模式兼容同站点 HTTP 与 HTTPS 反向代理 Origin', async () => {
    const httpLogin = await authenticate(`http://${siteHost}`);
    assert.equal(httpLogin.response.status, 200);
    assert.doesNotMatch(httpLogin.response.headers['set-cookie'][0], /; Secure/);
    const httpsLogin = await authenticate(httpsOrigin);
    assert.equal(httpsLogin.response.status, 200);
    assert.match(httpsLogin.response.headers['set-cookie'][0], /; Secure/);
    assert.equal(httpsLogin.response.headers['access-control-allow-origin'], undefined);
    const loopback = await authenticate(`http://127.0.0.1:${port}`, `127.0.0.1:${port}`);
    assert.equal(loopback.response.status, 200);
});

test('remote 模式拒绝不匹配 Origin，且 X-Forwarded 信息不能绕过校验', async () => {
    assert.equal((await request({ origin: 'https://evil.example' })).status, 403);
    assert.equal((await authenticate('https://evil.example')).response.status, 403);
    assert.equal((await request({
        host: 'internal.invalid',
        origin: httpsOrigin,
        headers: { 'X-Forwarded-Host': siteHost, 'X-Forwarded-Proto': 'https' }
    })).status, 403);
});

test('remote 模式仍要求 mutation 令牌，并支持新增、修改与删除', async () => {
    const unauthorized = await mutate('POST', draft('a'), { headers: { 'X-Travel-Token': '' } });
    assert.equal(unauthorized.status, 403);

    const createdResponse = await mutate('POST', draft('a'));
    assert.equal(createdResponse.status, 201);
    const created = json(createdResponse).record;

    const editedDraft = draft('b', { date: '2026-09-14', locality: '远程修改', title: '修改成功' });
    const updatedResponse = await mutate('PUT', { originalDescMd: created.desc_md, draft: editedDraft });
    assert.equal(updatedResponse.status, 200);
    const updated = json(updatedResponse).record;
    assert.equal(updated.title, undefined);
    assert.match(await fs.readFile(path.join(root, updated.desc_md), 'utf8'), /修改成功/);

    const deletedResponse = await mutate('DELETE', { desc_md: updated.desc_md });
    assert.equal(deletedResponse.status, 200, deletedResponse.body.toString('utf8'));
    assert.equal(json(deletedResponse).deleted, true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8')), []);
});

test('remote 模式可通过登录会话和令牌导出、导入 data 与认证配置', async () => {
    const created = json(await mutate('POST', draft('c', { date: '2026-09-15' }))).record;
    const exported = await request({ pathname: '/api/travel-data', headers: { Cookie: cookie } });
    assert.equal(exported.status, 200);
    assert.match(exported.headers['content-type'], /application\/zip/);
    assert.equal(readZip(exported.body).some(entry => entry.name === created.desc_md), true);

    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');
    const missingToken = await request({
        pathname: '/api/travel-data',
        method: 'POST',
        headers: { 'Content-Type': 'application/zip', Cookie: cookie },
        body: exported.body
    });
    assert.equal(missingToken.status, 403);

    const imported = await request({
        pathname: '/api/travel-data',
        method: 'POST',
        headers: {
            'Content-Type': 'application/zip',
            'X-Travel-Token': token,
            Cookie: cookie
        },
        body: exported.body
    });
    assert.equal(imported.status, 200);
    assert.equal(json(imported).imported, true);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8')).some(record => record.desc_md === created.desc_md), true);
});
