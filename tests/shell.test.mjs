import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const appJs = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const serverJs = await readFile(new URL('../js/server.js', import.meta.url), 'utf8');
const journalCss = await readFile(new URL('../css/journal.css', import.meta.url), 'utf8');
const baseCss = await readFile(new URL('../css/base.css', import.meta.url), 'utf8');

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
    assert.match(appJs, /重置全部/);
    assert.doesNotMatch(appJs, /当前筛选|当前排序|切到最早优先|切回最新优先/);
});

test('旅行概览渲染新增的可靠统计', () => {
    for (const label of ['复访率', '活跃年份', '活跃月份', '最长记录间隔']) {
        assert.match(appJs, new RegExp(label));
    }
    assert.match(appJs, /overviewAnalytics: deriveOverviewAnalytics\(enhanced\)/);
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
    assert.match(baseCss, /--font-display:\s*"Diary Kai";/);
    assert.match(baseCss, /--font-sans:\s*"Diary Kai";/);
    assert.match(baseCss, /--font-code:\s*"Archive Code";/);
    const cssFonts = `${journalCss}\n${baseCss}`;
    assert.doesNotMatch(cssFonts, /STKaiti|KaiTi|Courier New|Roboto|Google Sans|Segoe UI|Arial|JetBrains Mono|ui-monospace|SFMono-Regular|Menlo|Consolas/);
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

test('地点详情页关闭按钮固定在右页滚动容器右上角', () => {
    assert.doesNotMatch(appJs, /<div class="place-page">\s*<a class="location-back location-close"/);
    assert.match(appJs, /class="location-back location-close route-location-close"/);
    assert.match(appJs, /aria-label="关闭地点详情"/);
    assert.doesNotMatch(appJs, /routeActionRoot|renderRouteActions|refs\.routeAction/);
    assert.match(appJs, /<div class="place-detail-actions"/);
    assert.match(appJs, /'dossier-page place-detail-page'/);
    assert.match(journalCss, /\.place-detail-actions\s*{[^}]*position: sticky;[^}]*top: 0;[^}]*justify-content: flex-end;/);
    assert.match(journalCss, /\.place-detail-actions \.location-close\s*{[^}]*position: relative;[^}]*margin: 0;/);
    assert.match(journalCss, /\.location-close::before[\s\S]*?rotate\(45deg\)/);
    assert.match(journalCss, /\.location-close::after[\s\S]*?rotate\(-45deg\)/);
});
