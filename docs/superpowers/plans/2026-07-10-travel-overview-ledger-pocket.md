# 旅行概览与索引夹层优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除独立路线筛选抽屉，将索引夹层重构为即时生效的唯一高级筛选中心，并为旅行概览增加可靠的数据洞察。

**Architecture:** 保留现有原生 JavaScript hash 路由和双纸页渲染方式。把与 DOM 无关的统计计算提取到 `js/analytics.mjs` 并用 Node 内置测试覆盖；`js/app.js` 继续负责路由和页面组合，`css/journal.css` 负责既有皮革纸张体系内的布局。

**Tech Stack:** HTML5、CSS3、原生 JavaScript ES Modules、Node.js 内置 `node:test`、现有静态开发服务器。

## Global Constraints

- 不引入新依赖、框架或构建步骤。
- 索引夹层是高级筛选与排序的唯一入口，筛选条件改变后立即更新。
- 不覆盖工作区中已有的 `js/app.js` 与 `css/journal.css` 未提交优化，只做增量修改。
- 不展示无法由现有数据可靠推导的距离、费用或旅行天数。
- 保持现有中文文案、皮革档案视觉体系、hash 路由与无障碍交互模式。

---

## 文件结构

- Create: `js/analytics.mjs` — 纯数据统计函数。
- Create: `tests/analytics.test.mjs` — 统计口径与边界测试。
- Create: `tests/shell.test.mjs` — 单一筛选入口的静态契约测试。
- Modify: `package.json` — 增加 Node 内置测试脚本。
- Modify: `index.html` — 删除顶部筛选按钮和抽屉容器。
- Modify: `js/app.js` — 接入统计、渲染筛选工作台、删除抽屉逻辑、扩展概览。
- Modify: `css/journal.css` — 删除抽屉样式，增加工作台、洞察和窄屏样式。

### Task 1: 建立可测试的统计模块

**Files:**
- Create: `js/analytics.mjs`
- Create: `tests/analytics.test.mjs`
- Modify: `package.json:7-10`

**Interfaces:**
- Consumes: 旅行记录数组，每项可包含 `date`、`country`、`province`、`city`、`locationKey`、`isRepeated`。
- Produces: `deriveOverviewAnalytics(records)`、`buildRecordSetSnapshot(records)`。

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecordSetSnapshot, deriveOverviewAnalytics } from '../js/analytics.mjs';

const records = [
    { date: '2024-01-01', country: '中国', province: '云南省', city: '昆明市', locationKey: '中国|云南省|昆明市', isRepeated: false },
    { date: '2024-01-11', country: '中国', province: '云南省', city: '昆明市', locationKey: '中国|云南省|昆明市', isRepeated: true },
    { date: '2025-03-12', country: '中国', province: '江苏省', city: '苏州市', locationKey: '中国|江苏省|苏州市', isRepeated: false }
];

test('统计筛选集合', () => {
    assert.deepEqual(buildRecordSetSnapshot(records), {
        count: 3, cityCount: 2, provinceCount: 2,
        firstDate: '2024-01-01', latestDate: '2025-03-12'
    });
});

test('统计概览洞察', () => {
    assert.deepEqual(deriveOverviewAnalytics(records), {
        repeatCount: 1, repeatRate: 33,
        activeYearCount: 2, activeMonthCount: 2,
        longestGap: { days: 426, from: '2024-01-11', to: '2025-03-12' }
    });
});

test('空数据安全', () => {
    assert.deepEqual(buildRecordSetSnapshot([]), {
        count: 0, cityCount: 0, provinceCount: 0, firstDate: '', latestDate: ''
    });
    assert.equal(deriveOverviewAnalytics([]).longestGap, null);
});
```

- [ ] **Step 2: 确认测试失败**

Run: `node --test tests/analytics.test.mjs`

Expected: FAIL，包含 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现统计模块**

```js
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function buildRecordSetSnapshot(records = []) {
    const dates = records.map(item => item.date || '').filter(Boolean).sort();
    const cities = new Set(records.map(item => item.locationKey
        || [item.country, item.province, item.city].filter(Boolean).join('|')).filter(Boolean));
    const provinces = new Set(records.map(item =>
        [item.country, item.province].filter(Boolean).join('|')).filter(Boolean));
    return {
        count: records.length,
        cityCount: cities.size,
        provinceCount: provinces.size,
        firstDate: dates[0] || '',
        latestDate: dates[dates.length - 1] || ''
    };
}

export function deriveOverviewAnalytics(records = []) {
    const repeatCount = records.filter(item => item.isRepeated).length;
    const dates = records.map(item => item.date || '').filter(date => DATE_PATTERN.test(date)).sort();
    const years = new Set(dates.map(date => date.slice(0, 4)));
    const months = new Set(dates.map(date => date.slice(5, 7)));
    let longestGap = null;
    for (let index = 1; index < dates.length; index += 1) {
        const from = dates[index - 1];
        const to = dates[index];
        const days = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS);
        if (!longestGap || days > longestGap.days) longestGap = { days, from, to };
    }
    return {
        repeatCount,
        repeatRate: records.length ? Math.round((repeatCount / records.length) * 100) : 0,
        activeYearCount: years.size,
        activeMonthCount: months.size,
        longestGap
    };
}
```

- [ ] **Step 4: 增加 `npm test` 并验证**

将 `package.json` scripts 改为：

```json
"scripts": {
  "start": "node js/server.js",
  "serve": "node js/server.js",
  "test": "node --test tests/*.test.mjs"
}
```

Run: `npm test`

Expected: 3 tests PASS，0 FAIL。

- [ ] **Step 5: 提交统计模块**

Run: `git add -- package.json js/analytics.mjs tests/analytics.test.mjs; git commit -m "test: 增加旅行统计计算覆盖"`

Expected: 仅提交统计模块、测试和测试脚本。

### Task 2: 删除路线筛选抽屉与重复入口

**Files:**
- Create: `tests/shell.test.mjs`
- Modify: `index.html:35-65`
- Modify: `js/app.js:1-75,203-240,960-1043,1178-1330,1821-1852`
- Modify: `css/journal.css:413-451,534-536,678-685,2468-2516,2968-2978`

**Interfaces:**
- Consumes: `#ledger` 路由和 `updateLedgerRoute(nextParams, options)`。
- Produces: 没有抽屉 DOM、状态或事件分支的应用外壳。

- [ ] **Step 1: 写失败契约测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const appJs = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');

test('应用不再包含路线筛选抽屉', () => {
    assert.doesNotMatch(indexHtml, /drawerToggle|drawerRoot|journal-drawer|打开筛选面板/);
    assert.doesNotMatch(appJs, /renderDrawer|openDrawer|closeDrawer|toggleDrawer|keepDrawer|lastDrawerTrigger/);
});

test('路线页不存在重复筛选入口', () => {
    assert.doesNotMatch(appJs, /data-action="open-drawer"|筛选与排序|打开筛选面板/);
});
```

- [ ] **Step 2: 确认测试失败**

Run: `node --test tests/shell.test.mjs`

Expected: 2 tests FAIL，命中 `drawerRoot`、`renderDrawer` 和“筛选与排序”。

- [ ] **Step 3: 删除抽屉实现**

从 `index.html` 删除 `#drawerToggle` 和 `#drawerRoot`。从 `js/app.js` 删除抽屉引用、`renderDrawer`、`openDrawer`、`closeDrawer`、`toggleDrawer`，以及点击、Escape 和路由渲染中的抽屉分支。重置和即时更新统一调用：

```js
updateLedgerRoute({ ...LEDGER_FILTER_DEFAULTS }, { replace: true, focusId: 'ledgerSearch', animate: false });
updateLedgerRoute({ [key]: value }, { replace: true, animate: false });
updateLedgerRoute(nextParams, { replace: true, focusId: filter.id || '', animate: false });
```

删除 `.spine-filter`、`.journal-drawer`、`.drawer-grip`、`.drawer-head` 和 `body.drawer-open`；暂时保留筛选字段与分段控件样式供 Task 3 重命名。

- [ ] **Step 4: 验证抽屉删除**

Run: `npm test`

Expected: 5 tests PASS，0 FAIL。

- [ ] **Step 5: 提交抽屉删除**

Run: `git add -- index.html js/app.js css/journal.css tests/shell.test.mjs; git commit -m "refactor: 移除重复路线筛选抽屉"`

Expected: 不包含设计前已有改动之外的无关文件。

### Task 3: 将索引夹层改造成即时高级筛选工作台

**Files:**
- Modify: `js/app.js:625-760,1315-1330,1483-1500,1629-1705`
- Modify: `css/journal.css:1572-1685,2059-2124,2910-2990`
- Modify: `tests/shell.test.mjs`

**Interfaces:**
- Consumes: `travelModel.filterOptions`、`getCityFilterOptions`、`updateLedgerRoute`。
- Produces: `renderLedgerFilterWorkbench(params)`，控件用 `data-ledger-filter` 或 `data-ledger-toggle` 即时更新。

- [ ] **Step 1: 扩展失败测试**

```js
test('索引夹层包含完整高级筛选工作台', () => {
    assert.match(appJs, /function renderLedgerFilterWorkbench/);
    for (const key of ['year', 'month', 'province', 'city', 'sort']) {
        assert.match(appJs, new RegExp('data-ledger-filter="' + key + '"'));
    }
    assert.match(appJs, /重置全部/);
    assert.doesNotMatch(appJs, /当前筛选|当前排序|切到最早优先|切回最新优先/);
});
```

Run: `node --test tests/shell.test.mjs`

Expected: 新测试 FAIL，缺少工作台函数。

- [ ] **Step 2: 实现工作台**

`renderLedgerFilterWorkbench(params)` 按以下顺序输出：结果快照之后的年份、月份、省份、城市 select；到访类型与照片状态分段按钮；排序 select；唯一的“重置全部”按钮。每个 select 使用稳定 id `ledgerFilterYear`、`ledgerFilterMonth`、`ledgerFilterProvince`、`ledgerFilterCity`、`ledgerFilterSort`，并调用现有 `escapeHtml`。省份变化时设置 `nextParams.city = 'all'`。

通用 select 的完整结构为：

```js
function renderLedgerSelect(label, key, options, activeValue) {
    const id = `ledgerFilter${key[0].toUpperCase()}${key.slice(1)}`;
    return `
        <label class="index-filter-field" for="${id}">
            <span class="field-label">${escapeHtml(label)}</span>
            <select id="${id}" data-ledger-filter="${escapeHtml(key)}">
                ${options.map(option => `<option value="${escapeHtml(option.value)}"${activeValue === option.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
            </select>
        </label>
    `;
}
```

`filterToggleButton` 改用 `index-segment` 与 `index-segment-active`。删除 `toggle-sort`、`getCurrentLedgerSort`、`renderLedgerActiveFilters` 和 `renderYearCountLink`。

- [ ] **Step 3: 接入动态快照**

从 `analytics.mjs` 导入 `buildRecordSetSnapshot`，删除本地 `getLedgerSnapshot`。零结果时日期文案为“暂无匹配记录”，否则使用 `formatDateRange(firstDate, latestDate, 'day')`。

- [ ] **Step 4: 实现工作台样式**

```css
.index-filter-section { display: grid; gap: 9px; }
.index-filter-section h3 { margin: 0; color: var(--stamp); font: 12px/1.3 var(--font-code); letter-spacing: .08em; }
.index-filter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.index-filter-field { display: grid; gap: 6px; min-width: 0; }
.index-filter-field select { width: 100%; min-width: 0; min-height: 38px; padding: 8px 30px 8px 10px; border: 1px solid rgba(83,56,30,.22); border-radius: 7px; color: var(--ink); background: rgba(255,250,232,.66); font: 12px/1.3 var(--font-code); }
.index-segment-group { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.index-segment { min-width: 0; min-height: 36px; padding: 7px 5px; border: 1px solid rgba(83,56,30,.22); border-radius: 7px; color: var(--ink-soft); background: rgba(255,250,232,.52); font: 11px/1.2 var(--font-code); }
.index-segment-active { color: var(--paper-50); border-color: rgba(78,51,27,.38); background: linear-gradient(180deg,#8f6841,#694326); }
```

窄屏 `.paper-page-right.map-pocket` 使用 `order: -1`；更窄断点中 `.index-filter-grid` 改为单列。

- [ ] **Step 5: 验证工作台**

Run: `npm test`

Expected: 6 tests PASS，0 FAIL。

- [ ] **Step 6: 提交筛选工作台**

Run: `git add -- js/app.js js/analytics.mjs css/journal.css tests/shell.test.mjs; git commit -m "feat: 将索引夹层改为高级筛选工作台"`

Expected: 提交即时筛选、动态统计和对应样式。

### Task 4: 丰富旅行概览统计

**Files:**
- Modify: `js/app.js:1-8,244-305,761-920`
- Modify: `css/journal.css:2059-2218`
- Modify: `tests/shell.test.mjs`

**Interfaces:**
- Consumes: `deriveOverviewAnalytics(travelModel.records)`。
- Produces: `travelModel.overviewAnalytics` 和四项新增概览洞察。

- [ ] **Step 1: 写失败测试**

```js
test('旅行概览渲染新增可靠统计', () => {
    for (const label of ['复访率', '活跃年份', '活跃月份', '最长记录间隔']) {
        assert.match(appJs, new RegExp(label));
    }
    assert.match(appJs, /deriveOverviewAnalytics/);
});
```

Run: `node --test tests/shell.test.mjs`

Expected: 新测试 FAIL，缺少四项文案。

- [ ] **Step 2: 接入和渲染统计**

导入 `deriveOverviewAnalytics`，在 `deriveTravelModel` 增加 `overviewAnalytics: deriveOverviewAnalytics(enhanced)`。在覆盖范围网格追加活跃年份、活跃月份和复访率；在记录节奏区追加：

```js
function renderLongestGapInsight(longestGap) {
    if (!longestGap) return renderEmptyOverviewInsight('最长记录间隔', '暂无足够记录');
    return `
        <div class="overview-insight overview-insight-wide">
            <span>最长记录间隔</span>
            <strong>${longestGap.days} 天</strong>
            <small>${escapeHtml(formatDateRange(longestGap.from, longestGap.to, 'day'))}</small>
        </div>
    `;
}
```

- [ ] **Step 3: 调整统计网格**

```css
.overview-metric-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.overview-insight-wide { grid-column: 1 / -1; }
@media (max-width: 760px) {
    .overview-metric-grid, .overview-insight-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
```

- [ ] **Step 4: 验证概览**

Run: `npm test`

Expected: 7 tests PASS，0 FAIL。

- [ ] **Step 5: 提交概览统计**

Run: `git add -- js/app.js css/journal.css tests/shell.test.mjs; git commit -m "feat: 丰富旅行概览数据洞察"`

Expected: 提交四项新增统计及样式。

### Task 5: 浏览器与回归验证

**Files:**
- Modify if needed: `js/app.js`
- Modify if needed: `css/journal.css`

- [ ] **Step 1: 自动化检查**

Run: `npm test`

Expected: 7 tests PASS，0 FAIL。

Run: `node --check js/server.js`

Expected: 无输出，退出码 0。

Run: `git diff --check`

Expected: 无空白错误。

- [ ] **Step 2: 桌面验证 `#ledger`**

使用本地服务器和内置浏览器确认：抽屉与重复入口不存在；七类筛选/排序即时更新 URL、左页结果和右页统计；省份会联动城市；零结果安全；“重置全部”恢复默认并禁用；控制台无 error。

- [ ] **Step 3: 桌面验证 `#archive`**

确认全量统计、复访率、活跃年份、活跃月份和最长记录间隔与 `analytics.mjs` 输出一致；链接型洞察可跳转，纯统计项没有伪点击状态。

- [ ] **Step 4: 响应式验证**

在 `820 × 1000` 和 `390 × 844` 验证高级筛选位于列表之前，无横向滚动、裁切或控件溢出，Tab 焦点与 `aria-live` 正常。

- [ ] **Step 5: 完整复验**

修复发现的问题后重新运行 `npm test`、`git diff --check`，并再次检查桌面 `#ledger`、桌面 `#archive`、`820 × 1000`、`390 × 844`。

- [ ] **Step 6: 提交验证修复（仅有修改时）**

Run: `git add -- js/app.js css/journal.css; git commit -m "fix: 完善筛选工作台响应式表现"`

Expected: 没有修复改动时跳过提交；有改动时只提交验证阶段产生的修复。

## 完成标准

- 自动化测试全部通过，`git diff --check` 无错误。
- 路线筛选抽屉和所有重复入口已删除。
- 索引夹层七类筛选/排序均即时生效。
- 动态统计与筛选结果一致，零结果安全。
- 旅行概览展示复访率、活跃年份、活跃月份和最长记录间隔。
- 桌面与窄屏无控制台错误、横向滚动或视觉遮挡。
