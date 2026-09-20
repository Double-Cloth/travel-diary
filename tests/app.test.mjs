import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';
import { normalizeTravelLocation } from '../js/location.mjs';

globalThis.document = { addEventListener() {} };
const app = await loadBrowserModule(new URL('../js/app.js', import.meta.url), `
export { parseRoute, deriveTravelModel, normalizePhotoIndex, hasRecordNoteContent,
    renderWithPageTurn, cloneTurningPage, createPageCurlFrames, scheduleSearchRouteUpdate, syncRouteFromHash,
    applySearchRouteUpdate, syncPhotoSleevePreviewRows, isMobileContextPanelDismissTarget,
    deleteTravelRecord, renderEmptyArchiveState, matchesMediaFilter, formatMediaReferenceError };
export function stubReadingRoutes() {
    const originals = { renderLedger, renderCover, renderEntryPhotosRoute, openEntrySheet,
        closeEntrySheet, renderWithPageTurn, clearPageTurn, updateChapterTabs, restoreFocus,
        restoreReadingScrollPosition, travelModel, activeRoute, renderedPageHash, lastReadingHash,
        shell: refs.shell };
    const calls = [];
    renderLedger = () => calls.push('ledger');
    renderCover = () => calls.push('cover');
    renderEntryPhotosRoute = () => calls.push('photos');
    openEntrySheet = record => calls.push('entry:' + record.id);
    closeEntrySheet = () => {};
    clearPageTurn = () => {};
    updateChapterTabs = () => {};
    restoreFocus = () => {};
    restoreReadingScrollPosition = () => {};
    renderWithPageTurn = (render, options) => { calls.push(options.animate ? 'turn' : 'direct'); render(); };
    refs.shell = { dataset: {} };
    travelModel = { recordsById: new Map([['a', { id: 'a' }], ['b', { id: 'b' }]]) };
    activeRoute = null;
    renderedPageHash = '';
    lastReadingHash = '#ledger';
    return {
        calls,
        render: renderRoute,
        invalidate: () => { renderedPageHash = ''; },
        restore() {
            ({ renderLedger, renderCover, renderEntryPhotosRoute, openEntrySheet, closeEntrySheet,
                renderWithPageTurn, clearPageTurn, updateChapterTabs, restoreFocus,
                restoreReadingScrollPosition, travelModel, activeRoute, renderedPageHash,
                lastReadingHash } = originals);
            refs.shell = originals.shell;
        }
    };
}
export function setTestState(values) {
    if (values.spread) refs.spread = values.spread;
    if (values.leftPage) refs.leftPage = values.leftPage;
    if (values.rightPage) refs.rightPage = values.rightPage;
    if (values.route) activeRoute = values.route;
    if (values.observer) photoSleeveResizeObserver = values.observer;
    if (values.sleeve) observedPhotoSleeves.add(values.sleeve);
}
`);
delete globalThis.document;

test('删除已提交但数据刷新失败时返回已删除状态，避免误报删除失败', async t => {
    const previous = { window: globalThis.window, fetch: globalThis.fetch };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.window = { location: { hostname: 'diary.example', href: 'https://diary.example/' } };
    let requests = 0;
    globalThis.fetch = async () => {
        requests += 1;
        if (requests > 2) throw new Error('模拟刷新失败');
        return { ok: true, json: async () => requests === 1
            ? { service: 'travel-diary-writer-v1', authenticated: true, token: 'test', methods: ['DELETE'], writeMode: 'remote' }
            : { deleted: true } };
    };
    assert.deepEqual(await app.deleteTravelRecord({ desc_md: 'data/travel-diary/2026/test.md' }), { refreshFailed: true });
});

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

test('空档案提供新增与导入入口，不再显示不可用死路', () => {
    const state = app.renderEmptyArchiveState();
    assert.match(state, /档案盒已经准备好了/);
    assert.match(state, /data-action="add-record"/);
    assert.match(state, /data-action="import-all-data"/);
    assert.doesNotMatch(state, /暂时打不开/);
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

test('有媒体筛选同时匹配图片或视频记录', () => {
    assert.equal(app.matchesMediaFilter({ photos: ['a.jpg'], videos: [] }, 'any'), true);
    assert.equal(app.matchesMediaFilter({ photos: [], videos: ['a.mp4'] }, 'any'), true);
    assert.equal(app.matchesMediaFilter({ photos: [], videos: [] }, 'any'), false);
    assert.equal(app.matchesMediaFilter({ photos: ['a.jpg'], videos: [] }, 'videos'), false);
    assert.equal(app.matchesMediaFilter({ photos: [], videos: [] }, 'none'), true);
});

test('媒体引用错误指出文件、索引字段与实际路径', () => {
    globalThis.window = { location: { href: 'https://diary.example/' } };
    assert.equal(
        app.formatMediaReferenceError({ kind: 'image', name: 'missing.jpg', src: 'data/photos/test/missing.jpg' }),
        '图片文件“missing.jpg”不存在或无法读取。请检查 travel_data.json 中 photo_folder 与 photos 的引用（当前路径：data/photos/test/missing.jpg）。'
    );
    assert.match(
        app.formatMediaReferenceError({ kind: 'video', name: 'missing.mp4', src: 'data/videos/test/missing.mp4' }),
        /视频文件“missing\.mp4”不存在、无法读取或编码不受支持.*video_folder 与 videos/
    );
    delete globalThis.window;
});

test('异常照片索引回退且循环切换始终得到整数下标', () => {
    for (const value of [NaN, Infinity, '坏值', undefined]) assert.equal(app.normalizePhotoIndex(value, 3), 0);
    assert.equal(app.normalizePhotoIndex(1.9, 3), 1);
    assert.equal(app.normalizePhotoIndex(-1, 3), 2);
    assert.equal(app.normalizePhotoIndex(3, 3), 0);
    assert.equal(app.normalizePhotoIndex(1, 0), 0);
});

test('快速切换与取消翻页会清理旧副本并保持最后一次渲染', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const previous = { window: globalThis.window, document: globalThis.document, getComputedStyle: globalThis.getComputedStyle, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
    t.after(() => Object.assign(globalThis, previous));
    globalThis.requestAnimationFrame = callback => { callback(); return 1; };
    globalThis.cancelAnimationFrame = () => {};
    const copies = new Set();
    const animations = [];
    const createNode = () => ({
        classList: {
            values: new Set(),
            add(...names) { names.forEach(name => this.values.add(name)); },
            remove(...names) { names.forEach(name => this.values.delete(name)); }
        },
        style: { setProperty() {} },
        scrollTop: 45,
        children: [],
        getBoundingClientRect: () => ({ width: 600, height: 800 }),
        animate() {
            const animation = { cancelled: false, pause() {}, play() {}, cancel() { this.cancelled = true; } };
            animations.push(animation);
            return animation;
        },
        cloneNode: createNode,
        querySelectorAll: () => [],
        setAttribute() {},
        removeAttribute() {},
        append(...nodes) { this.children.push(...nodes); nodes.forEach(node => copies.add(node)); },
        remove() { copies.delete(this); }
    });
    const spread = createNode();
    globalThis.document = { createElement: createNode };
    globalThis.getComputedStyle = () => ({ background: '#fff' });
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    app.setTestState({ spread, leftPage: createNode(), rightPage: createNode() });
    let rendered = '';
    app.renderWithPageTurn(() => { rendered = '第一页'; });
    assert.equal(spread.classList.values.has('turn-back'), true);
    const firstLeaf = [...copies].find(node => node.className === 'book-turn-leaf');
    assert.equal(firstLeaf.inert, true);
    t.mock.timers.tick(100);
    app.renderWithPageTurn(() => { rendered = '第二页'; }, { direction: 'back' });
    assert.equal(copies.has(firstLeaf), false);
    assert.equal(animations.slice(0, 12).every(animation => animation.cancelled), true);
    assert.equal(spread.classList.values.has('turn-back'), true);
    const secondLeaf = [...copies].find(node => node.className === 'book-turn-leaf');
    t.mock.timers.tick(620);
    assert.equal(copies.has(secondLeaf), true);
    app.renderWithPageTurn(() => { rendered = '最后一页'; }, { animate: false });
    t.mock.timers.tick(1000);
    assert.equal(rendered, '最后一页');
    assert.equal(copies.has(secondLeaf), false);
    assert.equal(spread.classList.values.size, 0);
    globalThis.window.matchMedia = () => ({ matches: true });
    app.renderWithPageTurn(() => { rendered = '减少动态效果'; });
    assert.equal(rendered, '减少动态效果');
    assert.equal(spread.classList.values.size, 0);
    globalThis.window.matchMedia = () => ({ matches: false });
    const pendingFrames = [];
    globalThis.requestAnimationFrame = callback => { pendingFrames.push(callback); return 2; };
    app.renderWithPageTurn(() => { rendered = '等待首帧'; });
    app.renderWithPageTurn(() => { rendered = '取消待开始的翻页'; }, { animate: false });
    pendingFrames.forEach(callback => callback());
    t.mock.timers.tick(2000);
    assert.equal(rendered, '取消待开始的翻页');
    assert.equal(spread.classList.values.size, 0);
    assert.equal(animations.every(animation => animation.cancelled), true);
});

test('翻页副本清除屏外记录内容但保持占位，不修改真实记录', t => {
    const previous = globalThis.getComputedStyle;
    t.after(() => { globalThis.getComputedStyle = previous; });
    globalThis.getComputedStyle = () => ({ background: '#fff' });
    const visible = { style: {}, replaceChildren() { this.cleared = true; } };
    const outside = { style: {}, replaceChildren() { this.cleared = true; } };
    const copy = { style: {}, removeAttribute() {}, setAttribute() {}, classList: { add() {} },
        querySelectorAll: selector => selector === '[id]' ? [] : [visible, outside] };
    const source = { cloneNode: () => copy, getBoundingClientRect: () => ({ top: 100, bottom: 900 }),
        querySelectorAll: () => [
            { getBoundingClientRect: () => ({ top: 850, bottom: 970, height: 120 }) },
            { getBoundingClientRect: () => ({ top: 1100, bottom: 1250, height: 150 }) }
        ] };
    assert.equal(app.cloneTurningPage(source), copy);
    assert.equal(visible.cleared, undefined, '跨越可视边界的记录仍需保留');
    assert.equal(outside.cleared, true);
    assert.equal(outside.style.height, '150px');
    assert.equal(outside.style.visibility, 'hidden');
    assert.equal(copy.inert, true);
});

test('柔软纸页保持中缝锚点、连续曲面和正反向落页位置', () => {
    for (const backwards of [false, true]) {
        const frames = app.createPageCurlFrames(600, backwards);
        const parse = frame => frame.transform.match(/-?[\d.]+(?:e[+-]?\d+)?/g).slice(1).map(Number);
        const start = parse(frames[0][0]);
        const finish = parse(frames[0].at(-1));
        assert.equal(start[0], backwards ? 550 : 0);
        assert.equal(finish[0], start[0]);
        assert.equal(finish[2], 0);
        assert.ok(Math.abs(Math.abs(finish[3]) - Math.PI) < 1e-10);
        assert.deepEqual(frames[0][0].transform, frames[0][6].transform, '掀角期间书脊保持静止');
        const middle = frames.map(strip => parse(strip[24]));
        assert.ok(middle.at(-1)[2] > 400, '纸张中途拱起');
        assert.ok(Math.abs(middle[0][3] - middle.at(-1)[3]) > 1.5, '不同位置的角度应呈曲线而非平板');
        for (let index = 0; index < middle.length - 1; index += 1) {
            const direction = backwards ? -1 : 1;
            assert.ok(Math.abs(middle[index + 1][0] - middle[index][0] - direction * Math.cos(middle[index][3]) * 50) < 1e-8);
            assert.ok(Math.abs(middle[index + 1][2] - middle[index][2] + direction * Math.sin(middle[index][3]) * 50) < 1e-8);
        }
    }
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


test('详情打开、换篇和关闭复用列表；附件返回或数据刷新后重建背景', t => {
    const previousDocument = globalThis.document;
    globalThis.document = { body: { dataset: {} } };
    const scenario = app.stubReadingRoutes();
    t.after(() => { scenario.restore(); globalThis.document = previousDocument; });
    const ledger = app.parseRoute('#ledger');
    scenario.render(ledger, { initial: true });
    scenario.render(app.parseRoute('#entry?id=a'));
    scenario.render(app.parseRoute('#entry?id=b'));
    scenario.render(ledger);
    assert.deepEqual(scenario.calls, ['direct', 'ledger', 'entry:a', 'entry:b']);
    scenario.render(app.parseRoute('#photos?id=b'));
    scenario.render(app.parseRoute('#entry?id=b'));
    assert.deepEqual(scenario.calls.slice(-4), ['turn', 'photos', 'ledger', 'entry:b']);
    scenario.invalidate();
    scenario.render(app.parseRoute('#entry?id=a'));
    assert.deepEqual(scenario.calls.slice(-2), ['ledger', 'entry:a']);
});
