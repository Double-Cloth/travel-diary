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

test('正文比较仅输出改动块，支持新增、删除、分散修改与长正文', () => {
    assert.deepEqual(changedTextBlocks('开头\n旧段落\n中间\n旧结尾\n末尾', '开头\n新段落\n中间\n新结尾\n末尾'), [
        { before: '旧段落', after: '新段落', lineBefore: 2, lineAfter: 2 }, { before: '旧结尾', after: '新结尾', lineBefore: 4, lineAfter: 4 }
    ]);
    assert.deepEqual(changedTextBlocks('第一行\n末尾', '第一行\n新增\n末尾'), [{ before: '', after: '新增', lineBefore: 2, lineAfter: 2 }]);
    assert.deepEqual(changedTextBlocks('第一行\n删除\n末尾', '第一行\n末尾'), [{ before: '删除', after: '', lineBefore: 2, lineAfter: 2 }]);
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
