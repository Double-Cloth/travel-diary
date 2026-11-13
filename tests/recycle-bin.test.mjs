import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fileSystem from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { captureRecycle, readRecycleBin, manageRecycleBin } from '../js/recycle-bin.js';
import { clearTravelData, importDataArchive } from '../js/data-archive.js';
import { clearCache } from '../scripts/clear-cache.js';
import { createHandler } from '../js/server.js';
import fileStream from '../js/file-stream.js';
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

test('展示关联独立留存，正文改名后仍可定位日记且恢复不会还原旧索引信息', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { kind: 'version', title: '编辑前正文', displayRecords: [note], files: [{ path: note.desc_md }] });
    const current = { ...note, desc_md: 'data/travel-diary/2026/2026-11-03-new.md', locality: '新地点' };
    await write(root, 'data/travel_data.json', JSON.stringify([current, other]));
    const item = (await readRecycleBin(root)).items.find(item => item.id === id);
    assert.deepEqual(item.records, []);
    assert.deepEqual(item.displayRecords, [note]);
    assert.deepEqual(item.mediaReferences, []);
    await action(root, id);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')))[0].locality, '新地点');
});

test('整站回收从归档索引提取展示信息，旧清单和无效索引仍可列出', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { kind: 'snapshot', title: '整站历史' });
    await write(root, 'data/travel_data.json', '[]');
    let report = await readRecycleBin(root);
    assert.deepEqual(report.items[0].records, []);
    assert.deepEqual(report.items[0].displayRecords, [note, other]);
    await write(root, `.cache/recycle-bin/${id}/data/travel_data.json`, '{');
    report = await readRecycleBin(root);
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0].displayRecords, undefined);
});

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

test('清理的附件可恢复到不同目录的日记，预览与提交使用相同目标并保留现有附件', async t => {
    const root = await fixture(t);
    const source = 'data/photos/yuxi/recovered.png';
    const destination = 'data/photos/trip/recovered.png';
    await write(root, source, 'recovered');
    const id = await captureRecycle(root, { title: '清理的媒体', files: [{ path: source }] });
    await fs.unlink(path.join(root, source));
    let report = await readRecycleBin(root);
    const preview = await manageRecycleBin(root, { action: 'preview', id, targetDescMd: note.desc_md, revision: report.revision });
    assert.deepEqual(preview.savedFiles, [{ path: destination, sourcePath: source }]);
    assert.deepEqual(preview.savedPaths, [destination]);
    assert.equal(preview.changes.length, 1);
    assert.equal(preview.changes[0].record.photo_folder, note.photo_folder);
    assert.deepEqual(new Set(preview.changes[0].record.photos), new Set([...note.photos, 'recovered.png']));
    assert.deepEqual(preview.changes[0].comparison.media, [destination]);
    await assert.rejects(fs.stat(path.join(root, destination)), { code: 'ENOENT' });
    await manageRecycleBin(root, { action: 'restore-selected', revision: report.revision, selections: [{ id, targetDescMd: note.desc_md, previewToken: preview.previewToken }] });
    const records = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')));
    assert.deepEqual(new Set(records[0].photos), new Set([...note.photos, 'recovered.png']));
    assert.deepEqual(records[1], { ...other, record_id: `legacy:${other.desc_md}` });
    assert.equal(await fs.readFile(path.join(root, destination), 'utf8'), 'recovered');
    await assert.rejects(fs.stat(path.join(root, source)), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/shared.png'), 'utf8'), 'shared');
    report = await readRecycleBin(root);
    assert.ok(!report.items.some(item => item.id === id));
    assert.ok(report.items.some(item => item.title === '恢复前的文件'));
});

test('跨目录恢复在提交失败时撤回目标文件；同名来源及非法目标不会被合并', async t => {
    const root = await fixture(t);
    const source = 'data/photos/yuxi/new.png';
    await write(root, source, 'source');
    const id = await captureRecycle(root, { title: '清理的媒体', files: [{ path: source }] });
    await fs.unlink(path.join(root, source));
    const report = await readRecycleBin(root);
    const preview = await manageRecycleBin(root, { action: 'preview', id, targetDescMd: note.desc_md, revision: report.revision });
    const before = await fs.readFile(path.join(root, 'data/travel_data.json'));
    const writeFile = fs.writeFile;
    const failure = t.mock.method(fs, 'writeFile', async (target, ...args) => {
        if (target === path.join(root, 'data/travel_data.json')) throw new Error('模拟跨目录提交失败');
        return writeFile(target, ...args);
    });
    try { await assert.rejects(manageRecycleBin(root, { action: 'restore-selected', revision: report.revision, selections: [{ id, targetDescMd: note.desc_md, previewToken: preview.previewToken }] }), /跨目录提交失败/); }
    finally { failure.mock.restore(); }
    assert.deepEqual(await fs.readFile(path.join(root, 'data/travel_data.json')), before);
    await assert.rejects(fs.stat(path.join(root, 'data/photos/trip/new.png')), { code: 'ENOENT' });
    assert.ok((await readRecycleBin(root)).items.some(item => item.id === id));
    await write(root, 'data/photos/one/same.png', 'one');
    await write(root, 'data/photos/two/same.png', 'two');
    const duplicate = await captureRecycle(root, { title: '多目录媒体', files: [{ path: 'data/photos/one/same.png' }, { path: 'data/photos/two/same.png' }] });
    await assert.rejects(manageRecycleBin(root, { action: 'preview', id: duplicate, revision: (await readRecycleBin(root)).revision, targetDescMd: note.desc_md }), /同名文件/);
    await write(root, 'data/travel_data.json', JSON.stringify([{ ...note, photo_folder: 'data/photos/../outside' }, other]));
    await assert.rejects(manageRecycleBin(root, { action: 'preview', id, revision: (await readRecycleBin(root)).revision, targetDescMd: note.desc_md }), /路径无效/);
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

test('清除所选内容仅删除指定批次，保留未选内容和当前数据', async t => {
    const root = await fixture(t);
    const current = await fs.readFile(path.join(root, 'data/travel_data.json'));
    const ids = [];
    for (const title of ['选中一', '保留', '选中二']) ids.push(await captureRecycle(root, { title, files: [{ path: note.desc_md }] }));
    const report = await readRecycleBin(root);
    const result = await manageRecycleBin(root, { action: 'purge-selected', ids: [ids[0], ids[2]], revision: report.revision });
    assert.deepEqual(result.items.map(item => item.id), [ids[1]]);
    assert.deepEqual(await fs.readFile(path.join(root, 'data/travel_data.json')), current);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 标题\n\n原正文');
    for (const id of [ids[0], ids[2]]) await assert.rejects(fs.stat(path.join(root, '.cache/recycle-bin', id)), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(root, '.cache/recycle-bin', ids[1], note.desc_md), 'utf8'), '# 标题\n\n原正文');
});

test('清除所选内容在删除前拒绝无效、重复、过期选择及当前日记缺失的依赖', async t => {
    const root = await fixture(t);
    const first = await captureRecycle(root, { title: '可删除', files: [{ path: note.desc_md }] });
    const protectedId = await captureRecycle(root, { title: '被引用', files: [{ path: 'data/photos/trip/unique.png' }] });
    const report = await readRecycleBin(root);
    for (const ids of [undefined, [], 'invalid', [first, first], [first, 'missing'], [null]]) {
        await assert.rejects(manageRecycleBin(root, { action: 'purge-selected', ids, revision: report.revision }), /有效且不重复/);
    }
    await assert.rejects(manageRecycleBin(root, { action: 'purge-selected', ids: [first], revision: 'stale' }), /已变化/);
    await fs.unlink(path.join(root, 'data/photos/trip/unique.png'));
    await assert.rejects(manageRecycleBin(root, { action: 'purge-selected', ids: [first, protectedId], revision: report.revision }), /请先恢复/);
    assert.deepEqual(new Set((await readRecycleBin(root)).items.map(item => item.id)), new Set([first, protectedId]));
    for (const item of report.items) for (const file of item.files) await fs.stat(path.join(root, '.cache/recycle-bin', item.id, file.path));
    await assert.rejects(fs.stat(path.join(root, '.travel-data.lock')), { code: 'ENOENT' });
    const result = await manageRecycleBin(root, { action: 'purge-selected', ids: [first], revision: report.revision });
    assert.deepEqual(result.items.map(item => item.id), [protectedId]);
});

test('清除所选内容 API 要求会话与令牌，无需恢复预览即可删除', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { title: '旧文件', files: [{ path: note.desc_md }] });
    const { base, headers } = await api(t, root);
    const capability = await (await fetch(`${base}/api/travel-records`, { headers })).json();
    assert.equal(capability.recyclePurgeSelection, true);
    const endpoint = `${base}/api/travel-data?mode=recycle-bin`;
    const body = JSON.stringify({ action: 'purge-selected', ids: [id], revision: (await readRecycleBin(root)).revision });
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

test('恢复差异复用内容签名，避免再次流式读取媒体', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { kind: 'version', title: '旧正文', files: [{ path: note.desc_md }] });
    await write(root, note.desc_md, '# 新正文');
    const fileSource = fileStream.fileSource;
    const mocked = t.mock.method(fileStream, 'fileSource', async (...args) => {
        const source = await fileSource(...args);
        source.chunks = async function* () { throw new Error('重复读取了媒体签名'); };
        return source;
    });
    try {
        const plan = await preview(root, id);
        assert.equal(plan.changes.length, 1);
        assert.equal(plan.changes[0].comparison.markdown, '# 标题\n\n原正文');
    } finally { mocked.mock.restore(); }
});

test('首次正文预览只读取被恢复的正文，无关媒体和其他日记正文无需读取', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { kind: 'version', title: '旧正文', files: [{ path: note.desc_md }] });
    await write(root, note.desc_md, '# 新正文');
    await write(root, other.desc_md, Buffer.from([0xff]));
    await write(root, 'data/videos/unreferenced.mp4', 'unreferenced');
    const streams = [];
    const createReadStream = fileSystem.createReadStream;
    const mocked = t.mock.method(fileSystem, 'createReadStream', (file, ...args) => {
        streams.push(path.relative(root, file).replaceAll('\\', '/'));
        return createReadStream(file, ...args);
    });
    try {
        const plan = await preview(root, id);
        assert.equal(plan.changes.length, 1);
        assert.equal(plan.changes[0].comparison.markdown, '# 标题\n\n原正文');
        assert.deepEqual(streams.sort(), [note.desc_md, `.cache/recycle-bin/${id}/${note.desc_md}`].sort());
        await write(root, 'data/videos/unreferenced.mp4', 'UNREFERENCED');
        await assert.rejects(confirmRestore(root, id, plan), /预览后内容已变化/);
    } finally { mocked.mock.restore(); }
});

test('恢复改名日记时相同正文按字节比较，继续保留正文改名的信息变化', async t => {
    const root = await fixture(t);
    const original = { ...note, record_id: `r-${'a'.repeat(32)}` };
    await write(root, 'data/travel_data.json', JSON.stringify([original, other]));
    const id = await captureRecycle(root, { kind: 'record', title: '原日记', records: [original], files: [{ path: original.desc_md }] });
    const renamed = { ...original, desc_md: 'data/travel-diary/2026/renamed.md' };
    await write(root, renamed.desc_md, '# 标题\n\n原正文');
    await write(root, 'data/travel_data.json', JSON.stringify([renamed, other]));
    const plan = await preview(root, id);
    assert.equal(plan.changes.length, 1);
    assert.equal(plan.changes[0].comparison.markdownChanged, false);
    assert.ok(plan.changes[0].comparison.fields.includes('desc_md'));
});

test('签名缓存识别同大小同修改时间的写入和文件替换，重复预览保持一致', async t => {
    const root = await fixture(t);
    const name = 'data/photos/trip/unique.png';
    const id = await captureRecycle(root, { title: '旧附件', mediaReferences: [note], files: [{ path: name }] });
    const plan = await preview(root, id);
    assert.equal((await preview(root, id)).previewToken, plan.previewToken);
    const target = path.join(root, name);
    const before = await fs.stat(target);
    await write(root, name, 'UNIQUE');
    await fs.utimes(target, before.atime, before.mtime);
    await assert.rejects(confirmRestore(root, id, plan), /预览后内容已变化/);
    const changed = await preview(root, id);
    assert.deepEqual(changed.changes[0].comparison.media, [name]);
    const replacement = `${target}.replacement`;
    await fs.writeFile(replacement, 'unique');
    await fs.utimes(replacement, before.atime, before.mtime);
    await fs.rename(replacement, target);
    await assert.rejects(confirmRestore(root, id, changed), /预览后内容已变化/);
    assert.equal((await preview(root, id)).changes.length, 0);
});

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

test('恢复预览保留空文件的存在状态及附件两侧的字节数', async t => {
    const root = await fixture(t);
    await write(root, note.desc_md, '');
    const name = 'data/photos/empty.png';
    await write(root, name, '');
    const id = await captureRecycle(root, { kind: 'version', title: '空文件', files: [{ path: note.desc_md }, { path: name }] });
    await fs.unlink(path.join(root, note.desc_md));
    await write(root, name, 'current');
    const plan = await preview(root, id);
    const body = plan.changes.find(change => change.record.desc_md === note.desc_md).comparison;
    assert.equal(body.markdown, '');
    assert.deepEqual(body.markdownExists, { before: false, after: true });
    const image = plan.changes.find(change => change.comparison.media.includes(name)).comparison;
    assert.equal(image.mediaSizes.before[name], 7);
    assert.equal(image.mediaSizes.after[name], 0);
    await confirmRestore(root, id, plan);
    assert.equal((await fs.stat(path.join(root, note.desc_md))).size, 0);
    assert.equal((await fs.stat(path.join(root, name))).size, 0);
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

async function selectedRestore(root, selections, revision) {
    return manageRecycleBin(root, { action: 'restore-selected', selections, revision: revision ?? (await readRecycleBin(root)).revision });
}
async function selectionsFor(root, ids) {
    const selections = [];
    for (const id of ids) selections.push({ id, previewToken: (await preview(root, id)).previewToken });
    return selections;
}

test('选择恢复一次合并多份同篇附件，保留后续日记内容且留存恢复前版本', async t => {
    const root = await fixture(t);
    const names = ['data/photos/trip/unique.png', 'data/photos/trip/second.png'];
    await write(root, names[1], 'second');
    const saved = { ...note, photos: ['shared.png', 'unique.png', 'second.png'] };
    const ids = [];
    for (const name of names) {
        ids.push(await captureRecycle(root, { title: name, mediaReferences: [saved], files: [{ path: name }] }));
        await fs.unlink(path.join(root, name));
    }
    await write(root, 'data/travel_data.json', JSON.stringify([{ ...note, locality: '后续地点', photos: ['shared.png'] }, other]));
    const result = await selectedRestore(root, await selectionsFor(root, ids));
    const restored = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')))[0];
    assert.deepEqual(restored.photos, saved.photos);
    assert.equal(restored.locality, '后续地点');
    for (const name of names) assert.ok((await fs.stat(path.join(root, name))).isFile());
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, '恢复前的文件');
    assert.ok(result.items[0].files.some(file => file.path === 'data/travel_data.json'));
});

test('选择恢复先校验全部令牌，缺失、重复、过期或目标变更均不写入', async t => {
    const root = await fixture(t);
    const ids = [];
    for (const name of [note.desc_md, other.desc_md]) {
        ids.push(await captureRecycle(root, { kind: 'version', title: name, files: [{ path: name }] }));
        await write(root, name, '# 当前正文');
    }
    const selections = await selectionsFor(root, ids);
    for (const invalid of [[], [selections[0], selections[0]], [selections[0], { id: ids[1] }], [selections[0], { ...selections[1], previewToken: 'bad' }], [selections[0], { ...selections[1], targetDescMd: note.desc_md }]]) {
        await assert.rejects(selectedRestore(root, invalid), /选择|预览/);
        assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 当前正文');
        assert.deepEqual(new Set((await readRecycleBin(root)).items.map(item => item.id)), new Set(ids));
    }
    await write(root, 'data/profile/owner-name.txt', '预览后的变化');
    await assert.rejects(selectedRestore(root, selections), /预览后内容已变化/);
    assert.equal(await fs.readFile(path.join(root, other.desc_md), 'utf8'), '# 当前正文');
});

test('所选文件版本冲突或整站混选在写入前拒绝，整站单选仍可恢复', async t => {
    const root = await fixture(t);
    const first = await captureRecycle(root, { kind: 'version', title: '版本一', files: [{ path: note.desc_md }] });
    await write(root, note.desc_md, '# 版本二');
    const second = await captureRecycle(root, { kind: 'version', title: '版本二', files: [{ path: note.desc_md }] });
    await write(root, note.desc_md, '# 当前正文');
    await assert.rejects(selectedRestore(root, await selectionsFor(root, [first, second])), /同一篇日记每次只能恢复一个版本/);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 当前正文');
    const snapshot = await captureRecycle(root, { kind: 'snapshot', title: '整站备份' });
    await write(root, note.desc_md, '# 之后修改');
    await assert.rejects(selectedRestore(root, await selectionsFor(root, [first, snapshot])), /需要单独恢复/);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 之后修改');
    await selectedRestore(root, await selectionsFor(root, [snapshot]));
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 当前正文');
});

test('同篇日记内容相同的两次回收也禁止一起恢复，拒绝后当前内容和回收记录完整', async t => {
    const root = await fixture(t);
    const ids = [];
    for (let index = 0; index < 2; index++) ids.push(await captureRecycle(root, { kind: 'version', title: '编辑前正文', files: [{ path: note.desc_md }] }));
    await write(root, note.desc_md, '# 当前正文');
    await assert.rejects(selectedRestore(root, await selectionsFor(root, ids)), /同一篇日记每次只能恢复一个版本/);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 当前正文');
    assert.deepEqual(new Set((await readRecycleBin(root)).items.map(item => item.id)), new Set(ids));
    await selectedRestore(root, await selectionsFor(root, [ids[0]]));
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 标题\n\n原正文');
});

test('同篇固定标识的正文改名后禁止同时恢复两份历史正文', async t => {
    const root = await fixture(t);
    const original = { ...note, record_id: `r-${'a'.repeat(32)}` };
    const current = { ...original, desc_md: 'data/travel-diary/2026/renamed.md' };
    const first = await captureRecycle(root, { kind: 'version', title: '旧路径正文', displayRecords: [original], files: [{ path: original.desc_md }] });
    await write(root, current.desc_md, '# 改名后正文');
    const second = await captureRecycle(root, { kind: 'version', title: '新路径正文', displayRecords: [current], files: [{ path: current.desc_md }] });
    await write(root, 'data/travel_data.json', JSON.stringify([current, other]));
    await write(root, current.desc_md, '# 最新正文');
    await assert.rejects(selectedRestore(root, await selectionsFor(root, [first, second])), /同一篇日记每次只能恢复一个版本/);
    assert.equal(await fs.readFile(path.join(root, current.desc_md), 'utf8'), '# 最新正文');
    assert.equal((await readRecycleBin(root)).items.length, 2);
});

test('同篇日记的完整记录与附件混选被拒绝，不互相覆盖', async t => {
    const root = await fixture(t);
    const record = await captureRecycle(root, { kind: 'record', title: '整篇日记', records: [note], files: [{ path: note.desc_md }] });
    const media = await captureRecycle(root, { title: '附件', mediaReferences: [note], files: [{ path: 'data/photos/trip/unique.png' }] });
    await assert.rejects(selectedRestore(root, await selectionsFor(root, [record, media])), /同一篇日记/);
    assert.equal((await readRecycleBin(root)).items.length, 2);
});

test('选择恢复提交失败时整批撤回文件与索引，保留全部原回收项目', async t => {
    const root = await fixture(t);
    const ids = [];
    for (const name of [note.desc_md, 'data/photos/trip/unique.png']) {
        ids.push(await captureRecycle(root, { title: name, mediaReferences: name.endsWith('.png') ? [note] : [], files: [{ path: name }] }));
        await write(root, name, '当前文件');
    }
    await write(root, 'data/travel_data.json', JSON.stringify([{ ...note, photos: ['shared.png'] }, other]));
    const before = await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8');
    const selections = await selectionsFor(root, ids);
    const writeFile = fs.writeFile;
    const mocked = t.mock.method(fs, 'writeFile', async (target, ...args) => {
        if (target === path.join(root, 'data/travel_data.json')) throw new Error('模拟整批索引提交失败');
        return writeFile(target, ...args);
    });
    try { await assert.rejects(selectedRestore(root, selections), /索引提交失败/); }
    finally { mocked.mock.restore(); }
    for (const name of [note.desc_md, 'data/photos/trip/unique.png']) assert.equal(await fs.readFile(path.join(root, name), 'utf8'), '当前文件');
    assert.equal(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'), before);
    assert.deepEqual(new Set((await readRecycleBin(root)).items.map(item => item.id)), new Set(ids));
});

test('选择恢复 API 要求会话与写入令牌，并一次恢复全部已预览项目', async t => {
    const root = await fixture(t);
    const { base, headers } = await api(t, root);
    const capability = await (await fetch(`${base}/api/travel-records`, { headers })).json();
    assert.equal(capability.recycleSelection, true);
    const ids = [];
    for (const name of [note.desc_md, other.desc_md]) {
        ids.push(await captureRecycle(root, { kind: 'version', title: name, files: [{ path: name }] }));
        await write(root, name, '# 当前正文');
    }
    const body = JSON.stringify({ action: 'restore-selected', selections: await selectionsFor(root, ids), revision: (await readRecycleBin(root)).revision });
    const url = `${base}/api/travel-data?mode=recycle-bin`;
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'X-Travel-Token': '' }, body })).status, 403);
    const response = await fetch(url, { method: 'POST', headers, body });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).items.every(item => !ids.includes(item.id)));
    assert.equal(await fs.readFile(path.join(root, other.desc_md), 'utf8'), '# 另一篇');
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 标题\n\n原正文');
});

test('选择恢复补回多篇删除日记，重复的相同文件仅写入一次', async t => {
    const root = await fixture(t);
    const shared = 'data/photos/trip/shared.png';
    const ids = [];
    for (const record of [note, other]) ids.push(await captureRecycle(root, { kind: 'record', title: record.desc_md, records: [record], files: [{ path: record.desc_md }, { path: shared }] }));
    await write(root, 'data/travel_data.json', '[]');
    for (const name of [note.desc_md, other.desc_md, shared]) await fs.unlink(path.join(root, name));
    const result = await selectedRestore(root, await selectionsFor(root, ids));
    const restored = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')));
    assert.deepEqual(restored.map(record => record.desc_md), [note.desc_md, other.desc_md]);
    assert.equal(await fs.readFile(path.join(root, shared), 'utf8'), 'shared');
    assert.ok(result.items.every(item => !ids.includes(item.id)));
});


test('整站回收可只合并一篇日记及部分附件，保留当前其他日记、资料和原批次', async t => {
    const root = await fixture(t);
    await clearTravelData(root);
    const report = await readRecycleBin(root);
    const item = report.items.find(item => item.kind === 'snapshot');
    await write(root, 'data/travel_data.json', JSON.stringify([other]));
    await write(root, other.desc_md, '# 后续内容');
    await write(root, 'data/profile/owner-name.txt', '后续署名');
    const parts = [`record:${note.desc_md}`, 'file:data/photos/trip/unique.png'];
    const preview = await manageRecycleBin(root, { action: 'preview', id: item.id, parts, revision: report.revision });
    assert.ok(preview.savedPaths.includes(note.desc_md));
    assert.ok(!preview.savedPaths.includes('data/photos/trip/shared.png'));
    assert.ok(!preview.changes.some(change => change.comparison.status === 'removed'));
    const result = await manageRecycleBin(root, { action: 'restore-selected', revision: report.revision,
        selections: [{ id: item.id, parts, previewToken: preview.previewToken }] });
    const records = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')));
    assert.equal(records.length, 2);
    assert.deepEqual(records.find(record => record.desc_md === note.desc_md).photos, ['unique.png']);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 标题\n\n原正文');
    assert.equal(await fs.readFile(path.join(root, other.desc_md), 'utf8'), '# 后续内容');
    assert.equal(await fs.readFile(path.join(root, 'data/profile/owner-name.txt'), 'utf8'), '后续署名');
    await assert.rejects(fs.stat(path.join(root, 'data/photos/trip/shared.png')), { code: 'ENOENT' });
    assert.ok(result.items.some(candidate => candidate.id === item.id));
});

test('部分恢复仅正文或附件时保留后续信息，已删除日记自动带回信息与正文', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { kind: 'record', title: '删除的日记', records: [note],
        files: [{ path: note.desc_md }, { path: 'data/photos/trip/unique.png' }] });
    await write(root, 'data/travel_data.json', JSON.stringify([{ ...note, locality: '后续地点', photos: ['later.png'] }, other]));
    await write(root, note.desc_md, '# 后续正文');
    await fs.unlink(path.join(root, 'data/photos/trip/unique.png'));
    let report = await readRecycleBin(root);
    const restore = async parts => {
        report = await readRecycleBin(root);
        const preview = await manageRecycleBin(root, { action: 'preview', id, parts, revision: report.revision });
        await manageRecycleBin(root, { action: 'restore-selected', revision: report.revision, selections: [{ id, parts, previewToken: preview.previewToken }] });
    };
    await restore(['file:data/photos/trip/unique.png']);
    let current = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))).find(record => record.desc_md === note.desc_md);
    assert.equal(current.locality, '后续地点');
    assert.deepEqual(current.photos, ['later.png', 'unique.png']);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 后续正文');
    await restore([`file:${note.desc_md}`]);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 标题\n\n原正文');
    await write(root, 'data/travel_data.json', JSON.stringify([other]));
    await fs.unlink(path.join(root, note.desc_md));
    await restore([`file:${note.desc_md}`]);
    current = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))).find(record => record.desc_md === note.desc_md);
    assert.ok(current);
    assert.deepEqual(current.photos, []);
});

test('部分恢复令牌绑定勾选范围，非法、重复或空选择在写入前拒绝', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { kind: 'version', title: '正文和附件', displayRecords: [note],
        files: [{ path: note.desc_md }, { path: 'data/photos/trip/unique.png' }] });
    const report = await readRecycleBin(root);
    const preview = await manageRecycleBin(root, { action: 'preview', id, parts: [`file:${note.desc_md}`], revision: report.revision });
    for (const parts of [[], ['file:data/no-such-file'], [`file:${note.desc_md}`, `file:${note.desc_md}`], ['file:data/photos/trip/unique.png'], undefined]) {
        await assert.rejects(manageRecycleBin(root, { action: 'restore-selected', revision: report.revision,
            selections: [{ id, parts, previewToken: preview.previewToken }] }));
    }
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 标题\n\n原正文');
    assert.ok((await readRecycleBin(root)).items.some(item => item.id === id));
});

test('两份整站回收可选择不同日记合并，同篇版本仍在写入前拦截', async t => {
    const root = await fixture(t);
    const first = await captureRecycle(root, { kind: 'snapshot', title: '第一次' });
    const second = await captureRecycle(root, { kind: 'snapshot', title: '第二次' });
    const report = await readRecycleBin(root);
    const choose = async (id, desc) => {
        const parts = [`record:${desc}`, `file:${desc}`];
        const preview = await manageRecycleBin(root, { action: 'preview', id, parts, revision: report.revision });
        return { id, parts, previewToken: preview.previewToken };
    };
    const one = await choose(first, note.desc_md);
    const conflict = await choose(second, note.desc_md);
    await assert.rejects(manageRecycleBin(root, { action: 'restore-selected', revision: report.revision, selections: [one, conflict] }), /同一篇日记/);
    const two = await choose(second, other.desc_md);
    await manageRecycleBin(root, { action: 'restore-selected', revision: report.revision, selections: [one, two] });
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))).length, 2);
    assert.ok((await readRecycleBin(root)).items.some(item => item.id === first));
    assert.ok((await readRecycleBin(root)).items.some(item => item.id === second));
});

test('批量删除验证全部选择，分别回收日记并保留仍有引用的共用附件', async t => {
    const root = await fixture(t);
    const third = { ...other, date: '2026-11-05', desc_md: 'data/travel-diary/2026/2026-11-05-third.md' };
    await write(root, third.desc_md, '# 保留日记');
    await write(root, 'data/travel_data.json', JSON.stringify([note, other, third]));
    const { base, headers } = await api(t, root);
    const remove = payload => fetch(`${base}/api/travel-records`, { method: 'DELETE', headers, body: JSON.stringify(payload) });
    for (const paths of [[], [note.desc_md, note.desc_md], [note.desc_md, 'data/missing.md']]) {
        assert.ok(!(await remove({ paths })).ok);
        assert.equal((await readRecycleBin(root)).items.length, 0);
    }
    const stale = await remove({ paths: [note.desc_md], expectedRecords: [{ ...note, locality: '旧值' }] });
    assert.equal(stale.status, 409);
    const response = await remove({ paths: [note.desc_md, other.desc_md], expectedRecords: [note, other] });
    assert.equal(response.status, 200, await response.text());
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))).length, 1);
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/shared.png'), 'utf8'), 'shared');
    await assert.rejects(fs.stat(path.join(root, 'data/photos/trip/unique.png')), { code: 'ENOENT' });
    const report = await readRecycleBin(root);
    assert.equal(report.items.length, 2);
    assert.ok(report.items.every(item => item.kind === 'record' && item.records.length === 1));
    await action(root, report.items.find(item => item.records[0].desc_md === note.desc_md).id);
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/unique.png'), 'utf8'), 'unique');
});

test('批量删除中途失败撤回所有正文、媒体和回收留存', async t => {
    const root = await fixture(t);
    const { base, headers } = await api(t, root);
    const rename = fs.rename;
    const mocked = t.mock.method(fs, 'rename', async (source, target) => {
        if (source === path.join(root, other.desc_md)) throw new Error('模拟第二篇移动失败');
        return rename(source, target);
    });
    try {
        const response = await fetch(`${base}/api/travel-records`, { method: 'DELETE', headers,
            body: JSON.stringify({ paths: [note.desc_md, other.desc_md] }) });
        assert.equal(response.status, 500);
    } finally { mocked.mock.restore(); }
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))).length, 2);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 标题\n\n原正文');
    assert.equal(await fs.readFile(path.join(root, other.desc_md), 'utf8'), '# 另一篇');
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/shared.png'), 'utf8'), 'shared');
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/unique.png'), 'utf8'), 'unique');
    assert.equal((await readRecycleBin(root)).items.length, 0);
});


test('部分恢复正文跟随固定标识的新路径，仅恢复信息时保留当前正文路径与附件', async t => {
    const root = await fixture(t);
    const saved = { ...note, record_id: `r-${'f'.repeat(32)}` };
    const id = await captureRecycle(root, { kind: 'record', title: '历史日记', records: [saved], files: [{ path: saved.desc_md }] });
    const current = { ...saved, desc_md: 'data/travel-diary/2026/renamed.md', locality: '后续地点', photos: ['later.png'] };
    await write(root, 'data/travel_data.json', JSON.stringify([current, other]));
    await write(root, current.desc_md, '# 后续正文');
    await fs.unlink(path.join(root, saved.desc_md));
    const restore = async parts => {
        const report = await readRecycleBin(root);
        const preview = await manageRecycleBin(root, { action: 'preview', id, parts, revision: report.revision });
        await manageRecycleBin(root, { action: 'restore-selected', revision: report.revision, selections: [{ id, parts, previewToken: preview.previewToken }] });
        return preview;
    };
    await restore([`record:${saved.desc_md}`]);
    let record = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))).find(record => record.record_id === saved.record_id);
    assert.equal(record.desc_md, current.desc_md);
    assert.equal(record.locality, saved.locality);
    assert.deepEqual(record.photos, ['later.png']);
    assert.equal(await fs.readFile(path.join(root, current.desc_md), 'utf8'), '# 后续正文');
    const preview = await restore([`file:${saved.desc_md}`]);
    assert.ok(preview.savedPaths.includes(current.desc_md));
    assert.ok(preview.savedFiles.some(file => file.path === current.desc_md && file.sourcePath === saved.desc_md));
    assert.equal(await fs.readFile(path.join(root, current.desc_md), 'utf8'), '# 标题\n\n原正文');
    await assert.rejects(fs.stat(path.join(root, saved.desc_md)), { code: 'ENOENT' });
});


test('按日记选择整站恢复可找回正文和全部附件，未选日记、资料及原回收批次保留', async t => {
    const root = await fixture(t);
    const id = await captureRecycle(root, { kind: 'snapshot', title: '清空前的全部数据' });
    await write(root, 'data/travel_data.json', JSON.stringify([{ ...other, locality: '后续地点', photos: [] }]));
    await write(root, other.desc_md, '# 保留后续正文');
    await write(root, 'data/profile/owner-name.txt', '后续署名');
    await fs.unlink(path.join(root, note.desc_md));
    await fs.unlink(path.join(root, 'data/photos/trip/shared.png'));
    await fs.unlink(path.join(root, 'data/photos/trip/unique.png'));
    const report = await readRecycleBin(root);
    const parts = [`diary:${note.desc_md}`];
    const preview = await manageRecycleBin(root, { action: 'preview', id, parts, revision: report.revision });
    await assert.rejects(manageRecycleBin(root, { action: 'restore-selected', revision: report.revision,
        selections: [{ id, parts: [`diary:${other.desc_md}`], previewToken: preview.previewToken }] }));
    await manageRecycleBin(root, { action: 'restore-selected', revision: report.revision, selections: [{ id, parts, previewToken: preview.previewToken }] });
    const records = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')));
    const restored = records.find(record => record.desc_md === note.desc_md);
    assert.deepEqual(restored.photos, note.photos);
    assert.equal(records.find(record => record.desc_md === other.desc_md).locality, '后续地点');
    assert.deepEqual(records.find(record => record.desc_md === other.desc_md).photos, []);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 标题\n\n原正文');
    assert.equal(await fs.readFile(path.join(root, other.desc_md), 'utf8'), '# 保留后续正文');
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/shared.png'), 'utf8'), 'shared');
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/unique.png'), 'utf8'), 'unique');
    assert.equal(await fs.readFile(path.join(root, 'data/profile/owner-name.txt'), 'utf8'), '后续署名');
    assert.ok((await readRecycleBin(root)).items.some(item => item.id === id));
});

test('整站批次可单独恢复个人资料，也可与日记一起恢复并留存被替换资料', async t => {
    const root = await fixture(t);
    const owner = 'data/profile/owner-name.txt';
    const avatar = 'data/profile/profile-picture.png';
    await write(root, owner, '原署名');
    await write(root, avatar, '原头像');
    const id = await captureRecycle(root, { kind: 'snapshot', title: '全部数据历史' });
    await write(root, owner, '后续署名');
    await write(root, avatar, '后续头像');
    await write(root, note.desc_md, '# 后续正文');
    const index = JSON.stringify([{ ...note, locality: '后续地点' }, other]);
    await write(root, 'data/travel_data.json', index);
    const restore = async parts => {
        const report = await readRecycleBin(root);
        const preview = await manageRecycleBin(root, { action: 'preview', id, parts, revision: report.revision });
        await manageRecycleBin(root, { action: 'restore-selected', revision: report.revision,
            selections: [{ id, parts, previewToken: preview.previewToken }] });
        return preview;
    };
    const preview = await restore(['profile']);
    assert.deepEqual(preview.changes.map(change => change.record.desc_md).sort(), [owner, avatar].sort());
    assert.equal(await fs.readFile(path.join(root, owner), 'utf8'), '原署名');
    assert.equal(await fs.readFile(path.join(root, avatar), 'utf8'), '原头像');
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 后续正文');
    assert.equal(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'), index);
    const protection = (await readRecycleBin(root)).items.find(item => item.id !== id);
    assert.equal(await fs.readFile(path.join(root, `.cache/recycle-bin/${protection.id}/${owner}`), 'utf8'), '后续署名');
    assert.equal(await fs.readFile(path.join(root, `.cache/recycle-bin/${protection.id}/${avatar}`), 'utf8'), '后续头像');
    await write(root, owner, '再次修改');
    await restore(['profile', `diary:${note.desc_md}`]);
    assert.equal(await fs.readFile(path.join(root, owner), 'utf8'), '原署名');
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 标题\n\n原正文');
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')))[0].locality, note.locality);
    assert.ok((await readRecycleBin(root)).items.some(item => item.id === id));
});

test('个人资料快照预览并移除后来新增的署名，单独及混合恢复均可撤回', async t => {
    for (const parts of [['profile'], ['profile', `diary:${note.desc_md}`], ['index', 'profile'], ['profile', 'another']]) {
        await t.test(parts.join('、'), async t => {
            const root = await fixture(t);
            const owner = 'data/profile/owner-name.txt';
            const avatar = 'data/profile/profile-picture.png';
            await write(root, avatar, '历史头像');
            const id = await captureRecycle(root, { kind: 'snapshot', title: '无署名的资料' });
            await write(root, owner, '新增署名');
            await write(root, avatar, '当前头像');
            await write(root, note.desc_md, '# 当前正文');
            const another = parts.includes('another') ? await captureRecycle(root, { kind: 'version', title: '另一篇正文', files: [{ path: other.desc_md }] }) : null;
            const report = await readRecycleBin(root);
            const selectedParts = parts.filter(part => part !== 'another');
            const preview = await manageRecycleBin(root, { action: 'preview', id, parts: selectedParts, revision: report.revision });
            const change = preview.changes.find(change => change.record.desc_md === owner);
            assert.equal(change.comparison.status, 'removed');
            assert.equal(change.comparison.currentMarkdown, '新增署名');
            assert.equal(change.comparison.markdown, '');
            assert.deepEqual(change.comparison.markdownExists, { before: true, after: false });
            const selections = [{ id, parts: selectedParts, previewToken: preview.previewToken }];
            if (another) {
                const extra = await manageRecycleBin(root, { action: 'preview', id: another, revision: report.revision });
                selections.push({ id: another, previewToken: extra.previewToken });
            }
            await manageRecycleBin(root, { action: 'restore-selected', revision: report.revision, selections });
            await assert.rejects(fs.stat(path.join(root, owner)), { code: 'ENOENT' });
            assert.equal(await fs.readFile(path.join(root, avatar), 'utf8'), '历史头像');
            assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), parts.includes(`diary:${note.desc_md}`) ? '# 标题\n\n原正文' : '# 当前正文');
            const restored = await readRecycleBin(root);
            assert.ok(restored.items.some(item => item.id === id));
            const protection = restored.items.find(item => item.id !== id);
            assert.equal(await fs.readFile(path.join(root, `.cache/recycle-bin/${protection.id}/${owner}`), 'utf8'), '新增署名');
            await action(root, protection.id);
            assert.equal(await fs.readFile(path.join(root, owner), 'utf8'), '新增署名');
            assert.equal(await fs.readFile(path.join(root, avatar), 'utf8'), '当前头像');
        });
    }
});

test('空个人资料快照可移除当前资料，普通资料旧版本仅覆盖归档文件', async t => {
    const root = await fixture(t);
    const owner = 'data/profile/owner-name.txt';
    const avatar = 'data/profile/profile-picture.png';
    const id = await captureRecycle(root, { kind: 'snapshot', title: '空资料' });
    await write(root, avatar, '旧头像');
    const version = await captureRecycle(root, { kind: 'version', title: '头像旧版本', files: [{ path: avatar }] });
    await write(root, owner, '当前署名');
    await write(root, avatar, '当前头像');
    let report = await readRecycleBin(root);
    const old = await manageRecycleBin(root, { action: 'preview', id: version, parts: ['profile'], revision: report.revision });
    assert.deepEqual(old.changes.map(change => change.record.desc_md), [avatar]);
    await manageRecycleBin(root, { action: 'restore-selected', revision: report.revision, selections: [{ id: version, parts: ['profile'], previewToken: old.previewToken }] });
    assert.equal(await fs.readFile(path.join(root, owner), 'utf8'), '当前署名');
    report = await readRecycleBin(root);
    const empty = await manageRecycleBin(root, { action: 'preview', id, parts: ['profile'], revision: report.revision });
    assert.deepEqual(empty.changes.map(change => change.record.desc_md).sort(), [owner, avatar].sort());
    assert.ok(empty.changes.every(change => change.comparison.status === 'removed'));
    await manageRecycleBin(root, { action: 'restore-selected', revision: report.revision, selections: [{ id, parts: ['profile'], previewToken: empty.previewToken }] });
    for (const name of [owner, avatar]) await assert.rejects(fs.stat(path.join(root, name)), { code: 'ENOENT' });
});

test('资料恢复失败还原待移除的署名，跨批次恢复与移除同一资料时拒绝写入', async t => {
    const root = await fixture(t);
    const owner = 'data/profile/owner-name.txt';
    const avatar = 'data/profile/profile-picture.png';
    await write(root, avatar, '历史头像');
    const id = await captureRecycle(root, { kind: 'snapshot', title: '无署名资料' });
    await write(root, owner, '当前署名');
    await write(root, avatar, '当前头像');
    const version = await captureRecycle(root, { kind: 'version', title: '保留署名', files: [{ path: owner }] });
    const report = await readRecycleBin(root);
    const preview = await manageRecycleBin(root, { action: 'preview', id, parts: ['profile'], revision: report.revision });
    const selection = { id, parts: ['profile'], previewToken: preview.previewToken };
    const originalCopy = fs.copyFile;
    const mocked = t.mock.method(fs, 'copyFile', async (source, destination, ...args) => {
        if (destination === path.join(root, avatar)) throw new Error('模拟资料写入失败');
        return originalCopy(source, destination, ...args);
    });
    try {
        await assert.rejects(manageRecycleBin(root, { action: 'restore-selected', revision: report.revision, selections: [selection] }), /模拟资料写入失败/);
    } finally { mocked.mock.restore(); }
    assert.equal(await fs.readFile(path.join(root, owner), 'utf8'), '当前署名');
    assert.equal(await fs.readFile(path.join(root, avatar), 'utf8'), '当前头像');
    assert.deepEqual((await readRecycleBin(root)).items.map(item => item.id).sort(), [id, version].sort());
    const fresh = await readRecycleBin(root);
    const profile = await manageRecycleBin(root, { action: 'preview', id, parts: ['profile'], revision: fresh.revision });
    const keep = await manageRecycleBin(root, { action: 'preview', id: version, parts: ['profile'], revision: fresh.revision });
    await assert.rejects(manageRecycleBin(root, { action: 'restore-selected', revision: fresh.revision, selections: [
        { id, parts: ['profile'], previewToken: profile.previewToken }, { id: version, parts: ['profile'], previewToken: keep.previewToken }
    ] }), /同时恢复和移除/);
    assert.equal(await fs.readFile(path.join(root, owner), 'utf8'), '当前署名');
    assert.equal(await fs.readFile(path.join(root, avatar), 'utf8'), '当前头像');
    await fs.unlink(path.join(root, owner));
    const missing = await readRecycleBin(root);
    const emptyOwner = await manageRecycleBin(root, { action: 'preview', id, parts: ['profile'], revision: missing.revision });
    const addedOwner = await manageRecycleBin(root, { action: 'preview', id: version, parts: ['profile'], revision: missing.revision });
    await assert.rejects(manageRecycleBin(root, { action: 'restore-selected', revision: missing.revision, selections: [
        { id, parts: ['profile'], previewToken: emptyOwner.previewToken }, { id: version, parts: ['profile'], previewToken: addedOwner.previewToken }
    ] }), /同时恢复和移除/);
    await assert.rejects(fs.stat(path.join(root, owner)), { code: 'ENOENT' });
});

test('索引独立恢复通过认证 API 回退全部元数据，保留实际文件并留存可撤回的当前索引', async t => {
    const root = await fixture(t);
    await write(root, 'data/profile/owner-name.txt', '旧署名');
    const id = await captureRecycle(root, { kind: 'snapshot', title: '索引历史' });
    const added = { ...other, date: '2026-11-05', desc_md: 'data/travel-diary/2026/new.md' };
    const current = [{ ...note, title: '后续标题', photos: [] }, added];
    await write(root, 'data/travel_data.json', JSON.stringify(current));
    await write(root, note.desc_md, '# 后续正文');
    await write(root, added.desc_md, '# 新增正文');
    await write(root, 'data/profile/owner-name.txt', '后续署名');
    await write(root, 'data/photos/trip/unique.png', '后续图片');
    const { base, headers } = await api(t, root);
    const revision = (await readRecycleBin(root)).revision;
    const payload = { id, parts: ['index'], revision };
    const response = await fetch(`${base}/api/travel-data?mode=recycle-bin`, { method: 'POST', headers,
        body: JSON.stringify({ ...payload, action: 'preview' }) });
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.deepEqual(preview.savedPaths, ['data/travel_data.json']);
    assert.ok(preview.changes.some(change => change.comparison.status === 'added'));
    assert.ok(preview.changes.some(change => change.comparison.status === 'removed'));
    assert.ok(preview.changes.every(change => !change.comparison.markdownChanged && !change.comparison.media.length));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))), current);
    const restored = await fetch(`${base}/api/travel-data?mode=recycle-bin`, { method: 'POST', headers,
        body: JSON.stringify({ action: 'restore-selected', revision, selections: [{ ...payload, previewToken: preview.previewToken }] }) });
    assert.equal(restored.status, 200);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))), [note, other]);
    for (const [name, value] of [[note.desc_md, '# 后续正文'], [added.desc_md, '# 新增正文'], ['data/profile/owner-name.txt', '后续署名'], ['data/photos/trip/unique.png', '后续图片']]) {
        assert.equal(await fs.readFile(path.join(root, name), 'utf8'), value);
    }
    const report = await readRecycleBin(root);
    assert.ok(report.items.some(item => item.id === id));
    const protection = report.items.find(item => item.id !== id);
    assert.deepEqual(protection.files.map(file => file.path), ['data/travel_data.json']);
    await action(root, protection.id);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))), current);
});

test('索引可与同批次日记及个人资料一起恢复，正文与附件变化继续参与预览', async t => {
    const root = await fixture(t);
    await write(root, 'data/profile/owner-name.txt', '旧署名');
    const id = await captureRecycle(root, { kind: 'snapshot', title: '索引及文件' });
    await write(root, note.desc_md, '# 后续正文');
    await write(root, 'data/photos/trip/unique.png', '后续图片');
    await write(root, other.desc_md, '# 另一篇后续正文');
    await write(root, 'data/profile/owner-name.txt', '后续署名');
    await write(root, 'data/travel_data.json', JSON.stringify([{ ...note, title: '后续标题' }, other]));
    const parts = ['index', 'profile', `diary:${note.desc_md}`];
    const report = await readRecycleBin(root);
    const preview = await manageRecycleBin(root, { action: 'preview', id, parts, revision: report.revision });
    const change = preview.changes.find(change => change.record.desc_md === note.desc_md);
    assert.equal(change.comparison.markdownChanged, true);
    assert.ok(change.comparison.media.includes('data/photos/trip/unique.png'));
    await manageRecycleBin(root, { action: 'restore-selected', revision: report.revision, selections: [{ id, parts, previewToken: preview.previewToken }] });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))), [note, other]);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 标题\n\n原正文');
    assert.equal(await fs.readFile(path.join(root, other.desc_md), 'utf8'), '# 另一篇后续正文');
    assert.equal(await fs.readFile(path.join(root, 'data/profile/owner-name.txt'), 'utf8'), '旧署名');
    assert.ok((await readRecycleBin(root)).items.some(item => item.id === id));
});

test('索引恢复校验范围和批次冲突，写入失败撤回索引及资料，重复预览可重试', async t => {
    const root = await fixture(t);
    await write(root, 'data/profile/owner-name.txt', '旧署名');
    const id = await captureRecycle(root, { kind: 'snapshot', title: '历史索引' });
    const second = await captureRecycle(root, { kind: 'snapshot', title: '另一批次' });
    const current = JSON.stringify([{ ...note, title: '后续标题' }, other]);
    await write(root, 'data/travel_data.json', current);
    await write(root, 'data/profile/owner-name.txt', '后续署名');
    const parts = ['index', 'profile'];
    const report = await readRecycleBin(root);
    const preview = await manageRecycleBin(root, { action: 'preview', id, parts, revision: report.revision });
    const selection = { id, parts, previewToken: preview.previewToken };
    const restore = selections => manageRecycleBin(root, { action: 'restore-selected', revision: report.revision, selections });
    await assert.rejects(restore([{ ...selection, parts: ['index'] }]), /预览后内容已变化/);
    const another = await manageRecycleBin(root, { action: 'preview', id: second, parts: ['profile'], revision: report.revision });
    await assert.rejects(restore([selection, { id: second, parts: ['profile'], previewToken: another.previewToken }]), /需要单独恢复/);
    const originalWrite = fs.writeFile;
    fs.writeFile = async (target, ...args) => {
        if (target === path.join(root, 'data/travel_data.json')) throw new Error('模拟索引写入失败');
        return originalWrite(target, ...args);
    };
    try { await assert.rejects(restore([selection]), /模拟索引写入失败/); }
    finally { fs.writeFile = originalWrite; }
    assert.equal(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'), current);
    assert.equal(await fs.readFile(path.join(root, 'data/profile/owner-name.txt'), 'utf8'), '后续署名');
    assert.deepEqual((await readRecycleBin(root)).items.map(item => item.id).sort(), [id, second].sort());
    const fresh = await readRecycleBin(root);
    const retry = await manageRecycleBin(root, { action: 'preview', id, parts, revision: fresh.revision });
    await manageRecycleBin(root, { action: 'restore-selected', revision: fresh.revision, selections: [{ id, parts, previewToken: retry.previewToken }] });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))), [note, other]);
});

test('仅索引顺序变化仍显示差异，空索引可选择恢复且保留正文文件', async t => {
    const root = await fixture(t);
    const sameDay = [{ ...note, title: '第一篇' }, { ...other, date: note.date, title: '第二篇' }];
    await write(root, 'data/travel_data.json', JSON.stringify(sameDay));
    const id = await captureRecycle(root, { kind: 'snapshot', title: '原顺序' });
    await write(root, 'data/travel_data.json', JSON.stringify([...sameDay].reverse()));
    let report = await readRecycleBin(root);
    const preview = await manageRecycleBin(root, { action: 'preview', id, parts: ['index'], revision: report.revision });
    assert.deepEqual(preview.changes.map(change => change.record.desc_md), ['data/travel_data.json']);
    await manageRecycleBin(root, { action: 'restore-selected', revision: report.revision, selections: [{ id, parts: ['index'], previewToken: preview.previewToken }] });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))), sameDay);
    await write(root, 'data/travel_data.json', '[]');
    const empty = await captureRecycle(root, { kind: 'snapshot', title: '空索引' });
    await write(root, 'data/travel_data.json', JSON.stringify(sameDay));
    report = await readRecycleBin(root);
    const cleared = await manageRecycleBin(root, { action: 'preview', id: empty, parts: ['index'], revision: report.revision });
    assert.ok(cleared.changes.every(change => !change.comparison.markdownChanged && !change.comparison.media.length));
    await manageRecycleBin(root, { action: 'restore-selected', revision: report.revision, selections: [{ id: empty, parts: ['index'], previewToken: cleared.previewToken }] });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'))), []);
    assert.equal(await fs.readFile(path.join(root, note.desc_md), 'utf8'), '# 标题\n\n原正文');
});
