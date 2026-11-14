import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { collectMedia, findBrowser, buildMediaPreviews } from '../scripts/build-media-previews.js';
import { createMediaPreviewGenerator } from '../js/media-preview-generator.js';

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
    assert.deepEqual(await buildMediaPreviews(root, { previews: [], browser: 'missing' }), { generated: 0, cached: 0, failed: 0 });
    await assert.rejects(buildMediaPreviews(root, { previews: ['/.cache/media-previews/photos/../secret.png.jpg'] }), /无效的媒体预览路径/);
});

test('后台生成合并同路径请求，分批串行处理，避免并发启动浏览器', async () => {
    const batches = [], finish = [];
    const generate = createMediaPreviewGenerator('root', async (root, options) => {
        assert.equal(root, 'root');
        batches.push(options.previews);
        await new Promise(resolve => finish.push(resolve));
    });
    const first = generate('/.cache/media-previews/photos/trip/first.png.jpg');
    assert.equal(generate('/.cache/media-previews/photos/trip/first.png.jpg'), first);
    const second = generate('/.cache/media-previews/videos/trip/second.mp4.jpg');
    await new Promise(resolve => setImmediate(resolve));
    const third = generate('/.cache/media-previews/photos/trip/third.png.jpg');
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 2);
    finish.shift()();
    await Promise.all([first, second]);
    assert.equal(batches.length, 2);
    assert.equal(batches[1].length, 1);
    finish.shift()();
    await third;
});

test('后台生成失败后可重试，非法路径和过量排队不启动新任务', async () => {
    let calls = 0;
    const generate = createMediaPreviewGenerator('root', async () => { if (++calls === 1) throw new Error('浏览器不可用'); });
    const path = '/.cache/media-previews/photos/trip/retry.png.jpg';
    await assert.rejects(generate(path), /浏览器不可用/);
    await generate(path);
    assert.equal(calls, 2);
    await assert.rejects(generate('/.cache/media-previews/photos/../secret.png.jpg'), /无效的媒体预览路径/);
    const pending = Array.from({ length: 16 }, (_, index) => generate(`/.cache/media-previews/photos/trip/${index}.png.jpg`));
    await assert.rejects(generate('/.cache/media-previews/photos/trip/overflow.png.jpg'), /繁忙/);
    await Promise.all(pending);
});

test('每项完成后立即返回，后续请求唤醒同一浏览器并保持批次上限', async t => {
    let session, finish;
    let calls = 0;
    const generate = createMediaPreviewGenerator('root', async (_root, options) => {
        calls++;
        session = options;
        await new Promise(resolve => { finish = resolve; });
    });
    const paths = Array.from({ length: 5 }, (_, index) => `/.cache/media-previews/photos/trip/${index}.png.jpg`);
    const first = generate(paths[0]);
    const second = generate(paths[1]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(session.previews, paths.slice(0, 2));
    session.onProgress(paths[0]);
    await first;
    const signal = new AbortController().signal;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const waiting = session.nextBatch(signal);
    let expired = false;
    void waiting.then(() => { expired = true; });
    t.mock.timers.tick(2000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(expired, false, '停顿两秒后滚动仍可复用原浏览器');
    const third = generate(paths[2]);
    assert.equal(generate(paths[2]), third, '尚未完成的同路径请求继续合并');
    assert.deepEqual(await waiting, [paths[2]]);
    const fourth = generate(paths[3]);
    const fifth = generate(paths[4]);
    assert.deepEqual(await session.nextBatch(signal, 1), paths.slice(3, 4));
    assert.deepEqual(await session.nextBatch(signal, 1), paths.slice(4));
    assert.equal(calls, 1, '后续批次复用现有生成进程');
    for (const path of paths.slice(1)) session.onProgress(path);
    await Promise.all([second, third, fourth, fifth]);
    const idle = session.nextBatch(signal);
    t.mock.timers.tick(30000);
    assert.deepEqual(await idle, [], '空闲后结束会话');
    finish();
});

test('生成会话取消会唤醒等待，未领取的任务由下一会话处理', async () => {
    let session, fail;
    let calls = 0;
    const generate = createMediaPreviewGenerator('root', async (_root, options) => {
        if (++calls > 1) return;
        session = options;
        await new Promise((_resolve, reject) => { fail = reject; });
    });
    const firstPath = '/.cache/media-previews/photos/trip/first.png.jpg';
    const first = generate(firstPath);
    await new Promise(resolve => setImmediate(resolve));
    session.onProgress(firstPath);
    await first;
    const controller = new AbortController();
    const waiting = session.nextBatch(controller.signal);
    const next = generate('/.cache/media-previews/photos/trip/next.png.jpg');
    controller.abort();
    assert.deepEqual(await waiting, []);
    fail(new Error('浏览器提前退出'));
    await next;
    assert.equal(calls, 2);
});

test('后续批次失败只拒绝未完成项，重试继续可用', async () => {
    let session, fail;
    let calls = 0;
    const generate = createMediaPreviewGenerator('root', async (_root, options) => {
        if (++calls > 1) return;
        session = options;
        await new Promise((_resolve, reject) => { fail = reject; });
    });
    const firstPath = '/.cache/media-previews/photos/trip/first.png.jpg';
    const nextPath = '/.cache/media-previews/photos/trip/next.png.jpg';
    const first = generate(firstPath);
    await new Promise(resolve => setImmediate(resolve));
    session.onProgress(firstPath);
    await first;
    const next = generate(nextPath);
    assert.deepEqual(await session.nextBatch(new AbortController().signal), [nextPath]);
    const rejected = assert.rejects(next, /浏览器提前退出/);
    fail(new Error('浏览器提前退出'));
    await rejected;
    await generate(nextPath);
    assert.equal(calls, 2);
});

test('浏览器最多并行两项，慢媒体不阻挡后续项目，失败后继续处理', async () => {
    const source = await readFile(new URL('../scripts/media-preview-batch.mjs', import.meta.url), 'utf8');
    const manifests = [
        [{ index: 0, preview: '/generated', source: '/original', kind: 'image' }, { index: 1, preview: '/cached' }],
        [{ index: 2, preview: '/missing' }], [{ index: 3, preview: '/cached' }], []
    ];
    const reports = [], writes = [];
    let generated = 0;
    let release;
    let completed = false;
    const slow = new Promise(resolve => { release = resolve; });
    await runInNewContext(source.replace(/^import[^\n]+\n/, ''), {
        AbortSignal,
        createMediaPreview: async (source, kind) => {
            assert.equal(source, '/original');
            assert.equal(kind, 'image');
            generated++;
            await slow;
            return new Blob(['jpeg']);
        },
        fetch: async (url, options) => {
            if (url.startsWith('./manifest?limit=')) {
                assert.equal(url, manifests.length === 4 ? './manifest?limit=2' : './manifest?limit=1');
                return Response.json(manifests.shift());
            }
            if (url === './progress') {
                const report = JSON.parse(options.body);
                reports.push(report);
                if (report.index === 3) {
                    assert.ok(!reports.some(item => item.index === 0), '慢媒体仍在处理中，后续三项已经完成');
                    release();
                }
                return new Response(null, { status: 204 });
            }
            if (url === './complete') {
                assert.equal(reports.length, 4, '全部任务均报告后才结束会话');
                completed = true;
                return new Response(null, { status: 204 });
            }
            if (options?.method === 'PUT') {
                writes.push({ url, etag: options.headers['If-Match'] });
                return new Response(null, { status: 204 });
            }
            assert.ok(['/cached', '/generated', '/missing'].includes(url));
            return new Response(null, { status: url === '/cached' ? 200 : url === '/generated' ? 204 : 404, headers: { ETag: 'source-version' } });
        }
    });
    assert.equal(manifests.length, 0);
    assert.equal(generated, 1);
    assert.equal(completed, true);
    assert.deepEqual(writes, [{ url: '/generated', etag: 'source-version' }]);
    assert.deepEqual(reports.map(({ index, status }) => ({ index, status })), [
        { index: 1, status: 'cached' }, { index: 2, status: 'failed' },
        { index: 3, status: 'cached' }, { index: 0, status: 'generated' }
    ]);
});
