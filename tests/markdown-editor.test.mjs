import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadBrowserModule } from './helpers/browser-modules.mjs';
import { readUploads, storedPhotoNames } from '../js/photo-uploads.mjs';
import { defaultMarkdownPath, recordSlug } from '../js/record-input.mjs';
import { createDraftArchive, readDraftArchive } from '../js/draft-archive.mjs';
import { readZip } from '../js/zip-archive.mjs';

const { highlightMarkdown, splitMarkdown, previewToMarkdown, previewHtml } = await loadBrowserModule(new URL('../js/markdown-editor.js', import.meta.url));
const recordEditorSource = await readFile(new URL('../js/record-editor.js', import.meta.url), 'utf8');
const text = value => ({ nodeType: 3, nodeValue: value, textContent: value });
const element = (tagName, children, attributes = {}) => ({
    nodeType: 1, tagName, childNodes: children,
    textContent: children.map(child => child.textContent).join(''),
    getAttribute: key => attributes[key]
});

test('可编辑预览序列化标题、段落、行内格式及列表，文字边界不合并', () => {
    const nodes = [element('H1', [text('苏州')]), element('P', [text('雨后 '), element('STRONG', [text('茶馆')]), text(' 和 **字面星号**')]),
        element('UL', [element('LI', [text('河边')]), element('LI', [text('石桥')])]), text('末尾'), element('DIV', [text('新段落')])];
    const markdown = previewToMarkdown({ childNodes: nodes });
    const input = splitMarkdown(markdown);
    assert.equal(input.title, '苏州');
    assert.match(input.body, /\*\*茶馆\*\*/);
    assert.match(input.body, /- 河边\n- 石桥/);
    assert.match(input.body, /末尾\n\n新段落/);
    const html = previewHtml(markdown, input.title);
    assert.match(html, /<strong>茶馆<\/strong>/);
    assert.match(html, /和 \*\*字面星号\*\*/);
});

test('粘贴结构不会把脚本、图片或危险链接写入正文', () => {
    const markdown = previewToMarkdown({ childNodes: [element('SCRIPT', [text('evil')]), element('IMG', [], { src: 'x' }), element('A', [text('链接')], { href: 'javascript:evil' })] });
    assert.equal(markdown, '链接');
    assert.deepEqual(splitMarkdown('# 新标题\n\n正文'), { title: '新标题', body: '正文' });
    assert.deepEqual(splitMarkdown('正文', '原标题'), { title: '原标题', body: '正文' });
});

test('预览编辑后的粗体与斜体嵌套可再次预览', () => {
    const markdown = previewToMarkdown({ childNodes: [element('H1', [text('标题')]), element('P', [element('STRONG', [text('湖边 '), element('EM', [text('散步')])])])] });
    assert.match(previewHtml(markdown, '标题'), /<strong>湖边 <em>散步<\/em><\/strong>/);
});

test('预览编辑保留相对链接及行内代码中的反引号与反斜线', () => {
    const markdown = previewToMarkdown({ childNodes: [element('H1', [text('标题')]), element('P', [element('A', [text('日记')], { href: 'note.md' }), element('CODE', [text('a`b\\c')])])] });
    const html = previewHtml(markdown, '标题');
    assert.match(html, /href="note.md"/);
    assert.match(html, /<code>a`b\\c<\/code>/);
});

test('照片验证拒绝格式伪装与重复标识，但不限制上传数量或大小', () => {
    const photo = { id: 'a'.repeat(32), name: 'image.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=' };
    assert.equal(readUploads([photo])[0].extension, 'png');
    assert.throws(() => readUploads([photo, photo]));
    const manyPhotos = Array.from({ length: 25 }, (_, index) => ({ ...photo, id: index.toString(16).padStart(32, '0') }));
    assert.equal(readUploads(manyPhotos).length, manyPhotos.length);
    const largePhoto = { ...photo, id: 'b'.repeat(32), data: Buffer.concat([Buffer.from(photo.data, 'base64'), Buffer.alloc(11 * 1024 * 1024)]).toString('base64') };
    assert.ok(readUploads([largePhoto])[0].size > 10 * 1024 * 1024);
    assert.throws(() => readUploads([{ ...photo, data: 'invalid!' }]));
    assert.throws(() => readUploads([{ ...photo, data: Buffer.from('<html>not a photo</html>').toString('base64') }]));
});

test('新增旅行记录不再提供正文导出或照片张数上限', () => {
    assert.doesNotMatch(recordEditorSource, /data-editor-markdown|导出正文|MAX_PHOTOS|最多 20 张/);
    assert.match(recordEditorSource, /源码支持 Markdown 语法高亮，并与预览自动同步。/);
    assert.match(recordEditorSource, /支持 JPEG \/ PNG \/ GIF \/ WebP/);
    assert.doesNotMatch(recordEditorSource, /10 MB|30 MB|44 MB|MAX_PHOTO_BYTES|MAX_TOTAL_PHOTO_BYTES|MAX_DRAFT_BYTES/);
    assert.match(recordEditorSource, /event\.target !== dialog/);
});

test('自动文件路径使用日期与目的地，照片保留可读名称并为重名添加序号', () => {
    assert.equal(recordSlug(' 苏州市 '), 'suzhou');
    assert.equal(recordSlug('重庆市'), 'chongqing');
    assert.equal(defaultMarkdownPath('2026-09-11', '苏州市'), 'data/travel-diary/2026/2026-09-11-suzhou.md');
    assert.deepEqual(storedPhotoNames(['河畔.jpg'], [
        { name: '湖边.png', extension: 'png' },
        { name: '湖边.JPG', extension: 'jpg' },
        { name: '河畔.jpeg', extension: 'jpg' }
    ]), ['河畔.jpg', 'hubian.png', 'hubian.jpg', 'hepan.jpg']);
});

test('Markdown 源码高亮转义 HTML 并标记标题、列表、链接和代码', () => {
    const html = highlightMarkdown('# 标题\n\n- **重点** [链接](note.md) `<script>`');
    assert.match(html, /class="md-marker">#<\/span>/);
    assert.match(html, /class="md-heading">标题<\/span>/);
    assert.match(html, /class="md-emphasis">\*\*重点\*\*<\/span>/);
    assert.match(html, /class="md-link">\[链接\]\(note\.md\)<\/span>/);
    assert.match(html, /class="md-code">`&lt;script&gt;`<\/span>/);
    assert.doesNotMatch(html, /<script>/);
});

test('草稿 ZIP 将照片保存为独立文件且可以无损导入', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=';
    const value = {
        format: 'travel-diary-draft-v3', requestId: 'a'.repeat(32),
        input: { date: '2026-09-11', country_code: 'CN', country: '中国', admin_area: '江苏省', admin_area_type: '省', locality: '苏州市', locality_type: '城市', trip_id: '2026-09-江苏', title: '标题', body: '正文', desc_md: '', photo_folder: '', photos: [] },
        uploads: [{ id: 'b'.repeat(32), name: '湖边.png', data: png }]
    };
    const archive = createDraftArchive(value);
    const entries = readZip(archive);
    const metadata = JSON.parse(new TextDecoder().decode(entries.find(entry => entry.name === 'draft.json').data));
    assert.equal(entries.some(entry => entry.name === 'photos/001-hubian.png'), true);
    assert.equal(metadata.uploads[0].file, 'photos/001-hubian.png');
    assert.equal('data' in metadata.uploads[0], false);
    assert.equal(JSON.stringify(metadata).includes(png), false);
    assert.deepEqual(readDraftArchive(archive), value);
});
