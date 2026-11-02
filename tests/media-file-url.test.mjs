import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const { getMediaFileUrl } = await loadBrowserModule(new URL('../js/utils.js', import.meta.url));

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
