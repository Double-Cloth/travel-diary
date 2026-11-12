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
        assert.equal(content.children[0].innerHTML, undefined);
        assert.match(content.innerHTML, new RegExp(!text ? '空文件' : !text.trim() ? '文件仅含空白字符' : '旅行正文'));
        assert.doesNotMatch(content.innerHTML, /<details/);
    }
});

test('个人署名差异使用对应的文本名称并转义标题，正文差异保留原标签', () => {
    const record = { desc_md: 'data/profile/owner-name.txt' };
    const comparison = { status: 'changed', fields: [], media: [], markdownChanged: true, currentMarkdown: '原署名', markdown: '新署名' };
    const html = renderRecordDifference(record, comparison, { textLabel: '署名', afterLabel: '恢复后', note: '', collapsible: false });
    assert.match(html, /署名改动/);
    assert.match(html, /aria-label="署名差异/);
    assert.doesNotMatch(html, /正文改动|aria-label="正文差异/);
    assert.match(renderRecordDifference(record, comparison), /正文改动/);
    assert.doesNotMatch(renderRecordDifference(record, comparison, { textLabel: '<署名>' }), /<署名>/);
});

test('日记信息差异复用正文的双侧行号并保留数组顺序、转义与新增移除状态', () => {
    const previous = { title: '原标题', date: '2026-11-12', photos: ['a.png', 'b.png'], desc_md: 'data/a.md' };
    const record = { ...previous, title: '<新标题>', photos: ['b.png', 'a.png'] };
    const comparison = { status: 'changed', previous, fields: ['title', 'photos'], media: [], markdownChanged: false };
    const options = { numberedFields: true, afterLabel: '恢复后', note: '', collapsible: false };
    const html = renderRecordDifference(record, comparison, options);
    assert.match(html, /aria-label="日记信息差异，左侧为当前行号，右侧为恢复后行号"/);
    assert.match(html, /record-diff-line-number">1<\/span>/);
    assert.match(html, /@@ −4,2 \+4,2 @@/);
    assert.match(html, /&lt;新标题&gt;/);
    assert.doesNotMatch(html, /<新标题>|<dl>/);
    assert.match(html, /图片列表 \[1\]  &quot;b.png&quot;/);
    assert.match(html, /图片列表 \[2\]  &quot;a.png&quot;/);
    const added = renderRecordDifference(record, { ...comparison, status: 'added', previous: undefined }, options);
    assert.doesNotMatch(added, /class="record-diff-line record-diff-removed"/);
    const removed = renderRecordDifference({ desc_md: record.desc_md }, { ...comparison, status: 'removed' }, options);
    assert.doesNotMatch(removed, /class="record-diff-line record-diff-added"/);
    assert.match(renderRecordDifference(record, comparison), /<dl>/);
});

test('文件列表和附件顺序逐项显示位置、类型及特殊文件名，增删后保持双侧行号', () => {
    const previous = { desc_md: 'data/a.md', photos: ['<a>.png'], videos: [], media_order: ['photo:<a>.png'] };
    const record = { ...previous, photos: ['b.png', '<a>.png'], videos: ['clip.mp4'], media_order: ['video:clip.mp4', 'photo:b.png', 'photo:<a>.png'] };
    const comparison = { status: 'changed', previous, fields: ['photos', 'videos', 'media_order'], media: [], markdownChanged: false };
    const html = renderRecordDifference(record, comparison, { numberedFields: true });
    assert.match(html, /图片列表 \[1\]  &quot;b.png&quot;/);
    assert.match(html, /图片列表 \[2\]  &quot;&lt;a&gt;.png&quot;/);
    assert.match(html, /视频列表  \[\]/);
    assert.match(html, /视频列表 \[1\]  &quot;clip.mp4&quot;/);
    assert.match(html, /附件顺序 \[1\]  视频  &quot;clip.mp4&quot;/);
    assert.match(html, /附件顺序 \[2\]  图片  &quot;b.png&quot;/);
    assert.match(html, /附件顺序 \[3\]  图片  &quot;&lt;a&gt;.png&quot;/);
    assert.doesNotMatch(html, /<a>|photo:|video:/);
    assert.match(html, /record-diff-line-number">4<\/span>/);
    assert.match(html, /record-diff-line-number">7<\/span>/);
    const groups = [...html.matchAll(/<section class="record-diff-field-group"><h4>(.*?)<\/h4>([\s\S]*?)<\/section>/g)];
    assert.deepEqual(groups.map(group => group[1]), ['图片列表', '视频列表', '附件顺序']);
    assert.match(groups[0][2], /图片列表 \[2\]/);
    assert.doesNotMatch(groups[0][2], /视频列表|附件顺序/);
    assert.match(groups[1][2], /视频列表 \[1\]/);
    assert.doesNotMatch(groups[1][2], /图片列表|附件顺序/);
    assert.match(groups[2][2], /附件顺序 \[3\]/);
    assert.doesNotMatch(groups[2][2], /图片列表|视频列表/);
    assert.equal((html.match(/class="record-diff-legend"/g) || []).length, 1);
    const removed = renderRecordDifference({ ...record, photos: [], media_order: [] }, { ...comparison, previous: record }, { numberedFields: true });
    assert.match(removed, /图片列表  \[\]/);
    assert.match(removed, /附件顺序  \[\]/);
});

test('恢复结果复用直接内容预览，空正文和空索引同样保留文件标题', async t => {
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
    for (const [name, text, expected] of [
        ['data/empty.md', '', '空文件'], ['data/space.md', ' \n', '文件仅含空白字符'],
        ['data/diary.md', '# 北京\n\n旅行正文', '旅行正文'], ['data/travel_data.json', '[]', '日记目录为空'],
        ['data/profile/owner-name.txt', '旅行者', '']
    ]) {
        const entry = await scope.file({ name, source: new TextEncoder().encode(text), collapsible: false });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(entry.tagName, 'DIV');
        assert.equal(entry.events.toggle, undefined);
        assert.equal(entry.children[0].className, 'content-file-heading');
        assert.equal(entry.children[1].className, 'content-file-body');
        if (expected) assert.match(entry.children[1].innerHTML, new RegExp(expected));
        assert.equal(entry.children[0].children[0].textContent, name.split('/').pop());
        assert.equal(entry.children[0].children[0].innerHTML, undefined);
    }
});
