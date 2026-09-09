import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const { loadTravelData, loadTravelRecords } = await loadBrowserModule(new URL('../js/data.js', import.meta.url));
const record = { date: '2024-02-29', country: '中国', locality: '苏州市', desc_md: 'data/note.md' };

function mockRequests(t, fetch) {
    t.mock.method(globalThis, 'fetch', fetch);
    const previousWindow = globalThis.window;
    globalThis.window = { location: { href: 'http://localhost/travel-diary/index.html#cover' } };
    t.after(() => {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    });
}

async function renderMarkdown(t, markdown) {
    mockRequests(t, async () => new Response(markdown));
    return (await loadTravelRecords([record]))[0];
}

test('行内代码保留替换字符串和用户输入的私用区字符', async (t) => {
    const result = await renderMarkdown(t, '# 标题\n\n`$& **原文** <tag>` \uE0000\uE001');
    assert.equal(result.descBodyHtml, '<p><code>$&amp; **原文** &lt;tag&gt;</code> \uE0000\uE001</p>');
});

test('Markdown 格式不会修改链接地址，链接文字仍支持格式和代码', async (t) => {
    const result = await renderMarkdown(t, '# 标题\n\n**[**粗体** `代码`](https://example.test/~a~?q=**b**&x=1)**');
    assert.equal(result.descBodyHtml, '<p><strong><a href="https://example.test/~a~?q=**b**&amp;x=1" target="_blank" rel="noopener noreferrer"><strong>粗体</strong> <code>代码</code></a></strong></p>');
});

test('危险链接协议、控制字符和 HTML 均不能注入可执行内容', async (t) => {
    const result = await renderMarkdown(t, '# 标题\n\n[一](javascript:evil) [二](java\u0000script:evil) [三](data:text/html,evil) <img src=x onerror=evil>');
    assert.doesNotMatch(result.descBodyHtml, /<a |<img/);
    assert.match(result.descBodyHtml, /&lt;img/);
});

test('正文响应流失败后重试，最终失败仅降级该篇日记', async (t) => {
    let calls = 0;
    mockRequests(t, async () => {
        calls += 1;
        if (calls === 1) return { ok: true, text: async () => { throw new Error('响应中断'); } };
        return new Response('# 恢复\n\n正文');
    });
    const [loaded] = await loadTravelRecords([record]);
    assert.equal(calls, 2);
    assert.equal(loaded.descTitle, '恢复');
    assert.equal(loaded.descLoadFailed, false);

    t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
    const [failed] = await loadTravelRecords([record]);
    assert.equal(failed.descLoadFailed, true);
    assert.equal(failed.descTitle, '苏州市');
});

test('数据入口拒绝损坏的记录与无效日期，并过滤异常照片附件', async (t) => {
    let data;
    mockRequests(t, async url => Response.json(url.endsWith('countries.json') ? { countries: [] } : data));
    for (const invalid of [null, [], 1, { ...record, date: '2023-02-29' }, { ...record, date: 20240229 }, { ...record, desc_md: [] }]) {
        data = [invalid];
        await assert.rejects(loadTravelData(), /旅行记录第 1 项/);
    }
    data = [{ ...record, photos: [null, 3, '', ' a.png '], photo_folder: ' data/photos ' }];
    const [loaded] = await loadTravelData();
    assert.deepEqual(loaded.photos, ['a.png']);
    assert.equal(loaded.photo_folder, 'data/photos');
    data = [];
    assert.deepEqual(await loadTravelData(), []);
});
