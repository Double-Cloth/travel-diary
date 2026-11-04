import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';

const dataJs = await readFile(new URL('../js/data.js', import.meta.url), 'utf8');
const foundationCss = await readFile(new URL('../css/01-foundation.css', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const fontBuildScript = await readFile(new URL('../scripts/build-fonts.mjs', import.meta.url), 'utf8');
const appJs = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const recordEditorJs = await readFile(new URL('../js/record-editor.js', import.meta.url), 'utf8');
const mediaFileLinkJs = await readFile(new URL('../js/media-file-link.js', import.meta.url), 'utf8');
const mediaPreviewJs = await readFile(new URL('../js/media-preview.mjs', import.meta.url), 'utf8');
const entrySheetCss = await readFile(new URL('../css/06-entry-sheet.css', import.meta.url), 'utf8');

test('旅行日记正文允许浏览器缓存', () => {
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
    const fontFaceCount = (foundationCss.match(/@font-face\s*\{/g) || []).length;
    assert.equal((foundationCss.match(/font-display:\s*block/g) || []).length, fontFaceCount);
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
    assert.match(mediaPreviewJs, /createImageBitmap\(source,\s*\{[^}]*resizeWidth:\s*limitWidth,[^}]*resizeQuality:\s*'medium'/);
    assert.match(mediaPreviewJs, /const cropWidth = fit === 'cover'/);
    assert.match(mediaPreviewJs, /canvas\.toBlob\(resolve, 'image\/jpeg'/);
    assert.match(recordEditorJs, /createMediaPreview\(file, kind/);
    assert.match(mediaFileLinkJs, /media\.loading = 'lazy';[\s\S]*media\.decoding = 'async';[\s\S]*media\.fetchPriority = 'low';/);
    assert.match(mediaFileLinkJs, /media\.width = 84;[\s\S]*media\.height = 64;/);
    assert.doesNotMatch(recordEditorJs, /<img src="data:image\/\$\{/);
    assert.doesNotMatch(recordEditorJs, /const previewUrl = URL\.createObjectURL\(file\);\s*pendingPreviews/);
    assert.match(recordEditorJs, /existing = new Map/);
    assert.match(entrySheetCss, /@media \(max-width: 540px\)[\s\S]*\.record-editor::backdrop \{ backdrop-filter: none; \}/);
    assert.match(entrySheetCss, /@media \(hover: none\) and \(pointer: coarse\)[\s\S]*\.record-editor::backdrop\s*\{[\s\S]*backdrop-filter: none;/);
});

test('日记媒体列表显示压缩预览并懒加载，查看器保留原文件', () => {
    assert.match(appJs, /<img data-src="\$\{escapeHtml\(getMediaPreviewUrl\(item\.src\)\)\}" alt="\$\{escapeHtml\(item\.alt\)\}" loading="lazy" decoding="async" fetchpriority="low">/);
    assert.doesNotMatch(appJs, /<video data-src=/);
    assert.match(appJs, /class="photo-viewer-media photo-viewer-image"[\s\S]*decoding="async"/);
});
