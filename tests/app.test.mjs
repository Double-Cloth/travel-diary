import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';
import { normalizeTravelLocation } from '../js/location.mjs';

globalThis.document = { addEventListener() {} };
const app = await loadBrowserModule(new URL('../js/app.js', import.meta.url), `
export { parseRoute, deriveTravelModel, normalizePhotoIndex, hasRecordNoteContent,
    renderWithPageTurn, renderWithBookCover, clearPageTurn, cloneTurningPage, cloneTransitionContent, createTransitionMediaImage, observePhotoSleeveVideos, createPageCurlFrames, createMobilePageCurlFrames, getTurnDirection, scheduleSearchRouteUpdate, syncRouteFromHash,
    applySearchRouteUpdate, syncPhotoSleevePreviewRows, isMobileContextPanelDismissTarget,
    deleteTravelRecord, renderEmptyArchiveState, matchesMediaFilter, formatMediaReferenceError, trapPanelFocus, handleDocumentClick,
    restoreFocus, handleDocumentKeydown, updateLedgerRoute, serializeRoute,
    getInitialPhotoScale, getPhotoViewerBounds, constrainPhotoViewerTransform, getPhotoViewerBackgroundColor, updatePhotoViewerBackground };
export function stubSearchNavigation(route) {
    const originals = { navigateTo, activeRoute };
    const calls = [];
    activeRoute = route;
    navigateTo = (next, options) => calls.push({ next, options });
    return { calls, restore() { ({ navigateTo, activeRoute } = originals); } };
}
export function renderTestEntry(record, navigation) {
    const originals = { setPages, getEntryNavigation, travelModel };
    let result;
    setPages = (left, right, mode, options = {}) => { result = { left, right, ...options }; };
    getEntryNavigation = () => navigation;
    travelModel = { ...deriveTravelModel([record]), recordsById: new Map([[record.id, record]]) };
    try { renderEntryRoute({ id: record.id }); return result; }
    finally { ({ setPages, getEntryNavigation, travelModel } = originals); }
}
export function renderTestPlace(records, params, photos = false) {
    const originals = { setPages, travelModel };
    let result;
    setPages = (left, right, mode, options = {}) => { result = { left, right, ...options }; };
    travelModel = deriveTravelModel(records);
    try {
        if (photos) renderEntryPhotosRoute(params);
        else renderPlace(params);
        return result;
    }
    finally { ({ setPages, travelModel } = originals); }
}
export function stubViewerNavigation(state) {
    const originals = { photoViewerState, renderPhotoViewer, resetPhotoTransform };
    const calls = [];
    photoViewerState = state;
    renderPhotoViewer = () => calls.push('render');
    resetPhotoTransform = () => calls.push('reset');
    return {
        calls, show: showPhotoAt, action: handlePhotoViewerAction,
        restore() { ({ photoViewerState, renderPhotoViewer, resetPhotoTransform } = originals); }
    };
}
export function stubReadingRoutes() {
    const originals = { renderLedger, renderCover, renderEntryRoute, renderEntryPhotosRoute,
        renderWithPageTurn, clearPageTurn, updateChapterTabs, restoreFocus,
        restoreReadingScrollPosition, travelModel, activeRoute, renderedPageHash, lastReadingHash,
        shell: refs.shell };
    const calls = [];
    const turns = [];
    let deferred = false;
    let pending;
    renderLedger = () => calls.push('ledger');
    renderCover = () => calls.push('cover');
    renderEntryRoute = params => calls.push('entry:' + params.id);
    renderEntryPhotosRoute = () => calls.push('photos');
    clearPageTurn = () => {};
    updateChapterTabs = () => {};
    restoreFocus = () => {};
    restoreReadingScrollPosition = () => {};
    renderWithPageTurn = (render, options) => {
        calls.push(options.animate ? 'turn' : 'direct');
        turns.push(options);
        if (deferred) pending = render;
        else render();
    };
    refs.shell = { dataset: {} };
    travelModel = { recordsById: new Map([['a', { id: 'a' }], ['b', { id: 'b' }]]) };
    activeRoute = null;
    renderedPageHash = '';
    lastReadingHash = '#ledger';
    return {
        calls,
        turns,
        defer: () => { deferred = true; },
        finish: () => pending?.(),
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
    if (values.stage) refs.stage = values.stage;
    if (values.observer) photoSleeveResizeObserver = values.observer;
    if (values.sleeve) observedPhotoSleeves.add(values.sleeve);
}
export function stubBookReadingRoutes() {
    const originals = { restoreReadingScrollPosition, closedBookReadingContext,
        lastReadingScrollPosition, leftPage: refs.leftPage, rightPage: refs.rightPage };
    const scenario = stubReadingRoutes();
    restoreReadingScrollPosition = originals.restoreReadingScrollPosition;
    closedBookReadingContext = null;
    refs.leftPage = { scrollTop: 0 };
    refs.rightPage = { scrollTop: 0 };
    return {
        render(hash) {
            scenario.render(parseRoute(hash), { animate: false });
        },
        position(left, right, windowY) {
            refs.leftPage.scrollTop = left;
            refs.rightPage.scrollTop = right;
            window.scrollTo(0, windowY);
        },
        getPosition: () => [refs.leftPage.scrollTop, refs.rightPage.scrollTop, window.scrollY],
        rememberBackground: rememberReadingContext,
        open() {
            const original = navigateTo;
            let hash;
            navigateTo = next => { hash = next; };
            try {
                handleDocumentClick({ preventDefault() {}, target: {
                    closest: selector => selector === '[data-action="open-book"]' ? {} : null
                } });
                return hash;
            } finally { navigateTo = original; }
        },
        restore() {
            scenario.restore();
            ({ closedBookReadingContext, lastReadingScrollPosition } = originals);
            refs.leftPage = originals.leftPage;
            refs.rightPage = originals.rightPage;
        }
    };
}
`);
delete globalThis.document;

test('省份媒体汇总覆盖各篇日记，排除其他省份和同名国外行政区', t => {
    const previous = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 1;
    t.after(() => { globalThis.requestAnimationFrame = previous; });
    const records = [
        { date: '2026-10-01', country_code: 'CN', admin_area: '江苏省', locality: '苏州市', photo_folder: 'data/photos/suzhou', photos: ['river.jpg', 'garden.jpg'], videos: [] },
        { date: '2026-10-02', country_code: 'CN', admin_area: '江苏省', locality: '南京市', photo_folder: 'data/photos/nanjing', photos: ['gate.jpg', 'lake.jpg'], video_folder: 'data/videos/nanjing', videos: ['walk.mp4'] },
        { date: '2026-10-03', country_code: 'CN', admin_area: '浙江省', locality: '杭州市', photo_folder: 'data/photos/hangzhou', photos: ['other.jpg'] },
        { date: '2026-10-04', country_code: 'US', admin_area: '江苏省', locality: '海外', photo_folder: 'data/photos/foreign', photos: ['foreign.jpg'] }
    ].map(normalizeTravelLocation);
    const params = { country: 'CN', area: '江苏省', locality: '' };
    const preview = app.renderTestPlace(records, params);
    assert.equal((preview.left.match(/data-action="open-media-viewer"/g) || []).length, 5);
    assert.match(preview.left, /photo-sleeve-preview/);
    assert.match(preview.left, /data-preview-rows="3"/);
    assert.match(preview.left, /href="#photos\?country=CN&amp;area=%E6%B1%9F%E8%8B%8F%E7%9C%81"/);
    assert.doesNotMatch(preview.left, /other\.jpg|foreign\.jpg/);
    assert.match(preview.right, /苏州市/);
    assert.match(preview.right, /南京市/);

    const route = app.parseRoute(app.serializeRoute({ name: 'photos', params }));
    assert.deepEqual(route.params, params);
    const full = app.renderTestPlace(records, route.params, true);
    assert.equal((full.right.match(/data-action="open-media-viewer"/g) || []).length, 5);
    assert.doesNotMatch(full.right, /photo-sleeve-preview|other\.jpg|foreign\.jpg/);
    assert.match(full.left, /4 张图片 · 1 个视频/);
    assert.equal((full.right.match(/class="photo-sleeve-group-heading"/g) || []).length, 2);
    assert.ok(full.right.indexOf('2026-10-02') < full.right.indexOf('data-media-name="gate.jpg"'));
    assert.ok(full.right.indexOf('data-media-name="walk.mp4"') < full.right.indexOf('2026-10-01'));
    assert.ok(full.right.indexOf('2026-10-01') < full.right.indexOf('data-media-name="river.jpg"'));
    assert.deepEqual([...full.right.matchAll(/data-media-index="(\d+)"/g)].map(match => Number(match[1])), [0, 1, 2, 3, 4]);
    assert.doesNotMatch(preview.left, /photo-sleeve-group-heading/);
    assert.match(full.left, /href="#place\?country=CN&amp;area=%E6%B1%9F%E8%8B%8F%E7%9C%81"/);

    const locality = app.renderTestPlace(records, { ...params, locality: '苏州市' }, true);
    assert.equal((locality.right.match(/data-action="open-media-viewer"/g) || []).length, 2);
    assert.doesNotMatch(locality.right, /gate\.jpg|walk\.mp4/);
    assert.match(locality.left, /locality=%E8%8B%8F%E5%B7%9E%E5%B8%82/);
    assert.deepEqual(app.parseRoute('#photos?id=note').params, { id: 'note' });
    assert.equal(app.serializeRoute({ name: 'photos', params: { id: 'note' } }), '#photos?id=note');
});

test('没有媒体的省份保留记录列表，空附件页提供返回入口', t => {
    const previous = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 1;
    t.after(() => { globalThis.requestAnimationFrame = previous; });
    const records = [{ date: '2026-10-01', country_code: 'CN', admin_area: '江苏省', locality: '苏州市', photos: [], videos: [] }].map(normalizeTravelLocation);
    const params = { country: 'CN', area: '江苏省', locality: '' };
    const preview = app.renderTestPlace(records, params);
    assert.doesNotMatch(preview.left, /photo-sleeve/);
    assert.match(preview.right, /ledger-entry/);
    for (const data of [records, []]) {
        const full = app.renderTestPlace(data, params, true);
        assert.match(full.left, /返回地点档案/);
        assert.match(full.left, /0 张图片 · 0 个视频/);
        assert.match(full.right, /这个地点还没有图片或视频附件/);
    }
});

test('搜索保留原输入和中间选区，Tab 离开后保持下一控件焦点', t => {
    const previous = globalThis.document;
    const input = { id: 'ledgerSearch', value: ' axbc ', selectionStart: 2, selectionEnd: 3, selectionDirection: 'backward' };
    const navigation = app.stubSearchNavigation({ name: 'ledger', params: { q: 'abc' } });
    globalThis.document = { activeElement: input, getElementById: () => input };
    t.after(() => { globalThis.document = previous; navigation.restore(); });
    app.applySearchRouteUpdate({ id: input.id, value: input.value });
    assert.deepEqual(navigation.calls[0].options.searchInputState, { value: ' axbc ', start: 2, end: 3, direction: 'backward' });
    globalThis.document.activeElement = { id: 'ledgerFilterButton' };
    app.applySearchRouteUpdate({ id: input.id, value: 'abcz' });
    assert.equal(navigation.calls[1].options.focusId, 'ledgerFilterButton');
    assert.equal(navigation.calls[1].options.searchInputState, null);
});

test('恢复搜索焦点保留选区，单选排序聚焦可见按钮', t => {
    const previous = { document: globalThis.document, frame: globalThis.requestAnimationFrame };
    const calls = [];
    const input = { value: 'axbc', focus: () => calls.push('input'), setSelectionRange: (...args) => calls.push(args) };
    const sortButton = { focus: () => calls.push('sort') };
    globalThis.document = { getElementById: id => ({ ledgerSearch: input, ledgerSortButton: sortButton })[id] };
    globalThis.requestAnimationFrame = callback => callback();
    t.after(() => { globalThis.document = previous.document; globalThis.requestAnimationFrame = previous.frame; });
    app.restoreFocus('ledgerSearch', '', 0, { value: ' axbc ', start: 2, end: 3, direction: 'backward' });
    assert.equal(input.value, ' axbc ');
    assert.deepEqual(calls, ['input', [2, 3, 'backward']]);
    app.restoreFocus('ledgerSort');
    assert.equal(calls.at(-1), 'sort');
});

test('点击年份筛选纳入尚未完成防抖的搜索，重置仍清空全部条件', t => {
    const previous = globalThis.document;
    const navigation = app.stubSearchNavigation({ name: 'ledger', params: { q: '' } });
    globalThis.document = { getElementById: () => ({ value: '杭州' }) };
    t.after(() => { globalThis.document = previous; navigation.restore(); });
    app.updateLedgerRoute({ year: ['2025'] });
    assert.equal(navigation.calls[0].next.params.q, '杭州');
    assert.deepEqual(navigation.calls[0].next.params.year, ['2025']);
    app.updateLedgerRoute({ q: '', year: [] });
    assert.equal(navigation.calls[1].next.params.q, '');
});

test('原生对话框打开时媒体和夹层的 Escape 快捷键不响应', t => {
    const previous = globalThis.document;
    globalThis.document = { querySelector: selector => selector === 'dialog[open]' ? {} : null };
    t.after(() => { globalThis.document = previous; });
    assert.doesNotThrow(() => app.handleDocumentKeydown({ key: 'Escape' }));
});

test('跳到内容直接聚焦正文，不改变章节路由', t => {
    const previous = globalThis.document;
    const calls = [];
    const stage = { focus: () => calls.push('focus'), scrollIntoView: () => calls.push('scroll') };
    t.after(() => { globalThis.document = previous; });
    app.setTestState({ stage });
    app.handleDocumentClick({
        preventDefault: () => calls.push('prevent'),
        target: { closest: selector => selector === '.skip-link' ? {} : null }
    });
    assert.deepEqual(calls, ['prevent', 'focus', 'scroll']);
});

test('夹层与媒体面板的 Tab 焦点循环跳过禁用和隐藏控件', t => {
    const previous = globalThis.document;
    t.after(() => { globalThis.document = previous; });
    const control = (settings = {}) => ({
        disabled: false, tabIndex: 0, closest: () => null, getClientRects: () => [{}],
        focus() { globalThis.document.activeElement = this; }, ...settings
    });
    const first = control();
    const last = control();
    const panel = { querySelectorAll: () => [first, control({ disabled: true }), control({ closest: () => ({}) }), last] };
    globalThis.document = { activeElement: last };
    let prevented = 0;
    assert.equal(app.trapPanelFocus({ key: 'Tab', preventDefault: () => prevented++ }, panel), true);
    assert.equal(globalThis.document.activeElement, first);
    assert.equal(app.trapPanelFocus({ key: 'Tab', shiftKey: true, preventDefault: () => prevented++ }, panel), true);
    assert.equal(globalThis.document.activeElement, last);
    assert.equal(prevented, 2);
    assert.equal(app.trapPanelFocus({ key: 'Escape' }, panel), false);
});

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
        assert.match(result.pageTurns, /data-action="entry-prev" data-entry-id="prev"/);
        assert.match(result.pageTurns, /data-action="entry-next" data-entry-id="next"/);
        assert.match(result.pageTurns, /aria-label="上一篇：前一篇"/);
        assert.doesNotMatch(result.right, /data-action="entry-next"|data-action="entry-prev"|class="sheet-nav"/);
        const toolbar = result.left.match(/<header class="entry-book-toolbar">([\s\S]*?)<\/header>/)?.[1] || '';
        assert.match(toolbar, /返回原处[\s\S]*data-action="edit-record"[\s\S]*data-action="delete-record"/);
        assert.equal((result.left.match(/data-action="edit-record"/g) || []).length, 1);
        assert.equal((result.left.match(/data-action="delete-record"/g) || []).length, 1);
        assert.doesNotMatch(result.left, /entry-management/);
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
    assert.equal((result.pageTurns.match(/ disabled/g) || []).length, 2);
    assert.doesNotMatch(result.pageTurns, /data-action=/);
});

test('地点快捷翻页沿用省份顺序，目的地仅在当前行政区内切换', t => {
    const previous = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 1;
    t.after(() => { globalThis.requestAnimationFrame = previous; });
    const records = [
        { date: '2026-10-01', country_code: 'CN', admin_area: '江苏省', locality: '南京市' },
        { date: '2026-10-02', country_code: 'CN', admin_area: '江苏省', locality: '苏州市' },
        { date: '2026-10-03', country_code: 'CN', admin_area: '江苏省', locality: '苏州市' },
        { date: '2026-10-04', country_code: 'CN', admin_area: '浙江省', locality: '杭州市' },
        { date: '2026-10-05', country_code: 'MY', admin_area: '马六甲州', locality: '马六甲' }
    ].map(normalizeTravelLocation);
    const province = app.renderTestPlace(records, { country: 'CN', area: '江苏省' });
    assert.match(province.pageTurns, /data-action="place-next"[^>]*data-admin-area="浙江省"/);
    assert.ok(province.pageTurns.includes(province.left.match(/aria-label="下一[^"]+：浙江省"/)[0]));
    const city = app.renderTestPlace(records, { country: 'CN', area: '江苏省', locality: records[0].locationKey });
    assert.match(city.pageTurns, /data-action="place-next"[^>]*data-locality="苏州市"/);
    assert.match(city.pageTurns, /aria-label="下一地点：苏州市"/);
    assert.doesNotMatch(city.pageTurns, /杭州市|马六甲/);
    const last = app.renderTestPlace(records, { country: 'CN', area: '江苏省', locality: '苏州市' });
    assert.match(last.pageTurns, /aria-label="已到末个地点"/);
    assert.doesNotMatch(last.pageTurns, /data-action="place-next"/);
    const country = app.renderTestPlace(records, { country: 'CN' });
    assert.match(country.pageTurns, /data-country-key="MY" data-admin-area="" data-locality=""/);
    const photos = app.renderTestPlace(records, { country: 'CN', area: '江苏省' }, true);
    assert.equal(photos.pageTurns, undefined);
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
    assert.equal(app.parseRoute('#preface').name, 'preface');
    assert.equal(app.parseRoute('#ledger?q=去哪?怎么去?&year=2026').params.q, '去哪?怎么去?');
    assert.equal(app.parseRoute('#archive?q=?').params.q, '?');
});

test('目录地点筛选保留同一维度的多个选项，记录特征只保留单个选项', () => {
    const route = app.parseRoute('#ledger?year=2025&year=2026&month=07&month=08&visit=first&visit=repeat&media=photos&media=videos');
    assert.deepEqual(route.params.year, ['2025', '2026']);
    assert.deepEqual(route.params.month, ['07', '08']);
    assert.deepEqual(route.params.visit, ['first']);
    assert.deepEqual(route.params.media, ['photos']);
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

test('媒体筛选匹配对应的图片或视频记录', () => {
    assert.equal(app.matchesMediaFilter({ photos: ['a.jpg'], videos: [] }, 'any'), true);
    assert.equal(app.matchesMediaFilter({ photos: [], videos: ['a.mp4'] }, 'any'), true);
    assert.equal(app.matchesMediaFilter({ photos: [], videos: [] }, 'any'), false);
    assert.equal(app.matchesMediaFilter({ photos: ['a.jpg'], videos: [] }, 'videos'), false);
    assert.equal(app.matchesMediaFilter({ photos: [], videos: [] }, 'none'), true);
    assert.equal(app.matchesMediaFilter({ photos: ['a.jpg'], videos: [] }, 'photos'), true);
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

test('查看器背景避开媒体边缘颜色，黑白混合边缘采用中间色阶', () => {
    const size = 32;
    for (const [edge, expected] of [
        [() => [0, 0, 0], '#e3dfd5'],
        [() => [255, 255, 255], '#3a3e3b'],
        [() => [184, 181, 173], '#3a3e3b'],
        [x => x < 16 ? [0, 0, 0] : [255, 255, 255], '#636966']
    ]) {
        for (const center of [[0, 0, 0], [255, 255, 255]]) {
            const pixels = new Uint8ClampedArray(size * size * 4);
            for (let y = 0; y < size; y += 1) {
                for (let x = 0; x < size; x += 1) {
                    const color = x < 2 || x >= 30 || y < 2 || y >= 30 ? edge(x) : center;
                    pixels.set([...color, 255], (y * size + x) * 4);
                }
            }
            assert.equal(app.getPhotoViewerBackgroundColor(pixels, size, size), expected);
        }
    }
});

test('透明边缘不参与背景选色，完全透明时沿用默认暖灰', () => {
    const pixels = new Uint8ClampedArray(32 * 32 * 4);
    assert.equal(app.getPhotoViewerBackgroundColor(pixels, 32, 32), '#b8b5ad');
    pixels.set([255, 255, 255, 255], 0);
    assert.equal(app.getPhotoViewerBackgroundColor(pixels, 32, 32), '#3a3e3b');
});

test('背景取色更新当前媒体，忽略旧媒体回调并容忍像素读取失败', t => {
    const previousDocument = globalThis.document;
    t.after(() => { globalThis.document = previousDocument; });
    const writes = [];
    const stage = { style: { setProperty: (...args) => writes.push(args) } };
    const media = { closest: () => stage };
    const pixels = new Uint8ClampedArray(32 * 32 * 4).fill(255);
    let reads = 0;
    let fail = false;
    globalThis.document = {
        body: { querySelector: () => media },
        createElement: () => ({ getContext: () => ({
            drawImage(source) { assert.equal(source, media); },
            getImageData() {
                reads += 1;
                if (fail) throw new Error('无法读取跨域媒体');
                return { data: pixels };
            }
        }) })
    };
    app.updatePhotoViewerBackground(media);
    assert.deepEqual(writes, [['--viewer-screen', '#3a3e3b']]);
    app.updatePhotoViewerBackground({ closest() { throw new Error('不应读取旧媒体'); } });
    assert.equal(reads, 1);
    fail = true;
    assert.doesNotThrow(() => app.updatePhotoViewerBackground(media));
    assert.equal(writes.length, 1);
});

test('视频首帧暂不可读时不使用透明像素选背景，读到画面后再更新', t => {
    const previousDocument = globalThis.document;
    t.after(() => { globalThis.document = previousDocument; });
    const writes = [];
    const pixels = new Uint8ClampedArray(32 * 32 * 4);
    const media = {
        matches: () => true,
        closest: () => ({ style: { setProperty: (...args) => writes.push(args) } })
    };
    globalThis.document = {
        body: { querySelector: () => media },
        createElement: () => ({ getContext: () => ({
            drawImage() {}, getImageData: () => ({ data: pixels })
        }) })
    };
    assert.equal(app.updatePhotoViewerBackground(media), false);
    assert.deepEqual(writes, []);
    pixels.fill(255);
    assert.equal(app.updatePhotoViewerBackground(media), true);
    assert.deepEqual(writes, [['--viewer-screen', '#3a3e3b']]);
});

test('媒体适配与拖动使用边框内的可见尺寸，旋转后仍能在边缘留白', t => {
    const previousDocument = globalThis.document;
    t.after(() => { globalThis.document = previousDocument; });
    for (const border of [5, 3, 0]) {
        for (const rotation of [0, 90]) {
            const stage = {
                clientWidth: 350, clientHeight: 600,
                getBoundingClientRect: () => ({ width: 350 + border * 2, height: 600 + border * 2 })
            };
            const media = { naturalWidth: 1200, naturalHeight: 800, matches: () => false };
            globalThis.document = { body: { querySelector: selector => ({
                '[data-photo-viewer-stage]': stage,
                '[data-photo-viewer-media]': media
            })[selector] || null } };
            const state = { scale: 1, rotation, translateX: 10000, translateY: -10000 };
            const viewer = app.stubViewerNavigation(state);
            try {
                assert.equal(app.getInitialPhotoScale(stage, media), 350 / 1200);
                const bounds = app.getPhotoViewerBounds();
                assert.equal(bounds.stageWidth, 350);
                assert.equal(bounds.stageHeight, 600);
                app.constrainPhotoViewerTransform();
                const imageWidth = rotation ? 800 : 1200;
                const imageHeight = rotation ? 1200 : 800;
                assert.ok(Math.abs(state.translateX - ((imageWidth - 350) / 2 + 21)) < 1e-9);
                assert.ok(Math.abs(state.translateY + ((imageHeight - 600) / 2 + 32)) < 1e-9);
            } finally { viewer.restore(); }
        }
    }
});

test('单项图片和视频切换保留媒体及查看状态，不重新渲染或重置', t => {
    for (const kind of ['image', 'video']) {
        const state = { photos: [{ kind }], index: 0, scale: 2, rotation: 90,
            translateX: 12, translateY: 20, videoVolume: .6, videoRate: 1.5 };
        const original = structuredClone(state);
        const viewer = app.stubViewerNavigation(state);
        try {
            viewer.action('prev');
            viewer.action('next');
            viewer.show(-1);
            viewer.show(1);
            assert.deepEqual(viewer.calls, []);
            assert.deepEqual(state, original);
        } finally { viewer.restore(); }
    }
});

test('多项媒体继续循环切换，归一化后仍是当前项时不重新加载', () => {
    const state = { photos: [{ kind: 'image' }, { kind: 'video' }], index: 0 };
    const viewer = app.stubViewerNavigation(state);
    try {
        viewer.show(2);
        assert.deepEqual(viewer.calls, []);
        viewer.action('prev');
        assert.equal(state.index, 1);
        assert.deepEqual(viewer.calls, ['reset', 'render']);
        viewer.action('next');
        assert.equal(state.index, 0);
        assert.deepEqual(viewer.calls, ['reset', 'render', 'reset', 'render']);
    } finally { viewer.restore(); }
});

test('桌面连续翻页加速落稳后衔接最新目标，取消会清理副本', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const previous = { window: globalThis.window, document: globalThis.document, getComputedStyle: globalThis.getComputedStyle, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
    t.after(() => { app.clearPageTurn(); Object.assign(globalThis, previous); });
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
    globalThis.getComputedStyle = () => ({ background: '#fff', padding: '42px 40px 36px' });
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
    assert.equal(copies.has(firstLeaf), true, '打断时保留当前卷曲纸面');
    assert.equal(rendered, '第一页', '先落稳旧纸页，再渲染新目标');
    assert.equal(animations.every(animation => animation.playbackRate === 920 / 160), true, '纸带与阴影同步加速');
    app.renderWithPageTurn(() => { rendered = '最新目标'; }, { direction: 'back' });
    t.mock.timers.tick(159);
    assert.equal(copies.has(firstLeaf), true);
    t.mock.timers.tick(1);
    assert.equal(rendered, '最新目标', '连点只渲染最后一次目标');
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
    const startingPage = [...copies].find(node => node.classList.values.has('book-turn-starting'));
    assert.ok(startingPage, '首次建层时使用平面旧页覆盖真实新页');
    assert.equal(startingPage.style.padding, '42px 40px 36px', '旧页内边距不受新路由样式影响');
    assert.equal(startingPage.scrollTop, 45, '准备帧保留旧页阅读位置');
    pendingFrames.shift()();
    assert.equal(copies.has(startingPage), true, '首次绘制完成前保留平面旧页');
    pendingFrames.shift()();
    assert.equal(copies.has(startingPage), false, '播放动画时交接给曲面纸带');
    app.clearPageTurn();
    app.renderWithPageTurn(() => { rendered = '取消前的准备帧'; });
    const cancelledStartingPage = [...copies].find(node => node.classList.values.has('book-turn-starting'));
    app.renderWithPageTurn(() => { rendered = '取消待开始的翻页'; }, { animate: false });
    assert.equal(copies.has(cancelledStartingPage), false, '取消首帧时清理平面旧页');
    pendingFrames.forEach(callback => callback());
    t.mock.timers.tick(2000);
    assert.equal(rendered, '取消待开始的翻页');
    assert.equal(spread.classList.values.size, 0);
    assert.equal(animations.every(animation => animation.cancelled), true);
    globalThis.requestAnimationFrame = callback => { callback(); return 1; };
    app.renderWithPageTurn(() => { rendered = '调整窗口前'; });
    app.renderWithPageTurn(() => { rendered = '窗口调整后的目标'; });
    app.clearPageTurn();
    assert.equal(rendered, '窗口调整后的目标', '尺寸变化清理动画时仍呈现最新路由');
    t.mock.timers.tick(2000);
    assert.equal(spread.classList.values.size, 0);
    assert.equal(leftPage.inert, false);
});

test('翻页复制前裁掉屏外记录，保持占位且不深拷贝屏外媒体', () => {
    const depths = [];
    const makeRow = (top, height) => ({
        style: {}, getBoundingClientRect: () => ({ top, bottom: top + height, height }),
        cloneNode(deep) { depths.push({ top, deep }); return { style: {}, deep }; }
    });
    const visible = makeRow(850, 120);
    const outside = makeRow(1100, 150);
    const source = {
        childNodes: [visible, outside],
        querySelectorAll: selector => selector === '.ledger-entry, .photo-sleeve-button' ? [visible, outside] : [],
        cloneNode: () => ({ children: [], appendChild(child) { this.children.push(child); } })
    };
    visible.parentNode = source;
    outside.parentNode = source;
    const copy = app.cloneTransitionContent(source, { top: 100, bottom: 900 });
    assert.equal(copy.children[0].deep, true, '跨越可视边界的记录仍需保留');
    assert.equal(copy.children[1].deep, false, '屏外媒体不得进入深拷贝');
    assert.equal(copy.children[1].style.height, '150px');
    assert.equal(copy.children[1].style.visibility, 'hidden');
    assert.deepEqual(outside.style, {}, '真实记录保持原样');
});

test('翻页附件网格只复制可见项，保留尺寸、位置和原始旋转', t => {
    const previous = globalThis.getComputedStyle;
    t.after(() => { globalThis.getComputedStyle = previous; });
    globalThis.getComputedStyle = () => ({ transform: 'rotate(0.9deg)' });
    const copyNode = () => ({ style: {}, children: [], appendChild(child) { this.children.push(child); } });
    const visible = { offsetWidth: 100, offsetHeight: 80, cloneNode: copyNode,
        getBoundingClientRect: () => ({ left: 25, top: 1100, bottom: 1180, width: 100, height: 80 }) };
    const outside = { offsetWidth: 100, offsetHeight: 80,
        cloneNode() { assert.fail('屏外附件不得复制'); },
        getBoundingClientRect: () => ({ left: 25, top: 1900, bottom: 1980, width: 100, height: 80 }) };
    const sleeve = { children: [visible, outside], clientLeft: 1, clientTop: 1, cloneNode: copyNode,
        getBoundingClientRect: () => ({ left: 10, top: 1000, width: 400, height: 5000 }) };
    const source = { childNodes: [sleeve], cloneNode: copyNode,
        querySelectorAll: selector => selector === '.photo-sleeve' ? [sleeve] : [] };
    sleeve.parentNode = source;
    const copy = app.cloneTransitionContent(source, { top: 1000, bottom: 1600 }).children[0];
    assert.equal(copy.style.height, '5000px');
    assert.equal(copy.style.width, '400px');
    assert.equal(copy.children.length, 1);
    assert.equal(copy.children[0].style.left, '14px');
    assert.equal(copy.children[0].style.top, '99px');
    assert.equal(copy.children[0].style.transform, 'rotate(0.9deg)');
});

test('翻页视频画面缩为静态图片，未解码和跨源失败保留占位', t => {
    const previous = { document: globalThis.document, window: globalThis.window };
    t.after(() => Object.assign(globalThis, previous));
    let fails = false;
    let canvas;
    globalThis.window = { devicePixelRatio: 3 };
    globalThis.document = { createElement: tag => {
        if (tag === 'img') return { style: {} };
        canvas = { getContext: () => ({ drawImage() { if (fails) throw new Error('跨源'); } }),
            toDataURL: type => { assert.equal(type, 'image/webp'); return 'data:image/webp;base64,snapshot'; } };
        return canvas;
    } };
    const video = { videoWidth: 3840, videoHeight: 2160,
        getBoundingClientRect: () => ({ width: 800, height: 600 }) };
    const image = app.createTransitionMediaImage(video);
    assert.equal(image.src, 'data:image/webp;base64,snapshot');
    assert.equal(image.style.visibility, '');
    assert.equal(canvas.width, 512);
    assert.equal(canvas.height, 384);
    fails = true;
    assert.equal(app.createTransitionMediaImage(video).style.visibility, 'hidden');
    assert.equal(app.createTransitionMediaImage({ ...video, videoWidth: 0 }).src, undefined);
});

test('视频缩略图只在进入视口后加载，换页解除旧观察', t => {
    const previous = { document: globalThis.document, window: globalThis.window,
        IntersectionObserver: globalThis.IntersectionObserver };
    t.after(() => Object.assign(globalThis, previous));
    const observers = [];
    globalThis.window = { IntersectionObserver: true };
    globalThis.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
        observe(target) { this.targets.add(target); }
        unobserve(target) { this.targets.delete(target); }
        disconnect() { this.targets.clear(); }
    };
    const video = { dataset: { src: 'movie.mp4#t=0.1' } };
    globalThis.document = { querySelectorAll: () => [video] };
    app.observePhotoSleeveVideos();
    const first = observers[0];
    first.callback([{ target: video, isIntersecting: false }]);
    assert.equal(video.src, undefined);
    first.callback([{ target: video, isIntersecting: true }]);
    assert.equal(video.src, 'movie.mp4#t=0.1');
    assert.equal(video.preload, 'metadata');
    assert.equal(first.targets.size, 0);
    assert.equal(video.dataset.src, undefined);
    first.observe(video);
    app.observePhotoSleeveVideos();
    assert.equal(first.targets.size, 0);
    delete globalThis.window.IntersectionObserver;
    const fallback = { dataset: { src: 'fallback.mp4' } };
    globalThis.document.querySelectorAll = () => [fallback];
    app.observePhotoSleeveVideos();
    assert.equal(fallback.src, 'fallback.mp4');
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
    assert.equal(animations.length, 7);
    assert.equal(animations[1].timing.direction, 'reverse');
    assert.deepEqual(animations[0].keyframes, animations[2].keyframes, '封皮与纸芯必须共用书脊位移');
    assert.deepEqual(animations[1].keyframes.map(frame => frame.transform),
        ['rotateY(0deg)', 'rotateY(-4deg)', 'rotateY(-178deg)', 'rotateY(-180deg)']);
    t.mock.timers.tick(1179);
    assert.equal(renders, 0);
    t.mock.timers.tick(1);
    assert.equal(renders, 1);
    assert.equal(closedBookCover.focused, true);
    assert.equal(closedBookCover.attributes.has('aria-hidden'), false);
    assert.equal([...nodes].some(node => node.className === 'book-transition-overlay'), false);

    app.renderWithBookCover(() => { renders += 1; }, 'closing');
    app.clearPageTurn();
    frames.shift()();
    t.mock.timers.tick(1200);
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
    spread.parentElement.getBoundingClientRect = leftPage.getBoundingClientRect;
    app.renderWithBookCover(() => { renders += 1; }, 'opening');
    assert.equal(renders, 4, '开书时立即在静态封面下绘制新页');
    const mobileOverlay = [...nodes].find(node => node.className === 'book-transition-overlay');
    assert.ok(mobileOverlay);
    assert.equal([...nodes].findLast(node => node.className === 'book-transition-scene').style.width, '342px');
    frames.shift()(performance.now() + 1000);
    const mobileScaleY = Number(animations.at(-7).keyframes[0].transform.match(/scale\([^,]+, ([^)]+)\)/)[1]);
    assert.ok(mobileScaleY > .5 && mobileScaleY < 2, '连续滚动的手机书页不能把封皮拉伸到整页高度');
    assert.equal(animations.at(-7).timing.duration, 1040, '手机开书应以稍慢于原版的节奏完成');
    assert.deepEqual(animations.at(-6).keyframes.map(frame => frame.transform),
        ['rotateY(0deg)', 'rotateY(-3deg)', 'rotateY(-164deg)', 'rotateY(-179deg)', 'rotateY(-180deg)']);
    assert.deepEqual(animations.at(-1).keyframes.map(frame => frame.opacity),
        [1, .94, .18, 0], '封面背景应贯穿整段动画渐变，不能在末尾突然跳换');
    const mobileBackdrop = [...nodes].find(node => node.className === 'book-transition-backdrop');
    assert.equal(mobileBackdrop.style.background, '#eee', '手机动画应复用封面画布背景');
    t.mock.timers.tick(1039);
    assert.equal([...nodes].some(node => node.className === 'book-transition-overlay'), true);
    t.mock.timers.tick(1);
    assert.equal(shell.focused, true);
    assert.equal([...nodes].some(node => node.className === 'book-transition-overlay'), false);

    app.renderWithBookCover(() => { renders += 1; }, 'closing');
    assert.equal([...nodes].findLast(node => node.className === 'book-transition-scene').style.width, '342px');
    frames.shift()();
    assert.equal(animations.at(-7).timing.duration, 920, '手机合书速度应保持利落');
    t.mock.timers.tick(920);
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

test('手机柔性纸页始终固定左侧装订边，分段曲面连续并能反向展开', () => {
    for (const width of [360, 640, 760]) {
        const frames = app.createMobilePageCurlFrames(width);
        for (let frame = 0; frame <= 48; frame += 1) {
            assert.deepEqual(frames[0][frame].first, { x: 0, z: 0 }, '左侧装订边不得位移');
            for (let index = 0; index < frames.length - 1; index += 1) {
                assert.deepEqual(frames[index][frame].last, frames[index + 1][frame].first, '相邻纸面必须共享边界');
            }
        }
        assert.ok(Math.abs(frames.at(-1)[0].last.x - width) < 1e-8);
        assert.ok(Math.abs(frames.at(-1).at(-1).last.x + width) < 1e-8);
        assert.ok(Math.abs(frames.at(-1).at(-1).last.z) < 1e-8);
        assert.notEqual(frames[0][24].transform.split(',')[0], frames.at(-1)[24].transform.split(',')[0], '纸面各段倾角不同，避免整张刚性旋转');
        const angle = segment => Math.atan2((segment.last.z - segment.first.z), (segment.last.x - segment.first.x));
        const bend = angle(frames.at(-1)[24]) - angle(frames[0][24]);
        assert.ok(bend > 1.05 && bend < 1.2, '纸面弯曲稍微加深，保持连续舒展');
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

test('合书后重开保留筛选、详情与附件位置，且不覆盖详情返回目录的位置', t => {
    const previous = { document: globalThis.document, window: globalThis.window };
    globalThis.window = { scrollY: 0, matchMedia: () => ({ matches: false }),
        scrollTo(options, y) { this.scrollY = typeof options === 'object' ? options.top : y; } };
    globalThis.document = { body: { dataset: {}, scrollTop: 0 }, documentElement: { scrollTop: 0 } };
    const scenario = app.stubBookReadingRoutes();
    t.after(() => { scenario.restore(); Object.assign(globalThis, previous); });
    scenario.render('#cover');
    assert.equal(scenario.open(), '#preface', '首次翻开仍进入扉页');
    const ledger = '#ledger?q=旅行&sort=asc';
    scenario.render(ledger);
    scenario.position(180, 320, 0);
    scenario.rememberBackground();
    for (const hash of [ledger, '#entry?id=a', '#photos?id=a']) {
        scenario.render(hash);
        scenario.position(240, 560, 720);
        scenario.render('#cover');
        scenario.position(0, 0, 0);
        assert.equal(scenario.open(), app.serializeRoute(app.parseRoute(hash)));
        scenario.render(scenario.open());
        assert.deepEqual(scenario.getPosition(), [240, 560, 720]);
    }
    scenario.render(ledger);
    assert.deepEqual(scenario.getPosition(), [180, 320, 0], '返回目录仍恢复进入详情前的位置');
    scenario.render('#cover');
    scenario.position(0, 0, 0);
    scenario.render('#ledger?q=other');
    assert.deepEqual(scenario.getPosition(), [0, 0, 0], '打开其他页面不套用合书位置');
});

test('合并连续导航时以实际显示的页面计算翻页方向', t => {
    const previous = { document: globalThis.document, window: globalThis.window };
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    globalThis.document = { body: { dataset: {} } };
    const scenario = app.stubReadingRoutes();
    t.after(() => { scenario.restore(); Object.assign(globalThis, previous); });
    scenario.render(app.parseRoute('#ledger'), { initial: true });
    scenario.defer();
    scenario.render(app.parseRoute('#photos?id=b'));
    scenario.render(app.parseRoute('#entry?id=b'));
    assert.deepEqual(scenario.turns.slice(-2).map(turn => turn.direction), ['forward', 'forward']);
    scenario.finish();
    assert.equal(scenario.calls.at(-1), 'entry:b', '只渲染合并后的目标');
});

test('手机翻页保留当前曲面加速落稳，过期回调不清理新动画，取消与完成恢复交互', async t => {
    const previous = { window: globalThis.window, document: globalThis.document, getComputedStyle: globalThis.getComputedStyle, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
    t.after(() => { app.clearPageTurn(); Object.assign(globalThis, previous); });
    const nodes = new Set();
    const animations = [];
    const createNode = () => ({
        inert: false,
        style: {},
        classList: { add() {}, remove() {}, contains() { return false; } },
        setAttribute() {}, removeAttribute() {}, querySelectorAll() { return []; },
        getBoundingClientRect() { return { left: 0, top: -120, width: 390, height: 4000 }; },
        cloneNode: createNode,
        append(...children) { children.forEach(child => nodes.add(child)); },
        remove() { nodes.delete(this); },
        animate(keyframes, timing) {
            let finish;
            const finished = new Promise(resolve => { finish = resolve; });
            const animation = { finished, finish, keyframes, timing, pause() {}, play() {}, cancel() { this.cancelled = true; } };
            animations.push(animation);
            return animation;
        }
    });
    globalThis.document = { createElement: createNode, body: createNode() };
    globalThis.window = { matchMedia: query => ({ matches: !query.includes('reduced-motion') }) };
    globalThis.getComputedStyle = () => ({ background: '#fff' });
    globalThis.requestAnimationFrame = callback => { callback(); return 1; };
    globalThis.cancelAnimationFrame = () => {};
    const spread = createNode();
    app.setTestState({ shell: createNode(), spread, leftPage: createNode(), rightPage: createNode() });
    let rendered;
    app.renderWithPageTurn(() => { rendered = '第一页'; });
    const first = animations[0];
    assert.equal(first.timing.direction, 'normal');
    assert.equal(first.timing.duration, 760);
    assert.equal([...nodes].findLast(node => node.className === 'mobile-page-leaf').style.transformOrigin, 'left center');
    const secondStart = animations.length;
    assert.equal(spread.inert, true);
    first.currentTime = 380;
    app.renderWithPageTurn(() => { rendered = '第二页'; }, { direction: 'back' });
    assert.equal(rendered, '第一页');
    assert.equal(animations.length, secondStart, '落稳前不创建另一组纸带');
    assert.equal(animations.every(animation => animation.playbackRate === 380 / 160), true);
    app.renderWithPageTurn(() => { rendered = '最新页'; }, { direction: 'back' });
    assert.equal(first.playbackRate, 380 / 160, '重复打断不重置落页时间');
    first.finish();
    await Promise.resolve();
    const second = animations[secondStart];
    assert.equal(second.timing.direction, 'reverse');
    assert.deepEqual(second.keyframes, first.keyframes, '返回反放相同左侧曲面');
    assert.equal([...nodes].findLast(node => node.className === 'mobile-page-leaf').style.transformOrigin, 'left center');
    assert.equal([...nodes].find(node => node.className === 'mobile-page-transition').style.top, '0px');
    first.finish();
    await Promise.resolve();
    assert.equal(rendered, '最新页');
    assert.equal(first.cancelled, true);
    assert.equal(second.cancelled, undefined);
    assert.equal([...nodes].filter(node => node.className === 'mobile-page-transition').length, 1);
    second.finish();
    await Promise.resolve();
    assert.equal(second.cancelled, true);
    assert.equal([...nodes].filter(node => node.className === 'mobile-page-transition').length, 0);
    assert.equal(spread.inert, false);
    const pendingFrames = [];
    globalThis.requestAnimationFrame = callback => { pendingFrames.push(callback); return 2; };
    app.renderWithPageTurn(() => { rendered = '等待首帧'; });
    app.renderWithPageTurn(() => { rendered = '取消翻页'; }, { animate: false });
    pendingFrames.forEach(callback => callback());
    assert.equal(rendered, '取消翻页');
    assert.equal(spread.inert, false);
    assert.equal([...nodes].filter(node => node.className === 'mobile-page-transition').length, 0);
    globalThis.window.matchMedia = () => ({ matches: true });
    const animationCount = animations.length;
    app.renderWithPageTurn(() => { rendered = '减少动态效果'; });
    assert.equal(rendered, '减少动态效果');
    assert.equal(animations.length, animationCount);
    globalThis.window.matchMedia = query => ({ matches: !query.includes('reduced-motion') });
    globalThis.requestAnimationFrame = callback => { callback(); return 1; };
    app.renderWithPageTurn(() => { rendered = '取消前'; });
    const cancelledTurn = animations[animationCount];
    app.renderWithPageTurn(() => { rendered = '不应出现的旧请求'; });
    app.renderWithPageTurn(() => { rendered = '直接切换'; }, { animate: false });
    cancelledTurn.finish();
    await Promise.resolve();
    assert.equal(rendered, '直接切换', '显式取消丢弃排队目标，过期完成回调不重放');
    assert.equal(spread.inert, false);
    assert.equal([...nodes].filter(node => node.className === 'mobile-page-transition').length, 0);
});
