import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';

const dataJs = await readFile(new URL('../js/data.js', import.meta.url), 'utf8');
const foundationCss = await readFile(new URL('../css/01-foundation.css', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const fontBuildScript = await readFile(new URL('../scripts/build-fonts.mjs', import.meta.url), 'utf8');
const recordEditorJs = await readFile(new URL('../js/record-editor.js', import.meta.url), 'utf8');
const entrySheetCss = await readFile(new URL('../css/06-entry-sheet.css', import.meta.url), 'utf8');

test('旅行日记正文并行加载且允许浏览器缓存', () => {
    assert.match(dataJs, /Promise\.all\(records\.map/);
    assert.doesNotMatch(dataJs, /cache:\s*['"]no-store['"]/);
});

test('页面使用完整构建的本地 WOFF2 字体', async () => {
    assert.doesNotMatch(foundationCss, /\.ttf["')]/);
    assert.match(foundationCss, /format\(["']woff2["']\)/);

    const fontPaths = Array.from(foundationCss.matchAll(/url\("\.\.\/([^"]+\.woff2)"\)/g), match => match[1]);
    assert.ok(fontPaths.length >= 2);

    for (const fontPath of fontPaths) {
        const fontStat = await stat(new URL(`../${fontPath}`, import.meta.url));
        assert.ok(fontStat.size > 0, `${fontPath} 不能为空`);
    }
});

test('页面根节点只继承本地字体且加载时不显示系统回退字体', () => {
    assert.match(foundationCss, /html,\s*body\s*{[\s\S]*font-family:\s*var\(--font-serif\);/);
    assert.match(foundationCss, /html,\s*body\s*{[\s\S]*font-synthesis:\s*none;/);
    assert.equal((foundationCss.match(/font-display:\s*block/g) || []).length, 4);
    assert.doesNotMatch(foundationCss, /font-display:\s*swap/);
});

test('字体命令默认全量构建并保留显式子集模式', () => {
    assert.equal(packageJson.scripts.fonts, 'node scripts/build-fonts.mjs');
    assert.equal(packageJson.scripts['fonts:subset'], 'node scripts/build-fonts.mjs --subset');
    assert.equal(packageJson.scripts.start, 'node js/server.js');
    assert.equal(packageJson.scripts.serve, 'node js/server.js');
    assert.match(fontBuildScript, /if \(subsetMode\)[\s\S]*buildSubsets\(\);[\s\S]*else \{[\s\S]*buildFullFont/);
    assert.match(fontBuildScript, /'ttLib\.woff2',[\s\S]*'compress'/);
});

test('可选字体子集模式显式丢弃不需要的 meta 表', () => {
    assert.match(fontBuildScript, /--drop-tables\+=meta/);
});

test('多图预览不把 Base64 写入 DOM，并降低移动端重绘开销', () => {
    assert.match(recordEditorJs, /URL\.createObjectURL\(file\)/);
    assert.match(recordEditorJs, /loading="lazy" decoding="async"/);
    assert.doesNotMatch(recordEditorJs, /<img src="data:image\/\$\{/);
    assert.match(recordEditorJs, /existing = new Map/);
    assert.match(entrySheetCss, /@media \(max-width: 540px\)[\s\S]*\.record-editor::backdrop \{ backdrop-filter: none; \}/);
});
