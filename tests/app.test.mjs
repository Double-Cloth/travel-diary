import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';
import { normalizeTravelLocation } from '../js/location.mjs';

globalThis.document = { addEventListener() {} };
const app = await loadBrowserModule(new URL('../js/app.js', import.meta.url), `
export { parseRoute, deriveTravelModel, normalizePhotoIndex, hasRecordNoteContent,
    renderWithPageTurn, renderWithBookCover, clearPageTurn, cloneTurningPage, createPageCurlFrames, getTurnDirection, scheduleSearchRouteUpdate, syncRouteFromHash,
    applySearchRouteUpdate, syncPhotoSleevePreviewRows, isMobileContextPanelDismissTarget,
    deleteTravelRecord, renderEmptyArchiveState, matchesMediaFilter, formatMediaReferenceError };
export function renderTestEntry(record, navigation) {
    const originals = { setPages, getEntryNavigation, travelModel };
    let result;
    setPages = (left, right) => { result = { left, right }; };
    getEntryNavigation = () => navigation;
    travelModel = { ...deriveTravelModel([record]), recordsById: new Map([[record.id, record]]) };
    try { renderEntryRoute({ id: record.id }); return result; }
    finally { ({ setPages, getEntryNavigation, travelModel } = originals); }
}
export function stubReadingRoutes() {
    const originals = { renderLedger, renderCover, renderEntryRoute, renderEntryPhotosRoute,
        renderWithPageTurn, clearPageTurn, updateChapterTabs, restoreFocus,
        restoreReadingScrollPosition, travelModel, activeRoute, renderedPageHash, lastReadingHash,
        shell: refs.shell };
    const calls = [];
    renderLedger = () => calls.push('ledger');
    renderCover = () => calls.push('cover');
    renderEntryRoute = params => calls.push('entry:' + params.id);
    renderEntryPhotosRoute = () => calls.push('photos');
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
            ({ renderLedger, renderCover, renderEntryRoute, renderEntryPhotosRoute,
                renderWithPageTurn, clearPageTurn, updateChapterTabs, restoreFocus,
                restoreReadingScrollPosition, travelModel, activeRoute, renderedPageHash,
                lastReadingHash } = originals);
            refs.shell = originals.shell;
        }
    };
}
export function setTestState(values) {
    if (values.shell) refs.shell = values.shell;
    if (values.closedBookCover) refs.closedBookCover = values.closedBookCover;
    if (values.spread) refs.spread = values.spread;
    if (values.leftPage) refs.leftPage = values.leftPage;
    if (values.rightPage) refs.rightPage = values.rightPage;
    if (values.route) activeRoute = values.route;
    if (values.observer) photoSleeveResizeObserver = values.observer;
    if (values.sleeve) observedPhotoSleeves.add(values.sleeve);
}
`);
delete globalThis.document;

test('长短篇详情正文只渲染一次，左页相邻篇目与管理入口不重复', t => {
    const previous = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 1;
    t.after(() => { globalThis.requestAnimationFrame = previous; });
    for (const body of ['只有一句旅行笔记。', '旅行经过只应出现一次。'.repeat(20)]) {
        const record = normalizeTravelLocation({ id: 'current', date: '2026-08-28', country_code: 'CN', locality: '重庆市', title: '重庆',
            descMarkdown: '# 重庆\n\n' + body, descBodyHtml: '<p>' + body + '</p>', photos: [], videos: [] });
        const result = app.renderTestEntry(record, { index: 1, total: 3, previous: { id: 'prev', title: '前一篇' }, next: { id: 'next', title: '后一篇' } });
        assert.equal(result.left.includes(body), false);
        assert.equal(result.right.split(body).length - 1, 1);
        assert.match(result.left, /相邻篇目/);
        assert.equal((result.left.match(/data-action="entry-next"/g) || []).length, 1);
        assert.equal((result.left.match(/data-action="entry-prev"/g) || []).length, 1);
        assert.match(result.left, /data-action="entry-next" data-entry-id="next"/);
        assert.match(result.left, /data-action="entry-prev" data-entry-id="prev"/);
        assert.doesNotMatch(result.right, /data-action="entry-next"|data-action="entry-prev"|class="sheet-nav"/);
        assert.match(result.left, /<details class="entry-management">/);
        assert.doesNotMatch(result.right, /没有图片或视频附件/);
        assert.match(result.right, /02 \/ 3/);
    }
});

test('首末篇在相邻篇目中显示不可点击的边界提示', t => {
    const previous = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 1;
    t.after(() => { globalThis.requestAnimationFrame = previous; });
    const record = normalizeTravelLocation({ id: 'only', date: '2026-08-28', country_code: 'CN', locality: '重庆市', title: '重庆', photos: [], videos: [] });
    const result = app.renderTestEntry(record, { index: 0, total: 1, previous: null, next: null });
    assert.match(result.left, /已到首篇/);
    assert.match(result.left, /已到末篇/);
    assert.doesNotMatch(result.left, /data-action="entry-next"|data-action="entry-prev"/);
});

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
        animate(keyframes, timing) {
            const animation = { keyframes, timing, cancelled: false, pause() {}, play() {}, cancel() { this.cancelled = true; } };
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
    const leftPage = createNode();
    const rightPage = createNode();
    leftPage.inert = rightPage.inert = false;
    app.setTestState({ spread, leftPage, rightPage });
    let rendered = '';
    app.renderWithPageTurn(() => { rendered = '第一页'; });
    assert.equal(spread.classList.values.has('turn-forward'), true);
    assert.equal(leftPage.inert, true);
    assert.equal(rightPage.inert, true);
    const firstLeaf = [...copies].find(node => node.className === 'book-turn-leaf');
    assert.equal(firstLeaf.inert, true);
    assert.equal(animations[0].keyframes.find(frame => frame.offset === .72).opacity, 1);
    assert.equal(animations[0].keyframes.at(-1).opacity, 0, '对页副本在落页前完成交接');
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
    assert.equal(leftPage.inert, false);
    assert.equal(rightPage.inert, false);
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

test('翻页方向与书签顺序及返回按钮一致', () => {
    for (const [from, to, direction] of [
        ['cover', 'ledger', 'forward'], ['ledger', 'archive', 'forward'],
        ['archive', 'ledger', 'back'], ['ledger', 'cover', 'back'],
        ['archive', 'place', 'forward'], ['place', 'archive', 'back'],
        ['entry', 'photos', 'forward'], ['photos', 'entry', 'back']
    ]) assert.equal(app.getTurnDirection({ name: from }, { name: to }), direction);
});

test('封面沿书脊翻转，合书落稳后提交且中断不重复渲染', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const previous = { window: globalThis.window, document: globalThis.document,
        getComputedStyle: globalThis.getComputedStyle, requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame };
    t.after(() => { app.clearPageTurn(); Object.assign(globalThis, previous); });
    const nodes = new Set();
    const animations = [];
    const frames = [];
    const createNode = () => ({
        inert: false, scrollTop: 80, style: { setProperty() {} }, attributes: new Map(),
        classList: { values: new Set(), add(...names) { names.forEach(name => this.values.add(name)); },
            remove(...names) { names.forEach(name => this.values.delete(name)); } },
        cloneNode: createNode, querySelectorAll: () => [], querySelector: () => createNode(),
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 560, height: 800, bottom: 800 }),
        setAttribute(name, value) { this.attributes.set(name, value); },
        removeAttribute(name) { this.attributes.delete(name); },
        append(...children) { children.forEach(child => nodes.add(child)); },
        remove() { nodes.delete(this); }, focus() { this.focused = true; },
        animate(keyframes, timing) { const animation = { timing, keyframes, state: 'running',
            pause() { this.state = 'paused'; }, play() { this.state = 'running'; }, cancel() { this.cancelled = true; } };
            animations.push(animation); return animation; }
    });
    const shell = createNode();
    const leftPage = createNode();
    const rightPage = createNode();
    const closedBookCover = createNode();
    const spread = createNode();
    spread.parentElement = createNode();
    spread.closest = () => shell;
    let reduced = false;
    let mobile = false;
    globalThis.window = { matchMedia: query => ({ matches: query.includes('reduced-motion') ? reduced : mobile }) };
    globalThis.document = { createElement: createNode, body: createNode() };
    globalThis.getComputedStyle = () => ({ background: '#eee' });
    globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    globalThis.cancelAnimationFrame = () => {};
    app.setTestState({ shell, spread, leftPage, rightPage, closedBookCover });
    let renders = 0;
    app.renderWithBookCover(() => { renders += 1; }, 'closing');
    assert.equal(renders, 0, '合书开始时不能清空当前正文');
    assert.equal([...nodes].some(node => node.className === 'book-transition-overlay'), true);
    assert.equal(animations.length, 0, '书页仍可见时尚未开始合书');
    frames.shift()();
    assert.equal(animations.length, 3);
    assert.deepEqual(animations[1].keyframes.map(frame => frame.transform),
        ['rotateY(-176deg)', 'rotateY(-166deg)', 'rotateY(-105deg)', 'rotateY(-38deg)', 'rotateY(0deg)']);
    t.mock.timers.tick(959);
    assert.equal(renders, 0);
    t.mock.timers.tick(1);
    assert.equal(renders, 1);
    assert.equal(closedBookCover.focused, true);
    assert.equal(closedBookCover.attributes.has('aria-hidden'), false);
    assert.equal([...nodes].some(node => node.className === 'book-transition-overlay'), false);

    app.renderWithBookCover(() => { renders += 1; }, 'closing');
    app.clearPageTurn();
    frames.shift()();
    t.mock.timers.tick(1000);
    assert.equal(renders, 2, '取消首帧或调整视口不得重复提交目标画面');
    assert.equal(animations.every(animation => animation.cancelled), true);

    reduced = true;
    app.renderWithBookCover(() => { renders += 1; }, 'opening');
    assert.equal(renders, 3);
    reduced = false;
    mobile = true;
    globalThis.window.innerWidth = 390;
    globalThis.window.innerHeight = 844;
    closedBookCover.getBoundingClientRect = () => ({ width: 0, height: 0 });
    leftPage.getBoundingClientRect = () => ({ top: 112, left: 0, width: 390, height: 5000 });
    app.renderWithBookCover(() => { renders += 1; }, 'opening');
    assert.equal(renders, 4, '开书时立即在静态封面下绘制新页');
    const mobileOverlay = [...nodes].find(node => node.className === 'book-transition-overlay');
    assert.ok(mobileOverlay);
    assert.equal([...nodes].findLast(node => node.className === 'book-transition-scene').style.width, '342px');
    frames.shift()(performance.now() + 1000);
    const mobileScaleY = Number(animations.at(-4).keyframes.at(-1).transform.match(/scale\([^,]+, ([^)]+)\)/)[1]);
    assert.ok(mobileScaleY < 2, '连续滚动的手机书页不能把封皮拉伸到整页高度');
    assert.deepEqual(animations.at(-3).keyframes.map(frame => frame.transform),
        ['rotateY(0deg)', 'rotateY(-24deg)', 'rotateY(-100deg)', 'rotateY(-166deg)', 'rotateY(-176deg)']);
    t.mock.timers.tick(960);
    assert.equal(shell.focused, true);
    assert.equal([...nodes].some(node => node.className === 'book-transition-overlay'), false);

    app.renderWithBookCover(() => { renders += 1; }, 'closing');
    assert.equal([...nodes].findLast(node => node.className === 'book-transition-scene').style.width, '342px');
    frames.shift()();
    t.mock.timers.tick(960);
    assert.equal(renders, 5);
});

test('卷曲从下角向内扩散，纸面共享边界且正反向准确落页', () => {
    for (const backwards of [false, true]) {
        const frames = app.createPageCurlFrames(600, 800, backwards);
        assert.equal(frames.length, 18);
        for (const band of frames) {
            assert.equal(band[0].first.z, 0);
            assert.equal(band[0].last.z, 0);
            assert.ok(Math.abs(band.at(-1).first.u + band[0].first.u) < 1e-8);
            assert.equal(band.at(-1).first.z, 0);
        }
        const early = frames.map(band => band[10]);
        assert.ok(early[0].first.z === 0 && early[10].first.z === 0, '靠近书脊的纸张仍贴在底页');
        assert.ok(early[15].last.z > 0, '外侧下角已经开始卷动');
        assert.ok(early[0].tilt > 0.18 && early[0].tilt < 0.25, '下角轻微先行，避免整张纸大幅斜飞');
        for (let frame = 0; frame <= 48; frame += 1) {
            for (let index = 0; index < frames.length - 1; index += 1) {
                assert.ok(Math.abs(frames[index][frame].last.u - frames[index + 1][frame].first.u) < 1e-8);
                assert.ok(Math.abs(frames[index][frame].last.z - frames[index + 1][frame].first.z) < 1e-8);
            }
        }
        assert.equal(frames[0].at(-1).tilt, 0, '落页时与书脊平行');
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


test('详情、附件与返回都作为书页路由参与翻页', t => {
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const scrolls = [];
    globalThis.window = { matchMedia: () => ({ matches: true }), scrollTo: options => scrolls.push(options) };
    globalThis.document = { body: { dataset: {} } };
    const scenario = app.stubReadingRoutes();
    t.after(() => { scenario.restore(); globalThis.document = previousDocument; globalThis.window = previousWindow; });
    const ledger = app.parseRoute('#ledger');
    scenario.render(ledger, { initial: true });
    scenario.render(app.parseRoute('#entry?id=a'));
    scenario.render(app.parseRoute('#entry?id=b'));
    scenario.render(ledger);
    assert.deepEqual(scenario.calls, ['direct', 'ledger', 'turn', 'entry:a', 'turn', 'entry:b', 'turn', 'ledger']);
    assert.deepEqual(scrolls, [{ top: 0, behavior: 'instant' }, { top: 0, behavior: 'instant' }], '手机打开与切换日记回到页首，返回列表保留原阅读位置');
    scenario.render(app.parseRoute('#photos?id=b'));
    scenario.render(app.parseRoute('#entry?id=b'));
    assert.deepEqual(scenario.calls.slice(-4), ['turn', 'photos', 'turn', 'entry:b']);
    scenario.invalidate();
    scenario.render(app.parseRoute('#entry?id=a'));
    assert.deepEqual(scenario.calls.slice(-2), ['turn', 'entry:a']);
});
