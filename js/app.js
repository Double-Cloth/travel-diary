import { loadTravelData, loadTravelRecords } from './data.js';
import { buildFallbackTitle, escapeHtml } from './utils.js';

const DEFAULT_LEDGER_SORT = 'desc';
const PAGE_TURN_MS = 480;
const PAGE_TURN_SWAP_MS = 140;
const ROUTE_MAP_SLOTS = [
    { dot: 'dot-a', city: 'city-a' },
    { dot: 'dot-b', city: 'city-b' },
    { dot: 'dot-c', city: 'city-c' },
    { dot: 'dot-d', city: 'city-d' },
    { dot: 'dot-e', city: 'city-e' },
    { dot: 'dot-f', city: 'city-f' }
];

const refs = {};
let travelModel = null;
let activeRoute = null;
let pageTurnTimer = null;
let lastReadingHash = '#ledger';
let lastEntryFocusId = '';
let lastDrawerTrigger = null;

document.addEventListener('DOMContentLoaded', () => {
    void initApp();
});

async function initApp() {
    cacheRefs();
    bindGlobalEvents();
    renderLoading();

    try {
        const rawRecords = await loadTravelData();
        const hydratedRecords = await loadTravelRecords(rawRecords);
        travelModel = deriveTravelModel(hydratedRecords);
        syncRouteFromHash({ initial: true });
    } catch (error) {
        renderFatalError(error);
    }
}

function cacheRefs() {
    refs.shell = document.getElementById('appShell');
    refs.stage = document.getElementById('journalStage');
    refs.spread = document.getElementById('pageSpread');
    refs.leftPage = document.getElementById('leftPage');
    refs.rightPage = document.getElementById('rightPage');
    refs.drawer = document.getElementById('drawerRoot');
    refs.sheet = document.getElementById('sheetRoot');
    refs.drawerToggle = document.getElementById('drawerToggle');
}

function bindGlobalEvents() {
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('keydown', handleDocumentKeydown);
    document.addEventListener('input', handleDocumentInput);
    window.addEventListener('hashchange', () => syncRouteFromHash());
}

function parseRoute(hash = window.location.hash) {
    const source = (hash || '#cover').replace(/^#/, '');
    const [routeName = 'cover', query = ''] = source.split('?');
    const params = new URLSearchParams(query);

    switch (routeName || 'cover') {
        case 'cover':
            return { name: 'cover', params: {}, valid: true };
        case 'ledger':
            return {
                name: 'ledger',
                params: {
                    year: normalizeYear(params.get('year')),
                    q: (params.get('q') || '').trim(),
                    sort: params.get('sort') === 'asc' ? 'asc' : DEFAULT_LEDGER_SORT
                },
                valid: true
            };
        case 'archive':
            return {
                name: 'archive',
                params: {
                    q: (params.get('q') || '').trim()
                },
                valid: true
            };
        case 'place':
            return {
                name: 'place',
                params: {
                    country: params.get('country') || '',
                    province: params.get('province') || '',
                    city: params.get('city') || ''
                },
                valid: true
            };
        case 'entry':
            return {
                name: 'entry',
                params: {
                    id: params.get('id') || ''
                },
                valid: true
            };
        default:
            return { name: 'cover', params: {}, valid: false };
    }
}

function serializeRoute(route) {
    if (!route) {
        return '#cover';
    }

    const params = new URLSearchParams();

    switch (route.name) {
        case 'cover':
            return '#cover';
        case 'ledger':
            if (route.params.year && route.params.year !== 'all') params.set('year', route.params.year);
            if (route.params.q) params.set('q', route.params.q);
            if (route.params.sort === 'asc') params.set('sort', 'asc');
            return `#ledger${params.toString() ? `?${params}` : ''}`;
        case 'archive':
            if (route.params.q) params.set('q', route.params.q);
            return `#archive${params.toString() ? `?${params}` : ''}`;
        case 'place':
            if (route.params.country) params.set('country', route.params.country);
            if (route.params.province) params.set('province', route.params.province);
            if (route.params.city) params.set('city', route.params.city);
            return `#place${params.toString() ? `?${params}` : ''}`;
        case 'entry':
            if (route.params.id) params.set('id', route.params.id);
            return `#entry${params.toString() ? `?${params}` : ''}`;
        default:
            return '#cover';
    }
}

function syncRouteFromHash(options = {}) {
    if (!travelModel) return;

    const parsed = parseRoute(window.location.hash);
    const normalizedHash = serializeRoute(parsed);

    if (!parsed.valid || !window.location.hash) {
        history.replaceState(null, document.title, normalizedHash);
    }

    renderRoute(parsed, options);
}

function navigateTo(route, options = {}) {
    const nextHash = typeof route === 'string' ? route : serializeRoute(route);

    if (options.replace) {
        history.replaceState(null, document.title, nextHash);
    } else {
        history.pushState(null, document.title, nextHash);
    }

    syncRouteFromHash(options);
}

function renderRoute(route, options = {}) {
    const previousRoute = activeRoute;
    activeRoute = route;
    refs.shell.dataset.route = route.name;
    document.body.dataset.route = route.name;
    if (!options.keepDrawer) {
        closeDrawer();
    }
    updateChapterTabs(route.name);

    if (route.name !== 'entry') {
        closeEntrySheet({ restoreHash: false });
    }

    const direction = getTurnDirection(previousRoute, route);
    renderWithPageTurn(() => {
        switch (route.name) {
            case 'cover':
                renderCover();
                break;
            case 'ledger':
                renderLedger(route.params);
                break;
            case 'archive':
                renderArchive(route.params);
                break;
            case 'place':
                renderPlace(route.params);
                break;
            case 'entry':
                renderEntryRoute(route.params);
                break;
            default:
                renderCover();
        }

        renderDrawer();
        restoreFocus(options.focusId);
    }, { direction, animate: !options.initial });
}

function deriveTravelModel(records) {
    const sortedAsc = [...records].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const seenLocations = new Set();
    const enhancedAsc = sortedAsc.map((record) => {
        const id = createRecordId(record);
        const year = (record.date || '').slice(0, 4) || '未知';
        const month = (record.date || '').slice(5, 7) || '';
        const locationKey = [record.country, record.province, record.city].filter(Boolean).join('|');
        const isRepeated = seenLocations.has(locationKey);
        seenLocations.add(locationKey);

        return {
            ...record,
            id,
            year,
            month,
            locationKey,
            isRepeated,
            title: record.descTitle || buildFallbackTitle(record)
        };
    });
    const enhanced = records.map((record) => enhancedAsc.find(item => item.desc_md === record.desc_md) || record);
    const recordsById = new Map(enhanced.map(record => [record.id, record]));
    const recordsDesc = [...enhanced].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const years = Array.from(new Set(recordsDesc.map(record => record.year))).filter(Boolean);
    const yearRange = years.length > 1 ? `${years[years.length - 1]} - ${years[0]}` : (years[0] || '未知');
    const yearRangeShort = years.length > 1 ? `${years[years.length - 1]}-${years[0].slice(2)}` : (years[0] || '未知');
    const countries = buildLocationIndex(enhanced);
    const latestRecord = recordsDesc[0] || null;

    return {
        records: enhanced,
        recordsDesc,
        recordsById,
        years,
        yearRange,
        yearRangeShort,
        countries,
        stats: {
            total: enhanced.length,
            countries: countries.length,
            provinces: countries.reduce((sum, country) => sum + country.provinces.length, 0),
            cities: new Set(enhanced.map(record => [record.country, record.province, record.city].join('|'))).size
        },
        latestRecord
    };
}

function buildLocationIndex(records) {
    const countryMap = new Map();

    records.forEach((record) => {
        const countryKey = record.country || '未知国家';
        const provinceKey = record.province || countryKey;
        const country = countryMap.get(countryKey) || {
            country: countryKey,
            count: 0,
            cities: new Set(),
            provinces: new Map(),
            latestDate: '',
            searchText: ''
        };
        const province = country.provinces.get(provinceKey) || {
            country: countryKey,
            province: record.province || '',
            label: record.province || countryKey,
            count: 0,
            cities: new Set(),
            latestDate: '',
            searchText: ''
        };

        country.count += 1;
        country.cities.add(record.city);
        country.latestDate = maxDate(country.latestDate, record.date);
        country.searchText = `${country.searchText} ${record.country || ''} ${record.province || ''} ${record.city || ''}`.toLowerCase();

        province.count += 1;
        province.cities.add(record.city);
        province.latestDate = maxDate(province.latestDate, record.date);
        province.searchText = `${province.searchText} ${record.country || ''} ${record.province || ''} ${record.city || ''}`.toLowerCase();

        country.provinces.set(provinceKey, province);
        countryMap.set(countryKey, country);
    });

    return Array.from(countryMap.values())
        .map(country => ({
            ...country,
            cityCount: country.cities.size,
            provinces: Array.from(country.provinces.values())
                .map(province => ({
                    ...province,
                    cityCount: province.cities.size,
                    cities: Array.from(province.cities).filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN'))
                }))
                .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))
        }))
        .sort((a, b) => b.count - a.count || a.country.localeCompare(b.country, 'zh-CN'));
}

function renderCover() {
    const stats = travelModel.stats;
    const latest = travelModel.latestRecord;
    const routeRecords = getRouteMapRecords();
    const recentRecords = travelModel.recordsDesc.slice(0, 4);

    setPages(`
        <div class="cover-page archive-home">
            <h1 class="archive-home-title">把走过的城市，整理成一条清晰的时间线。</h1>
            <div class="archive-search-card">
                <a class="archive-search-link" href="#ledger" aria-label="搜索路线记录">
                    <span aria-hidden="true"></span>
                    搜索记录
                </a>
                <button class="filter-chip" type="button" data-action="open-drawer">筛选</button>
            </div>
            <p class="journal-label">最近记录</p>
            <div class="cover-record-list">
                ${recentRecords.map(renderCoverRecord).join('')}
            </div>
            <dl class="tag-stats" aria-label="旅行统计">
                ${statTag('旅行记录', stats.total)}
                ${statTag('城市', stats.cities)}
                ${statTag('时间范围', travelModel.yearRangeShort)}
            </dl>
        </div>
    `, `
        <div class="pocket-page">
            <div class="route-insert">
                <div class="route-map-label">
                    <strong>我的旅行路线图</strong>
                    <span>${escapeHtml(travelModel.yearRange)}</span>
                </div>
                <div class="route-sketch" aria-label="最近旅行路线图">
                    <svg class="route-path" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
                        <path d="M25 35 C35 38 34 57 45 61 S58 47 68 55 S79 61 84 43 S78 27 88 24" />
                        <path class="route-path-shadow" d="M18 69 C28 73 32 82 42 75 S48 58 58 62" />
                    </svg>
                    ${renderRouteMap(routeRecords)}
                    <span class="map-compass">N</span>
                </div>
            </div>
            ${latest ? renderLatestTicket(latest) : '<div class="empty-note latest-ticket-empty">还没有旅行记录。</div>'}
        </div>
    `);
}

function renderCoverRecord(record, index) {
    const entryHref = `#entry?id=${encodeURIComponent(record.id)}`;

    return `
        <article class="cover-record" id="entry-card-cover-${escapeHtml(record.id)}" data-open-entry="${escapeHtml(record.id)}" tabindex="0" role="button" aria-label="打开 ${escapeHtml(record.title)} 档案">
            <span class="cover-record-thumb" aria-hidden="true"></span>
            <div class="cover-record-body">
                <h2>${escapeHtml(record.title)}</h2>
                <p>${escapeHtml(record.date || '')} · ${escapeHtml(getLocationText(record))}</p>
            </div>
            <a class="record-open" href="${entryHref}">打开档案</a>
            <span class="cover-record-index">${String(index + 1).padStart(2, '0')}</span>
        </article>
    `;
}

function getRouteMapRecords() {
    const seenLocations = new Set();
    const routeRecords = [];

    travelModel.recordsDesc.forEach((record) => {
        const key = record.locationKey || [record.country, record.province, record.city].filter(Boolean).join('|');
        if (!key || seenLocations.has(key)) {
            return;
        }

        seenLocations.add(key);
        routeRecords.push(record);
    });

    return routeRecords.slice(0, ROUTE_MAP_SLOTS.length).reverse();
}

function renderRouteMap(records) {
    return records.map((record, index) => {
        const slot = ROUTE_MAP_SLOTS[index];
        const entryHref = `#entry?id=${encodeURIComponent(record.id)}`;
        const label = getLocationText(record);

        return `
            <a class="route-city ${slot.city}" href="${entryHref}" aria-label="打开 ${escapeHtml(record.title)} 日记">${escapeHtml(record.city || record.province || record.country)}</a>
            <a class="route-dot ${slot.dot}" href="${entryHref}" data-record-id="${escapeHtml(record.id)}" aria-label="打开 ${escapeHtml(label)} 的旅行记录"></a>
        `;
    }).join('');
}

function renderLedger(params = {}) {
    const ledgerParams = normalizeLedgerParams(params);
    const filtered = getLedgerRecords(ledgerParams);
    const resultLabel = createLedgerResultLabel(filtered.length, travelModel.records.length, ledgerParams);

    setPages(`
        <div class="ledger-page">
            <header class="page-head">
                <p class="journal-label">路线档案</p>
                <h1>按时间回看每一次出发。</h1>
            </header>
            ${renderLedgerControls(ledgerParams, 'ledgerSearch')}
            <div class="year-bookmarks" aria-label="年份书签">
                ${yearLink('全部', 'all', ledgerParams)}
                ${travelModel.years.map(year => yearLink(year, year, ledgerParams)).join('')}
            </div>
            <p class="result-count" aria-live="polite">${escapeHtml(resultLabel)}</p>
            <div class="timeline-list" id="ledgerList">
                ${filtered.length ? filtered.map(renderLedgerEntry).join('') : '<div class="empty-note">没有找到匹配的旅行记录。</div>'}
            </div>
        </div>
    `, `
        <aside class="map-pocket">
            <p class="journal-label">索引夹层</p>
            <h2>路线地图与标签</h2>
            <div class="filter-summary">
                <span>${ledgerParams.year === 'all' ? '全部年份' : `${ledgerParams.year} 年`}</span>
                <span>${ledgerParams.sort === 'asc' ? '最早优先' : '最新优先'}</span>
                <span>${ledgerParams.q ? `搜索：${escapeHtml(ledgerParams.q)}` : '未搜索'}</span>
                <span>${escapeHtml(resultLabel)}</span>
            </div>
            <button class="brass-toggle" type="button" data-action="toggle-sort" aria-pressed="${ledgerParams.sort === 'asc' ? 'true' : 'false'}" aria-label="当前排序：${ledgerParams.sort === 'asc' ? '最早优先' : '最新优先'}">
                ${ledgerParams.sort === 'asc' ? '切回最新优先' : '切到最早优先'}
            </button>
            <button class="paper-button full-width" type="button" data-action="open-drawer">打开搜索抽屉</button>
            <div class="province-strip">
                ${travelModel.countries.flatMap(country => country.provinces).slice(0, 10).map(renderMiniLuggageTag).join('')}
            </div>
        </aside>
    `);
}

function createLedgerResultLabel(count, total, params) {
    const hasFilter = params.year !== 'all' || Boolean(params.q);

    if (!hasFilter) {
        return `共 ${total} 条旅行记录`;
    }

    return `显示 ${count} / ${total} 条记录`;
}

function renderArchive(params = {}) {
    const query = (params.q || '').trim().toLowerCase();
    const countries = travelModel.countries
        .map(country => {
            if (!query) return country;
            const countryMatch = country.country.toLowerCase().includes(query);
            const provinces = countryMatch
                ? country.provinces
                : country.provinces.filter(province => province.searchText.includes(query));
            return { ...country, provinces };
        })
        .filter(country => country.provinces.length > 0);

    setPages(`
        <div class="archive-page">
            <header class="page-head">
                <p class="journal-label">地点索引</p>
                <h1>按地点抽出一张行李牌。</h1>
            </header>
            <label class="field-label" for="archiveSearch">搜索国家、省份或城市</label>
            <div class="ink-field search-field">
                <input id="archiveSearch" type="search" value="${escapeHtml(params.q || '')}" autocomplete="off" placeholder="例如：云南、苏州、北京">
                <button class="search-clear" type="button" data-action="clear-search" data-target="archive" aria-label="清空地点搜索" ${params.q ? '' : 'disabled'}>×</button>
            </div>
            <div class="archive-country-list">
                ${countries.length ? countries.map(renderCountryFolder).join('') : '<div class="empty-note">没有找到匹配的地点。</div>'}
            </div>
        </div>
    `, `
        <aside class="dossier-page">
            <p class="journal-label">索引</p>
            <h2>目的地统计</h2>
            <dl class="dossier-stats">
                ${statTag('国家', travelModel.stats.countries)}
                ${statTag('省份', travelModel.stats.provinces)}
                ${statTag('城市', travelModel.stats.cities)}
            </dl>
            <p class="page-copy">点击任一行李牌，会翻到对应地点档案。地点档案只展示真实记录，不补造照片。</p>
        </aside>
    `);
}

function renderPlace(params = {}) {
    const matching = getPlaceRecords(params);
    const label = getPlaceLabel(params);
    const cities = Array.from(new Set(matching.map(record => record.city).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));

    setPages(`
        <div class="place-page">
            <a class="ribbon-back" href="#archive">返回地点索引</a>
            <p class="journal-label">地点档案</p>
            <h1>${escapeHtml(label)}</h1>
            <p class="place-count">${matching.length} 次到访</p>
            <div class="city-tags">
                ${cities.map(city => `
                    <a class="location-chip" href="${placeHash(params.country, params.province, city)}">${escapeHtml(city)}</a>
                `).join('')}
            </div>
        </div>
    `, `
        <div class="place-records">
            <p class="journal-label">相关纸条</p>
            ${matching.length ? matching.map(renderLedgerEntry).join('') : '<div class="empty-note">这个地点还没有旅行记录。</div>'}
        </div>
    `);
}

function renderEntryRoute(params = {}) {
    const record = travelModel.recordsById.get(params.id);
    const backgroundRoute = parseRoute(lastReadingHash);
    if (backgroundRoute.name === 'place') {
        renderPlace(backgroundRoute.params);
    } else if (backgroundRoute.name === 'archive') {
        renderArchive(backgroundRoute.params);
    } else {
        const ledgerParams = backgroundRoute.name === 'ledger'
            ? backgroundRoute.params
            : (record ? { year: record.year, q: '', sort: DEFAULT_LEDGER_SORT } : { year: 'all', q: '', sort: DEFAULT_LEDGER_SORT });
        renderLedger(ledgerParams);
    }
    openEntrySheet(record);
}

function renderLoading() {
    setPages(`
        <div class="loading-page">
            <p class="journal-label">正在打开档案盒</p>
            <h1>正在整理旅行档案...</h1>
        </div>
    `, '<div class="loading-page muted-page"></div>');
}

function renderFatalError(error) {
    setPages(`
        <div class="loading-page">
            <p class="journal-label">加载失败</p>
            <h1>档案盒暂时打不开。</h1>
            <p class="page-copy">${escapeHtml(error.message)}</p>
        </div>
    `, '<div class="loading-page muted-page"></div>');
}

function renderDrawer() {
    if (!refs.drawer || !travelModel) return;

    const route = activeRoute || parseRoute();
    const ledgerParams = route.name === 'ledger' ? normalizeLedgerParams(route.params) : { year: 'all', q: '', sort: DEFAULT_LEDGER_SORT };
    const filtered = getLedgerRecords(ledgerParams);
    const resultLabel = createLedgerResultLabel(filtered.length, travelModel.records.length, ledgerParams);

    refs.drawer.innerHTML = `
        <div class="drawer-grip" aria-hidden="true"></div>
        <div class="drawer-head">
            <h2>搜索记录</h2>
            <button class="icon-button" type="button" data-action="close-drawer" aria-label="关闭筛选">×</button>
        </div>
        <label class="field-label" for="drawerSearch">路线搜索</label>
        <div class="ink-field search-field">
            <input id="drawerSearch" type="search" value="${escapeHtml(ledgerParams.q)}" autocomplete="off" placeholder="搜索城市或记录">
            <button class="search-clear" type="button" data-action="clear-search" data-target="drawer" aria-label="清空抽屉搜索" ${ledgerParams.q ? '' : 'disabled'}>×</button>
        </div>
        <p class="result-count drawer-result-count" aria-live="polite">${escapeHtml(resultLabel)}</p>
        <div class="drawer-years">
            ${yearLink('全部', 'all', ledgerParams)}
            ${travelModel.years.map(year => yearLink(year, year, ledgerParams)).join('')}
        </div>
        <button class="brass-toggle full-width" type="button" data-action="toggle-sort" aria-pressed="${ledgerParams.sort === 'asc' ? 'true' : 'false'}" aria-label="当前排序：${ledgerParams.sort === 'asc' ? '最早优先' : '最新优先'}">
            ${ledgerParams.sort === 'asc' ? '最早优先' : '最新优先'}
        </button>
    `;
}

function handleClearSearch(button) {
    const target = button.getAttribute('data-target');

    if (target === 'ledger') {
        updateLedgerRoute({ q: '' }, { replace: true, focusId: 'ledgerSearch' });
        return;
    }

    if (target === 'drawer') {
        updateLedgerRoute({ q: '' }, { replace: true, focusId: 'drawerSearch', keepDrawer: true });
        return;
    }

    if (target === 'archive') {
        navigateTo({ name: 'archive', params: { q: '' } }, { replace: true, focusId: 'archiveSearch' });
    }
}

function openEntrySheet(record) {
    if (!refs.sheet) return;

    refs.sheet.setAttribute('aria-hidden', 'false');
    refs.sheet.classList.add('entry-sheet-root-open');

    if (!record) {
        refs.sheet.innerHTML = `
            <div class="sheet-backdrop" data-action="close-entry"></div>
            <article class="entry-sheet" role="dialog" aria-modal="true" aria-labelledby="entrySheetTitle">
                <button class="sheet-close" type="button" data-action="close-entry" aria-label="合上纸页">×</button>
                <h1 id="entrySheetTitle">没有找到这篇日记</h1>
            </article>
        `;
        return;
    }

    const navigation = getEntryNavigation(record);
    refs.sheet.innerHTML = `
        <div class="sheet-backdrop" data-action="close-entry"></div>
        <article class="entry-sheet" role="dialog" aria-modal="true" aria-labelledby="entrySheetTitle" tabindex="-1">
            <button class="sheet-close" type="button" data-action="close-entry" aria-label="合上纸页">×</button>
            <div class="sheet-meta">
                <time datetime="${escapeHtml(record.date || '')}">${escapeHtml(record.date || '')}</time>
                <a class="location-chip" href="${placeHash(record.country, record.province, record.city)}">${escapeHtml(getLocationText(record))}</a>
            </div>
            <h1 id="entrySheetTitle">${escapeHtml(record.title)}</h1>
            <div class="markdown-content">${record.descBodyHtml || '<p>这篇日记还没有正文。</p>'}</div>
            ${renderPhotoSleeve(record)}
            ${renderEntrySheetNav(navigation)}
        </article>
    `;

    requestAnimationFrame(() => {
        refs.sheet.querySelector('.entry-sheet')?.focus({ preventScroll: true });
    });
}

function getEntryNavigation(record) {
    const contextRoute = parseRoute(lastReadingHash || '#ledger');
    let records;

    if (contextRoute.name === 'ledger') {
        records = getLedgerRecords(contextRoute.params);
    } else if (contextRoute.name === 'place') {
        records = getPlaceRecords(contextRoute.params);
    } else {
        records = travelModel.recordsDesc;
    }

    const index = records.findIndex(item => item.id === record.id);

    return {
        index,
        total: records.length,
        previous: index > 0 ? records[index - 1] : null,
        next: index >= 0 && index < records.length - 1 ? records[index + 1] : null
    };
}

function renderEntrySheetNav(navigation) {
    const position = navigation.index >= 0
        ? `${navigation.index + 1} / ${navigation.total}`
        : `1 / ${Math.max(navigation.total, 1)}`;

    return `
        <nav class="sheet-nav" aria-label="日记翻页">
            <button class="paper-button sheet-nav-button" type="button" data-action="entry-prev" data-entry-id="${navigation.previous ? escapeHtml(navigation.previous.id) : ''}" ${navigation.previous ? '' : 'disabled'} aria-label="上一篇日记">
                上一篇
            </button>
            <span class="sheet-nav-count">${escapeHtml(position)}</span>
            <button class="paper-button sheet-nav-button" type="button" data-action="entry-next" data-entry-id="${navigation.next ? escapeHtml(navigation.next.id) : ''}" ${navigation.next ? '' : 'disabled'} aria-label="下一篇日记">
                下一篇
            </button>
        </nav>
    `;
}

function closeEntrySheet(options = {}) {
    if (!refs.sheet) return;

    refs.sheet.classList.remove('entry-sheet-root-open');
    refs.sheet.setAttribute('aria-hidden', 'true');
    refs.sheet.innerHTML = '';

    if (options.restoreHash) {
        navigateTo(lastReadingHash || '#ledger', { replace: true, focusId: lastEntryFocusId, animate: false });
        return;
    }

    if (options.restoreFocus && lastEntryFocusId) {
        restoreFocus(lastEntryFocusId);
    }
}

function renderWithPageTurn(renderFn, options = {}) {
    clearTimeout(pageTurnTimer);

    if (!refs.spread || options.animate === false || prefersReducedMotion()) {
        renderFn();
        return;
    }

    refs.spread.classList.remove('turn-forward', 'turn-back', 'turn-in');
    refs.spread.classList.add(options.direction === 'back' ? 'turn-back' : 'turn-forward');

    pageTurnTimer = setTimeout(() => {
        renderFn();
        refs.spread.classList.remove('turn-forward', 'turn-back');
        refs.spread.classList.add('turn-in');
        pageTurnTimer = setTimeout(() => refs.spread.classList.remove('turn-in'), PAGE_TURN_MS);
    }, PAGE_TURN_SWAP_MS);
}

function handleDocumentClick(event) {
    const clearSearch = event.target.closest('[data-action="clear-search"]');
    if (clearSearch) {
        event.preventDefault();
        handleClearSearch(clearSearch);
        return;
    }

    const closeEntry = event.target.closest('[data-action="close-entry"]');
    if (closeEntry) {
        event.preventDefault();
        closeEntrySheet({ restoreHash: true });
        return;
    }

    const entryNav = event.target.closest('[data-action="entry-prev"], [data-action="entry-next"]');
    if (entryNav) {
        event.preventDefault();
        const nextId = entryNav.getAttribute('data-entry-id');
        if (nextId) {
            navigateTo({ name: 'entry', params: { id: nextId } }, { replace: true });
        }
        return;
    }

    const drawerAction = event.target.closest('[data-action="open-drawer"], [data-action="close-drawer"]');
    if (drawerAction) {
        event.preventDefault();
        drawerAction.dataset.action === 'open-drawer' ? openDrawer(drawerAction) : closeDrawer({ restoreFocus: true });
        return;
    }

    const latestAction = event.target.closest('[data-action="open-latest"]');
    if (latestAction) {
        event.preventDefault();
        if (travelModel?.latestRecord) {
            lastReadingHash = serializeRoute(activeRoute?.name === 'entry' ? parseRoute(lastReadingHash) : activeRoute);
            lastEntryFocusId = '';
            navigateTo({ name: 'entry', params: { id: travelModel.latestRecord.id } });
        }
        return;
    }

    if (event.target.closest('#drawerToggle')) {
        event.preventDefault();
        toggleDrawer(event.target.closest('#drawerToggle'));
        return;
    }

    const sortToggle = event.target.closest('[data-action="toggle-sort"]');
    if (sortToggle) {
        event.preventDefault();
        updateLedgerRoute(
            { sort: getCurrentLedgerSort() === 'asc' ? 'desc' : 'asc' },
            { keepDrawer: Boolean(sortToggle.closest('#drawerRoot')) }
        );
        return;
    }

    if (refs.drawer?.classList.contains('journal-drawer-open') && !event.target.closest('#drawerRoot')) {
        closeDrawer({ restoreFocus: false });
    }

    const entryCard = event.target.closest('[data-open-entry]');
    if (entryCard && !event.target.closest('a, button, input')) {
        event.preventDefault();
        lastReadingHash = serializeRoute(activeRoute?.name === 'entry' ? parseRoute(lastReadingHash) : activeRoute);
        lastEntryFocusId = entryCard.id || '';
        navigateTo({ name: 'entry', params: { id: entryCard.dataset.openEntry } });
        return;
    }

    const routeAnchor = event.target.closest('a[href^="#"]');
    if (routeAnchor) {
        event.preventDefault();
        const href = routeAnchor.getAttribute('href');
        if (href.startsWith('#entry')) {
            lastReadingHash = serializeRoute(activeRoute?.name === 'entry' ? parseRoute(lastReadingHash) : activeRoute);
            lastEntryFocusId = '';
        }
        navigateTo(href);
    }
}

function handleDocumentKeydown(event) {
    if (event.key === 'Escape') {
        if (refs.sheet?.classList.contains('entry-sheet-root-open')) {
            closeEntrySheet({ restoreHash: true });
            return;
        }

        closeDrawer({ restoreFocus: true });
        return;
    }

    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-open-entry]')) {
        event.preventDefault();
        lastReadingHash = serializeRoute(activeRoute || { name: 'ledger', params: {} });
        lastEntryFocusId = event.target.id || '';
        navigateTo({ name: 'entry', params: { id: event.target.dataset.openEntry } });
    }
}

function handleDocumentInput(event) {
    if (event.target.id === 'ledgerSearch') {
        updateLedgerRoute({ q: event.target.value }, { replace: true, focusId: 'ledgerSearch' });
    }

    if (event.target.id === 'drawerSearch') {
        updateLedgerRoute({ q: event.target.value }, { replace: true, focusId: 'drawerSearch', keepDrawer: true });
    }

    if (event.target.id === 'archiveSearch') {
        navigateTo({ name: 'archive', params: { q: event.target.value } }, { replace: true, focusId: 'archiveSearch' });
    }
}

function updateLedgerRoute(nextParams, options = {}) {
    const current = activeRoute?.name === 'ledger' ? activeRoute.params : {};
    navigateTo({
        name: 'ledger',
        params: normalizeLedgerParams({ ...current, ...nextParams })
    }, options);
}

function updateChapterTabs(routeName) {
    const activeName = routeName === 'entry' ? 'ledger' : routeName;
    document.querySelectorAll('[data-route-link]').forEach((link) => {
        const isActive = link.dataset.routeLink === activeName;
        link.classList.toggle('chapter-tab-active', isActive);
        link.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
}

function setPages(leftHtml, rightHtml) {
    refs.leftPage.innerHTML = leftHtml;
    refs.rightPage.innerHTML = rightHtml;
}

function getLedgerRecords(params) {
    const normalized = normalizeLedgerParams(params);
    const query = normalized.q.toLowerCase();
    const records = travelModel.records.filter((record) => {
        const yearMatch = normalized.year === 'all' || record.year === normalized.year;
        const searchMatch = !query || record.searchText.includes(query);
        return yearMatch && searchMatch;
    });

    return records.sort((a, b) => normalized.sort === 'asc'
        ? (a.date || '').localeCompare(b.date || '')
        : (b.date || '').localeCompare(a.date || ''));
}

function getPlaceRecords(params) {
    return travelModel.recordsDesc.filter(record => (
        (!params.country || record.country === params.country) &&
        (!params.province || record.province === params.province) &&
        (!params.city || record.city === params.city)
    ));
}

function renderLedgerControls(params, inputId) {
    return `
        <div class="ledger-controls">
            <label class="field-label" for="${inputId}">搜索路线</label>
            <div class="ink-field search-field">
                <input id="${inputId}" type="search" value="${escapeHtml(params.q)}" autocomplete="off" placeholder="搜索城市、省份或日记内容">
                <button class="search-clear" type="button" data-action="clear-search" data-target="ledger" aria-label="清空路线搜索" ${params.q ? '' : 'disabled'}>×</button>
            </div>
            <button class="filter-chip" type="button" data-action="open-drawer">搜索抽屉</button>
        </div>
    `;
}

function renderLedgerEntry(record) {
    return `
        <article class="ledger-entry" id="entry-card-${escapeHtml(record.id)}" data-open-entry="${escapeHtml(record.id)}" tabindex="0" role="button" aria-label="打开 ${escapeHtml(record.title)} 日记">
            <time datetime="${escapeHtml(record.date || '')}" class="entry-date-chip">
                <strong>${escapeHtml((record.date || '').slice(8, 10) || '--')}</strong>
                <span>${escapeHtml((record.date || '').slice(0, 7) || '')}</span>
            </time>
            <div class="entry-note">
                <span class="entry-location">${escapeHtml(getLocationText(record))}</span>
                <h3>${escapeHtml(record.title)}</h3>
                <div class="entry-tags">
                    <a class="location-chip" href="${placeHash(record.country, record.province, record.city)}">${escapeHtml(record.province || record.country)}</a>
                    ${record.isRepeated ? '<span class="repeat-stamp">再次到访</span>' : ''}
                </div>
            </div>
        </article>
    `;
}

function renderCountryFolder(country) {
    return `
        <section class="country-folder" aria-label="${escapeHtml(country.country)}">
            <div class="country-head">
                <h2>${escapeHtml(country.country)}</h2>
                <span>${country.provinces.length} 个省份 · ${country.count} 次到访</span>
            </div>
            <div class="luggage-grid">
                ${country.provinces.map(renderLuggageTag).join('')}
            </div>
        </section>
    `;
}

function renderLuggageTag(province) {
    return `
        <a class="luggage-tag" href="${placeHash(province.country, province.province, '')}">
            <strong>${escapeHtml(province.label)}</strong>
            <span>${province.count} 次到访 · ${province.cityCount} 座城市</span>
            <small>最近 ${escapeHtml(province.latestDate)}</small>
        </a>
    `;
}

function renderMiniLuggageTag(province) {
    return `<a class="mini-luggage-tag" href="${placeHash(province.country, province.province, '')}">${escapeHtml(province.label)}</a>`;
}

function renderLatestTicket(record) {
    return `
        <article class="latest-ticket" id="entry-card-latest-${escapeHtml(record.id)}" data-open-entry="${escapeHtml(record.id)}" tabindex="0" role="button" aria-label="打开最近日记">
            <span class="latest-ticket-label">最近旅行记录</span>
            <time datetime="${escapeHtml(record.date || '')}">${escapeHtml(record.date || '')}</time>
            <h2>${escapeHtml(record.title)}</h2>
            <p>${escapeHtml(getLocationText(record))}</p>
            <span>点击展开档案页</span>
        </article>
    `;
}

function renderPhotoSleeve(record) {
    if (!record.photo_folder || !Array.isArray(record.photos) || record.photos.length === 0) {
        return '<p class="photo-note">这篇记录没有照片附件。</p>';
    }

    return `
        <div class="photo-sleeve">
            ${record.photos.map(photo => `
                <img src="${escapeHtml(`${record.photo_folder}/${photo}`)}" alt="${escapeHtml(photo)}" loading="lazy">
            `).join('')}
        </div>
    `;
}

function statTag(label, value) {
    return `
        <div class="stat-tag">
            <dt>${escapeHtml(label)}</dt>
            <dd>${escapeHtml(value)}</dd>
        </div>
    `;
}

function yearLink(label, year, params) {
    const nextParams = normalizeLedgerParams({ ...params, year });
    const active = nextParams.year === normalizeLedgerParams(params).year;
    return `<a class="year-bookmark${active ? ' year-bookmark-active' : ''}" href="${serializeRoute({ name: 'ledger', params: nextParams })}">${escapeHtml(label)}</a>`;
}

function normalizeLedgerParams(params = {}) {
    return {
        year: normalizeYear(params.year),
        q: (params.q || '').trim(),
        sort: params.sort === 'asc' ? 'asc' : DEFAULT_LEDGER_SORT
    };
}

function normalizeYear(year) {
    return year && year !== 'All' ? String(year) : 'all';
}

function getCurrentLedgerSort() {
    return activeRoute?.name === 'ledger' ? normalizeLedgerParams(activeRoute.params).sort : DEFAULT_LEDGER_SORT;
}

function getTurnDirection(previousRoute, nextRoute) {
    if (!previousRoute) return 'forward';

    const order = ['cover', 'ledger', 'archive', 'place', 'entry'];
    const previousIndex = order.indexOf(previousRoute.name);
    const nextIndex = order.indexOf(nextRoute.name);

    return nextIndex < previousIndex ? 'back' : 'forward';
}

function getPlaceLabel(params) {
    if (params.country === '中国') {
        if (params.city) return params.province && params.province !== params.city ? `${params.province} · ${params.city}` : params.city;
        return params.province || params.country || '地点';
    }

    return [params.country, params.province && params.province !== params.city ? params.province : '', params.city]
        .filter(Boolean)
        .join(' ') || '地点';
}

function getLocationText(record) {
    if (record.province === record.city) {
        return record.country === '中国' ? record.city : `${record.country} ${record.city}`;
    }

    return record.country === '中国'
        ? `${record.province} ${record.city}`
        : `${record.country} ${record.province} ${record.city}`;
}

function placeHash(country, province, city) {
    return serializeRoute({
        name: 'place',
        params: {
            country: country || '',
            province: province || '',
            city: city || ''
        }
    });
}

function createRecordId(record) {
    const file = (record.desc_md || '').split('/').pop() || '';
    return file.replace(/\.md$/i, '') || `${record.date || 'entry'}-${record.city || record.province || 'unknown'}`;
}

function maxDate(current, next) {
    return !current || (next || '') > current ? (next || '') : current;
}

function openDrawer(triggerElement) {
    lastDrawerTrigger = triggerElement || document.activeElement;
    refs.drawer.classList.add('journal-drawer-open');
    refs.drawer.setAttribute('aria-hidden', 'false');
    refs.drawerToggle?.setAttribute('aria-expanded', 'true');
    document.body.classList.add('drawer-open');

    requestAnimationFrame(() => {
        refs.drawer.querySelector('#drawerSearch')?.focus({ preventScroll: true });
    });
}

function closeDrawer(options = {}) {
    const wasOpen = refs.drawer?.classList.contains('journal-drawer-open');
    refs.drawer?.classList.remove('journal-drawer-open');
    refs.drawer?.setAttribute('aria-hidden', 'true');
    refs.drawerToggle?.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('drawer-open');

    if (wasOpen && options.restoreFocus && lastDrawerTrigger && typeof lastDrawerTrigger.focus === 'function') {
        lastDrawerTrigger.focus({ preventScroll: true });
    }

    if (wasOpen) {
        lastDrawerTrigger = null;
    }
}

function toggleDrawer(triggerElement) {
    refs.drawer?.classList.contains('journal-drawer-open') ? closeDrawer({ restoreFocus: true }) : openDrawer(triggerElement);
}

function restoreFocus(focusId) {
    if (!focusId) return;

    requestAnimationFrame(() => {
        const target = document.getElementById(focusId);
        if (!target) return;
        target.focus({ preventScroll: true });
        if (typeof target.setSelectionRange === 'function') {
            const end = target.value.length;
            target.setSelectionRange(end, end);
        }
    });
}

function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
