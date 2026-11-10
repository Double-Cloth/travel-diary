import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhotoSleeveRows } from '../js/photo-sleeve-virtual.mjs';

test('虚拟媒体行保留全量索引，尾行不足列数时不丢失附件', () => {
    const media = Array.from({ length: 10001 }, () => ({}));
    const rows = buildPhotoSleeveRows(media, 3, false);
    assert.equal(rows.length, 3334);
    assert.deepEqual(rows[0], { start: 0, end: 3, heading: false });
    assert.deepEqual(rows.at(-1), { start: 9999, end: 10001, heading: false });
    assert.equal(rows.reduce((sum, row) => sum + row.end - row.start, 0), media.length);
    assert.deepEqual(buildPhotoSleeveRows([], 2, true), []);
});

test('跨日记分组独立起行，重新计算列数后标题和媒体顺序保持一致', () => {
    const media = ['a', 'a', 'a', 'b', 'c', 'c'].map(recordId => ({ recordId }));
    const rows = buildPhotoSleeveRows(media, 2, true);
    assert.deepEqual(rows, [
        { start: 0, end: 0, heading: true },
        { start: 0, end: 2, heading: false },
        { start: 2, end: 3, heading: false },
        { start: 3, end: 3, heading: true },
        { start: 3, end: 4, heading: false },
        { start: 4, end: 4, heading: true },
        { start: 4, end: 6, heading: false }
    ]);
    const resized = buildPhotoSleeveRows(media, 4, true);
    assert.deepEqual(resized.filter(row => row.heading), rows.filter(row => row.heading));
    assert.deepEqual(resized.filter(row => !row.heading).map(row => [row.start, row.end]), [[0, 3], [3, 4], [4, 6]]);
});
