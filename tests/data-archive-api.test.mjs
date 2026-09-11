import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHandler } from '../js/server.js';
import { readZip } from '../js/zip-archive.mjs';

let root;
let server;
let base;
let token;
const record = { date: '2026-09-11', desc_md: 'data/travel-diary/2026/2026-09-11-suzhou.md', photo_folder: '', photos: [] };

before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-diary-archive-api-'));
    await fs.mkdir(path.join(root, 'data/travel-diary/2026'), { recursive: true });
    await fs.writeFile(path.join(root, 'data/travel_data.json'), JSON.stringify([record]));
    await fs.writeFile(path.join(root, record.desc_md), '# 苏州\n');
    server = http.createServer(createHandler(root));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    token = (await (await fetch(`${base}/api/travel-records`)).json()).token;
});

after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    if (root && path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('travel-diary-archive-api-')) {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('本地数据 API 使用令牌导出并重新导入整个 data 目录', async () => {
    assert.equal((await fetch(`${base}/api/travel-data`)).status, 403);
    const exported = await fetch(`${base}/api/travel-data`, { headers: { 'X-Travel-Token': token } });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type'), /application\/zip/);
    const archive = new Uint8Array(await exported.arrayBuffer());
    assert.equal(readZip(archive).some(entry => entry.name === record.desc_md), true);

    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');
    const imported = await fetch(`${base}/api/travel-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': token, Origin: base },
        body: archive
    });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).imported, true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8')), [record]);
});
