import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sortRecords, serializeRecords } from '../js/record-order.js';
import { ensureDataStructure } from '../js/server.js';
import { sortTravelData } from '../scripts/sort-travel-data.js';
import { acquireDataLock } from '../js/data-archive.js';

test('手工维护检查不改文件，自动排序保留同日、字段及附件顺序，重复执行不改格式', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'travel-sort-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'data'));
    const file = path.join(root, 'data/travel_data.json');
    const records = [
        { date: '2026-01-01', photos: ['b.jpg', 'a.jpg'], custom: true },
        { date: '2024-01-01', title: '第一篇' },
        { date: '2024-01-01', title: '第二篇' }
    ];
    const original = JSON.stringify(records);
    await writeFile(file, original);
    assert.deepEqual(await sortTravelData(root, { check: true }), { changed: true, count: 3 });
    assert.equal(await readFile(file, 'utf8'), original);
    assert.deepEqual(await sortTravelData(root), { changed: true, count: 3 });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), [records[1], records[2], records[0]]);
    const formatted = JSON.stringify([records[1], records[2], records[0]], null, 4);
    await writeFile(file, formatted);
    assert.deepEqual(await sortTravelData(root), { changed: false, count: 3 });
    assert.deepEqual(await sortTravelData(root, { check: true }), { changed: false, count: 3 });
    assert.equal(await readFile(file, 'utf8'), formatted);
    assert.deepEqual(await readdir(root), ['data']);
});

test('无效索引拒绝覆盖并释放锁，已有数据锁时拒绝排序', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'travel-sort-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'data'));
    const file = path.join(root, 'data/travel_data.json');
    for (const source of ['{', '{}', '[null]', '[{"date":"2026-02-30"}]']) {
        await writeFile(file, source);
        await assert.rejects(sortTravelData(root));
        assert.equal(await readFile(file, 'utf8'), source);
        assert.deepEqual(await readdir(root), ['data']);
    }
    await writeFile(file, '[]');
    const release = await acquireDataLock(root);
    try {
        await assert.rejects(sortTravelData(root), /另一项数据操作正在进行/);
        assert.equal(await readFile(file, 'utf8'), '[]');
    } finally {
        await release();
    }
    assert.deepEqual(await sortTravelData(root), { changed: false, count: 0 });
});

test('索引按日期升序排列，同日稳定且不修改输入或附件顺序', () => {
    const records = [
        { date: '2026-01-01', photos: ['b.jpg', 'a.jpg'] },
        { date: '2024-12-31', title: '第一篇' },
        { date: '2024-12-31', title: '第二篇' }
    ];
    const original = structuredClone(records);
    assert.deepEqual(sortRecords(records), [records[1], records[2], records[0]]);
    assert.deepEqual(records, original);
    assert.deepEqual(JSON.parse(serializeRecords(records)), [records[1], records[2], records[0]]);
});

test('启动自动修正磁盘乱序，已排序索引保留原始格式', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'travel-order-'));
    try {
        await ensureDataStructure(root);
        const file = path.join(root, 'data/travel_data.json');
        const records = [{ date: '2026-01-01' }, { date: '2024-01-01' }];
        await writeFile(file, JSON.stringify(records));
        await ensureDataStructure(root);
        assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), records.toReversed());
        const formatted = JSON.stringify(records.toReversed());
        await writeFile(file, formatted);
        await ensureDataStructure(root);
        assert.equal(await readFile(file, 'utf8'), formatted);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
