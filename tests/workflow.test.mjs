import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const workflow = await readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');

test('CI 验证字体缓存构建并运行 Node 测试', () => {
    assert.match(workflow, /on:\s*\n\s+push:/);
    assert.match(workflow, /actions\/setup-node@v[0-9]+/);
    assert.match(workflow, /npm test/);
    assert.match(workflow, /npm run fonts/);
    assert.doesNotMatch(workflow, /setup-python|pip install|fonttools|npm install|npm ci|deploy-pages|upload-pages|pages: write/);
});

test('仓库移除页面发布工作流和只读 API 文件', async () => {
    await assert.rejects(access(new URL('../.github/workflows/pages.yml', import.meta.url)), { code: 'ENOENT' });
    await assert.rejects(access(new URL('../api/travel-records', import.meta.url)), { code: 'ENOENT' });
});
