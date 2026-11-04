import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectMedia, findBrowser, buildMediaPreviews } from '../scripts/build-media-previews.js';

test('批量生成按索引收集并去重媒体，编码中文和特殊字符', () => {
    const record = { photo_folder: 'data/photos/旅行', photos: ['a #.png', 'a #.png'], video_folder: 'data/videos/旅行', videos: ['b.webm'] };
    assert.deepEqual(collectMedia([record, record]), [
        { source: '/data/photos/%E6%97%85%E8%A1%8C/a%20%23.png', preview: '/.cache/media-previews/photos/%E6%97%85%E8%A1%8C/a%20%23.png.jpg', kind: 'image' },
        { source: '/data/videos/%E6%97%85%E8%A1%8C/b.webm', preview: '/.cache/media-previews/videos/%E6%97%85%E8%A1%8C/b.webm.jpg', kind: 'video' }
    ]);
    assert.deepEqual(collectMedia([{}]), []);
    assert.throws(() => collectMedia({}), /索引必须是数组/);
    assert.throws(() => collectMedia([{ photo_folder: 'data/photos/../private', photos: ['x.png'] }]), /无效的媒体路径/);
});

test('显式指定不存在的浏览器时明确报错，不自动下载工具', async () => {
    assert.equal(await findBrowser(process.execPath), process.execPath);
    await assert.rejects(findBrowser(path.join(tmpdir(), 'travel-missing-browser', 'not-a-browser.exe')), /未找到 Edge 或 Chrome/);
});

test('没有媒体时无需浏览器即可完成，不创建缓存或启动服务', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'travel-preview-command-'));
    t.after(async () => {
        if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('travel-preview-command-')) {
            await rm(root, { recursive: true, force: true });
        }
    });
    await mkdir(path.join(root, 'data'));
    await writeFile(path.join(root, 'data/travel_data.json'), '[]');
    assert.deepEqual(await buildMediaPreviews(root, { browser: 'missing' }), { generated: 0, cached: 0, failed: 0 });
    await writeFile(path.join(root, 'data/travel_data.json'), JSON.stringify([{ photo_folder: 'data/photos/trip', photos: ['missing.png'] }]));
    const messages = [];
    assert.deepEqual(await buildMediaPreviews(root, { browser: 'missing', skipMissing: true, log: message => messages.push(message) }), { generated: 0, cached: 0, failed: 0 });
    assert.match(messages[0], /跳过未随项目提供的原文件/);
});
