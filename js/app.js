import { loadTravelData, loadTravelRecords } from './data.js';
import { buildFallbackTitle, escapeHtml } from './utils.js';

const DEFAULT_LEDGER_SORT = 'desc';
const LEDGER_SORT_OPTIONS = new Set(['desc', 'asc', 'location', 'province', 'title']);
const LEDGER_FILTER_DEFAULTS = {
    year: 'all',
    month: 'all',
    province: 'all',
    city: 'all',
    visit: 'all',
    media: 'all',
    q: '',
    sort: DEFAULT_LEDGER_SORT
};
const PAGE_TURN_MS = 480;
const PAGE_TURN_SWAP_MS = 140;
const SEARCH_UPDATE_DELAY_MS = 180;
const COVER_RECENT_RECORD_LIMIT = 7;
const COVER_RECENT_RECORD_MIN = 2;
const COVER_RECENT_RECORD_RESERVED_HEIGHT = 132;
const COVER_RECENT_RECORD_ROW_HEIGHT = 108;
const ROUTE_MAP_SLOTS = [
    { ticket: 'ticket-a', stamp: 'stamp-a', label: '01' },
    { ticket: 'ticket-b', stamp: 'stamp-b', label: '02' },
    { ticket: 'ticket-c', stamp: 'stamp-c', label: '03' },
    { ticket: 'ticket-d', stamp: 'stamp-d', label: '04' },
    { ticket: 'ticket-e', stamp: 'stamp-e', label: '05' },
    { ticket: 'ticket-f', stamp: 'stamp-f', label: '06' }
];

const refs = {};
let travelModel = null;
let activeRoute = null;
let pageTurnTimer = null;
let lastReadingHash = '#ledger';
let lastEntryFocusId = '';
let searchRouteTimer = null;
let isSearchComposing = false;
let viewportResizeTimer = null;

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
    refs.sheet = document.getElementById('sheetRoot');
}

function bindGlobalEvents() {
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('keydown', handleDocumentKeydown);
    document.addEventListener('input', handleDocumentInput);
    document.addEventListener('change', handleDocumentChange);
    document.addEventListener('compositionstart', handleSearchCompositionStart);
    document.addEventListener('compositionend', handleSearchCompositionEnd);
    window.addEventListener('hashchange', () => syncRouteFromHash());
    window.addEventListener('resize', handleViewportResize);
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
                    month: normalizeMonth(params.get('month')),
                    province: normalizeFilterValue(params.get('province')),
                    city: normalizeFilterValue(params.get('city')),
                    visit: normalizeVisit(params.get('visit')),
                    media: normalizeMedia(params.get('media')),
                    q: (params.get('q') || '').trim(),
                    sort: normalizeLedgerSort(params.get('sort'))
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
            {
                const ledgerParams = normalizeLedgerParams(route.params);
                if (ledgerParams.year !== 'all') params.set('year', ledgerParams.year);
                if (ledgerParams.month !== 'all') params.set('month', ledgerParams.month);
                if (ledgerParams.province !== 'all') params.set('province', ledgerParams.province);
                if (ledgerParams.city !== 'all') params.set('city', ledgerParams.city);
                if (ledgerParams.visit !== 'all') params.set('visit', ledgerParams.visit);
                if (ledgerParams.media !== 'all') params.set('media', ledgerParams.media);
                if (ledgerParams.q) params.set('q', ledgerParams.q);
                if (ledgerParams.sort !== DEFAULT_LEDGER_SORT) params.set('sort', ledgerParams.sort);
            }
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
    clearSearchRouteTimer();
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
        restoreFocus(options.focusId);
    }, { direction, animate: options.animate !== false && !options.initial });
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
    const firstDate = sortedAsc.find(record => record.date)?.date || '';
    const lastDate = recordsDesc.find(record => record.date)?.date || '';
    const dateRangeCompact = formatDateRange(firstDate, lastDate, 'month');
    const dateRangeLabel = formatDateRange(firstDate, lastDate, 'day');
    const countries = buildLocationIndex(enhanced);
    const latestRecord = recordsDesc[0] || null;
    const firstRecord = sortedAsc[0] || null;
    const yearStats = buildYearStats(enhanced);
    const monthStats = buildMonthStats(enhanced);
    const topProvinces = buildTopProvinces(countries);
    const repeatLocations = buildRepeatLocations(enhanced);
    const filterOptions = buildLedgerFilterOptions(enhanced);

    return {
        records: enhanced,
        recordsDesc,
        recordsById,
        years,
        yearRange,
        yearRangeShort,
        dateRangeCompact,
        dateRangeLabel,
        countries,
        firstRecord,
        yearStats,
        monthStats,
        topProvinces,
        repeatLocations,
        filterOptions,
        stats: {
            total: enhanced.length,
            countries: countries.length,
            provinces: countries.reduce((sum, country) => sum + country.provinces.length, 0),
            cities: new Set(enhanced.map(record => [record.country, record.province, record.city].join('|'))).size
        },
        latestRecord
    };
}

function buildYearStats(records) {
    const yearMap = new Map();

    records.forEach((record) => {
        const year = record.year || '未知';
        const item = yearMap.get(year) || {
            year,
            count: 0,
            cities: new Set(),
            firstDate: '',
            latestDate: ''
        };

        item.count += 1;
        item.cities.add(record.locationKey || getLocationText(record));
        item.firstDate = !item.firstDate || (record.date || '') < item.firstDate ? (record.date || '') : item.firstDate;
        item.latestDate = maxDate(item.latestDate, record.date);
        yearMap.set(year, item);
    });

    return Array.from(yearMap.values())
        .map(item => ({
            ...item,
            cityCount: item.cities.size,
            cities: undefined
        }))
        .sort((a, b) => b.year.localeCompare(a.year));
}

function buildTopProvinces(countries) {
    return countries
        .flatMap(country => country.provinces)
        .sort((a, b) => b.count - a.count || b.cityCount - a.cityCount || a.label.localeCompare(b.label, 'zh-CN'));
}

function buildMonthStats(records) {
    const monthMap = new Map();

    records.forEach(record => {
        const month = record.month;
        if (!month) {
            return;
        }

        const item = monthMap.get(month) || {
            month,
            label: `${Number(month)}月`,
            count: 0,
            cities: new Set(),
            latestDate: ''
        };

        item.count += 1;
        item.cities.add(record.locationKey || getLocationText(record));
        item.latestDate = maxDate(item.latestDate, record.date);
        monthMap.set(month, item);
    });

    return Array.from(monthMap.values())
        .map(item => ({
            ...item,
            cityCount: item.cities.size,
            cities: undefined
        }))
        .sort((a, b) => a.month.localeCompare(b.month));
}

function buildRepeatLocations(records) {
    const locationMap = new Map();

    records.forEach((record) => {
        const key = record.locationKey || getLocationText(record);
        if (!key) return;

        const item = locationMap.get(key) || {
            key,
            record,
            count: 0,
            firstDate: '',
            latestDate: ''
        };

        item.count += 1;
        item.firstDate = !item.firstDate || (record.date || '') < item.firstDate ? (record.date || '') : item.firstDate;
        item.latestDate = maxDate(item.latestDate, record.date);
        if ((record.date || '') >= (item.record.date || '')) {
            item.record = record;
        }
        locationMap.set(key, item);
    });

    return Array.from(locationMap.values())
        .filter(item => item.count > 1)
        .sort((a, b) => b.count - a.count || b.latestDate.localeCompare(a.latestDate));
}

function buildLedgerFilterOptions(records) {
    const provinceMap = new Map();
    const cityMap = new Map();
    const months = new Set();

    records.forEach((record) => {
        if (record.month) {
            months.add(record.month);
        }

        const provinceKey = record.province || record.country || '未知地点';
        const province = provinceMap.get(provinceKey) || {
            value: provinceKey,
            label: provinceKey,
            count: 0,
            latestDate: ''
        };
        province.count += 1;
        province.latestDate = maxDate(province.latestDate, record.date);
        provinceMap.set(provinceKey, province);

        const cityKey = [provinceKey, record.city || provinceKey].join('|');
        const city = cityMap.get(cityKey) || {
            value: record.city || provinceKey,
            label: record.city || provinceKey,
            province: provinceKey,
            count: 0,
            latestDate: ''
        };
        city.count += 1;
        city.latestDate = maxDate(city.latestDate, record.date);
        cityMap.set(cityKey, city);
    });

    return {
        months: Array.from(months).sort((a, b) => a.localeCompare(b)).map(month => ({
            value: month,
            label: `${Number(month)}月`
        })),
        provinces: Array.from(provinceMap.values())
            .sort((a, b) => b.count - a.count || b.latestDate.localeCompare(a.latestDate) || a.label.localeCompare(b.label, 'zh-CN')),
        cities: Array.from(cityMap.values())
            .sort((a, b) => a.province.localeCompare(b.province, 'zh-CN') || a.label.localeCompare(b.label, 'zh-CN'))
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
    const routeRecords = getRouteMapRecords();
    const recentRecordCount = getCoverRecentRecordCount();
    const recentRecords = travelModel.recordsDesc.slice(0, recentRecordCount);

    setPages(`
        <div class="cover-page cover-recent-page">
            <h1 class="archive-home-title">最近旅行记录</h1>
            <p class="journal-label">最近记录</p>
            <div class="cover-record-list">
                ${recentRecords.length ? recentRecords.map(renderCoverRecord).join('') : '<div class="empty-note">还没有旅行记录。</div>'}
            </div>
        </div>
    `, `
        <div class="pocket-page">
            <div class="route-insert">
                <div class="route-map-label">
                    <strong>随机路线图</strong>
                    <span>本次抽取 ${routeRecords.length} 座城市</span>
                </div>
                <div class="route-sketch route-collage" aria-label="随机旅行路线拼贴">
                    <svg class="route-doodle" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false" aria-hidden="true">
                        <path class="doodle-route" d="M12 72 C26 52 34 73 48 50 S69 37 86 22" />
                        <path class="doodle-river" d="M5 34 C17 25 25 38 36 31 S55 18 70 31 S84 45 95 36" />
                        <path class="doodle-hill" d="M8 84 L18 69 L27 84 M24 84 L36 62 L50 84 M70 78 L79 65 L90 78" />
                        <circle class="doodle-sun" cx="83" cy="18" r="5" />
                    </svg>
                    <span class="route-washi route-washi-a" aria-hidden="true"></span>
                    <span class="route-washi route-washi-b" aria-hidden="true"></span>
                    <span class="route-postmark" aria-hidden="true">TRAVEL<br>DIARY</span>
                    ${routeRecords.length ? renderRouteMap(routeRecords) : '<span class="route-map-empty">还没有城市可抽取</span>'}
                    <span class="map-compass">N</span>
                </div>
            </div>
        </div>
    `);
}

function getCoverRecentRecordCount() {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 720;
    const pageHeight = refs.leftPage?.clientHeight || refs.stage?.clientHeight || viewportHeight;
    const usableHeight = Math.max(0, pageHeight - COVER_RECENT_RECORD_RESERVED_HEIGHT);
    const availableSlots = Math.max(COVER_RECENT_RECORD_MIN, Math.floor(usableHeight / COVER_RECENT_RECORD_ROW_HEIGHT));

    return Math.min(COVER_RECENT_RECORD_LIMIT, availableSlots);
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
    const uniqueRecords = [];

    travelModel.recordsDesc.forEach((record) => {
        const key = record.locationKey || [record.country, record.province, record.city].filter(Boolean).join('|');
        if (!key || seenLocations.has(key)) {
            return;
        }

        seenLocations.add(key);
        uniqueRecords.push(record);
    });

    const slotLimit = Math.min(ROUTE_MAP_SLOTS.length, uniqueRecords.length);
    if (slotLimit === 0) {
        return [];
    }

    const minimumCount = Math.min(3, slotLimit);
    const randomCount = minimumCount + Math.floor(Math.random() * (slotLimit - minimumCount + 1));

    return shuffleRecords(uniqueRecords)
        .slice(0, randomCount)
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

function shuffleRecords(records) {
    const shuffled = [...records];

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }

    return shuffled;
}

function renderRouteMap(records) {
    return records.map((record, index) => {
        const slot = ROUTE_MAP_SLOTS[index];
        const entryHref = `#entry?id=${encodeURIComponent(record.id)}`;
        const label = getLocationText(record);
        const place = record.city || record.province || record.country;
        const date = record.date ? record.date.replace(/-/g, '.') : '未注明日期';

        return `
            <a class="route-ticket ${slot.ticket}" href="${entryHref}" data-record-id="${escapeHtml(record.id)}" aria-label="打开 ${escapeHtml(label)} 的旅行记录">
                <span class="route-ticket-label">${escapeHtml(slot.label)}</span>
                <strong class="route-ticket-place">${escapeHtml(place)}</strong>
                <small>${escapeHtml(date)}</small>
                <span class="ticket-stamp ${slot.stamp}" aria-hidden="true">${escapeHtml((record.province || record.country || '出发').slice(0, 3))}</span>
            </a>
        `;
    }).join('');
}

function renderLedger(params = {}) {
    const ledgerParams = normalizeLedgerParams(params);
    const filtered = getLedgerRecords(ledgerParams);
    const resultLabel = createLedgerResultLabel(filtered.length, travelModel.records.length, ledgerParams);
    const snapshot = getLedgerSnapshot(filtered);

    setPages(`
        <div class="ledger-page">
            <header class="page-head">
                <p class="journal-label">路线档案</p>
                <h1>出发，到新的爱与喧闹中去！</h1>
            </header>
            ${renderLedgerControls(ledgerParams, 'ledgerSearch')}
            <div class="year-bookmarks" aria-label="年份书签">
                ${yearLink('全部', 'all', ledgerParams)}
                ${travelModel.years.map(year => yearLink(year, year, ledgerParams)).join('')}
            </div>
            <p class="result-count" aria-live="polite">${escapeHtml(resultLabel)}</p>
            <div class="timeline-list" id="ledgerList">
                ${filtered.length ? renderLedgerGroups(filtered, ledgerParams) : '<div class="empty-note">没有找到匹配的旅行记录。</div>'}
            </div>
        </div>
    `, `
            <p class="journal-label">索引夹层</p>
            <h2>当前列表工具</h2>
            ${renderLedgerSnapshot(snapshot, resultLabel)}
            <div class="index-actions">
                <button class="brass-toggle" type="button" data-action="toggle-sort" aria-pressed="${ledgerParams.sort === 'asc' ? 'true' : 'false'}" aria-label="当前排序：${ledgerParams.sort === 'asc' ? '最早优先' : '最新优先'}">
                    ${ledgerParams.sort === 'asc' ? '切回最新优先' : '切到最早优先'}
                </button>
            </div>
            <section class="index-section">
                <h3>当前筛选</h3>
                ${renderLedgerActiveFilters(ledgerParams)}
                <button class="paper-button full-width" type="button" data-action="reset-ledger-filters" ${hasActiveLedgerFilter(ledgerParams) || ledgerParams.sort !== DEFAULT_LEDGER_SORT ? '' : 'disabled'}>清空筛选</button>
            </section>
            <section class="index-section">
                <h3>排序方式</h3>
                <div class="index-sort-note">
                    <span>当前</span>
                    <strong>${escapeHtml(getLedgerSortLabel(ledgerParams.sort))}</strong>
                </div>
            </section>
            <section class="index-section">
                <h3>年份跳转</h3>
                <div class="year-count-links">
                    ${travelModel.yearStats.map(stat => renderYearCountLink(stat, ledgerParams)).join('')}
                </div>
            </section>
    `, 'map-pocket');
}

function createLedgerResultLabel(count, total, params) {
    const hasFilter = hasActiveLedgerFilter(params);

    if (!hasFilter) {
        return `共 ${total} 条旅行记录`;
    }

    return `显示 ${count} / ${total} 条记录`;
}

function getLedgerSnapshot(records) {
    const sorted = [...records].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const cities = new Set(records.map(record => record.locationKey || getLocationText(record)).filter(Boolean));
    const provinces = new Set(records.map(record => [record.country, record.province].filter(Boolean).join('|')).filter(Boolean));
    const firstDate = sorted[0]?.date || '';
    const latestDate = sorted[sorted.length - 1]?.date || '';

    return {
        count: records.length,
        cityCount: cities.size,
        provinceCount: provinces.size,
        dateRange: formatDateRange(firstDate, latestDate, 'day')
    };
}

function renderLedgerSnapshot(snapshot, resultLabel) {
    return `
        <div class="index-dashboard" aria-label="当前路线索引快照">
            <div class="index-dashboard-main">
                <span>${escapeHtml(resultLabel)}</span>
                <strong>${snapshot.count}</strong>
            </div>
            <div class="index-dashboard-grid">
                <span><strong>${snapshot.cityCount}</strong> 座城市</span>
                <span><strong>${snapshot.provinceCount}</strong> 个省份</span>
                <span>${escapeHtml(snapshot.dateRange)}</span>
            </div>
        </div>
    `;
}

function renderLedgerActiveFilters(params) {
    const labels = getActiveLedgerFilterLabels(params);

    if (!labels.length) {
        labels.push('全部记录');
    }

    return `
        <div class="index-filter-summary" aria-label="当前筛选条件">
            ${labels.map(label => `<span>${escapeHtml(label)}</span>`).join('')}
        </div>
    `;
}

function getLedgerSortLabel(sort) {
    switch (normalizeLedgerSort(sort)) {
        case 'asc':
            return '最早优先';
        case 'location':
            return '按地点名称';
        case 'province':
            return '按省份归类';
        case 'title':
            return '按标题名称';
        case 'desc':
        default:
            return '最新优先';
    }
}

function renderYearCountLink(stat, params) {
    const nextParams = normalizeLedgerParams({ ...params, year: stat.year });
    const active = nextParams.year === normalizeLedgerParams(params).year;

    return `
        <a class="year-count-link${active ? ' year-count-link-active' : ''}" href="${serializeRoute({ name: 'ledger', params: nextParams })}">
            <strong>${escapeHtml(stat.year)}</strong>
            <span>${stat.count} 条 · ${stat.cityCount} 城</span>
        </a>
    `;
}

function renderArchive(params = {}) {
    const query = (params.q || '').trim().toLowerCase();
    const latest = travelModel.latestRecord;
    const topYear = getTopYearStat(travelModel.yearStats);
    const topMonth = getTopMonthStat(travelModel.monthStats);
    const leadingProvince = travelModel.topProvinces[0] || null;
    const leadingRepeat = travelModel.repeatLocations[0] || null;
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
                <p class="journal-label">个人主页</p>
                <p class="page-copy">"I was surprised, as always, by how easy the act of leaving was, and how good it felt. The world was suddenly rich with possibility."</p>
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
            <p class="journal-label">旅行概览</p>
            <h2>足迹摘要</h2>
            <section class="archive-overview-hero" aria-label="旅行记录摘要">
                <span>记录跨度</span>
                <strong>${escapeHtml(travelModel.dateRangeLabel)}</strong>
                <small>${travelModel.stats.total} 篇日记${latest ? ` · 最近 ${escapeHtml(latest.date || '')} 写到 ${escapeHtml(getLocationText(latest))}` : ''}</small>
            </section>
            <section class="archive-overview-block">
                <h3>覆盖范围</h3>
                <div class="overview-metric-grid">
                    ${renderOverviewMetric('国家', travelModel.stats.countries)}
                    ${renderOverviewMetric('省份', travelModel.stats.provinces)}
                    ${renderOverviewMetric('城市', travelModel.stats.cities)}
                </div>
            </section>
            <section class="archive-overview-block">
                <h3>记录节奏</h3>
                <div class="overview-insight-list">
                    ${renderTopYearInsight(topYear)}
                    ${renderTopMonthInsight(topMonth)}
                </div>
            </section>
            <section class="archive-overview-block">
                <h3>地点倾向</h3>
                <div class="overview-insight-list">
                    ${renderTopProvinceInsight(leadingProvince)}
                    ${renderRepeatLocationInsight(leadingRepeat)}
                </div>
            </section>
    `, 'dossier-page');
}

function renderOverviewMetric(label, value) {
    return `
        <div class="overview-metric">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
        </div>
    `;
}

function renderTopYearInsight(stat) {
    if (!stat) {
        return renderEmptyOverviewInsight('年度高峰', '暂无记录');
    }

    return `
        <a class="overview-insight" href="${serializeRoute({ name: 'ledger', params: { year: stat.year, q: '', sort: DEFAULT_LEDGER_SORT } })}">
            <span>年度高峰</span>
            <strong>${escapeHtml(stat.year)}</strong>
            <small>${stat.count} 篇日记 · ${stat.cityCount} 城</small>
        </a>
    `;
}

function renderTopMonthInsight(stat) {
    if (!stat) {
        return renderEmptyOverviewInsight('常出发月份', '暂无记录');
    }

    return `
        <a class="overview-insight" href="${serializeRoute({ name: 'ledger', params: { month: stat.month, q: '', sort: DEFAULT_LEDGER_SORT } })}">
            <span>常出发月份</span>
            <strong>${escapeHtml(stat.label)}</strong>
            <small>${stat.count} 篇日记 · ${stat.cityCount} 城</small>
        </a>
    `;
}

function renderTopProvinceInsight(province) {
    if (!province) {
        return renderEmptyOverviewInsight('高频省份', '暂无地点');
    }

    return `
        <a class="overview-insight" href="${placeHash(province.country, province.province, '')}">
            <span>高频省份</span>
            <strong>${escapeHtml(province.label)}</strong>
            <small>${province.count} 篇日记 · ${province.cityCount} 城</small>
        </a>
    `;
}

function renderRepeatLocationInsight(item) {
    if (!item) {
        return renderEmptyOverviewInsight('复访地点', '暂无复访');
    }

    const record = item.record;

    return `
        <a class="overview-insight" href="${placeHash(record.country, record.province, record.city)}">
            <span>复访地点</span>
            <strong>${escapeHtml(getLocationText(record))}</strong>
            <small>${item.count} 次 · ${escapeHtml(item.firstDate)} 至 ${escapeHtml(item.latestDate)}</small>
        </a>
    `;
}

function renderEmptyOverviewInsight(label, value) {
    return `
        <div class="overview-insight">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
        </div>
    `;
}

function getTopYearStat(yearStats) {
    return [...yearStats].sort((a, b) => b.count - a.count || b.year.localeCompare(a.year))[0] || null;
}

function getTopMonthStat(monthStats) {
    return [...monthStats].sort((a, b) => b.count - a.count || b.cityCount - a.cityCount || a.month.localeCompare(b.month))[0] || null;
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
    `, 'dossier-page');
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

function handleClearSearch(button) {
    const target = button.getAttribute('data-target');
    clearSearchRouteTimer();

    if (target === 'ledger') {
        updateLedgerRoute({ q: '' }, { replace: true, focusId: 'ledgerSearch', animate: false });
        return;
    }

    if (target === 'archive') {
        navigateTo({ name: 'archive', params: { q: '' } }, { replace: true, focusId: 'archiveSearch', animate: false });
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

    const resetLedgerFilters = event.target.closest('[data-action="reset-ledger-filters"]');
    if (resetLedgerFilters) {
        event.preventDefault();
        updateLedgerRoute(
            { ...LEDGER_FILTER_DEFAULTS },
            { replace: true, focusId: 'ledgerSearch', animate: false }
        );
        return;
    }

    const ledgerToggle = event.target.closest('[data-ledger-toggle]');
    if (ledgerToggle) {
        event.preventDefault();
        const key = ledgerToggle.getAttribute('data-ledger-toggle');
        const value = ledgerToggle.getAttribute('data-value') || 'all';
        if (key) {
            updateLedgerRoute({ [key]: value }, { replace: true, animate: false });
        }
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

    const sortToggle = event.target.closest('[data-action="toggle-sort"]');
    if (sortToggle) {
        event.preventDefault();
        updateLedgerRoute({ sort: getCurrentLedgerSort() === 'asc' ? 'desc' : 'asc' });
        return;
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
    if (!isSearchInput(event.target)) {
        return;
    }

    if (event.isComposing || isSearchComposing) {
        return;
    }

    scheduleSearchRouteUpdate(event.target);
}

function handleDocumentChange(event) {
    const filter = event.target.closest('[data-ledger-filter]');
    if (!filter) {
        return;
    }

    const key = filter.getAttribute('data-ledger-filter');
    const value = filter.value || 'all';
    const nextParams = { [key]: value };

    if (key === 'province') {
        nextParams.city = 'all';
    }

    updateLedgerRoute(nextParams, { replace: true, focusId: filter.id || '', animate: false });
}

function handleSearchCompositionStart(event) {
    if (!isSearchInput(event.target)) {
        return;
    }

    isSearchComposing = true;
    clearSearchRouteTimer();
}

function handleSearchCompositionEnd(event) {
    if (!isSearchInput(event.target)) {
        return;
    }

    isSearchComposing = false;
    scheduleSearchRouteUpdate(event.target, { immediate: true });
}

function isSearchInput(target) {
    return Boolean(target?.matches?.('#ledgerSearch, #archiveSearch'));
}

function scheduleSearchRouteUpdate(input, options = {}) {
    const pending = {
        id: input.id,
        value: input.value
    };

    clearSearchRouteTimer();

    if (options.immediate) {
        applySearchRouteUpdate(pending);
        return;
    }

    searchRouteTimer = window.setTimeout(() => {
        searchRouteTimer = null;
        applySearchRouteUpdate(pending);
    }, SEARCH_UPDATE_DELAY_MS);
}

function clearSearchRouteTimer() {
    if (!searchRouteTimer) {
        return;
    }

    window.clearTimeout(searchRouteTimer);
    searchRouteTimer = null;
}

function handleViewportResize() {
    if (activeRoute?.name !== 'cover') {
        return;
    }

    if (viewportResizeTimer) {
        window.clearTimeout(viewportResizeTimer);
    }

    viewportResizeTimer = window.setTimeout(() => {
        viewportResizeTimer = null;
        if (activeRoute?.name === 'cover') {
            renderCover();
        }
    }, 120);
}

function applySearchRouteUpdate({ id, value }) {
    if (id === 'ledgerSearch') {
        if (activeRoute?.name === 'ledger' && normalizeLedgerParams(activeRoute.params).q === value) return;
        updateLedgerRoute({ q: value }, { replace: true, focusId: 'ledgerSearch', animate: false });
        return;
    }

    if (id === 'archiveSearch') {
        if (activeRoute?.name === 'archive' && (activeRoute.params.q || '') === value) return;
        navigateTo({ name: 'archive', params: { q: value } }, { replace: true, focusId: 'archiveSearch', animate: false });
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

function setPages(leftHtml, rightHtml, rightPageMode = '') {
    refs.leftPage.innerHTML = leftHtml;
    refs.rightPage.className = ['paper-page', 'paper-page-right', rightPageMode].filter(Boolean).join(' ');
    refs.rightPage.innerHTML = rightHtml;
}

function getLedgerRecords(params) {
    const normalized = normalizeLedgerParams(params);
    const query = normalized.q.toLowerCase();
    const records = travelModel.records.filter((record) => {
        const yearMatch = normalized.year === 'all' || record.year === normalized.year;
        const monthMatch = normalized.month === 'all' || record.month === normalized.month;
        const provinceMatch = normalized.province === 'all' || (record.province || record.country || '未知地点') === normalized.province;
        const cityMatch = normalized.city === 'all' || (record.city || record.province || record.country || '未知地点') === normalized.city;
        const visitMatch = normalized.visit === 'all' || (normalized.visit === 'repeat' ? record.isRepeated : !record.isRepeated);
        const hasPhotos = Array.isArray(record.photos) && record.photos.length > 0;
        const mediaMatch = normalized.media === 'all' || (normalized.media === 'photos' ? hasPhotos : !hasPhotos);
        const searchMatch = !query || record.searchText.includes(query);
        return yearMatch && monthMatch && provinceMatch && cityMatch && visitMatch && mediaMatch && searchMatch;
    });

    return records.sort((a, b) => compareLedgerRecords(a, b, normalized.sort));
}

function compareLedgerRecords(a, b, sort) {
    switch (sort) {
        case 'asc':
            return (a.date || '').localeCompare(b.date || '') || getLocationText(a).localeCompare(getLocationText(b), 'zh-CN');
        case 'location':
            return getLocationText(a).localeCompare(getLocationText(b), 'zh-CN') || (b.date || '').localeCompare(a.date || '');
        case 'province':
            return (a.province || a.country || '').localeCompare(b.province || b.country || '', 'zh-CN') || (b.date || '').localeCompare(a.date || '');
        case 'title':
            return (a.title || '').localeCompare(b.title || '', 'zh-CN') || (b.date || '').localeCompare(a.date || '');
        case 'desc':
        default:
            return (b.date || '').localeCompare(a.date || '') || getLocationText(a).localeCompare(getLocationText(b), 'zh-CN');
    }
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
        </div>
    `;
}

function renderLedgerGroups(records, params = {}) {
    const sort = normalizeLedgerParams(params).sort;
    const groups = [];
    let currentKey = '';
    let currentRecords = [];

    records.forEach((record) => {
        const label = getLedgerGroupLabel(record, sort);
        const key = `${sort}:${label}`;

        if (currentKey && key !== currentKey) {
            groups.push({ label: currentKey.split(':').slice(1).join(':'), records: currentRecords });
            currentRecords = [];
        }

        currentKey = key;
        currentRecords.push(record);
    });

    if (currentRecords.length) {
        groups.push({ label: currentKey.split(':').slice(1).join(':'), records: currentRecords });
    }

    return groups.map(group => `
        <section class="ledger-year-group" aria-label="${escapeHtml(getLedgerGroupAriaLabel(group.label, sort))}">
            <div class="ledger-year-divider">
                <span>${escapeHtml(group.label)}</span>
                <small>${group.records.length} 条记录</small>
            </div>
            <div class="ledger-year-entries">
                ${group.records.map(renderLedgerEntry).join('')}
            </div>
        </section>
    `).join('');
}

function getLedgerGroupLabel(record, sort) {
    if (sort === 'province' || sort === 'location') {
        return record.province || record.country || '未知地点';
    }

    if (sort === 'title') {
        return '按标题排序';
    }

    return record.year || (record.date || '').slice(0, 4) || '未知';
}

function getLedgerGroupAriaLabel(label, sort) {
    if (sort === 'province' || sort === 'location') {
        return `${label} 路线`;
    }

    if (sort === 'title') {
        return '按标题排序的路线';
    }

    return `${label} 年路线`;
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

function filterToggleButton(label, key, value, activeValue) {
    const active = value === activeValue;

    return `
        <button class="drawer-segment${active ? ' drawer-segment-active' : ''}" type="button" data-ledger-toggle="${escapeHtml(key)}" data-value="${escapeHtml(value)}" aria-pressed="${active ? 'true' : 'false'}">
            ${escapeHtml(label)}
        </button>
    `;
}

function renderLedgerSortOptions(activeSort) {
    const options = [
        ['desc', '最新优先'],
        ['asc', '最早优先'],
        ['location', '按地点名称'],
        ['province', '按省份归类'],
        ['title', '按标题名称']
    ];

    return options.map(([value, label]) => `<option value="${value}"${activeSort === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
}

function getCityFilterOptions(province) {
    const normalizedProvince = normalizeFilterValue(province);

    return travelModel.filterOptions.cities.filter(city => normalizedProvince === 'all' || city.province === normalizedProvince);
}

function getActiveLedgerFilterLabels(params) {
    const normalized = normalizeLedgerParams(params);
    const labels = [];

    if (normalized.year !== 'all') labels.push(`${normalized.year}年`);
    if (normalized.month !== 'all') labels.push(`${Number(normalized.month)}月`);
    if (normalized.province !== 'all') labels.push(normalized.province);
    if (normalized.city !== 'all') labels.push(normalized.city);
    if (normalized.visit === 'first') labels.push('首次到访');
    if (normalized.visit === 'repeat') labels.push('再次到访');
    if (normalized.media === 'photos') labels.push('有照片');
    if (normalized.media === 'none') labels.push('无照片');
    if (normalized.q) labels.push(`搜索：${normalized.q}`);

    return labels;
}

function hasActiveLedgerFilter(params) {
    const normalized = normalizeLedgerParams(params);

    return normalized.year !== 'all'
        || normalized.month !== 'all'
        || normalized.province !== 'all'
        || normalized.city !== 'all'
        || normalized.visit !== 'all'
        || normalized.media !== 'all'
        || Boolean(normalized.q);
}

function yearLink(label, year, params) {
    const nextParams = normalizeLedgerParams({ ...params, year });
    const active = nextParams.year === normalizeLedgerParams(params).year;
    return `<a class="year-bookmark${active ? ' year-bookmark-active' : ''}" href="${serializeRoute({ name: 'ledger', params: nextParams })}">${escapeHtml(label)}</a>`;
}

function normalizeLedgerParams(params = {}) {
    const normalizedProvince = normalizeFilterValue(params.province);

    return {
        year: normalizeYear(params.year),
        month: normalizeMonth(params.month),
        province: normalizedProvince,
        city: normalizeFilterValue(params.city),
        visit: normalizeVisit(params.visit),
        media: normalizeMedia(params.media),
        q: (params.q || '').trim(),
        sort: normalizeLedgerSort(params.sort)
    };
}

function normalizeYear(year) {
    return year && year !== 'All' ? String(year) : 'all';
}

function normalizeMonth(month) {
    const value = String(month || '').padStart(2, '0');
    return /^(0[1-9]|1[0-2])$/.test(value) ? value : 'all';
}

function normalizeFilterValue(value) {
    const normalized = String(value || '').trim();
    return normalized && normalized !== 'All' ? normalized : 'all';
}

function normalizeVisit(visit) {
    return visit === 'first' || visit === 'repeat' ? visit : 'all';
}

function normalizeMedia(media) {
    return media === 'photos' || media === 'none' ? media : 'all';
}

function normalizeLedgerSort(sort) {
    return LEDGER_SORT_OPTIONS.has(sort) ? sort : DEFAULT_LEDGER_SORT;
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

function formatDateRange(startDate, endDate, precision = 'month') {
    const start = formatDateForRange(startDate, precision);
    const end = formatDateForRange(endDate, precision);

    if (!start && !end) {
        return '未知';
    }

    if (!start || start === end) {
        return end || start;
    }

    if (!end) {
        return start;
    }

    return `${start} - ${end}`;
}

function formatDateForRange(dateStr, precision) {
    const match = String(dateStr || '').match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
    if (!match) {
        return dateStr || '';
    }

    const [, year, month, day] = match;
    if (precision === 'day' && day) {
        return `${year}.${month}.${day}`;
    }

    return `${year}.${month}`;
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
