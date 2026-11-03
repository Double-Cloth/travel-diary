import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('从入口加载的公共模块及样式统一使用当前发布版本，避免重复模块实例', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/sync-asset-versions.js', import.meta.url)), '--check'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
});
