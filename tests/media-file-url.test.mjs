import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const { getMediaFileUrl, formatFileSize } = await loadBrowserModule(new URL('../js/utils.js', import.meta.url));

test('媒体查看链接编码文件名，保留项目相对目录', () => {
    assert.equal(getMediaFileUrl('data/photos/trip/照片 #1?.jpg'), 'data/photos/trip/%E7%85%A7%E7%89%87%20%231%3F.jpg');
    assert.equal(getMediaFileUrl('data/videos/trip/clip.webm'), 'data/videos/trip/clip.webm');
});

test('媒体查看链接拒绝外部地址、目录穿越和非媒体路径', () => {
    for (const path of [null, 123, 'https://example.com/a.jpg', 'javascript:alert(1)',
        'data/travel_data.json', 'data/photos/../a.jpg', 'data/videos/./clip.mp4',
        'data/photos//a.jpg', 'data/photos/trip\\..\\a.jpg']) {
        assert.equal(getMediaFileUrl(path), '', String(path));
    }
});

test('损坏的 Unicode 和控制字符路径返回无效链接，合法代理对正常编码', () => {
    for (const path of ['data/photos/\uD800.jpg', 'data/videos/\uDC00.mp4', 'data/photos/a\0.jpg', 'data/photos/a\n.jpg']) {
        assert.equal(getMediaFileUrl(path), '');
    }
    assert.equal(getMediaFileUrl('data/photos/🌄.jpg'), 'data/photos/%F0%9F%8C%84.jpg');
});

test('媒体整理与回收站共用文件大小格式，单位边界与显示精度保持一致', () => {
    for (const [bytes, expected] of [[0, '0 B'], [1023, '1023 B'], [1024, '1.0 KiB'],
        [1024 ** 2, '1.0 MiB'], [1024 ** 3, '1.00 GiB'], [1.5 * 1024 ** 3, '1.50 GiB']]) {
        assert.equal(formatFileSize(bytes), expected);
    }
});
