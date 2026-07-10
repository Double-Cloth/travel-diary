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
    assert.match(appJs, /updateLedgerRoute\(\{ \[key\]: value \}, \{ replace: true, animate: false, preserveRightScroll: true \}\)/);
    assert.match(appJs, /updateLedgerRoute\(nextParams, \{ replace: true, focusId: filter\.id \|\| '', animate: false, preserveRightScroll: true \}\)/);
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

test('窄屏优先显示筛选工作台和旅行概览', () => {
    assert.match(journalCss, /data-route="ledger"[^}]+map-pocket[^}]+order: -1/);
    assert.match(journalCss, /data-route="archive"[^}]+dossier-page[^}]+order: -1/);
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
