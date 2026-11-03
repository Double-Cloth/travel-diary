import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { installAuth, AUTH_CONFIG, AUTH_PASSWORD, login } from './helpers/auth.mjs';
import { listenOnFetchSafePort } from './helpers/http.mjs';
import { readZipSource, createZipBlob } from '../js/zip-stream.mjs';
import { recordBackupEntries, readBackupRecords, selectBackupRecords, sortBackupRecords, RECORD_BACKUP_PATH } from '../js/record-backup.mjs';

const require = createRequire(import.meta.url);
const { exportDataArchive, importDataArchive } = require('../js/data-archive.js');
const { createHandler } = require('../js/server.js');
const { createAuthConfig } = require('../js/auth.js');
const record = name => ({ date: '2026-11-03', country: '中国', country_code: 'CN', locality: name,
    desc_md: `data/travel-diary/2026/2026-11-03-${name}.md`, photo_folder: 'data/photos/trip', photos: ['lake.png'],
    video_folder: 'data/videos/trip', videos: ['walk.mp4'] });
const first = record('first');
const second = record('second');

async function fixture(t, records = [first, second]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-record-backup-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const files = [
        { name: 'data/travel_data.json', data: JSON.stringify(records) },
        ...records.map(item => ({ name: item.desc_md, data: `# ${item.locality}\n正文` })),
        { name: 'data/photos/trip/lake.png', data: 'photo' },
        { name: 'data/videos/trip/walk.mp4', data: 'video' },
        { name: 'data/profile/owner-name.txt', data: '当前署名' },
        { name: 'data/photos/orphan.png', data: '未引用文件' }
    ];
    for (const file of files) {
        await fs.mkdir(path.dirname(path.join(root, file.name)), { recursive: true });
        await fs.writeFile(path.join(root, file.name), file.data);
    }
    await installAuth(root);
    return root;
}

async function exported(root, paths) {
    const archive = await exportDataArchive(root, paths);
    try {
        const parts = [];
        for await (const part of archive.stream) parts.push(part);
        return Buffer.concat(parts);
    } finally { await archive.release(); }
}

async function selectedArchive(records, extra = []) {
    const entries = [
        ...records.map(item => ({ name: item.desc_md, data: `# 更新 ${item.locality}` })),
        { name: 'data/photos/trip/lake.png', data: 'photo' },
        { name: 'data/videos/trip/walk.mp4', data: 'video' }
    ];
    return new Uint8Array(await (await createZipBlob([...recordBackupEntries(entries, records), ...extra])).arrayBuffer());
}

test('部分导出包含勾选记录、去重媒体和密码配置，拒绝过期及空选择', async t => {
    const root = await fixture(t);
    const bytes = await exported(root, [first.desc_md]);
    const entries = await readZipSource(bytes);
    assert.deepEqual(entries.map(entry => entry.name).sort(), [RECORD_BACKUP_PATH, 'data/travel_data.json', first.desc_md,
        'data/photos/trip/lake.png', 'data/videos/trip/walk.mp4', '.secrets/auth.json'].sort());
    assert.deepEqual(await readBackupRecords(entries), [first]);
    const both = await readZipSource(await exported(root, [second.desc_md, first.desc_md]));
    assert.equal(both.filter(entry => entry.name === 'data/photos/trip/lake.png').length, 1);
    for (const paths of [[], [first.desc_md, first.desc_md], ['missing']]) await assert.rejects(exported(root, paths));
    await assert.rejects(importDataArchive(root, bytes), /导入部分记录/);
    await assert.rejects(importDataArchive(root, bytes, { mergeRecords: true }), /备份密码不正确/);
    const originalAuth = await fs.readFile(path.join(root, '.secrets/auth.json'));
    const result = await importDataArchive(root, bytes, { mergeRecords: true, backupPassword: AUTH_PASSWORD });
    assert.equal(result.authPreserved, true);
    assert.deepEqual(await fs.readFile(path.join(root, '.secrets/auth.json')), originalAuth);
});

test('选择列表与导出索引按日期倒序排列，同日保持原顺序且不修改原始列表', async t => {
    const older = { ...record('older'), date: '2025-01-02', desc_md: 'data/travel-diary/2025/2025-01-02-older.md' };
    const records = [older, first, second];
    assert.deepEqual(sortBackupRecords(records), [first, second, older]);
    assert.deepEqual(records, [older, first, second]);
    assert.deepEqual(sortBackupRecords([{ desc_md: 'missing' }, older]), [older, { desc_md: 'missing' }]);
    const root = await fixture(t, records);
    const entries = await readZipSource(await exported(root, records.map(item => item.desc_md)));
    assert.deepEqual(await readBackupRecords(entries), [first, second, older]);
});

test('增量合并更新所选并新增记录，保留其他日记、个人资料、密码和未引用文件，重试不重复', async t => {
    const root = await fixture(t);
    const originalAuth = await fs.readFile(path.join(root, '.secrets/auth.json'));
    const third = record('third');
    const archive = await selectedArchive([{ ...first, trip_id: 'updated' }, third]);
    for (let retry = 0; retry < 2; retry++) {
        const result = await importDataArchive(root, archive, { mergeRecords: true });
        assert.equal(result.merged, true);
        assert.equal(result.addedRecords, retry ? 0 : 1);
        assert.equal(result.updatedRecords, retry ? 2 : 1);
        const records = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')));
        assert.equal(records.length, 3);
        assert.equal(records[0].trip_id, 'updated');
        assert.deepEqual(records[1], second);
        assert.equal(await fs.readFile(path.join(root, second.desc_md), 'utf8'), '# second\n正文');
        assert.equal(await fs.readFile(path.join(root, 'data/profile/owner-name.txt'), 'utf8'), '当前署名');
        assert.equal(await fs.readFile(path.join(root, 'data/photos/orphan.png'), 'utf8'), '未引用文件');
        assert.deepEqual(await fs.readFile(path.join(root, '.secrets/auth.json')), originalAuth);
        assert.equal((await fs.readdir(root)).some(name => name.startsWith('.travel-')), false);
    }
});

test('共享媒体冲突、跨目录大小写冲突及损坏 CRC 都不修改现有数据', async t => {
    const root = await fixture(t);
    const before = await fs.readFile(path.join(root, 'data/travel_data.json'));
    const entries = await readZipSource(await selectedArchive([first]));
    const changedMedia = await createZipBlob(entries.map(entry => entry.name.endsWith('lake.png') ? { ...entry, data: 'changed' } : entry));
    await assert.rejects(importDataArchive(root, changedMedia, { mergeRecords: true }), /未选中的记录共用/);
    await fs.writeFile(path.join(root, 'data/photos/trip/untracked.png'), '独立文件');
    const orphanCollision = await selectedArchive([{ ...first, photos: ['untracked.png'] }], [
        { name: 'data/photos/trip/untracked.png', data: 'incoming' }
    ]);
    await assert.rejects(importDataArchive(root, orphanCollision, { mergeRecords: true }), /已有独立文件重名/);
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/untracked.png'), 'utf8'), '独立文件');
    const conflicting = { ...first, photo_folder: 'data/photos/Trip' };
    const collision = await createZipBlob(recordBackupEntries([
        { name: first.desc_md, data: '# 更新' }, { name: 'data/photos/Trip/lake.png', data: 'photo' },
        { name: 'data/videos/trip/walk.mp4', data: 'video' }
    ], [conflicting]));
    await assert.rejects(importDataArchive(root, collision, { mergeRecords: true }), /大小写/);
    const bytes = Buffer.from(await selectedArchive([first]));
    bytes[bytes.indexOf(Buffer.from('photo'))] ^= 1;
    await assert.rejects(importDataArchive(root, bytes, { mergeRecords: true }), /校验失败/);
    assert.deepEqual(await fs.readFile(path.join(root, 'data/travel_data.json')), before);
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/lake.png'), 'utf8'), 'photo');
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.travel-')), false);
});

test('从完整备份选择记录时只打包所需内容，并保留备份密码验证', async t => {
    const root = await fixture(t);
    const full = await readZipSource(await exported(root));
    const chosen = selectBackupRecords(await readBackupRecords(full), [first.desc_md]);
    const partial = recordBackupEntries(full, chosen, { includeAuth: true });
    assert.equal(partial.some(entry => entry.name === '.secrets/auth.json'), true);
    assert.equal(partial.some(entry => entry.name === second.desc_md || entry.name.startsWith('data/profile/')), false);
    const archive = await createZipBlob(partial);
    await assert.rejects(importDataArchive(root, archive, { mergeRecords: true, backupPassword: '000000' }), /备份密码不正确/);
    const result = await importDataArchive(root, archive, { mergeRecords: true, backupPassword: AUTH_PASSWORD });
    assert.equal(result.authPreserved, true);
    assert.equal(result.updatedRecords, 1);
});

test('API 选择绑定当前会话，导入仍需令牌及当前密码，合并后会话保留', async t => {
    const root = await fixture(t);
    const server = http.createServer(createHandler(root));
    const base = await listenOnFetchSafePort(server);
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const login = async () => {
        const response = await fetch(`${base}/api/travel-auth`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: AUTH_PASSWORD }) });
        return { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-Travel-Token': (await response.json()).token, Origin: base };
    };
    const headers = await login();
    const noToken = await fetch(`${base}/api/travel-data?mode=select`, {
        method: 'POST', headers: { Cookie: headers.Cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [first.desc_md] })
    });
    assert.equal(noToken.status, 403);
    const select = await fetch(`${base}/api/travel-data?mode=select`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [first.desc_md] })
    });
    assert.equal(select.status, 200);
    const { selection } = await select.json();
    const head = await fetch(`${base}/api/travel-data?selection=${selection}`, { method: 'HEAD', headers });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers.get('content-length')) > 0);
    const exported = await fetch(`${base}/api/travel-data?selection=${selection}`, { headers });
    const archive = new Uint8Array(await exported.arrayBuffer());
    assert.deepEqual(await readBackupRecords(await readZipSource(archive)), [first]);
    const other = await login();
    assert.equal((await fetch(`${base}/api/travel-data?selection=${selection}`, { headers: other })).status, 400);
    const upload = extra => fetch(`${base}/api/travel-data?mode=merge`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/zip', ...extra }, body: archive });
    assert.equal((await upload({})).status, 403);
    assert.equal((await upload({ 'X-Travel-Current-Password': AUTH_PASSWORD })).status, 403);
    const response = await upload({ 'X-Travel-Current-Password': AUTH_PASSWORD, 'X-Travel-Backup-Password': AUTH_PASSWORD });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).merged, true);
    assert.equal((await (await fetch(`${base}/api/travel-records`, { headers })).json()).authenticated, true);
});

test('密码预校验要求会话、令牌及当前密码，不修改数据，正式导入仍独立验证备份密码', async t => {
    const root = await fixture(t);
    const server = http.createServer(createHandler(root));
    const base = await listenOnFetchSafePort(server);
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const { cookie, token } = await login(base);
    const headers = { Cookie: cookie, Origin: base, 'X-Travel-Token': token, 'Content-Type': 'application/json',
        'X-Travel-Current-Password': AUTH_PASSWORD, 'X-Travel-Backup-Password': AUTH_PASSWORD };
    const verify = (extra = {}, auth = AUTH_CONFIG) => fetch(`${base}/api/travel-data?mode=verify-backup`, {
        method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ auth })
    });
    const before = await fs.readFile(path.join(root, 'data/travel_data.json'));
    assert.equal((await verify({ Cookie: '' })).status, 401);
    assert.equal((await verify({ 'X-Travel-Token': '' })).status, 403);
    assert.equal((await verify({ 'X-Travel-Current-Password': '000000' })).status, 403);
    assert.equal((await verify({}, { ...AUTH_CONFIG, cost: { N: 2 ** 22, r: 8, p: 1 } })).status, 400);
    assert.deepEqual(await (await verify()).json(), { verified: true });
    const differentConfig = await createAuthConfig('590247');
    const mismatch = await verify({}, differentConfig);
    assert.equal(mismatch.status, 403);
    assert.equal((await mismatch.json()).code, 'BACKUP_PASSWORD_INVALID');
    assert.equal((await verify({ 'X-Travel-Backup-Password': '590247' }, differentConfig)).status, 200);
    assert.deepEqual(await fs.readFile(path.join(root, 'data/travel_data.json')), before);
    const archive = await exported(root, [first.desc_md]);
    const upload = backupPassword => fetch(`${base}/api/travel-data?mode=merge`, { method: 'POST', headers: {
        ...headers, 'Content-Type': 'application/zip', 'X-Travel-Backup-Password': backupPassword
    }, body: archive });
    assert.equal((await upload('590247')).status, 403, '预校验成功不能代替 ZIP 内认证校验');
    assert.deepEqual(await fs.readFile(path.join(root, 'data/travel_data.json')), before);
    assert.equal((await upload(AUTH_PASSWORD)).status, 200);
});

test('预校验与正式导入共享失败限速，重新登录或提供自选正确配置不能重置计数', async t => {
    const root = await fixture(t);
    const server = http.createServer(createHandler(root));
    const base = await listenOnFetchSafePort(server);
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    let session = await login(base);
    const verify = password => fetch(`${base}/api/travel-data?mode=verify-backup`, { method: 'POST', headers: {
        Cookie: session.cookie, Origin: base, 'X-Travel-Token': session.token, 'Content-Type': 'application/json',
        'X-Travel-Current-Password': AUTH_PASSWORD, 'X-Travel-Backup-Password': password
    }, body: JSON.stringify({ auth: AUTH_CONFIG }) });
    for (let attempt = 0; attempt < 5; attempt++) {
        assert.equal((await verify(AUTH_PASSWORD)).status, 200);
        assert.equal((await verify('000000')).status, 403);
        session = await login(base);
    }
    const limited = await verify(AUTH_PASSWORD);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const upload = await fetch(`${base}/api/travel-data?mode=merge`, { method: 'POST', headers: {
        Cookie: session.cookie, Origin: base, 'X-Travel-Token': session.token, 'Content-Type': 'application/zip',
        'X-Travel-Current-Password': AUTH_PASSWORD, 'X-Travel-Backup-Password': AUTH_PASSWORD
    }, body: await exported(root, [first.desc_md]) });
    assert.equal(upload.status, 429);
});
