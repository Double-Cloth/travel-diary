import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readMediaIndex } from '../js/media-index.js';

test('媒体索引跨实例复用哈希，只读取同大小候选，并识别修改、移动与删除', async t => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'travel-media-index-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    await fsp.mkdir(path.join(root, 'data/photos/nested'), { recursive: true });
    const image = path.join(root, 'data/photos/nested/IMAGE.PNG');
    await fsp.writeFile(image, 'first');
    await fsp.writeFile(path.join(root, 'data/photos/other.png'), 'different-size');
    const createReadStream = fs.createReadStream;
    let reads = 0;
    fs.createReadStream = (...args) => { reads += 1; return createReadStream(...args); };
    t.after(() => { fs.createReadStream = createReadStream; });
    const first = await readMediaIndex(root, new Set([5]));
    assert.equal(reads, 1);
    assert.equal(first.find(file => file.path.endsWith('IMAGE.PNG')).digest, createHash('sha256').update('first').digest('hex'));
    assert.equal(first.find(file => file.path.endsWith('other.png')).digest, null);
    const cached = JSON.parse(await fsp.readFile(path.join(root, '.cache/media-index.json'), 'utf8'));
    assert.equal(cached.version, 1);
    assert.deepEqual(await readMediaIndex(root, new Set([5])), first);
    assert.equal(reads, 1, '有效索引不重新读取原媒体内容');
    await fsp.writeFile(image, 'other');
    const changed = await readMediaIndex(root, new Set([5]));
    assert.equal(reads, 2);
    assert.notEqual(changed.find(file => file.path.endsWith('IMAGE.PNG')).digest, first.find(file => file.path.endsWith('IMAGE.PNG')).digest);
    await fsp.rename(image, path.join(root, 'data/photos/renamed.png'));
    await fsp.unlink(path.join(root, 'data/photos/other.png'));
    const moved = await readMediaIndex(root, new Set([5]));
    assert.deepEqual(moved.map(file => file.path), ['data/photos/renamed.png']);
    assert.equal(reads, 3);
});

test('媒体索引损坏或清理后自动重建，拒绝缓存和媒体链接', async t => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'travel-media-index-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    await fsp.mkdir(path.join(root, 'data/videos'), { recursive: true });
    await fsp.writeFile(path.join(root, 'data/videos/VIDEO.MP4'), 'video');
    await fsp.mkdir(path.join(root, '.cache'));
    for (const content of ['{broken', 'null', '{"version":1,"files":[null,{}]}']) {
        await fsp.writeFile(path.join(root, '.cache/media-index.json'), content);
        assert.equal((await readMediaIndex(root, new Set([5]))).length, 1);
    }
    await fsp.unlink(path.join(root, '.cache/media-index.json'));
    assert.equal((await readMediaIndex(root, new Set([5]))).length, 1);
    await fsp.symlink(path.join(root, 'data/videos'), path.join(root, 'data/videos/alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readMediaIndex(root, new Set([5])), { status: 403 });
});
