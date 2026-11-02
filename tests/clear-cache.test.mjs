import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clearCache } from '../scripts/clear-cache.js';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/clear-cache.js', import.meta.url));

async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'travel-clear-cache-'));
    t.after(async () => {
        if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('travel-clear-cache-')) {
            await rm(root, { recursive: true, force: true });
        }
    });
    return root;
}

test('命令清除全部项目缓存，同时保留媒体、日记和认证配置，可重复执行', async t => {
    const root = await fixture(t);
    const files = ['data/photos/original.png', 'data/travel-diary/note.md', '.secrets/auth.json', 'README.md'];
    for (const file of [...files, '.cache/media-previews/nested/photo.jpg', '.cache/other/file.tmp']) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), file);
    }
    const first = await execute(process.execPath, [script, '--dir', root]);
    assert.match(first.stdout, /已清除缓存/);
    await assert.rejects(access(path.join(root, '.cache')), { code: 'ENOENT' });
    for (const file of files) assert.equal(await readFile(path.join(root, file), 'utf8'), file);
    const second = await execute(process.execPath, [script, '--dir', root]);
    assert.match(second.stdout, /无需清理/);
});

test('拒绝作为缓存根目录的外部链接，嵌套链接不删除外部文件', async t => {
    const root = await fixture(t);
    const external = await fixture(t);
    await writeFile(path.join(external, 'keep.txt'), '保留');
    const cache = path.join(root, '.cache');
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(external, cache, kind);
    await assert.rejects(clearCache(root), /不能是符号链接或 junction/);
    assert.equal(await readFile(path.join(external, 'keep.txt'), 'utf8'), '保留');
    await rm(cache);
    await mkdir(cache);
    await symlink(external, path.join(cache, 'nested-link'), kind);
    await clearCache(root);
    assert.equal(await readFile(path.join(external, 'keep.txt'), 'utf8'), '保留');
});

test('帮助与无效参数不执行清理', async t => {
    const root = await fixture(t);
    const cache = path.join(root, '.cache');
    await mkdir(cache);
    assert.match((await execute(process.execPath, [script, '--help'], { cwd: root })).stdout, /用法/);
    await assert.rejects(execute(process.execPath, [script, '--dir', root, '--invalid']), error => error.code === 1);
    await access(cache);
});
