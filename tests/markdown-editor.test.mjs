import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';
import { readUploads, MAX_PHOTOS } from '../js/photo-uploads.mjs';

const { splitMarkdown, previewToMarkdown, previewHtml } = await loadBrowserModule(new URL('../js/markdown-editor.js', import.meta.url));
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

test('照片验证拒绝格式伪装、重复标识及超出数量上限', () => {
    const photo = { id: 'a'.repeat(32), name: 'image.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=' };
    assert.equal(readUploads([photo])[0].extension, 'png');
    assert.throws(() => readUploads([photo, photo]));
    assert.throws(() => readUploads(Array(MAX_PHOTOS + 1).fill(photo)));
    assert.throws(() => readUploads([{ ...photo, data: 'invalid!' }]));
    assert.throws(() => readUploads([{ ...photo, data: Buffer.from('<html>not a photo</html>').toString('base64') }]));
});
