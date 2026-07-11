import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';

const dataJs = await readFile(new URL('../js/data.js', import.meta.url), 'utf8');
const foundationCss = await readFile(new URL('../css/01-foundation.css', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const subsetFontsScript = await readFile(new URL('../scripts/subset-fonts.mjs', import.meta.url), 'utf8');

test('旅行日记正文并行加载且允许浏览器缓存', () => {
    assert.match(dataJs, /Promise\.all\(records\.map/);
    assert.doesNotMatch(dataJs, /cache:\s*['"]no-store['"]/);
});

test('首屏字体使用压缩后的本地 woff2 文件', async () => {
    assert.doesNotMatch(foundationCss, /\.ttf["')]/);
    assert.match(foundationCss, /format\(["']woff2["']\)/);

    const fontPaths = Array.from(foundationCss.matchAll(/url\("\.\.\/([^"]+\.woff2)"\)/g), match => match[1]);
    assert.ok(fontPaths.length >= 2);

    for (const fontPath of fontPaths) {
        const fontStat = await stat(new URL(`../${fontPath}`, import.meta.url));
        assert.ok(fontStat.size < 1024 * 1024, `${fontPath} should stay below 1MB`);
    }
});

test('本地启动前会重新生成字体子集', () => {
    assert.equal(packageJson.scripts.fonts, 'node scripts/subset-fonts.mjs');
    assert.match(packageJson.scripts.start, /npm run fonts && node js\/server\.js/);
    assert.match(packageJson.scripts.serve, /npm run fonts && node js\/server\.js/);
});

test('字体子集脚本显式丢弃不需要的 meta 表', () => {
    assert.match(subsetFontsScript, /--drop-tables\+=meta/);
});
