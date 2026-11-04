import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sortRecords, serializeRecords } from '../js/record-order.js';
import { ensureDataStructure } from '../js/server.js';

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
