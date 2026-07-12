import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const appJs = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const serverJs = await readFile(new URL('../js/server.js', import.meta.url), 'utf8');
const journalEntryCss = await readFile(new URL('../css/journal.css', import.meta.url), 'utf8');
const cssPartFiles = [
    '01-foundation.css',
    '02-shell.css',
    '03-cover-route.css',
    '04-ledger.css',
    '05-archive-place.css',
    '06-entry-sheet.css',
    '07-responsive.css'
];
const cssPartContents = [];

for (const file of cssPartFiles) {
    try {
        cssPartContents.push(await readFile(new URL(`../css/${file}`, import.meta.url), 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
}

const journalCss = cssPartContents.length > 0 ? `${journalEntryCss}\n${cssPartContents.join('\n')}` : journalEntryCss;

test('主样式入口拆分为按职责导入的 CSS 文件', () => {
    for (const file of cssPartFiles) {
        assert.match(journalEntryCss, new RegExp(`@import url\\('\\./${file}'\\);`));
    }

    assert.doesNotMatch(journalEntryCss, /@font-face|:root|\\.journal-shell|\\.cover-page|\\.index-dashboard|@media/);
});

test('应用外壳不再包含路线筛选抽屉', () => {
    assert.doesNotMatch(indexHtml, /drawerToggle|drawerRoot|journal-drawer|打开筛选面板/);
    assert.doesNotMatch(appJs, /renderDrawer|openDrawer|closeDrawer|toggleDrawer|keepDrawer|lastDrawerTrigger/);
});

test('路线页不存在重复筛选入口', () => {
    assert.doesNotMatch(appJs, /data-action="open-drawer"|筛选与排序|打开筛选面板/);
});

test('索引夹层包含完整且唯一的高级筛选工作台', () => {
    assert.match(appJs, /function renderLedgerFilterWorkbench/);
    for (const key of ['year', 'month', 'province', 'city', 'sort']) {
        assert.match(appJs, new RegExp(`renderLedgerSelect\\([^;]+['"]${key}['"]`));
    }
    assert.match(appJs, /filterToggleButton\('首次到访', 'visit'/);
    assert.match(appJs, /filterToggleButton\('有照片', 'media'/);
    assert.match(appJs, /filterToggleButton\('有笔记', 'note'/);
    assert.match(appJs, /重置全部/);
    assert.doesNotMatch(appJs, /当前筛选|当前排序|切到最早优先|切回最新优先/);
});

test('索引夹层重置筛选固定在筛选项之前', () => {
    assert.match(appJs, /renderLedgerSnapshot\(snapshot, resultLabel\)\}\s+\$\{renderLedgerResetAction\(ledgerParams\)\}\s+\$\{renderLedgerFilterWorkbench\(ledgerParams\)\}/);
    assert.match(journalCss, /\.index-reset-anchor\s*{[^}]*position: sticky;[^}]*top: 0;/);
    assert.match(journalCss, /\.index-reset-anchor\s*{[^}]*background: transparent;/);
    assert.doesNotMatch(journalCss, /\.index-reset-anchor\s*{[^}]*linear-gradient/);
});

test('索引夹层筛选更新时保留右页滚动位置', () => {
    assert.match(appJs, /updateLedgerRoute\(\{ \[key\]: value \}, \{[\s\S]*preserveRightScroll: true,[\s\S]*keepContextPanelOpen: isMobileContextPanelOpen/);
    assert.match(appJs, /updateLedgerRoute\(nextParams, \{[\s\S]*focusId: filter\.id \|\| '',[\s\S]*preserveRightScroll: true,[\s\S]*keepContextPanelOpen: isMobileContextPanelOpen/);
    assert.match(appJs, /function setPages\(leftHtml, rightHtml, rightPageMode = '', options = \{\}\)/);
    assert.match(appJs, /const rightScrollTop = options\.preserveRightScroll \? refs\.rightPage\.scrollTop : 0;/);
    assert.match(appJs, /refs\.rightPage\.scrollTop = rightScrollTop;/);
});

test('索引夹层总数只保留一个视觉锚点', () => {
    assert.match(appJs, /return '全部旅行记录';/);
    assert.match(appJs, /筛选结果 · 全部 \$\{total\} 条/);
    assert.match(appJs, /class="index-dashboard-value"/);
    assert.match(appJs, /class="index-dashboard-unit"/);
    assert.match(journalCss, /\.index-dashboard-main > span,/);
    assert.doesNotMatch(journalCss, /\.index-dashboard-main span,/);
    assert.doesNotMatch(appJs, /共 \$\{total\} 条旅行记录/);
});

test('索引夹层分段按钮具备拟物化层次', () => {
    assert.match(journalCss, /\.index-segment::before/);
    assert.match(journalCss, /\.index-segment::after/);
    assert.match(journalCss, /\.index-segment-active::before/);
    assert.match(journalCss, /\.index-segment:active/);
    assert.match(journalCss, /inset 0 1px 0 rgba\(255, 255, 255/);
    assert.match(journalCss, /0 7px 0 rgba\(121, 84, 43/);
});

test('记录卡片回形针具备前后遮挡关系', () => {
    assert.match(appJs, /class="record-paperclip record-paperclip-back" aria-hidden="true"/);
    assert.match(appJs, /class="record-paperclip record-paperclip-front" aria-hidden="true"/);
    assert.match(journalCss, /\.cover-record,\s*\.ledger-entry\s*{[\s\S]*--clip-svg: url\("data:image\/svg\+xml,[\s\S]*%3Cpath/);
    assert.match(journalCss, /\.record-paperclip\s*{[\s\S]*background: var\(--clip-svg\) center \/ contain no-repeat;[\s\S]*filter: drop-shadow/);
    assert.match(journalCss, /\.record-paperclip-back\s*{[\s\S]*z-index: 1;[\s\S]*clip-path: inset\(50% 0 0 0\);/);
    assert.match(journalCss, /\.record-paperclip-front\s*{[\s\S]*z-index: 4;[\s\S]*clip-path: inset\(0 0 48% 0\);/);
    assert.match(journalCss, /\.cover-record-thumb,\s*\.entry-date-chip\s*{[\s\S]*z-index: 2;/);
    assert.doesNotMatch(journalCss, /linear-gradient\(var\(--clip-metal\), var\(--clip-metal\)\)/);
    assert.match(journalCss, /\.cover-record:hover \.record-paperclip,[\s\S]*\.ledger-entry:focus-visible \.record-paperclip/);
    assert.doesNotMatch(journalCss, /\.place-records \.ledger-entry::before\s*{[\s\S]*top:/);
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.record-paperclip\s*{[\s\S]*width: 21px;[\s\S]*height: 38px;/);
});

test('移动端首页回形针为标题区域预留安全留白', () => {
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.cover-record\s*{[\s\S]*padding: 14px 44px 14px 50px;/);
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.cover-record \.record-paperclip\s*{[\s\S]*left: 13px;/);
});

test('随机路线图按视口尺寸限制票据数量', () => {
    assert.match(appJs, /const ROUTE_MAP_RESPONSIVE_LIMITS = \[[\s\S]*maxWidth: 420,\s*count: 3[\s\S]*maxWidth: 760,\s*count: 4/);
    assert.match(appJs, /function getRouteMapSlotLimit\(\)/);
    assert.match(appJs, /const slotLimit = Math\.min\(getRouteMapSlotLimit\(\), uniqueRecords\.length\);/);
});

test('旅行概览渲染新增的可靠统计', () => {
    for (const label of ['复访地点', '覆盖最广', '活跃年份', '活跃月份', '最长记录间隔']) {
        assert.match(appJs, new RegExp(label));
    }
    assert.doesNotMatch(appJs, /复访率|repeatRate/);
    assert.match(appJs, /activeMonthCount\}\s*\/\s*\$\{travelModel\.overviewAnalytics\.activeMonthCapacity\}/);
    assert.match(appJs, /renderRepeatLocationInsights\(travelModel\.repeatLocations\)/);
    assert.match(appJs, /renderBroadProvinceInsight\(broadestProvince\)/);
    assert.match(appJs, /function getBroadestProvince/);
    assert.doesNotMatch(appJs, /items\.slice\(0,\s*3\)/);
    assert.match(appJs, /overview-insight-list overview-location-list/);
    assert.match(appJs, /overview-insight overview-location-feature/);
    assert.match(appJs, /overview-insight overview-location-secondary/);
    assert.match(appJs, /overview-insight overview-repeat-location/);
    assert.match(journalCss, /\.overview-location-list\s*{/);
    assert.match(journalCss, /\.overview-location-feature\s*{/);
    assert.match(journalCss, /\.overview-location-secondary\s*{/);
    assert.match(journalCss, /\.overview-repeat-location\s*{/);
    assert.match(appJs, /overviewAnalytics: deriveOverviewAnalytics\(enhanced,\s*todayDate\)/);
    assert.match(appJs, /const todayDate = getTodayDate\(\);[\s\S]+const dateRangeLabel = formatDateRange\(firstDate, todayDate, 'day'\);/);
});

test('本地服务器以 JavaScript MIME 类型提供 mjs 模块', () => {
    assert.match(serverJs, /case '\.mjs':\s*case '\.js':\s*return 'text\/javascript; charset=utf-8'/);
});

test('切换纸页内容时重置左右页滚动位置', () => {
    assert.match(appJs, /function setPages[\s\S]+refs\.leftPage\.scrollTop = 0;[\s\S]+refs\.rightPage\.scrollTop = 0;/);
});

test('窄屏将索引夹层和旅行概览放入弹出层', () => {
    assert.match(appJs, /data-action="open-context-panel"/);
    assert.match(appJs, /data-action="close-context-panel"/);
    assert.match(appJs, /'map-pocket context-panel'/);
    assert.match(appJs, /'dossier-page context-panel'/);
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.paper-page-right\.context-panel\s*{[\s\S]*position: fixed;[\s\S]*display: none;/);
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.journal-shell\.mobile-context-panel-open \.paper-page-right\.context-panel\s*{[\s\S]*display: grid;/);
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.journal-shell\.mobile-context-panel-open::before/);
    assert.doesNotMatch(journalCss, /data-route="ledger"[^}]+map-pocket[^}]+order: -1/);
    assert.doesNotMatch(journalCss, /data-route="archive"[^}]+dossier-page[^}]+order: -1/);
});

test('关闭移动端夹层前先把焦点移出即将隐藏的右页', () => {
    assert.match(appJs, /function closeMobileContextPanel\(\)\s*{[\s\S]*restoreFocusBeforeHidingContextPanel\(\);[\s\S]*syncMobileContextPanelState\(\);/);
    assert.match(appJs, /function restoreFocusBeforeHidingContextPanel\(\)/);
    assert.match(appJs, /refs\.rightPage\.contains\(document\.activeElement\)/);
    assert.match(appJs, /refs\.rightPage\.toggleAttribute\('inert', !isOpen\);/);
});

test('移动端夹层自身保留纵向触摸滚动能力', () => {
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.paper-page-right\.context-panel\s*{[\s\S]*height: calc\(100dvh - var\(--context-panel-inset-top\) - var\(--context-panel-inset-bottom\)\);[\s\S]*max-height: calc\(100dvh - var\(--context-panel-inset-top\) - var\(--context-panel-inset-bottom\)\);[\s\S]*min-height: 0;[\s\S]*overflow-y: auto;[\s\S]*-webkit-overflow-scrolling: touch;[\s\S]*touch-action: pan-y;/);
});

test('移动端夹层打开时锁定页面滚动且不被翻页透视捕获', () => {
    assert.match(appJs, /document\.documentElement\.classList\.toggle\('mobile-context-panel-open', isOpen\);/);
    assert.match(appJs, /function lockMobileContextPageScroll\(\)/);
    assert.match(appJs, /function unlockMobileContextPageScroll\(\)/);
    assert.match(appJs, /document\.body\.style\.position = 'fixed';/);
    assert.match(appJs, /window\.scrollTo\(0, mobileContextScrollY\);/);
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*html\.mobile-context-panel-open,\s*body\.mobile-context-panel-open\s*{[\s\S]*overflow: hidden;/);
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.journal-shell\.mobile-context-panel-open \.page-spread\s*{[\s\S]*perspective: none;/);
});

test('移动端夹层滚动条轨道可以贴到底部', () => {
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.paper-page-right\.context-panel::-webkit-scrollbar-track\s*{[\s\S]*margin: 0;/);
});

test('移动端夹层遮罩不使用全屏模糊', () => {
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.journal-shell\.mobile-context-panel-open::before\s*{[\s\S]*content: none;[\s\S]*display: none;/);
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.journal-shell\.mobile-context-panel-open::before\s*{[\s\S]*pointer-events: none;/);
    assert.doesNotMatch(journalCss, /\.journal-shell\.mobile-context-panel-open::before\s*{[\s\S]*backdrop-filter/);
    assert.doesNotMatch(journalCss, /\.journal-shell\.mobile-context-panel-open::before\s*{[\s\S]*pointer-events: auto;/);
});

test('旅行档案仅使用项目本地字体族', () => {
    assert.match(journalCss, /--font-serif:\s*"Diary Kai";/);
    assert.match(journalCss, /--font-code:\s*"Archive Code";/);
    assert.doesNotMatch(journalCss, /STKaiti|KaiTi|Courier New|Roboto|Google Sans|Segoe UI|Arial|JetBrains Mono|ui-monospace|SFMono-Regular|Menlo|Consolas/);
});

test('头部方块控件在书脊栏中显式垂直居中', () => {
    for (const selector of ['brand-lockup', 'chapter-tabs', 'spine-tools']) {
        assert.match(journalCss, new RegExp(`\\.${selector}\\s*{[\\s\\S]*?align-self: center;`));
    }
    assert.match(journalCss, /\.brand-lockup\s*{[^}]*height: 76px;/);
    assert.match(journalCss, /\.brand-lockup > span\s*{[^}]*display: grid;[^}]*place-items: center;/);
    assert.match(journalCss, /\.brand-lockup > span\s*{[^}]*height: 100%;/);
    assert.match(journalCss, /--brand-rivet-y:\s*12px;/);
    assert.doesNotMatch(journalCss, /circle at calc\(50% [-+] 1px\) 7px|circle at calc\(50% [-+] 1px\) 9px/);
    assert.doesNotMatch(journalCss, /\\.chapter-tab-active\\s*{[\\s\\S]*?transform: translateY\\(1px\\);/);
});

test('地点详情页仅保留左页返回按钮', () => {
    assert.doesNotMatch(appJs, /<div class="place-page">\s*<a class="location-back location-close"/);
    assert.match(appJs, /<a class="ribbon-back" href="#archive">返回档案夹<\/a>/);
    assert.doesNotMatch(appJs, /class="location-back location-close route-location-close"/);
    assert.doesNotMatch(appJs, /aria-label="关闭地点详情"/);
    assert.doesNotMatch(appJs, /routeActionRoot|renderRouteActions|refs\.routeAction/);
    assert.doesNotMatch(appJs, /<div class="place-detail-actions"/);
    assert.match(appJs, /'dossier-page place-detail-page'/);
    assert.doesNotMatch(journalCss, /\.place-detail-actions/);
    assert.doesNotMatch(journalCss, /\.location-close/);
});

test('日记照片支持沉浸式查看与基础变换操作', () => {
    assert.match(appJs, /function openPhotoViewer/);
    assert.match(appJs, /function renderPhotoViewer/);
    assert.match(appJs, /data-action="open-photo-viewer"/);
    assert.match(appJs, /data-action="photo-zoom-in"/);
    assert.match(appJs, /data-action="photo-zoom-out"/);
    assert.match(appJs, /data-action="photo-rotate-left"/);
    assert.match(appJs, /data-action="photo-rotate-right"/);
    assert.match(appJs, /data-photo-viewer-image/);
    assert.match(appJs, /handlePhotoPointerDown/);
    assert.match(appJs, /handlePhotoPointerMove/);
    assert.match(appJs, /handlePhotoWheel/);
    assert.match(journalCss, /\.photo-sleeve-button\s*{/);
    assert.match(journalCss, /\.photo-viewer\s*{/);
    assert.match(journalCss, /\.photo-viewer-image\s*{/);
});

test('移动端照片缩略图保持双列且旋转角度连续递增', () => {
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.photo-sleeve\s*{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    assert.doesNotMatch(journalCss, /@media \(max-width: 760px\)[\s\S]*\.photo-sleeve\s*{[\s\S]*grid-template-columns: 1fr;/);
    assert.match(journalCss, /\.photo-viewer-image-rotating\s*{[\s\S]*transition: transform 0\.22s/);
    assert.match(appJs, /const PHOTO_ROTATION_ANIMATION_MS = 220;/);
    assert.match(appJs, /photoViewerState\.rotation \+= delta;/);
    assert.doesNotMatch(appJs, /photoViewerState\.rotation = normalizeRotation\(photoViewerState\.rotation \+ delta\);/);
});

test('照片查看器工具栏按功能分组且原图以自然尺寸显示', () => {
    for (const group of ['photo-viewer-nav-group', 'photo-viewer-zoom-group', 'photo-viewer-rotate-group']) {
        assert.match(appJs, new RegExp(`class="${group} photo-viewer-control-group"`));
    }
    assert.match(appJs, /<\/div>\s*<button class="photo-viewer-control photo-viewer-close" type="button" data-action="close-photo-viewer"/);
    assert.match(journalCss, /\.photo-viewer-toolbar\s*{[\s\S]*display: grid;/);
    assert.match(journalCss, /\.photo-viewer-toolbar\s*{[\s\S]*grid-template-columns: repeat\(3, max-content\);/);
    assert.match(journalCss, /\.photo-viewer-control-group\s*{[\s\S]*display: inline-flex;/);
    assert.match(journalCss, /\.photo-viewer-close\s*{[\s\S]*position: absolute;[\s\S]*top: 8px;[\s\S]*right: 8px;[\s\S]*width: 38px;[\s\S]*height: 36px;/);
    assert.doesNotMatch(appJs, /photo-viewer-separator/);
    assert.match(journalCss, /\.photo-viewer-image\s*{[\s\S]*width: auto;[\s\S]*height: auto;[\s\S]*max-width: none;[\s\S]*max-height: none;/);
    assert.doesNotMatch(journalCss, /\.photo-viewer-image\s*{[\s\S]*max-width: min/);
});

test('移动端照片查看器充分利用上下空间', () => {
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.photo-viewer\s*{[\s\S]*padding: 8px;/);
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.photo-viewer-panel\s*{[\s\S]*height: 100%;[\s\S]*max-height: calc\(100dvh - 16px\);/);
    assert.doesNotMatch(journalCss, /@media \(max-width: 760px\)[\s\S]*\.photo-viewer-panel\s*{[\s\S]*height: min\(720px, 100%\);/);
});

test('移动端照片查看器工具栏可换行且关闭按钮不继承横向内边距', () => {
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.photo-viewer-toolbar\s*{[\s\S]*display: flex;[\s\S]*flex-wrap: wrap;[\s\S]*overflow-x: visible;/);
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.photo-viewer-toolbar\s*{[\s\S]*padding: 8px 48px 8px 8px;/);
    assert.doesNotMatch(journalCss, /@media \(max-width: 760px\)[\s\S]*\.photo-viewer-toolbar\s*{[\s\S]*grid-template-columns: repeat\(3, max-content\);/);
    assert.match(journalCss, /@media \(max-width: 760px\)[\s\S]*\.photo-viewer-close\s*{[\s\S]*top: 8px;[\s\S]*right: 8px;[\s\S]*height: 36px;[\s\S]*padding: 0;/);
});

test('照片初始居中适配舞台且平移不会完全移出屏幕', () => {
    assert.match(appJs, /function fitPhotoToStage/);
    assert.match(appJs, /function getInitialPhotoScale/);
    assert.match(appJs, /function getMinimumPhotoScale/);
    assert.match(appJs, /function getMaximumPhotoScale/);
    assert.match(appJs, /function constrainPhotoViewerTransform\(\)/);
    assert.match(appJs, /function getPhotoViewerBounds\(\)/);
    assert.match(appJs, /const PHOTO_VIEWER_MIN_VISIBLE_EDGE = 48;/);
    assert.match(appJs, /image\.addEventListener\('load', fitPhotoToStage, \{ once: true \}\)/);
    assert.match(appJs, /Math\.min\(1, stageRect\.width \/ image\.naturalWidth, stageRect\.height \/ image\.naturalHeight\)/);
    assert.match(appJs, /photoViewerState\.scale = getInitialPhotoScale\(stage, image\);/);
    assert.match(appJs, /photoViewerState\.initialScale = photoViewerState\.scale;/);
    assert.match(appJs, /return Math\.min\(PHOTO_VIEWER_MIN_SCALE_BASE, photoViewerState\.initialScale \* PHOTO_VIEWER_MIN_SCALE_RATIO\);/);
    assert.match(appJs, /return Math\.max\(PHOTO_VIEWER_MAX_SCALE_BASE, photoViewerState\.initialScale \* PHOTO_VIEWER_MAX_SCALE_RATIO\);/);
    assert.doesNotMatch(appJs, /const PHOTO_VIEWER_MIN_SCALE = 0\.5;/);
    assert.doesNotMatch(appJs, /const PHOTO_VIEWER_MAX_SCALE = 5;/);
    assert.match(appJs, /clamp\(previousScale \* factor, getMinimumPhotoScale\(\), getMaximumPhotoScale\(\)\)/);
    assert.match(appJs, /clamp\(start\.scale \* \(current\.distance \/ Math\.max\(start\.distance, 1\)\), getMinimumPhotoScale\(\), getMaximumPhotoScale\(\)\)/);
    assert.match(appJs, /constrainPhotoViewerTransform\(\);[\s\S]*frame\.style\.transform/);
    assert.match(appJs, /photoViewerState\.translateX = 0;[\s\S]*photoViewerState\.translateY = 0;/);
    assert.doesNotMatch(appJs, /photoViewerState\.rotation = start\.rotation \+ current\.angle - start\.angle;/);
    assert.doesNotMatch(appJs, /pinchStart = \{[\s\S]*rotation: photoViewerState\.rotation/);
});
