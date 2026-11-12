import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const { markdownPreview, createContentPreviewScope } = await loadBrowserModule(new URL('../js/content-preview.js', import.meta.url));
const { renderRecordDifference } = await loadBrowserModule(new URL('../js/record-diff-view.js', import.meta.url));

test('Markdown 预览明确标记空文件与空白内容，只有标题时保留标题', () => {
    assert.match(markdownPreview(''), /空文件/);
    assert.match(markdownPreview(' \n\t'), /文件仅含空白字符/);
    assert.match(markdownPreview('# 行记'), /<h3>行记<\/h3>/);
    assert.doesNotMatch(markdownPreview('# 行记'), /空文件|无内容/);
});

test('零字节文件直接显示状态，文本默认收起，空 JSON 与空目录有明确提示', async t => {
    const original = globalThis.document;
    t.after(() => { globalThis.document = original; });
    globalThis.document = {
        createElement(tag) {
            return { tagName: tag.toUpperCase(), children: [], events: {},
                append(...children) { this.children.push(...children); },
                querySelector() { return null; },
                addEventListener(name, callback) { this.events[name] = callback; }
            };
        }
    };
    const scope = createContentPreviewScope();
    t.after(() => scope.dispose());
    for (const name of ['a.md', 'a.json', 'a.txt', 'a.png', 'a.mp4', 'a.bin']) {
        const entry = await scope.file({ name, size: 0 });
        assert.equal(entry.tagName, 'DIV');
        assert.equal(entry.children[1].textContent, '空文件 · 0 B');
        assert.equal(entry.events.toggle, undefined);
    }
    for (const [name, text, expected] of [
        ['a.json', ' \n', '文件仅含空白字符'],
        ['a.txt', '\t', '文件仅含空白字符'],
        ['data/travel_data.json', '[]', '日记目录为空']
    ]) {
        const entry = await scope.file({ name, source: new TextEncoder().encode(text) });
        assert.equal(entry.tagName, 'DETAILS');
        assert.equal(Boolean(entry.open), false);
        assert.equal(entry.children.length, 1);
        entry.open = true;
        await entry.events.toggle();
        assert.match(entry.children[1].innerHTML, new RegExp(expected));
    }
});

test('空正文差异区分文件不存在、零字节与空白内容，空预览无需二次展开', () => {
    const record = { desc_md: 'data/empty.md' };
    const comparison = { status: 'added', fields: [], media: [], markdownChanged: true, currentMarkdown: '', markdown: '' };
    const render = value => renderRecordDifference(record, { ...comparison, ...value }, { afterLabel: '恢复后', note: '', collapsible: false });
    const added = render({});
    assert.match(added, /当前 · 无此文件/);
    assert.match(added, /恢复后 · 空文件/);
    assert.doesNotMatch(added, /<details|record-diff-note|record-diff-range/);
    assert.match(render({ status: 'removed' }), /恢复后 · 无此文件/);
    assert.match(render({ status: 'changed', markdown: ' \n' }), /恢复后 · 文件仅含空白字符/);
    assert.match(render({ status: 'changed', markdownExists: { before: false, after: true } }), /当前 · 无此文件/);
    const filled = render({ status: 'changed', markdown: '# 正文' });
    assert.match(filled, /当前 · 空文件/);
    assert.match(filled, /<details class="content-preview-source">/);
    assert.doesNotMatch(filled, /<details[^>]*\bopen\b/);
    const cleared = render({ status: 'changed', currentMarkdown: '# 正文' });
    assert.match(cleared, /恢复后 · 空文件/);
    assert.match(cleared, /record-diff-removed/);
});

test('正文入口展开后直接显示文件名和内容，零字节正文保持同样结构', async t => {
    const original = globalThis.document;
    t.after(() => { globalThis.document = original; });
    globalThis.document = {
        createElement(tag) {
            return { tagName: tag.toUpperCase(), children: [], events: {},
                append(...children) { this.children.push(...children); },
                prepend(...children) { this.children.unshift(...children); },
                querySelector() { return null; },
                addEventListener(name, callback) { this.events[name] = callback; }
            };
        }
    };
    const scope = createContentPreviewScope();
    t.after(() => scope.dispose());
    for (const text of ['', ' \n', '# 黄山\n\n旅行正文']) {
        const entry = await scope.file({ name: 'data/huangshan.md', source: new TextEncoder().encode(text), label: '正文' });
        assert.equal(entry.tagName, 'DETAILS');
        assert.equal(Boolean(entry.open), false);
        assert.equal(entry.children[0].children[0].textContent, '正文');
        assert.equal(entry.children.length, 1);
        entry.open = true;
        await entry.events.toggle();
        const content = entry.children[1];
        assert.equal(content.children[0].textContent, 'huangshan.md');
        assert.match(content.innerHTML, new RegExp(!text ? '空文件' : !text.trim() ? '文件仅含空白字符' : '旅行正文'));
        assert.doesNotMatch(content.innerHTML, /<details/);
    }
});
