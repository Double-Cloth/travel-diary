import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { identifyRecords, recordIdentity, matchRecord } from '../js/record-identity.mjs';
import { describeRecords, compareBackup } from '../js/record-diff.mjs';
import { recordBackupEntries } from '../js/record-backup.mjs';
import { createZipBlob, readZipSource } from '../js/zip-stream.mjs';
import { installAuth, login, AUTH_PASSWORD } from './helpers/auth.mjs';
import { listenOnFetchSafePort } from './helpers/http.mjs';
import { loadBrowserModule } from './helpers/browser-modules.mjs';
import { normalizeTravelLocation } from '../js/location.mjs';
import { DRAFT_FORMAT } from '../js/record-input.mjs';

const require = createRequire(import.meta.url);
const { inventory, readBackupState } = require('../js/record-inventory.js');
const { scanMedia, manageMedia } = require('../js/media-health.js');
const { importDataArchive, exportDataArchive } = require('../js/data-archive.js');
const { createHandler } = require('../js/server.js');
const record = name => ({ date: '2026-11-03', country: '中国', country_code: 'CN', admin_area: '江苏省', locality: name,
    desc_md: `data/travel-diary/2026/2026-11-03-${name}.md`, photo_folder: 'data/photos/trip', photos: ['shared.png'] });
const first = record('first');
const second = record('second');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-record-management-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const entries = [{ name: 'data/travel_data.json', data: JSON.stringify([first, second]) },
        { name: first.desc_md, data: '# 第一篇\n\n当前正文' }, { name: second.desc_md, data: '# 第二篇\n\n相同正文' },
        { name: 'data/photos/trip/shared.png', data: 'shared' }, { name: 'data/photos/unused.png', data: 'unused' }];
    for (const file of entries) {
        await fs.mkdir(path.dirname(path.join(root, file.name)), { recursive: true });
        await fs.writeFile(path.join(root, file.name), file.data);
    }
    await installAuth(root);
    return root;
}

async function archive(records, entries, plan) {
    return createZipBlob([...recordBackupEntries(entries, records), ...(plan ? [{ name: 'data/record-merge.json', data: JSON.stringify(plan) }] : [])]);
}

test('固定标识不随路径变化，兼容旧备份并拒绝重复标识及身份路径冲突', () => {
    const identified = identifyRecords([first, second]);
    const moved = { ...identified[0], date: '2026-11-04', desc_md: 'data/travel-diary/2026/2026-11-04-moved.md' };
    assert.equal(recordIdentity(moved), recordIdentity(first));
    assert.equal(matchRecord(first, [moved]), moved);
    assert.throws(() => identifyRecords([identified[0], { ...second, record_id: identified[0].record_id }]), /重复/);
    assert.throws(() => identifyRecords([{ ...first, record_id: '../escape' }]), /无效/);
    assert.throws(() => matchRecord({ ...moved, desc_md: second.desc_md }, [identified[0], identified[1]]), /不同记录/);
    assert.throws(() => matchRecord({ ...first, record_id: `r-${'a'.repeat(32)}` }, identified), /另一篇记录/);
});

test('导出准备内容指纹失败时释放数据锁，不阻塞后续写入', async t => {
    const root = await fixture(t);
    const nativeFs = require('node:fs');
    const original = nativeFs.createReadStream;
    const mocked = t.mock.method(nativeFs, 'createReadStream', function (file, options) {
        if (file.endsWith('shared.png')) throw new Error('模拟读取媒体失败');
        return original.call(this, file, options);
    });
    try { await assert.rejects(exportDataArchive(root), /模拟读取媒体失败/); }
    finally { mocked.mock.restore(); }
    await assert.rejects(fs.stat(path.join(root, '.travel-data.lock')), { code: 'ENOENT' });
    const exported = await exportDataArchive(root);
    await exported.release();
});

test('差异预览区分相同、新增、正文及媒体变化，输出字段和当前指纹', async () => {
    const records = identifyRecords([first, second]);
    const currentEntries = [{ name: first.desc_md, data: '# 当前正文' }, { name: second.desc_md, data: '# 相同正文' },
        { name: 'data/photos/trip/shared.png', data: 'before' }];
    const current = await describeRecords(records, currentEntries);
    const third = record('third');
    const changed = { ...records[0], trip_id: 'new-trip' };
    const incoming = [...currentEntries.filter(entry => entry.name !== first.desc_md), { name: first.desc_md, data: '# 备份正文' }, { name: third.desc_md, data: '# 新增' }];
    let differences = await compareBackup([changed, records[1], third], incoming, current);
    assert.equal(differences.get(first.desc_md).status, 'changed');
    assert.deepEqual(differences.get(first.desc_md).fields, ['trip_id']);
    assert.equal(differences.get(first.desc_md).expected, current.fingerprints[recordIdentity(first)]);
    assert.equal(differences.get(second.desc_md).status, 'same');
    assert.equal(differences.get(third.desc_md).status, 'added');
    incoming.find(entry => entry.name.endsWith('shared.png')).data = 'after!';
    differences = await compareBackup([records[1]], incoming, current);
    assert.equal(differences.get(second.desc_md).status, 'changed');
    assert.deepEqual(differences.get(second.desc_md).media, ['data/photos/trip/shared.png']);
    const reversed = Object.fromEntries(Object.entries(records[0]).reverse());
    assert.deepEqual((await describeRecords([reversed], currentEntries)).fingerprints, (await describeRecords([records[0]], currentEntries)).fingerprints);
});

test('新增记录持久保存固定标识，修改日期及路径后标识和页面链接保持不变', async t => {
    const root = await fixture(t);
    await fs.mkdir(path.join(root, 'assets/catalogs'), { recursive: true });
    await fs.writeFile(path.join(root, 'assets/catalogs/countries.json'), JSON.stringify({ countries: [{ code: 'CN', name_zh: '中国' }] }));
    const server = http.createServer(createHandler(root));
    const base = await listenOnFetchSafePort(server);
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const { token, cookie } = await login(base);
    const headers = { Cookie: cookie, Origin: base, 'X-Travel-Token': token, 'Content-Type': 'application/json' };
    const draft = { format: DRAFT_FORMAT, requestId: 'a'.repeat(32), uploads: [], input: {
        date: '2026-11-03', country_code: 'CN', country: '中国', admin_area: '', admin_area_type: '', locality: '新日记', locality_type: '', trip_id: '', title: '标题', body: '正文', desc_md: '', photo_folder: '', photos: [], video_folder: '', videos: []
    } };
    const response = await fetch(`${base}/api/travel-records`, { method: 'POST', headers, body: JSON.stringify(draft) });
    assert.equal(response.status, 201);
    const created = (await response.json()).record;
    assert.match(created.record_id, /^r-[a-f0-9]{32}$/);
    const update = await fetch(`${base}/api/travel-records`, { method: 'PUT', headers, body: JSON.stringify({ originalDescMd: created.desc_md, draft: { ...draft, input: { ...draft.input, date: '2027-01-01', locality: '新的目的地' } } }) });
    assert.equal(update.status, 200);
    const changed = (await update.json()).record;
    assert.equal(changed.record_id, created.record_id);
    assert.notEqual(changed.desc_md, created.desc_md);
    const saved = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')));
    assert.equal(saved.find(record => record.record_id === created.record_id).desc_md, changed.desc_md);
});

test('固定标识合并改名记录及其旧备份不新增重复记录，身份冲突拒绝写入', async t => {
    const root = await fixture(t);
    const moved = { ...identifyRecords([first])[0], date: '2026-11-04', desc_md: 'data/travel-diary/2026/2026-11-04-moved.md' };
    const files = [{ name: moved.desc_md, data: '# 改名正文' }, { name: 'data/photos/trip/shared.png', data: 'shared' }];
    const result = await importDataArchive(root, await archive([moved], files), { mergeRecords: true });
    assert.equal(result.updatedRecords, 1);
    assert.equal(result.addedRecords, 0);
    let records = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')));
    assert.equal(records.length, 2);
    assert.equal(records[0].record_id, recordIdentity(first));
    await assert.rejects(fs.stat(path.join(root, first.desc_md)), { code: 'ENOENT' });
    // 没有固定标识的老备份仍可按最初正文路径派生的身份找到改名后的记录。
    await importDataArchive(root, await archive([first], [{ name: first.desc_md, data: '# 老备份正文' }, files[1]]), { mergeRecords: true });
    records = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json')));
    assert.equal(records.length, 2);
    assert.equal(records[0].desc_md, first.desc_md);
    const before = await fs.readFile(path.join(root, 'data/travel_data.json'));
    await assert.rejects(importDataArchive(root, await archive([{ ...moved, desc_md: second.desc_md, date: second.date }], [{ name: second.desc_md, data: '# 冲突' }, files[1]]), { mergeRecords: true }), /不同记录/);
    assert.deepEqual(await fs.readFile(path.join(root, 'data/travel_data.json')), before);
});

test('差异预览后正文或媒体变化时合并返回冲突，重新预览后才能采用备份', async t => {
    const root = await fixture(t);
    const current = await inventory(root);
    const chosen = identifyRecords([first])[0];
    const files = [{ name: first.desc_md, data: '# 备份内容' }, { name: 'data/photos/trip/shared.png', data: 'shared' }];
    const plan = { [first.desc_md]: current.fingerprints[recordIdentity(first)] };
    await fs.writeFile(path.join(root, first.desc_md), '# 另一窗口刚保存');
    await assert.rejects(importDataArchive(root, await archive([chosen], files, plan), { mergeRecords: true }), /预览后/);
    assert.equal(await fs.readFile(path.join(root, first.desc_md), 'utf8'), '# 另一窗口刚保存');
    const refreshed = await inventory(root);
    const result = await importDataArchive(root, await archive([chosen], files, { [first.desc_md]: refreshed.fingerprints[recordIdentity(first)] }), { mergeRecords: true });
    assert.equal(result.updatedRecords, 1);
    assert.equal(await fs.readFile(path.join(root, first.desc_md), 'utf8'), '# 备份内容');
    await assert.rejects(fs.stat(path.join(root, 'data/record-merge.json')), { code: 'ENOENT' });
});

test('体检准确列出空间、缺失与共享引用，仅未引用媒体可回收、恢复与永久清理', async t => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, 'data/travel_data.json'), JSON.stringify([first, { ...second, photos: ['shared.png', 'missing.png'] }]));
    let report = await scanMedia(root);
    assert.equal(report.files.length, 2);
    assert.equal(report.totalBytes, 12);
    assert.equal(report.unusedBytes, 6);
    assert.equal(report.files.find(file => file.path.endsWith('shared.png')).records.length, 2);
    assert.equal(report.missing[0].path, 'data/photos/trip/missing.png');
    await assert.rejects(manageMedia(root, { action: 'trash', revision: report.revision, paths: ['data/photos/trip/shared.png'] }), /仍被引用/);
    report = await manageMedia(root, { action: 'trash', revision: report.revision, paths: ['data/photos/unused.png'] });
    assert.equal(report.totalBytes, 6);
    assert.equal(report.trashBytes, 6);
    assert.equal(report.trash.length, 1);
    await assert.rejects(fs.stat(path.join(root, 'data/photos/unused.png')), { code: 'ENOENT' });
    report = await manageMedia(root, { action: 'restore', revision: report.revision, id: report.trash[0].id });
    assert.equal(await fs.readFile(path.join(root, 'data/photos/unused.png'), 'utf8'), 'unused');
    assert.equal(report.trashBytes, 0);
    report = await manageMedia(root, { action: 'trash', revision: report.revision, paths: ['data/photos/unused.png'] });
    report = await manageMedia(root, { action: 'purge', revision: report.revision, id: report.trash[0].id });
    assert.equal(report.trash.length, 0);
    assert.equal(report.unusedBytes, 0);
    assert.equal(await fs.readFile(path.join(root, 'data/photos/trip/shared.png'), 'utf8'), 'shared');
});

test('体检后新增引用或文件变化时拒绝清理，同名恢复不覆盖，链接不能逃逸目录', async t => {
    const root = await fixture(t);
    let report = await scanMedia(root);
    await fs.writeFile(path.join(root, 'data/photos/unused.png'), 'external change');
    await assert.rejects(manageMedia(root, { action: 'trash', revision: report.revision, paths: ['data/photos/unused.png'] }), /已变化/);
    report = await scanMedia(root);
    report = await manageMedia(root, { action: 'trash', revision: report.revision, paths: ['data/photos/unused.png'] });
    await fs.writeFile(path.join(root, 'data/photos/unused.png'), 'keep');
    report = await scanMedia(root);
    await assert.rejects(manageMedia(root, { action: 'restore', revision: report.revision, id: report.trash[0].id }), /已存在/);
    assert.equal(await fs.readFile(path.join(root, 'data/photos/unused.png'), 'utf8'), 'keep');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-media-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.symlink(outside, path.join(root, 'data/photos/escape'), 'junction');
    await assert.rejects(scanMedia(root), /普通文件或目录/);
});

test('回收文件被新增引用时禁止永久删除，回收清单损坏时停止操作', async t => {
    const root = await fixture(t);
    let report = await scanMedia(root);
    report = await manageMedia(root, { action: 'trash', revision: report.revision, paths: ['data/photos/unused.png'] });
    const batch = report.trash[0];
    await fs.writeFile(path.join(root, 'data/travel_data.json'), JSON.stringify([{ ...first, photo_folder: 'data/photos', photos: ['unused.png'] }, second]));
    report = await scanMedia(root);
    await assert.rejects(manageMedia(root, { action: 'purge', revision: report.revision, id: batch.id }), /现在被记录引用/);
    assert.equal(await fs.readFile(path.join(root, 'data/media-trash', batch.id, 'data/photos/unused.png'), 'utf8'), 'unused');
    await fs.unlink(path.join(root, 'data/media-trash', batch.id, 'manifest.json'));
    await assert.rejects(scanMedia(root), /清单缺失或损坏/);
});

test('导出传输完成自动记录快照，无需确认，回执仍校验会话且不覆盖后续修改', async t => {
    const root = await fixture(t);
    const server = http.createServer(createHandler(root));
    const base = await listenOnFetchSafePort(server);
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const { token, cookie } = await login(base);
    const headers = { Cookie: cookie, Origin: base, 'X-Travel-Token': token, 'Content-Type': 'application/json' };
    const getInventory = async () => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const response = await fetch(`${base}/api/travel-data?mode=inventory`, { headers });
            if (response.status !== 409) return response.json();
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.fail('导出后未能读取记录状态');
    };
    const initial = await getInventory();
    assert.deepEqual(initial.backup.records, {});
    const select = await (await fetch(`${base}/api/travel-data?mode=select`, { method: 'POST', headers, body: JSON.stringify({ paths: [first.desc_md] }) })).json();
    const download = await fetch(`${base}/api/travel-data?selection=${select.selection}`, { headers });
    const receipt = download.headers.get('x-travel-backup-receipt');
    await download.arrayBuffer();
    assert.deepEqual((await getInventory()).backup.records, { [recordIdentity(first)]: initial.fingerprints[recordIdentity(first)] }, '传输完成自动标记，未导出记录不标记');
    const publicInventory = await fetch(`${base}/api/travel-data?mode=inventory`);
    assert.equal(publicInventory.status, 200, '只读选择无需密码');
    assert.equal((await fetch(`${base}/api/travel-data`)).status, 401, '实际导出仍需验证');
    const acknowledge = (extra = {}, value = receipt) => fetch(`${base}/api/travel-data?mode=backup-complete`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ receipt: value }) });
    assert.equal((await acknowledge({ Cookie: '' })).status, 401);
    assert.equal((await acknowledge({ 'X-Travel-Token': '' })).status, 403);
    assert.equal((await acknowledge({}, 'forged')).status, 409);
    await fs.writeFile(path.join(root, first.desc_md), '# 下载后又修改');
    assert.equal((await acknowledge()).status, 200);
    const next = await getInventory();
    assert.equal(next.backup.records[recordIdentity(first)], initial.fingerprints[recordIdentity(first)]);
    assert.notEqual(next.backup.records[recordIdentity(first)], next.fingerprints[recordIdentity(first)]);
    assert.equal(next.backup.records[recordIdentity(second)], undefined, '未导出记录不标记');
    assert.deepEqual(await readBackupState(root), next.backup);
    const media = await fetch(`${base}/api/travel-data?mode=media-health`, { headers });
    const report = await media.json();
    const denied = await fetch(`${base}/api/travel-data?mode=media-health`, { method: 'POST', headers: { ...headers, 'X-Travel-Token': '' }, body: JSON.stringify({ action: 'trash', revision: report.revision, paths: ['data/photos/unused.png'] }) });
    assert.equal(denied.status, 403);
    const head = await fetch(`${base}/api/travel-data`, { method: 'HEAD', headers });
    assert.equal((await acknowledge({}, head.headers.get('x-travel-backup-receipt'))).status, 409);
    const complete = await fetch(`${base}/api/travel-data`, { headers });
    await complete.arrayBuffer();
    await getInventory();
    assert.equal((await acknowledge({}, complete.headers.get('x-travel-backup-receipt'))).status, 200);
    const afterComplete = await getInventory();
    assert.deepEqual(afterComplete.backup.records, afterComplete.fingerprints, '完整导出为全部记录更新比较基准');
    await fs.writeFile(path.join(root, 'data/photos/trip/shared.png'), 'change');
    const afterMedia = await getInventory();
    for (const record of afterMedia.records) assert.notEqual(afterMedia.backup.records[record.record_id], afterMedia.fingerprints[record.record_id], '共享媒体字节变化使引用它的记录都需要备份');
});

test('行程路由可往返序列化、按时间阅读、导出整趟，并保留旧记录书签', async t => {
    globalThis.document = { addEventListener() {} };
    const originalFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => {};
    t.after(() => { if (originalFrame) globalThis.requestAnimationFrame = originalFrame; else delete globalThis.requestAnimationFrame; });
    const app = await loadBrowserModule(new URL('../js/app.js', import.meta.url), `
        export { parseRoute, serializeRoute, deriveTravelModel, canonicalizeLocationRoute };
        export function renderTripTest(records, params) {
            let result; travelModel = deriveTravelModel(records);
            setPages = (left, right) => { result = { left, right }; };
            renderTrip(params); return result;
        }
        export function ledgerTripsTest(records, params) {
            travelModel = deriveTravelModel(records.map(record => ({ ...record, searchText: record.locality })));
            return getLedgerTrips(getLedgerRecords(params));
        }`);
    const route = { name: 'trip', params: { id: 'trip:long-trip' } };
    assert.deepEqual(app.parseRoute(app.serializeRoute(route)), { ...route, valid: true });
    const records = identifyRecords([second, { ...first, date: '2026-11-02' }]).map(record => normalizeTravelLocation({ ...record, trip_id: 'long-trip', descTitle: record.locality, descBodyHtml: `<p>${record.locality}正文</p>`, photos: [] }));
    const result = app.renderTripTest(records, route.params);
    assert.match(result.left, /本次行程时间线/);
    assert.match(result.left, /导出本次行程/);
    assert.ok(result.right.indexOf('first正文') < result.right.indexOf('second正文'));
    const model = app.deriveTravelModel(records);
    assert.equal(model.recordsById.get('2026-11-03-second').record_id, recordIdentity(second));
    const tripRoute = app.parseRoute('#ledger?view=trips&q=first&sort=asc');
    assert.equal(app.serializeRoute(tripRoute), '#ledger?q=first&view=trips&sort=asc');
    const matchingTrips = app.ledgerTripsTest(records, { q: 'first', view: 'trips' });
    assert.equal(matchingTrips.length, 1);
    assert.equal(matchingTrips[0].tripRecords.length, 2, '筛选命中一篇时仍展示完整行程');
    assert.equal(app.ledgerTripsTest(records, {}).length, 1, '同一行程只展示一次');
    const empty = app.renderTripTest([], {});
    assert.match(empty.left, /目录查看方式/);
    assert.match(empty.left, /data-ledger-view="trips" aria-pressed="true"/);
    assert.match(empty.right, /全部行程 · 0 次/);
    assert.equal(app.canonicalizeLocationRoute({ name: 'trip', params: {} }).params.view, 'trips');
});
