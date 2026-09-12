import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';
import { normalizeTravelLocation } from '../js/location.mjs';

globalThis.document = { addEventListener() {} };
const app = await loadBrowserModule(new URL('../js/app.js', import.meta.url), `
export { parseRoute, deriveTravelModel, normalizePhotoIndex, hasRecordNoteContent,
    renderWithPageTurn, scheduleSearchRouteUpdate, syncRouteFromHash,
    applySearchRouteUpdate, syncPhotoSleevePreviewRows, isMobileContextPanelDismissTarget };
export function setTestState(values) {
    if (values.spread) refs.spread = values.spread;
    if (values.route) activeRoute = values.route;
    if (values.observer) photoSleeveResizeObserver = values.observer;
    if (values.sleeve) observedPhotoSleeves.add(values.sleeve);
}
`);
delete globalThis.document;

test('路由搜索保留查询值中的后续问号', () => {
    assert.equal(app.parseRoute('#ledger?q=去哪?怎么去?&year=2026').params.q, '去哪?怎么去?');
    assert.equal(app.parseRoute('#archive?q=?').params.q, '?');
});

test('同名或缺少正文路径的记录保留独立身份及原始顺序', () => {
    const records = [
        { date: '2026-01-02', desc_md: 'data/a/note.md', locality: '甲' },
        { date: '2025-01-01', desc_md: 'data/b/note.md', locality: '乙' },
        { date: '2024-01-01', locality: '丙' },
        { date: '2024-01-01', locality: '丙' }
    ].map(normalizeTravelLocation);
    const model = app.deriveTravelModel(records);
    assert.equal(model.recordsById.size, 4);
    assert.deepEqual(model.records.map(item => item.date), records.map(item => item.date));
    assert.deepEqual(model.records.map(item => item.locality), ['甲', '乙', '丙', '丙']);
    assert.equal(model.records[0].id, 'note');
    assert.equal(model.records[1].id, 'note-2');
    assert.equal(model.stats.total, 4);
    assert.equal(app.deriveTravelModel([]).recordsById.size, 0);
});

test('重复文件名生成的后缀不会占用已有日记链接', () => {
    const records = ['a/note.md', 'b/note.md', 'note-2.md'].map(desc_md => normalizeTravelLocation({ date: '2026-01-01', desc_md }));
    assert.deepEqual(app.deriveTravelModel(records).records.map(record => record.id), ['note', 'note-3', 'note-2']);
});

test('正文加载失败不会被识别为有笔记', () => {
    assert.equal(app.hasRecordNoteContent({ descLoadFailed: true, descBodyHtml: '<p>加载失败</p>' }), false);
    assert.equal(app.hasRecordNoteContent({ descMarkdown: '# 标题\n\n正文' }), true);
    assert.equal(app.hasRecordNoteContent({ descMarkdown: '# 标题' }), false);
});

test('异常照片索引回退且循环切换始终得到整数下标', () => {
    for (const value of [NaN, Infinity, '坏值', undefined]) assert.equal(app.normalizePhotoIndex(value, 3), 0);
    assert.equal(app.normalizePhotoIndex(1.9, 3), 1);
    assert.equal(app.normalizePhotoIndex(-1, 3), 2);
    assert.equal(app.normalizePhotoIndex(3, 3), 0);
    assert.equal(app.normalizePhotoIndex(1, 0), 0);
});

test('取消翻页动画时清除旧动画类且只渲染新页面', async () => {
    const classes = new Set();
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    app.setTestState({ spread: { classList: {
        add: name => classes.add(name),
        remove: (...names) => names.forEach(name => classes.delete(name))
    } } });
    let rendered = '';
    app.renderWithPageTurn(() => { rendered = '旧页面'; });
    assert.equal(classes.has('turn-forward'), true);
    app.renderWithPageTurn(() => { rendered = '新页面'; }, { animate: false });
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(rendered, '新页面');
    assert.equal(classes.size, 0);
    delete globalThis.window;
});

test('外部路由变化取消搜索定时器并忽略离开页面后的搜索回调', () => {
    let cancelled = false;
    globalThis.window = { setTimeout: () => 1, clearTimeout: () => { cancelled = true; } };
    app.scheduleSearchRouteUpdate({ id: 'ledgerSearch', value: '苏州' });
    app.syncRouteFromHash();
    assert.equal(cancelled, true);
    app.setTestState({ route: { name: 'cover', params: {} } });
    assert.doesNotThrow(() => app.applySearchRouteUpdate({ id: 'ledgerSearch', value: '苏州' }));
    delete globalThis.window;
});

test('移动端足迹摘要不会把数据操作弹窗中的点击当作外部点击', () => {
    const contextPanelTarget = { closest: selector => selector.includes('.paper-page-right.context-panel') ? {} : null };
    const dialogTarget = { closest: selector => selector.includes('dialog') ? {} : null };
    const outsideTarget = { closest: () => null };

    assert.equal(app.isMobileContextPanelDismissTarget(contextPanelTarget), false);
    assert.equal(app.isMobileContextPanelDismissTarget(dialogTarget), false);
    assert.equal(app.isMobileContextPanelDismissTarget(outsideTarget), true);
});

test('照片预览同步时释放已移除节点并保留仍连接的节点', () => {
    const removed = { isConnected: false };
    const retained = { isConnected: true };
    const unobserved = [];
    globalThis.document = { querySelectorAll: () => [] };
    app.setTestState({ observer: { unobserve: node => unobserved.push(node) }, sleeve: removed });
    app.setTestState({ sleeve: retained });
    app.syncPhotoSleevePreviewRows();
    app.syncPhotoSleevePreviewRows();
    assert.deepEqual(unobserved, [removed]);
    delete globalThis.document;
});
