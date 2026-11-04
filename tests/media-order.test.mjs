import test from 'node:test';
import assert from 'node:assert/strict';
import { orderMedia } from '../js/media-order.mjs';
import { readMediaTime, sortMediaByTime } from '../js/media-time.mjs';
import { exif, jpeg, movie } from './helpers/media-metadata.mjs';

test('图片与视频按拍摄时间统一交错排序，无时间文件统一置后', async () => {
    const items = [
        { key: 'late', type: 'photo', name: 'late.jpg', bytes: jpeg(exif('2026:11:03 12:00:00', { offset: '+00:00' })) },
        { key: 'unknown-photo', type: 'photo', name: '10.png', bytes: Buffer.from('unknown') },
        { key: 'early', type: 'photo', name: 'early.jpg', bytes: jpeg(exif('2026:11:03 10:00:00', { offset: '+00:00' })) },
        { key: 'middle', type: 'video', name: 'middle.mp4', bytes: movie('2026-11-03T11:00:00Z') },
        { key: 'unknown-video', type: 'video', name: '2.webm', bytes: Buffer.from('unknown') }
    ];
    const times = new Map(await Promise.all(items.map(async item => [item.key, await readMediaTime(item.bytes)])));
    const sorted = sortMediaByTime(items, times);
    assert.deepEqual(sorted.map(item => item.key), ['early', 'middle', 'late', 'unknown-video', 'unknown-photo']);
    assert.equal(items[0].key, 'late');
});

test('统一顺序兼容旧记录、缺失引用、新附件、同名跨类型文件及重复引用', () => {
    const items = [
        { type: 'photo', name: 'same.png' }, { type: 'photo', name: 'same.png' },
        { type: 'photo', name: 'new.png' }, { type: 'video', name: 'same.png' }
    ];
    assert.deepEqual(orderMedia(items), items);
    assert.deepEqual(orderMedia(items, null), items);
    assert.deepEqual(orderMedia(items, ['photo:missing.png', 'photo:same.png', 'video:same.png', 'photo:same.png']),
        [items[0], items[3], items[1], items[2]]);
});
