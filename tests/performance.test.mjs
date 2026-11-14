import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

test('页面按需加载本地字体缓存并提供系统回退', () => {
    assert.match(foundationCss, /@import url\('\.\.\/\.cache\/fonts\/diary-kai-core\.css/);
    assert.match(foundationCss, /--font-serif: "Diary Kai", "KaiTi", "STKaiti", serif;/);
    assert.match(foundationCss, /--font-code: "Archive Code", "Diary Kai", monospace;/);
    assert.match(foundationCss, /html,\s*body\s*{[\s\S]*font-family:\s*var\(--font-serif\);/);
    assert.match(foundationCss, /html,\s*body\s*{[\s\S]*font-synthesis:\s*none;/);
});

test('字体命令复用按需缓存且保留显式子集模式', () => {
    assert.equal(packageJson.scripts.fonts, 'node scripts/build-fonts.mjs');
    assert.equal(packageJson.scripts['fonts:subset'], 'node scripts/build-fonts.mjs --subset');
    assert.equal(packageJson.scripts.start, 'node js/server.js');
    assert.equal(packageJson.scripts.serve, 'node js/server.js');
    assert.match(fontBuildScript, /export function createFontCache/);
    assert.match(fontBuildScript, /await compressFont\(font\)/);
    assert.match(fontBuildScript, /new Worker\(/);
    assert.doesNotMatch(fontBuildScript, /child_process|spawnSync|fonttools|pyftsubset/);
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
