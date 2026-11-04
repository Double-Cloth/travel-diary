import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { loadBrowserModule } from './helpers/browser-modules.mjs';
import { readZipSource, readSourceText } from '../js/zip-stream.mjs';
import { readBackupRecords, RECORD_BACKUP_PATH } from '../js/record-backup.mjs';
import { MAXIMUM_ARCHIVE_BYTES } from '../js/file-limits.mjs';
import { installAuth } from './helpers/auth.mjs';

const { createStaticBackup, downloadStaticBackup } = await loadBrowserModule(new URL('../js/static-backup.js', import.meta.url));
const { importDataArchive } = createRequire(import.meta.url)('../js/data-archive.js');
const first = { date: '2026-11-04', country: '中国', country_code: 'CN', locality: '湖边',
    desc_md: 'data/travel-diary/2026/2026-11-04-lake.md', photo_folder: 'data/photos/trip', photos: ['lake.jpg'] };
const second = { ...first, desc_md: 'data/travel-diary/2026/2026-11-04-mountain.md', locality: '山中',
    video_folder: 'data/videos/trip', videos: ['walk.mp4'] };

function fixture(t, records = [first, second]) {
    const previous = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document };
    t.after(() => Object.assign(globalThis, previous));
    const files = new Map([
        ['data/travel_data.json', JSON.stringify(records)],
        [first.desc_md, '# 湖边\n日记正文'], [second.desc_md, '# 山中\n日记正文'],
        ['data/photos/trip/lake.jpg', '图片'], ['data/videos/trip/walk.mp4', '视频'],
        ['data/profile/profile-picture.png', '头像'], ['data/profile/owner-name.txt', '旅行者'],
        ['data/photos/unreferenced.jpg', '未引用的图片'], ['.secrets/auth.json', '不能导出的配置']
    ]);
    const requests = [];
    globalThis.window = { location: { href: 'https://static.example/diary/index.html#preface' } };
    globalThis.fetch = async (url, options) => {
        assert.equal(options.cache, 'no-store');
        assert.equal(options.method, undefined);
        assert.equal(url.origin, 'https://static.example');
        assert.ok(url.pathname.startsWith('/diary/data/'));
        const name = decodeURIComponent(url.pathname.slice('/diary/'.length));
        requests.push(name);
        const data = files.get(name);
        return data instanceof Response ? data : new Response(data ?? '', { status: data === undefined ? 404 : 200 });
    };
    const controller = new AbortController();
    const progress = { signal: controller.signal, phase() {}, update() {}, setCancelable() {}, complete() {}, remove() {} };
    return { files, requests, controller, progress };
}

test('静态完整备份可在动态服务恢复，保留目标密码，不抓取未引用文件与秘密', async t => {
    const { requests, progress } = fixture(t);
    const { blob, missingMediaFiles } = await createStaticBackup(null, progress);
    const entries = await readZipSource(blob);
    assert.equal(missingMediaFiles, 0);
    assert.equal(entries.filter(entry => entry.name === 'data/photos/trip/lake.jpg').length, 1);
    assert.equal(entries.some(entry => entry.name === RECORD_BACKUP_PATH || entry.name.startsWith('.secrets/')), false);
    assert.equal(requests.some(name => name.includes('unreferenced') || name.includes('auth')), false);
    assert.equal((await readBackupRecords(entries))[0].record_id, `legacy:${first.desc_md}`);

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-static-backup-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');
    await installAuth(root);
    const auth = await fs.readFile(path.join(root, '.secrets/auth.json'));
    const result = await importDataArchive(root, blob);
    assert.equal(result.authPreserved, true);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))).length, 2);
    assert.equal(await fs.readFile(path.join(root, first.desc_md), 'utf8'), '# 湖边\n日记正文');
    assert.equal(await fs.readFile(path.join(root, 'data/profile/owner-name.txt'), 'utf8'), '旅行者');
    assert.deepEqual(await fs.readFile(path.join(root, '.secrets/auth.json')), auth);
});

test('静态部分导出只包含选中日记与共享附件，含部分备份标记，可合并恢复', async t => {
    const { requests, progress } = fixture(t);
    const { blob } = await createStaticBackup([first.desc_md], progress);
    const entries = await readZipSource(blob);
    assert.deepEqual(entries.map(entry => entry.name).sort(), ['data/travel_data.json', RECORD_BACKUP_PATH,
        first.desc_md, 'data/photos/trip/lake.jpg'].sort());
    assert.deepEqual(requests, ['data/travel_data.json', first.desc_md, 'data/photos/trip/lake.jpg']);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-static-partial-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');
    await installAuth(root);
    const result = await importDataArchive(root, blob, { mergeRecords: true });
    assert.equal(result.addedRecords, 1);
    assert.equal(result.authPreserved, true);
    await assert.rejects(createStaticBackup(['stale'], progress), /已变化或不存在/);
});

test('缺失附件与资料允许导出并报告，缺失正文、网络与服务错误均中止', async t => {
    const { files, progress } = fixture(t);
    files.delete('data/photos/trip/lake.jpg');
    files.delete('data/profile/owner-name.txt');
    const result = await createStaticBackup(null, progress);
    assert.equal(result.missingMediaFiles, 1);
    const entries = await readZipSource(result.blob);
    assert.deepEqual((await readBackupRecords(entries))[0].photos, ['lake.jpg']);
    assert.equal(entries.some(entry => entry.name === 'data/profile/owner-name.txt'), false);
    files.set('data/videos/trip/walk.mp4', new Response('稍后重试', { status: 503 }));
    await assert.rejects(createStaticBackup(null, progress), /walk.mp4.*503/);
    files.delete(first.desc_md);
    await assert.rejects(createStaticBackup(null, progress), /lake.md.*404/);
    globalThis.fetch = async () => { throw new TypeError('网络断开'); };
    await assert.rejects(createStaticBackup(null, progress), /网络断开/);
});

test('拒绝越界路径、畸形索引和超大内容，取消后不继续读取文件', async t => {
    const { files, requests, controller, progress } = fixture(t);
    const unsafe = { ...first, record_id: 'r-' + 'a'.repeat(32) };
    for (const change of [{ desc_md: 'https://other.example/secret' }, { photo_folder: 'data/photos/../profile' },
        { photos: ['%2e%2e'] }, { photos: ['a/b.jpg'] }, { photos: 'lake.jpg' }]) {
        files.set('data/travel_data.json', JSON.stringify([{ ...unsafe, ...change }]));
        const before = requests.length;
        await assert.rejects(createStaticBackup(null, progress), /无效/);
        assert.equal(requests.length, before + 1);
    }
    files.set('data/travel_data.json', JSON.stringify([first]));
    files.set(first.desc_md, new Response('正文', { headers: { 'Content-Length': String(MAXIMUM_ARCHIVE_BYTES + 1) } }));
    await assert.rejects(createStaticBackup(null, progress), /100 GiB/);
    controller.abort();
    const before = requests.length;
    await assert.rejects(createStaticBackup(null, progress), { name: 'AbortError' });
    assert.equal(requests.length, before);
    assert.deepEqual(await downloadStaticBackup('cancel.zip', progress), { cancelled: true });
});

test('静态空档案可下载为合法完整 ZIP，不要求密码或个人资料存在', async t => {
    const { files, progress } = fixture(t, []);
    files.delete('data/profile/profile-picture.png');
    files.delete('data/profile/owner-name.txt');
    let downloaded;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    t.after(() => { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; });
    URL.createObjectURL = blob => { downloaded = blob; return 'blob:test'; };
    URL.revokeObjectURL = () => {};
    globalThis.document = { body: { append() {} }, createElement: () => ({ click() {}, remove() {} }) };
    const result = await downloadStaticBackup('empty.zip', progress);
    assert.equal(result.static, true);
    const entries = await readZipSource(downloaded);
    assert.equal(entries.length, 1);
    assert.equal(new TextDecoder().decode(await readSourceText(entries[0].data)), '[]\n');
});
