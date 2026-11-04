import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { captureRecycle, readRecycleBin, manageRecycleBin } from '../js/recycle-bin.js';
import { clearTravelData, importDataArchive } from '../js/data-archive.js';
import { clearCache } from '../scripts/clear-cache.js';
import { createHandler } from '../js/server.js';
import { createZipBlob } from '../js/zip-stream.mjs';
import { compareBackup, describeRecords, changedTextBlocks } from '../js/record-diff.mjs';
import { DRAFT_FORMAT } from '../js/record-input.mjs';
import { installAuth, login } from './helpers/auth.mjs';
import { listenOnFetchSafePort } from './helpers/http.mjs';

const note = { date: '2026-11-03', country: '中国', country_code: 'CN', locality: '苏州市', desc_md: 'data/travel-diary/2026/2026-11-03-suzhou.md', photo_folder: 'data/photos/trip', photos: ['shared.png', 'unique.png'] };
const other = { ...note, date: '2026-11-04', desc_md: 'data/travel-diary/2026/2026-11-04-suzhou.md', photos: ['shared.png'] };
async function write(root, name, data) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), data);
}
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-recycle-test-'));
    t.after(async () => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('travel-recycle-test-'));
        await fs.rm(root, { recursive: true, force: true });
    });
    for (const [name, value] of [[note.desc_md, '# 标题\n\n原正文'], [other.desc_md, '# 另一篇'], ['data/photos/trip/shared.png', 'shared'], ['data/photos/trip/unique.png', 'unique'], ['data/travel_data.json', JSON.stringify([note, other])], ['assets/catalogs/countries.json', JSON.stringify({ countries: [{ code: 'CN', name_zh: '中国' }] })]]) await write(root, name, value);
    await installAuth(root);
    return root;
}
async function action(root, id, operation = 'restore') {
    return manageRecycleBin(root, { id, action: operation, revision: (await readRecycleBin(root)).revision });
}
async function api(t, root) {
    const server = http.createServer(createHandler(root));
    const base = await listenOnFetchSafePort(server);
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const { cookie, token } = await login(base);
    const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', 'X-Travel-Token': token };
    return { base, headers };
}

test('删除日记将正文和独占媒体移入回收站，共用媒体保留，恢复后索引与文件完整', async t => {
    const root = await fixture(t);
    const { base, headers } = await api(t, root);
    const response = await fetch(`${base}/api/travel-records`, { method: 'DELETE', headers, body: JSON.stringify({ desc_md: note.desc_md }) });
    assert.equal(response.status, 200);
    const report = await readRecycleBin(root);
    assert.equal(report.items.length, 1);
    const item = report.items[0];
    assert.equal(item.kind, 'record');
    assert.equal(item.records[0].desc_md, note.desc_md);
    for (const name of [note.desc_md, 'data/photos/trip/unique.png']) await assert.rejects(fs.stat(path.join(root, name)), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/shared.png'), 'utf8'), 'shared');
    await action(root, item.id);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))).length, 2);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 标题\n\n原正文');
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/unique.png'), 'utf8'), 'unique');
    assert.equal((await readRecycleBin(root)).items.length, 0);
});

test('保存时移除真实媒体先留存回收站，恢复不会覆盖冲突文件', async t => {
    const root = await fixture(t);
    const { base, headers } = await api(t, root);
    const response = await fetch(`${base}/api/travel-records`, { method: 'PUT', headers, body: JSON.stringify({ originalDescMd: note.desc_md, draft: { format: DRAFT_FORMAT, requestId: 'b'.repeat(32), uploads: [], input: { ...note, admin_area: '', admin_area_type: '', locality_type: '', trip_id: '', title: '标题', body: '原正文', photos: ['shared.png'], video_folder: '', videos: [] } } }) });
    assert.equal(response.status, 200, await response.text());
    const item = (await readRecycleBin(root)).items.find(item => item.title === '编辑日记时移除的媒体');
    assert.deepEqual(item.files.map(file => file.path), ['data/photos/trip/unique.png']);
    await write(root, item.files[0].path, 'newer');
    await assert.rejects(action(root, item.id), /内容不同/);
    assert.equal(await fs.readFile(path.join(root, item.files[0].path), 'utf8'), 'newer');
    await fs.unlink(path.join(root, item.files[0].path));
    await action(root, item.id);
    assert.equal(await fs.readFile(path.join(root, item.files[0].path), 'utf8'), 'unique');
    const restored = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))).find(record => record.desc_md === note.desc_md);
    assert.deepEqual(restored.photos, ['shared.png', 'unique.png']);
});

test('媒体恢复只合并附件引用，保留后续修改，重复引用不增加', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { title: '移除的附件', mediaReferences: [note], files: [{ path: 'data/photos/trip/unique.png' }] });
    await fs.unlink(path.join(root, 'data/photos/trip/unique.png'));
    await write(root, 'data/travel_data.json', JSON.stringify([{ ...note, locality: '后续目的地', photos: ['shared.png', 'later.png'], trip_id: 'later' }, other]));
    await action(root, id);
    const records = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')));
    assert.equal(records[0].locality, '后续目的地');
    assert.equal(records[0].trip_id, 'later');
    assert.deepEqual(records[0].photos, ['shared.png', 'unique.png', 'later.png']);
    const again = await captureRecycle(root, { title: '重复附件', mediaReferences: [note], files: [{ path: 'data/photos/trip/unique.png' }] });
    await action(root, again);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')))[0].photos, records[0].photos);
});

test('移除共用图片也保留日记关联，恢复不影响其他日记', async t => {
    const root = await fixture(t);
    const { base, headers } = await api(t, root);
    const response = await fetch(`${base}/api/travel-records`, { method: 'PUT', headers, body: JSON.stringify({ originalDescMd: note.desc_md, draft: { format: DRAFT_FORMAT, requestId: 'c'.repeat(32), uploads: [], input: { ...note, admin_area: '', admin_area_type: '', locality_type: '', trip_id: '', title: '标题', body: '原正文', photos: ['unique.png'], video_folder: '', videos: [] } } }) });
    assert.equal(response.status, 200, await response.text());
    const item = (await readRecycleBin(root)).items.find(item => item.title === '编辑日记时移除的媒体');
    assert.deepEqual(item.files.map(file => file.path), ['data/photos/trip/shared.png']);
    await action(root, item.id);
    const records = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')));
    assert.deepEqual(records[0].photos, note.photos);
    assert.deepEqual(records[1].photos, other.photos);
});

test('恢复附件提交索引失败时撤回文件，关联日记缺失或目录冲突时保留回收项目', async t => {
    const root = await fixture(t);
    const name = 'data/photos/trip/unique.png';
    const id = await captureRecycle(root, { title: '移除的附件', mediaReferences: [note], files: [{ path: name }] });
    await fs.unlink(path.join(root, name));
    const records = [{ ...note, photos: ['shared.png'] }, other];
    await write(root, 'data/travel_data.json', JSON.stringify(records));
    const rename = fs.rename;
    const mocked = t.mock.method(fs, 'rename', async (source, target) => {
        if (target === path.join(root, 'data/travel_data.json')) throw new Error('模拟引用提交失败');
        return rename(source, target);
    });
    try { await assert.rejects(action(root, id), /引用提交失败/); }
    finally { mocked.mock.restore(); }
    await assert.rejects(fs.stat(path.join(root, name)), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))), records);
    await write(root, 'data/travel_data.json', JSON.stringify([{ ...records[0], photo_folder: 'data/photos/new' }, other]));
    await assert.rejects(action(root, id), /目录已改变/);
    await write(root, 'data/travel_data.json', JSON.stringify([other]));
    await assert.rejects(action(root, id), /请先恢复日记/);
    assert.equal((await readRecycleBin(root)).items[0].id, id);
});

test('旧媒体必须选择原日记，指定后同时恢复图片、视频引用，未引用媒体可只恢复文件', async t => {
    const root = await fixture(t);
    await write(root, 'data/videos/trip/old.mp4', 'video');
    const id = await captureRecycle(root, { title: '编辑日记时移除的媒体', files: [{ path: 'data/photos/trip/unique.png' }, { path: 'data/videos/trip/old.mp4' }] });
    await write(root, 'data/travel_data.json', JSON.stringify([{ ...note, photos: ['shared.png'] }, other]));
    await assert.rejects(action(root, id), /选择恢复到哪篇日记/);
    await manageRecycleBin(root, { id, action: 'restore', revision: (await readRecycleBin(root)).revision, targetDescMd: note.desc_md });
    const restored = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')))[0];
    assert.ok(restored.photos.includes('unique.png'));
    assert.deepEqual(restored.videos, ['old.mp4']);
    assert.equal(restored.video_folder, 'data/videos/trip');
    const unused = await captureRecycle(root, { title: '清理的媒体', files: [{ path: 'data/videos/trip/old.mp4' }] });
    const before = await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8');
    await action(root, unused);
    assert.equal(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'), before);
});

test('回收文件预览需登录，只读取清单内文件，支持视频范围读取并防止路径越界', async t => {
    const root = await fixture(t);
    const name = 'data/photos/trip/unique.png';
    const id = await captureRecycle(root, { title: '图片', files: [{ path: name }] });
    const { base, headers } = await api(t, root);
    const url = `${base}/api/travel-data?mode=recycle-file&id=${id}&path=${encodeURIComponent(name)}`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(await response.text(), 'unique');
    const range = await fetch(url, { headers: { ...headers, Range: 'bytes=1-3' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 1-3/6');
    assert.equal(await range.text(), 'niq');
    assert.equal((await fetch(url, { headers: { ...headers, Range: 'bytes=99-' } })).status, 416);
    assert.equal((await fetch(`${url.replace(encodeURIComponent(name), encodeURIComponent('data/../.secrets/auth.json'))}`, { headers })).status, 409);
    assert.equal((await fetch(`${url.replace(encodeURIComponent(name), encodeURIComponent(note.desc_md))}`, { headers })).status, 409);
});

test('删除提交失败时恢复正文和媒体，不遗留回收项目或数据锁', async t => {
    const root = await fixture(t);
    const { base, headers } = await api(t, root);
    const rename = fs.rename;
    const mocked = t.mock.method(fs, 'rename', async (source, target) => {
        if (target === path.join(root, 'data/travel_data.json')) throw new Error('模拟索引提交失败');
        return rename(source, target);
    });
    try {
        assert.equal((await fetch(`${base}/api/travel-records`, { method: 'DELETE', headers, body: JSON.stringify({ desc_md: note.desc_md }) })).status, 500);
    } finally { mocked.mock.restore(); }
    assert.equal((await readRecycleBin(root)).items.length, 0);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 标题\n\n原正文');
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/unique.png'), 'utf8'), 'unique');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))).length, 2);
    await assert.rejects(fs.stat(path.join(root, '.travel-data.lock')), { code: 'ENOENT' });
});

test('清空可恢复整站数据，恢复前当前内容也保留，密码与旧回收项目保持不变', async t => {
    const root = await fixture(t);
    await write(root, 'data/profile/owner-name.txt', '原署名');
    const oldId = await captureRecycle(root, { title: '旧文件', files: [{ path: 'data/photos/trip/shared.png' }] });
    const auth = await fs.readFile(path.join(root, '.secrets/auth.json'));
    await clearTravelData(root);
    let report = await readRecycleBin(root);
    const snapshot = report.items.find(item => item.kind === 'snapshot');
    assert.equal(report.items.length, 2);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))), []);
    await write(root, 'data/profile/owner-name.txt', '清空后新署名');
    await action(root, snapshot.id);
    assert.equal(await fs.readFile(path.join(root, 'data/profile/owner-name.txt'), 'utf8'), '原署名');
    report = await readRecycleBin(root);
    assert.ok(report.items.some(item => item.id === oldId));
    const protection = report.items.find(item => item.title === '恢复前的数据');
    await action(root, protection.id);
    assert.equal(await fs.readFile(path.join(root, 'data/profile/owner-name.txt'), 'utf8'), '清空后新署名');
    assert.deepEqual(await fs.readFile(path.join(root, '.secrets/auth.json')), auth);
});

test('导入替换前的数据可从回收站恢复，导入失败不产生可误恢复的项目', async t => {
    const root = await fixture(t);
    const bytes = await createZipBlob([{ name: 'data/travel_data.json', data: '[]' }, { name: 'data/profile/owner-name.txt', data: '导入署名' }]);
    await importDataArchive(root, bytes);
    const item = (await readRecycleBin(root)).items[0];
    assert.equal(item.title, '导入全部数据前的数据');
    await action(root, item.id);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))).length, 2);
    const count = (await readRecycleBin(root)).items.length;
    await assert.rejects(importDataArchive(root, await createZipBlob([{ name: 'data/travel_data.json', data: 'invalid' }])));
    assert.equal((await readRecycleBin(root)).items.length, count);
});

test('旧媒体回收区自动迁入 .cache，清缓存保留回收项目，永久删除只删除指定项目', async t => {
    const root = await fixture(t);
    const id = 'a'.repeat(32);
    const file = 'data/photos/old.png';
    await write(root, `data/media-trash/${id}/${file}`, 'old');
    await write(root, `data/media-trash/${id}/manifest.json`, JSON.stringify({ createdAt: '2026-01-01', files: [{ path: file }] }));
    await write(root, '.cache/media-previews/cache.jpg', 'preview');
    let report = await readRecycleBin(root);
    assert.equal(report.items[0].id, id);
    await assert.rejects(fs.stat(path.join(root, 'data/media-trash')), { code: 'ENOENT' });
    await clearCache(root);
    await assert.rejects(fs.stat(path.join(root, '.cache/media-previews')), { code: 'ENOENT' });
    assert.equal((await readRecycleBin(root)).items.length, 1);
    await action(root, id, 'purge');
    assert.equal((await readRecycleBin(root)).totalBytes, 0);
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/shared.png'), 'utf8'), 'shared');
});

test('旧版本恢复前保存当前文件，可连续撤回且不影响其他文件', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { title: '旧正文', kind: 'version', files: [{ path: note.desc_md }] });
    await write(root, note.desc_md, '# 新正文');
    await action(root, id);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 标题\n\n原正文');
    const protection = (await readRecycleBin(root)).items[0];
    await action(root, protection.id);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 新正文');
    assert.equal(await fs.readFile(path.join(root, other.desc_md), 'utf8'), '# 另一篇');
});

test('清空回收站删除所有类型项目，保留当前数据、密码及其他缓存，空站可重复清空', async t => {
    const root = await fixture(t);
    const current = await fs.readFile(path.join(root, 'data/travel_data.json'));
    const auth = await fs.readFile(path.join(root, '.secrets/auth.json'));
    await write(root, '.cache/backup-state.json', 'backup-state');
    for (const kind of ['files', 'record', 'version', 'snapshot']) {
        await captureRecycle(root, { kind, title: kind, records: kind === 'record' ? [note] : [], files: [{ path: note.desc_md }] });
    }
    const report = await readRecycleBin(root);
    assert.equal(report.items.length, 4);
    const cleared = await manageRecycleBin(root, { action: 'clear', revision: report.revision });
    assert.deepEqual(cleared.items, []);
    assert.equal(cleared.totalBytes, 0);
    assert.deepEqual(await fs.readdir(path.join(root, '.cache/recycle-bin')), []);
    assert.deepEqual(await fs.readFile(path.join(root, 'data/travel_data.json')), current);
    assert.deepEqual(await fs.readFile(path.join(root, '.secrets/auth.json')), auth);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 标题\n\n原正文');
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/shared.png'), 'utf8'), 'shared');
    assert.equal(await fs.readFile(path.join(root, '.cache/backup-state.json'), 'utf8'), 'backup-state');
    assert.deepEqual((await manageRecycleBin(root, { action: 'clear', revision: cleared.revision })).items, []);
    await assert.rejects(fs.stat(path.join(root, '.travel-data.lock')), { code: 'ENOENT' });
});

test('清空前校验全部依赖与版本，受保护项目或新增项目不会被误删', async t => {
    const root = await fixture(t);
    await captureRecycle(root, { title: '可删除', files: [{ path: note.desc_md }] });
    const stale = (await readRecycleBin(root)).revision;
    await captureRecycle(root, { title: '被引用', files: [{ path: 'data/photos/trip/unique.png' }] });
    await assert.rejects(manageRecycleBin(root, { action: 'clear', revision: stale }), /已变化/);
    await fs.unlink(path.join(root, 'data/photos/trip/unique.png'));
    const report = await readRecycleBin(root);
    await assert.rejects(manageRecycleBin(root, { action: 'clear', revision: report.revision }), /请先恢复/);
    assert.equal((await readRecycleBin(root)).items.length, 2);
    for (const item of report.items) for (const file of item.files) await fs.stat(path.join(root, '.cache/recycle-bin', item.id, file.path));
    await assert.rejects(fs.stat(path.join(root, '.travel-data.lock')), { code: 'ENOENT' });
});

test('清空 API 要求登录和写入令牌，成功返回空回收站', async t => {
    const root = await fixture(t);
    await captureRecycle(root, { title: '旧文件', files: [{ path: note.desc_md }] });
    const { base, headers } = await api(t, root);
    const endpoint = `${base}/api/travel-data?mode=recycle-bin`;
    const body = JSON.stringify({ action: 'clear', revision: (await readRecycleBin(root)).revision });
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'X-Travel-Token': '' }, body })).status, 403);
    assert.equal((await readRecycleBin(root)).items.length, 1);
    const response = await fetch(endpoint, { method: 'POST', headers, body });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).items, []);
});

test('恢复冲突、过期版本及回收路径链接均被拒绝，不会覆盖站外文件', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { kind: 'record', title: '重复日记', records: [note], files: [{ path: note.desc_md }] });
    await assert.rejects(action(root, id), /已存在/);
    await assert.rejects(manageRecycleBin(root, { id, action: 'purge', revision: 'stale' }), /已变化/);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-recycle-outside-'));
    t.after(async () => { assert.equal(path.dirname(outside), path.resolve(os.tmpdir())); await fs.rm(outside, { recursive: true, force: true }); });
    await fs.symlink(outside, path.join(root, '.cache/recycle-bin', 'b'.repeat(32)), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readRecycleBin(root), /普通文件或目录/);
    await assert.rejects(fs.stat(path.join(root, '.travel-data.lock')), { code: 'ENOENT' });
});

test('回收站 API 保护读取与写入，静态目录不暴露内容', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { title: '旧文件', files: [{ path: note.desc_md }] });
    const { base, headers } = await api(t, root);
    assert.equal((await (await fetch(`${base}/api/travel-records`, { headers })).json()).recycleClear, true);
    assert.equal((await fetch(`${base}/api/travel-data?mode=recycle-bin`)).status, 401);
    const report = await (await fetch(`${base}/api/travel-data?mode=recycle-bin`, { headers })).json();
    assert.equal(report.items.length, 1);
    assert.equal((await fetch(`${base}/api/travel-data?mode=recycle-bin`, { method: 'POST', headers: { ...headers, 'X-Travel-Token': '' }, body: JSON.stringify({ id, revision: report.revision, action: 'purge' }) })).status, 403);
    assert.equal((await fetch(`${base}/.cache/recycle-bin/${id}/manifest.json`, { headers })).status, 403);
});

test('相同正文不展示正文，仅元数据或附件变化仍能准确识别', async () => {
    const files = [{ name: note.desc_md, data: '# 相同正文' }, { name: 'data/photos/trip/shared.png', data: 'shared' }];
    const current = await describeRecords([note], files);
    const comparisons = await compareBackup([{ ...note, trip_id: 'new' }], files, current);
    const comparison = comparisons.get(note.desc_md);
    assert.equal(comparison.status, 'changed');
    assert.equal(comparison.markdownChanged, false);
    assert.deepEqual(comparison.fields, ['trip_id']);
    assert.deepEqual(changedTextBlocks('# 相同正文', '# 相同正文'), []);
});

async function preview(root, id, targetDescMd) {
    return manageRecycleBin(root, { action: 'preview', id, targetDescMd, revision: (await readRecycleBin(root)).revision });
}

async function confirmRestore(root, id, plan, targetDescMd) {
    return manageRecycleBin(root, { action: 'restore', id, targetDescMd, previewToken: plan.previewToken, revision: (await readRecycleBin(root)).revision });
}

test('恢复预览的整个异步读取过程持有数据锁', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { kind: 'version', title: '旧正文', files: [{ path: note.desc_md }] });
    const revision = (await readRecycleBin(root)).revision;
    const readFile = fs.readFile;
    let count = 0;
    let entered;
    let resume;
    const reading = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    const mocked = t.mock.method(fs, 'readFile', async (target, ...args) => {
        if (target === path.join(root, 'data/travel_data.json') && ++count === 2) {
            entered();
            await gate;
        }
        return readFile(target, ...args);
    });
    const pending = manageRecycleBin(root, { action: 'preview', id, revision });
    try {
        await reading;
        assert.ok((await fs.stat(path.join(root, '.travel-data.lock'))).isFile());
    } finally { resume(); await pending; mocked.mock.restore(); }
    await assert.rejects(fs.stat(path.join(root, '.travel-data.lock')), { code: 'ENOENT' });
});

test('同一日记冲突先预览字段、正文和附件，确认恢复留存当前版本且不影响其他日记', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { kind: 'record', title: '旧日记', records: [note], files: [note.desc_md, 'data/photos/trip/unique.png'].map(path => ({ path })) });
    await write(root, note.desc_md, '# 新标题\n\n新正文');
    await write(root, 'data/photos/trip/unique.png', 'new-photo');
    await write(root, 'data/travel_data.json', JSON.stringify([{ ...note, locality: '新地点' }, other]));
    const plan = await preview(root, id);
    const change = plan.changes.find(change => change.record.desc_md === note.desc_md).comparison;
    assert.equal(change.status, 'changed');
    assert.deepEqual(change.fields, ['locality']);
    assert.equal(change.currentMarkdown, '# 新标题\n\n新正文');
    assert.equal(change.markdown, '# 标题\n\n原正文');
    assert.deepEqual(change.media, ['data/photos/trip/unique.png']);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 新标题\n\n新正文');
    assert.equal((await readRecycleBin(root)).items.length, 1);
    await confirmRestore(root, id, plan);
    const records = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')));
    assert.equal(records.length, 2);
    assert.equal(records[0].locality, note.locality);
    assert.equal(records[1].desc_md, other.desc_md);
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/unique.png'), 'utf8'), 'unique');
    const protection = (await readRecycleBin(root)).items.find(item => item.title === '恢复前的文件');
    assert.ok(protection);
    await action(root, protection.id);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 新标题\n\n新正文');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')))[0].locality, '新地点');
});

test('附件恢复预览真实的合并结果，保留后续字段与附件并显示同名内容变化', async t => {
    const root = await fixture(t);
    const name = 'data/photos/trip/unique.png';
    const id = await captureRecycle(root, { title: '旧附件', mediaReferences: [note], files: [{ path: name }] });
    await write(root, name, 'newer');
    await write(root, 'data/travel_data.json', JSON.stringify([{ ...note, locality: '后续地点', photos: ['shared.png', 'later.png'] }, other]));
    const plan = await preview(root, id);
    const change = plan.changes.find(change => change.record.desc_md === note.desc_md);
    assert.deepEqual(change.comparison.fields, ['photos']);
    assert.equal(change.comparison.markdownChanged, false);
    assert.deepEqual(change.comparison.media, [name]);
    assert.deepEqual(change.record.photos, ['shared.png', 'unique.png', 'later.png']);
    await confirmRestore(root, id, plan);
    const record = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')))[0];
    assert.equal(record.locality, '后续地点');
    assert.deepEqual(record.photos, change.record.photos);
});

test('预览后正文、同大小媒体、索引、无引用文件变化或恢复目标改变时拒绝旧预览', async t => {
    const root = await fixture(t);
    const name = 'data/photos/trip/unique.png';
    const id = await captureRecycle(root, { title: '旧文件', files: [{ path: name }] });
    for (const [target, value] of [[note.desc_md, '# 后续修改'], [name, 'UNIQUE'], ['data/travel_data.json', JSON.stringify([{ ...note, trip_id: 'later' }, other])], ['data/profile/owner-name.txt', '新署名']]) {
        const plan = await preview(root, id);
        await write(root, target, value);
        await assert.rejects(confirmRestore(root, id, plan), /预览后内容已变化/);
        assert.equal(await fs.readFile(path.join(root, target), 'utf8'), value);
    }
    const plan = await preview(root, id);
    await assert.rejects(confirmRestore(root, id, plan, other.desc_md), /预览后内容已变化/);
    assert.equal((await readRecycleBin(root)).items.length, 1);
});

test('整站恢复预览包含日记移除、个人资料和无引用文件变化，预览不改磁盘', async t => {
    const root = await fixture(t);
    await write(root, 'data/profile/owner-name.txt', '旧署名');
    const id = await captureRecycle(root, { kind: 'snapshot', title: '旧整站' });
    const added = { ...other, date: '2026-11-05', desc_md: 'data/travel-diary/2026/2026-11-05-new.md' };
    await write(root, added.desc_md, '# 后新增日记');
    await write(root, 'data/travel_data.json', JSON.stringify([note, other, added]));
    await write(root, 'data/profile/owner-name.txt', '新署名');
    await write(root, 'data/photos/orphan.png', 'orphan');
    const plan = await preview(root, id);
    assert.equal(plan.changes.find(change => change.record.desc_md === added.desc_md).comparison.status, 'removed');
    assert.equal(plan.changes.find(change => change.record.desc_md === 'data/profile/owner-name.txt').comparison.markdown, '旧署名');
    assert.equal(plan.changes.find(change => change.record.desc_md === 'data/photos/orphan.png').comparison.status, 'removed');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))).length, 3);
    await confirmRestore(root, id, plan);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))).length, 2);
    assert.equal(await fs.readFile(path.join(root, 'data/profile/owner-name.txt'), 'utf8'), '旧署名');
    await assert.rejects(fs.stat(path.join(root, 'data/photos/orphan.png')), { code: 'ENOENT' });
});

test('旧正文与未引用文件复用恢复差异，正文缺失的其他日记不阻断预览', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { kind: 'version', title: '旧正文', files: [{ path: note.desc_md }] });
    await write(root, note.desc_md, '# 当前正文');
    await fs.unlink(path.join(root, other.desc_md));
    const plan = await preview(root, id);
    assert.equal(plan.changes.length, 1);
    assert.equal(plan.changes[0].comparison.currentMarkdown, '# 当前正文');
    await confirmRestore(root, id, plan);
    const name = 'data/photos/orphan.png';
    await write(root, name, 'old');
    const fileId = await captureRecycle(root, { title: '无引用文件', files: [{ path: name }] });
    await write(root, name, 'new');
    const filePlan = await preview(root, fileId);
    assert.deepEqual(filePlan.changes[0].comparison.media, [name]);
    const index = await fs.readFile(path.join(root, 'data/travel_data.json'));
    await confirmRestore(root, fileId, filePlan);
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), 'old');
    assert.deepEqual(await fs.readFile(path.join(root, 'data/travel_data.json')), index);
});

test('确认冲突恢复时索引提交失败，撤回附件覆盖并保留原回收项目', async t => {
    const root = await fixture(t);
    const name = 'data/photos/trip/unique.png';
    const id = await captureRecycle(root, { title: '旧附件', mediaReferences: [note], files: [{ path: name }] });
    await write(root, name, 'current');
    await write(root, 'data/travel_data.json', JSON.stringify([{ ...note, photos: ['shared.png'] }, other]));
    const plan = await preview(root, id);
    const writeFile = fs.writeFile;
    const mocked = t.mock.method(fs, 'writeFile', async (target, ...args) => {
        if (target === path.join(root, 'data/travel_data.json')) throw new Error('模拟索引提交失败');
        return writeFile(target, ...args);
    });
    try { await assert.rejects(confirmRestore(root, id, plan), /索引提交失败/); }
    finally { mocked.mock.restore(); }
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), 'current');
    assert.deepEqual((await readRecycleBin(root)).items.map(item => item.id), [id]);
    await assert.rejects(fs.stat(path.join(root, '.travel-data.lock')), { code: 'ENOENT' });
});

test('恢复预览 API 要求会话与令牌，返回差异而非执行恢复', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { kind: 'version', title: '旧正文', files: [{ path: note.desc_md }] });
    await write(root, note.desc_md, '# 当前正文');
    const { base, headers } = await api(t, root);
    const url = `${base}/api/travel-data?mode=recycle-bin`;
    const body = JSON.stringify({ action: 'preview', id, revision: (await readRecycleBin(root)).revision });
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'X-Travel-Token': '' }, body })).status, 403);
    const response = await fetch(url, { method: 'POST', headers, body });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).changes[0].comparison.markdown, '# 标题\n\n原正文');
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 当前正文');
});

test('共用媒体的字节未变，单篇日记新增或移除引用仍列入附件差异', async () => {
    const files = [{ name: note.desc_md, data: '# 日记' }, { name: other.desc_md, data: '# 另一篇' }, { name: 'data/photos/trip/shared.png', data: 'shared' }, { name: 'data/photos/trip/unique.png', data: 'unique' }];
    const current = await describeRecords([note, other], files);
    const comparisons = await compareBackup([{ ...note, photos: ['unique.png'] }, other], files, current);
    assert.deepEqual(comparisons.get(note.desc_md).media, ['data/photos/trip/shared.png']);
});

test('正文比较仅输出改动块，支持新增、删除、分散修改与长正文', () => {
    assert.deepEqual(changedTextBlocks('开头\n旧段落\n中间\n旧结尾\n末尾', '开头\n新段落\n中间\n新结尾\n末尾'), [
        { before: '旧段落', after: '新段落', lineBefore: 2, lineAfter: 2, countBefore: 1, countAfter: 1 }, { before: '旧结尾', after: '新结尾', lineBefore: 4, lineAfter: 4, countBefore: 1, countAfter: 1 }
    ]);
    assert.deepEqual(changedTextBlocks('第一行\n末尾', '第一行\n新增\n末尾'), [{ before: '', after: '新增', lineBefore: 2, lineAfter: 2, countBefore: 0, countAfter: 1 }]);
    assert.deepEqual(changedTextBlocks('第一行\n删除\n末尾', '第一行\n末尾'), [{ before: '删除', after: '', lineBefore: 2, lineAfter: 2, countBefore: 1, countAfter: 0 }]);
    const before = Array.from({ length: 20000 }, (_, i) => `行${i}`).join('\n');
    const blocks = changedTextBlocks(before, before.replace('行1234\n', '改动\n'));
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].after, '改动');
    const inserted = Array.from({ length: 150 }, (_, i) => `新增段${i}`).join('\n');
    const scattered = changedTextBlocks('开头\n相同中段\n旧结尾\n结束', `开头\n${inserted}\n相同中段\n新结尾\n结束`);
    assert.equal(scattered.length, 2);
    assert.equal(scattered[0].after, inserted);
    assert.equal(scattered[1].before, '旧结尾');
});

test('单栏正文差异保留空行计数，空正文不产生虚假的删除或新增行', () => {
    assert.deepEqual(changedTextBlocks('', '# 新日记'), [{ before: '', after: '# 新日记', lineBefore: 1, lineAfter: 1, countBefore: 0, countAfter: 1 }]);
    assert.deepEqual(changedTextBlocks('# 旧日记', ''), [{ before: '# 旧日记', after: '', lineBefore: 1, lineAfter: 1, countBefore: 1, countAfter: 0 }]);
    assert.deepEqual(changedTextBlocks('开头\n结尾', '开头\n\n结尾'), [{ before: '', after: '', lineBefore: 2, lineAfter: 2, countBefore: 0, countAfter: 1 }]);
    const pairs = [
        ['', '\n'], ['\n', ''], ['正文', '\n正文'], ['\n正文', '正文'],
        ['正文', '正文\n'], ['正文\n', '正文'], ['开头\n\n结尾', '开头\n结尾'],
        ['开头\n\n旧行\n结尾', '开头\n新行\n\n\n结尾']
    ];
    for (const [before, after] of pairs) {
        const result = before ? before.split('\n') : [];
        for (const block of changedTextBlocks(before, after).reverse()) {
            const added = block.countAfter ? block.after.split('\n') : [];
            assert.equal(added.length, block.countAfter);
            assert.deepEqual(result.slice(block.lineBefore - 1, block.lineBefore - 1 + block.countBefore), block.countBefore ? block.before.split('\n') : []);
            result.splice(block.lineBefore - 1, block.countBefore, ...added);
        }
        assert.deepEqual(result, after ? after.split('\n') : []);
    }
});
