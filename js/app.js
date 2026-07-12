import { loadTravelData, loadTravelRecords } from './data.js';
import { buildRecordSetSnapshot, deriveOverviewAnalytics } from './analytics.mjs';
import { buildFallbackTitle, escapeHtml } from './utils.js';
import { getRouteMapRandomCount } from './route-map.mjs';
import {
    constrainPhotoViewerTranslate,
    getInitialPhotoScale as calculateInitialPhotoScale,
    getMaximumPhotoScale as calculateMaximumPhotoScale,
    getMinimumPhotoScale as calculateMinimumPhotoScale,
    getPhotoViewerBounds as calculatePhotoViewerBounds,
    getPhotoViewerRenderMetrics
} from './photo-viewer-transform.mjs';

const DEFAULT_LEDGER_SORT = 'desc';
const LEDGER_SORT_OPTIONS = new Set(['desc', 'asc', 'location', 'province', 'title']);
const LEDGER_FILTER_DEFAULTS = {
    year: 'all',
    month: 'all',
    province: 'all',
    city: 'all',
    visit: 'all',
    media: 'all',
    note: 'all',
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
const ENTRY_PHOTO_PREVIEW_ROWS = 3;
const ROUTE_MAP_SLOTS = [
    { ticket: 'ticket-a', stamp: 'stamp-a', label: '01' },
    { ticket: 'ticket-b', stamp: 'stamp-b', label: '02' },
    { ticket: 'ticket-c', stamp: 'stamp-c', label: '03' },
    { ticket: 'ticket-d', stamp: 'stamp-d', label: '04' },
    { ticket: 'ticket-e', stamp: 'stamp-e', label: '05' },
    { ticket: 'ticket-f', stamp: 'stamp-f', label: '06' }
];
const MOBILE_CONTEXT_PANEL_QUERY = '(max-width: 760px)';

const refs = {};
let travelModel = null;
let activeRoute = null;
let pageTurnTimer = null;
let lastReadingHash = '#ledger';
let lastEntryFocusId = '';
let searchRouteTimer = null;
let isSearchComposing = false;
let isMobileContextPanelOpen = false;
let isMobileContextPageScrollLocked = false;
let mobileContextScrollY = 0;
let viewportResizeTimer = null;
let photoPreviewResizeTimer = null;
let photoPreviewLateResizeTimer = null;
let photoSleeveResizeObserver = null;
const PHOTO_ROTATION_ANIMATION_MS = 220;
let photoViewerState = null;
let photoGestureState = createPhotoGestureState();
let photoRotationTimer = null;

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
    document.addEventListener('pointerdown', handlePhotoPointerDown);
    document.addEventListener('pointermove', handlePhotoPointerMove);
    document.addEventListener('pointerup', handlePhotoPointerEnd);
    document.addEventListener('pointercancel', handlePhotoPointerEnd);
    document.addEventListener('dblclick', handlePhotoDoubleClick);
    document.addEventListener('wheel', handlePhotoWheel, { passive: false });
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
                    note: normalizeNote(params.get('note')),
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
        case 'photos':
            return {
                name: 'photos',
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
                if (ledgerParams.note !== 'all') params.set('note', ledgerParams.note);
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
        case 'photos':
            if (route.params.id) params.set('id', route.params.id);
            return `#photos${params.toString() ? `?${params}` : ''}`;
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
                renderLedger(route.params, options);
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
            case 'photos':
                renderEntryPhotosRoute(route.params);
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
    const todayDate = getTodayDate();
    const dateRangeCompact = formatDateRange(firstDate, lastDate, 'month');
    const dateRangeLabel = formatDateRange(firstDate, todayDate, 'day');
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
        overviewAnalytics: deriveOverviewAnalytics(enhanced, todayDate),
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
            ${renderRecordPaperclip()}
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

function renderRecordPaperclip() {
    return `
            <span class="record-paperclip record-paperclip-back" aria-hidden="true"></span>
            <span class="record-paperclip record-paperclip-front" aria-hidden="true"></span>`;
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

    const randomCount = getRouteMapRandomCount(
        getRouteMapAvailableWidth(),
        uniqueRecords.length,
        ROUTE_MAP_SLOTS.length
    );

    return shuffleRecords(uniqueRecords)
        .slice(0, randomCount)
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

function getRouteMapAvailableWidth() {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || ROUTE_MAP_SLOTS.length * 160;
    const panelWidth = refs.rightPage?.clientWidth || refs.stage?.clientWidth || viewportWidth;

    return Math.min(viewportWidth, panelWidth || viewportWidth);
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

function renderLedger(params = {}, options = {}) {
    const ledgerParams = normalizeLedgerParams(params);
    const filtered = getLedgerRecords(ledgerParams);
    const resultLabel = createLedgerResultLabel(filtered.length, travelModel.records.length, ledgerParams);
    const snapshot = buildRecordSetSnapshot(filtered);

    setPages(`
        <div class="ledger-page">
            <header class="page-head">
                <p class="journal-label">路线档案</p>
                <h1>出发，到新的爱与喧闹中去！</h1>
            </header>
            ${renderLedgerControls(ledgerParams, 'ledgerSearch')}
            ${renderMobileContextToggle('打开索引夹层', '查看高级筛选与结果快照')}
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
            ${renderContextPanelHeading('索引夹层', '高级筛选')}
            ${renderLedgerSnapshot(snapshot, resultLabel)}
            ${renderLedgerResetAction(ledgerParams)}
            ${renderLedgerFilterWorkbench(ledgerParams)}
    `, 'map-pocket context-panel', {
        preserveRightScroll: options.preserveRightScroll,
        keepContextPanelOpen: options.keepContextPanelOpen
    });
}

function createLedgerResultLabel(count, total, params) {
    const hasFilter = hasActiveLedgerFilter(params);

    if (!hasFilter) {
        return '全部旅行记录';
    }

    return `筛选结果 · 全部 ${count} 条`;
}

function renderLedgerSnapshot(snapshot, resultLabel) {
    const dateRange = snapshot.count
        ? formatDateRange(snapshot.firstDate, snapshot.latestDate, 'day')
        : '暂无匹配记录';

    return `
        <div class="index-dashboard" aria-label="筛选结果快照">
            <div class="index-dashboard-main">
                <span>${escapeHtml(resultLabel)}</span>
                <strong class="index-dashboard-value">
                    <span>${snapshot.count}</span>
                    <small class="index-dashboard-unit">条</small>
                </strong>
            </div>
            <div class="index-dashboard-grid">
                <span><strong>${snapshot.cityCount}</strong> 座城市</span>
                <span><strong>${snapshot.provinceCount}</strong> 个省份</span>
                <span>${escapeHtml(dateRange)}</span>
            </div>
        </div>
    `;
}

function renderLedgerFilterWorkbench(params) {
    const cityOptions = getCityFilterOptions(params.province);
    const yearOptions = [
        { value: 'all', label: '全部年份' },
        ...travelModel.years.map(year => ({ value: year, label: `${year}年` }))
    ];
    const monthOptions = [
        { value: 'all', label: '全部月份' },
        ...travelModel.filterOptions.months
    ];
    const provinceOptions = [
        { value: 'all', label: '全部省份' },
        ...travelModel.filterOptions.provinces.map(item => ({ value: item.value, label: `${item.label} · ${item.count}` }))
    ];
    const scopedCityOptions = [
        { value: 'all', label: '全部城市' },
        ...cityOptions.map(item => ({
            value: item.value,
            label: params.province === 'all' ? `${item.label} · ${item.province}` : item.label
        }))
    ];
    const sortOptions = [
        { value: 'desc', label: '最新优先' },
        { value: 'asc', label: '最早优先' },
        { value: 'location', label: '按地点名称' },
        { value: 'province', label: '按省份归类' },
        { value: 'title', label: '按标题名称' }
    ];

    return `
        <section class="index-filter-section" aria-labelledby="indexLocationFilters">
            <h3 id="indexLocationFilters">时间与地点</h3>
            <div class="index-filter-grid">
                ${renderLedgerSelect('年份', 'year', yearOptions, params.year)}
                ${renderLedgerSelect('月份', 'month', monthOptions, params.month)}
                ${renderLedgerSelect('省份', 'province', provinceOptions, params.province)}
                ${renderLedgerSelect('城市', 'city', scopedCityOptions, params.city)}
            </div>
        </section>
        <section class="index-filter-section" aria-labelledby="indexRecordFilters">
            <h3 id="indexRecordFilters">记录特征</h3>
            <span class="field-label">到访类型</span>
            <div class="index-segment-group" aria-label="到访类型">
                ${filterToggleButton('全部', 'visit', 'all', params.visit)}
                ${filterToggleButton('首次到访', 'visit', 'first', params.visit)}
                ${filterToggleButton('再次到访', 'visit', 'repeat', params.visit)}
            </div>
            <span class="field-label">照片状态</span>
            <div class="index-segment-group" aria-label="照片状态">
                ${filterToggleButton('全部', 'media', 'all', params.media)}
                ${filterToggleButton('有照片', 'media', 'photos', params.media)}
                ${filterToggleButton('无照片', 'media', 'none', params.media)}
            </div>
            <span class="field-label">笔记内容</span>
            <div class="index-segment-group" aria-label="笔记内容">
                ${filterToggleButton('全部', 'note', 'all', params.note)}
                ${filterToggleButton('有笔记', 'note', 'filled', params.note)}
                ${filterToggleButton('无笔记', 'note', 'empty', params.note)}
            </div>
        </section>
        <section class="index-filter-section" aria-labelledby="indexSortFilter">
            <h3 id="indexSortFilter">排序方式</h3>
            ${renderLedgerSelect('排序方式', 'sort', sortOptions, params.sort, true)}
        </section>
    `;
}

function renderLedgerResetAction(params) {
    const canReset = hasActiveLedgerFilter(params) || params.sort !== DEFAULT_LEDGER_SORT;

    return `
        <div class="index-reset-anchor">
            <button class="paper-button full-width index-reset" type="button" data-action="reset-ledger-filters" ${canReset ? '' : 'disabled'}>重置全部</button>
        </div>
    `;
}

function renderLedgerSelect(label, key, options, activeValue, visuallyHiddenLabel = false) {
    const id = `ledgerFilter${key[0].toUpperCase()}${key.slice(1)}`;
    return `
        <label class="index-filter-field" for="${id}">
            <span class="field-label${visuallyHiddenLabel ? ' sr-only' : ''}">${escapeHtml(label)}</span>
            <select id="${id}" data-ledger-filter="${escapeHtml(key)}">
                ${options.map(option => `<option value="${escapeHtml(option.value)}"${activeValue === option.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
            </select>
        </label>
    `;
}

function renderArchive(params = {}) {
    const query = (params.q || '').trim().toLowerCase();
    const latest = travelModel.latestRecord;
    const topYear = getTopYearStat(travelModel.yearStats);
    const topMonth = getTopMonthStat(travelModel.monthStats);
    const leadingProvince = travelModel.topProvinces[0] || null;
    const broadestProvince = getBroadestProvince(travelModel.topProvinces);
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
            ${renderMobileContextToggle('打开旅行概览', '查看足迹摘要与统计')}
            <div class="archive-country-list">
                ${countries.length ? countries.map(renderCountryFolder).join('') : '<div class="empty-note">没有找到匹配的地点。</div>'}
            </div>
        </div>
    `, `
            ${renderContextPanelHeading('旅行概览', '足迹摘要')}
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
                    ${renderOverviewMetric('活跃年份', travelModel.overviewAnalytics.activeYearCount)}
                    ${renderOverviewMetric('活跃月份', `${travelModel.overviewAnalytics.activeMonthCount} / ${travelModel.overviewAnalytics.activeMonthCapacity}`)}
                    ${renderOverviewMetric('复访地点', `${travelModel.overviewAnalytics.repeatLocationCount} 处`)}
                </div>
            </section>
            <section class="archive-overview-block">
                <h3>记录节奏</h3>
                <div class="overview-insight-list">
                    ${renderTopYearInsight(topYear)}
                    ${renderTopMonthInsight(topMonth)}
                    ${renderLongestGapInsight(travelModel.overviewAnalytics.longestGap)}
                </div>
            </section>
            <section class="archive-overview-block">
                <h3>地点倾向</h3>
                <div class="overview-insight-list overview-location-list">
                    ${renderTopProvinceInsight(leadingProvince)}
                    ${renderBroadProvinceInsight(broadestProvince)}
                    ${renderRepeatLocationInsights(travelModel.repeatLocations)}
                </div>
            </section>
    `, 'dossier-page context-panel');
}

function renderMobileContextToggle(label, description) {
    return `
        <button class="paper-button mobile-context-toggle" type="button" data-action="open-context-panel" aria-controls="rightPage" aria-expanded="false">
            <span>${escapeHtml(label)}</span>
            <small>${escapeHtml(description)}</small>
        </button>
    `;
}

function renderContextPanelHeading(label, title) {
    return `
        <div class="context-panel-heading">
            <div class="context-panel-title">
                <p class="journal-label">${escapeHtml(label)}</p>
                <h2>${escapeHtml(title)}</h2>
            </div>
            <button class="paper-button context-panel-close" type="button" data-action="close-context-panel" aria-label="关闭${escapeHtml(label)}">×</button>
        </div>
    `;
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

function renderLongestGapInsight(longestGap) {
    if (!longestGap) {
        return renderEmptyOverviewInsight('最长记录间隔', '暂无足够记录', true);
    }

    return `
        <div class="overview-insight overview-insight-wide">
            <span>最长记录间隔</span>
            <strong>${longestGap.days} 天</strong>
            <small>${escapeHtml(formatDateRange(longestGap.from, longestGap.to, 'day'))}</small>
        </div>
    `;
}

function renderTopProvinceInsight(province) {
    if (!province) {
        return renderEmptyOverviewInsight('高频省份', '暂无地点');
    }

    return `
        <a class="overview-insight overview-location-feature" href="${placeHash(province.country, province.province, '')}">
            <span>高频省份</span>
            <strong>${escapeHtml(province.label)}</strong>
            <small>${province.count} 篇日记 · ${province.cityCount} 城</small>
        </a>
    `;
}

function renderBroadProvinceInsight(province) {
    if (!province) {
        return renderEmptyOverviewInsight('覆盖最广', '暂无地点');
    }

    return `
        <a class="overview-insight overview-location-secondary" href="${placeHash(province.country, province.province, '')}">
            <span>覆盖最广</span>
            <strong>${escapeHtml(province.label)}</strong>
            <small>${province.cityCount} 座城市 · 最近 ${escapeHtml(province.latestDate)}</small>
        </a>
    `;
}

function renderRepeatLocationInsights(items = []) {
    if (!items.length) {
        return renderEmptyOverviewInsight('复访地点', '暂无复访');
    }

    return items.map(renderRepeatLocationInsight).join('');
}

function renderRepeatLocationInsight(item) {
    const record = item.record;

    return `
        <a class="overview-insight overview-repeat-location" href="${placeHash(record.country, record.province, record.city)}">
            <span>复访地点</span>
            <strong>${escapeHtml(getLocationText(record))}</strong>
            <small>${item.count} 次 · ${escapeHtml(item.firstDate)} 至 ${escapeHtml(item.latestDate)}</small>
        </a>
    `;
}

function renderEmptyOverviewInsight(label, value, wide = false) {
    return `
        <div class="overview-insight${wide ? ' overview-insight-wide' : ''}">
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

function getBroadestProvince(provinces = []) {
    return [...provinces].sort((a, b) => b.cityCount - a.cityCount || b.count - a.count || b.latestDate.localeCompare(a.latestDate))[0] || null;
}

function renderPlace(params = {}) {
    const matching = getPlaceRecords(params);
    const label = getPlaceLabel(params);
    const cities = Array.from(new Set(matching.map(record => record.city).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));

    setPages(`
        <div class="place-page">
            <a class="ribbon-back" href="#archive">返回档案夹</a>
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
    `, 'dossier-page place-detail-page');
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

function renderEntryPhotosRoute(params = {}) {
    const record = travelModel.recordsById.get(params.id);

    if (!record) {
        setPages(`
            <div class="place-page">
                <a class="ribbon-back" href="#ledger">返回路线档案</a>
                <p class="journal-label">照片附件</p>
                <h1>没有找到这篇日记</h1>
            </div>
        `, `
            <div class="photo-note">无法加载对应的照片附件。</div>
        `, 'dossier-page place-detail-page');
        return;
    }

    setPages(`
        <div class="place-page">
            <a class="ribbon-back" href="${serializeRoute({ name: 'entry', params: { id: record.id } })}">返回笔记</a>
            <p class="journal-label">照片附件</p>
            <h1>${escapeHtml(record.title)}</h1>
            <p class="place-count">${escapeHtml(getLocationText(record))} · ${record.photos?.length || 0} 张照片</p>
        </div>
    `, `
        <div class="place-records entry-photos-page">
            <p class="journal-label">全部照片</p>
            ${renderPhotoSleeve(record)}
        </div>
    `, 'dossier-page place-detail-page');
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
            <div class="entry-sheet-frame">
                <button class="sheet-close" type="button" data-action="close-entry" aria-label="合上纸页">×</button>
                <article class="entry-sheet" role="dialog" aria-modal="true" aria-labelledby="entrySheetTitle">
                    <h1 id="entrySheetTitle">没有找到这篇日记</h1>
                </article>
            </div>
        `;
        return;
    }

    const navigation = getEntryNavigation(record);
    refs.sheet.innerHTML = `
        <div class="sheet-backdrop" data-action="close-entry"></div>
        <div class="entry-sheet-frame">
            <button class="sheet-close" type="button" data-action="close-entry" aria-label="合上纸页">×</button>
            <article class="entry-sheet" role="dialog" aria-modal="true" aria-labelledby="entrySheetTitle" tabindex="-1">
                <div class="sheet-meta">
                    <time datetime="${escapeHtml(record.date || '')}">${escapeHtml(record.date || '')}</time>
                    <a class="location-chip" href="${placeHash(record.country, record.province, record.city)}">${escapeHtml(getLocationText(record))}</a>
                </div>
                <h1 id="entrySheetTitle">${escapeHtml(record.title)}</h1>
                <div class="markdown-content">${record.descBodyHtml || '<p>这篇日记还没有正文。</p>'}</div>
                ${renderPhotoSleeve(record, {
                    previewRows: ENTRY_PHOTO_PREVIEW_ROWS,
                    showViewAll: true
                })}
                ${renderEntrySheetNav(navigation)}
            </article>
        </div>
    `;

    requestAnimationFrame(() => {
        queuePhotoSleevePreviewSync();
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

    photoViewerState = null;
    photoGestureState = createPhotoGestureState();
    clearPhotoRotationTimer();
    document.querySelector('[data-photo-viewer]')?.remove();
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

function openPhotoViewer(photos, index = 0) {
    if (!Array.isArray(photos) || photos.length === 0 || !getPhotoViewerRoot()) {
        return;
    }

    photoViewerState = {
        photos,
        index: normalizePhotoIndex(index, photos.length),
        scale: 1,
        initialScale: 1,
        rotation: 0,
        translateX: 0,
        translateY: 0
    };
    photoGestureState = createPhotoGestureState();
    renderPhotoViewer();
}

function renderPhotoViewer() {
    document.querySelector('[data-photo-viewer]')?.remove();
    const root = getPhotoViewerRoot();
    if (!photoViewerState || !root) {
        return;
    }

    const photo = photoViewerState.photos[photoViewerState.index];
    const position = `${photoViewerState.index + 1} / ${photoViewerState.photos.length}`;

    root.insertAdjacentHTML('beforeend', `
        <div class="photo-viewer" data-photo-viewer>
            <div class="photo-viewer-backdrop" data-action="close-photo-viewer"></div>
            <section class="photo-viewer-panel" role="dialog" aria-modal="true" aria-label="照片查看器" tabindex="-1">
                <div class="photo-viewer-toolbar">
                    <div class="photo-viewer-nav-group photo-viewer-control-group" aria-label="照片切换">
                        <button class="photo-viewer-control" type="button" data-action="photo-prev" data-photo-action="prev" aria-label="上一张照片">‹</button>
                        <span class="photo-viewer-count">${escapeHtml(position)}</span>
                        <button class="photo-viewer-control" type="button" data-action="photo-next" data-photo-action="next" aria-label="下一张照片">›</button>
                    </div>
                    <div class="photo-viewer-zoom-group photo-viewer-control-group" aria-label="照片缩放">
                        <button class="photo-viewer-control" type="button" data-action="photo-zoom-out" data-photo-action="zoom-out" aria-label="缩小">−</button>
                        <span class="photo-viewer-zoom" data-photo-viewer-zoom>100%</span>
                        <button class="photo-viewer-control" type="button" data-action="photo-zoom-in" data-photo-action="zoom-in" aria-label="放大">+</button>
                        <button class="photo-viewer-control" type="button" data-action="photo-reset" data-photo-action="reset" aria-label="重置照片">1:1</button>
                    </div>
                    <div class="photo-viewer-rotate-group photo-viewer-control-group" aria-label="照片旋转">
                        <button class="photo-viewer-control" type="button" data-action="photo-rotate-left" data-photo-action="rotate-left" aria-label="向左旋转">↺</button>
                        <button class="photo-viewer-control" type="button" data-action="photo-rotate-right" data-photo-action="rotate-right" aria-label="向右旋转">↻</button>
                    </div>
                </div>
                <button class="photo-viewer-control photo-viewer-close" type="button" data-action="close-photo-viewer" aria-label="关闭照片查看器">×</button>
                <div class="photo-viewer-stage" data-photo-viewer-stage>
                    <div class="photo-viewer-image-frame" data-photo-viewer-frame>
                        <img class="photo-viewer-image" data-photo-viewer-image src="${escapeHtml(photo.src)}" alt="${escapeHtml(photo.alt)}" draggable="false">
                    </div>
                </div>
                <p class="photo-viewer-caption">${escapeHtml(photo.alt)}</p>
            </section>
        </div>
    `);

    const image = getPhotoViewerRoot()?.querySelector('[data-photo-viewer-image]');
    if (image?.complete) {
        fitPhotoToStage();
    } else {
        if (image) {
            image.addEventListener('load', fitPhotoToStage, { once: true });
        }
        updatePhotoViewerTransform();
    }
    requestAnimationFrame(() => {
        getPhotoViewerRoot()?.querySelector('.photo-viewer-panel')?.focus({ preventScroll: true });
    });
}

function closePhotoViewerDialog() {
    document.querySelector('[data-photo-viewer]')?.remove();
    photoViewerState = null;
    photoGestureState = createPhotoGestureState();
    clearPhotoRotationTimer();
}

function getPhotoViewerRoot() {
    if (refs.sheet?.classList.contains('entry-sheet-root-open')) {
        return refs.sheet;
    }

    return document.body;
}

function getPhotoViewerItems(button) {
    const buttons = Array.from(button.closest('.photo-sleeve')?.querySelectorAll('[data-action="open-photo-viewer"]:not([hidden])') || [button]);
    return buttons.map(item => ({
        src: item.dataset.photoSrc || '',
        alt: item.dataset.photoAlt || '旅行照片'
    })).filter(item => item.src);
}

function handlePhotoViewerAction(action) {
    if (!photoViewerState) {
        return;
    }

    switch (action) {
        case 'prev':
            showPhotoAt(photoViewerState.index - 1);
            break;
        case 'next':
            showPhotoAt(photoViewerState.index + 1);
            break;
        case 'zoom-in':
            zoomPhoto(1.16);
            break;
        case 'zoom-out':
            zoomPhoto(0.86);
            break;
        case 'reset':
            resetPhotoTransform();
            break;
        case 'rotate-left':
            rotatePhoto(-90);
            break;
        case 'rotate-right':
            rotatePhoto(90);
            break;
        default:
            break;
    }
}

function showPhotoAt(index) {
    if (!photoViewerState) {
        return;
    }

    photoViewerState.index = normalizePhotoIndex(index, photoViewerState.photos.length);
    resetPhotoTransform({ render: false });
    renderPhotoViewer();
}

function fitPhotoToStage() {
    if (!photoViewerState) {
        return;
    }

    const stage = getPhotoViewerRoot()?.querySelector('[data-photo-viewer-stage]');
    const image = getPhotoViewerRoot()?.querySelector('[data-photo-viewer-image]');
    if (!stage || !image) {
        return;
    }

    photoViewerState.scale = getInitialPhotoScale(stage, image);
    photoViewerState.initialScale = photoViewerState.scale;
    photoViewerState.translateX = 0;
    photoViewerState.translateY = 0;
    updatePhotoViewerTransform();
}

function getInitialPhotoScale(stage, image) {
    const stageRect = stage.getBoundingClientRect();
    return calculateInitialPhotoScale({
        stageWidth: stageRect.width,
        stageHeight: stageRect.height,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight
    });
}

function zoomPhoto(factor, focalPoint) {
    if (!photoViewerState) {
        return;
    }

    const previousScale = photoViewerState.scale;
    const nextScale = clamp(previousScale * factor, getMinimumPhotoScale(), getMaximumPhotoScale());
    if (focalPoint && previousScale > 0) {
        const ratio = nextScale / previousScale;
        photoViewerState.translateX = focalPoint.x - (focalPoint.x - photoViewerState.translateX) * ratio;
        photoViewerState.translateY = focalPoint.y - (focalPoint.y - photoViewerState.translateY) * ratio;
    }
    photoViewerState.scale = nextScale;
    updatePhotoViewerTransform();
}

function getMinimumPhotoScale() {
    if (!photoViewerState) {
        return calculateMinimumPhotoScale();
    }

    return calculateMinimumPhotoScale(photoViewerState.initialScale);
}

function getMaximumPhotoScale() {
    if (!photoViewerState) {
        return calculateMaximumPhotoScale();
    }

    return calculateMaximumPhotoScale(photoViewerState.initialScale);
}

function rotatePhoto(delta) {
    if (!photoViewerState) {
        return;
    }

    photoViewerState.rotation += delta;
    updatePhotoViewerTransform({ animateRotation: true });
}

function resetPhotoTransform(options = {}) {
    if (!photoViewerState) {
        return;
    }

    photoViewerState.scale = 1;
    photoViewerState.rotation = 0;
    photoViewerState.translateX = 0;
    photoViewerState.translateY = 0;
    photoGestureState = createPhotoGestureState();
    if (options.render !== false) {
        updatePhotoViewerTransform();
    }
}

function updatePhotoViewerTransform(options = {}) {
    if (!photoViewerState) {
        return;
    }

    const image = getPhotoViewerRoot()?.querySelector('[data-photo-viewer-image]');
    const frame = getPhotoViewerRoot()?.querySelector('[data-photo-viewer-frame]');
    if (!image || !frame) {
        return;
    }

    constrainPhotoViewerTransform();

    if (options.animateRotation) {
        clearPhotoRotationTimer();
        image.classList.remove('photo-viewer-image-rotating');
        void image.offsetWidth;
        image.classList.add('photo-viewer-image-rotating');
        photoRotationTimer = window.setTimeout(() => {
            image.classList.remove('photo-viewer-image-rotating');
            photoRotationTimer = null;
        }, PHOTO_ROTATION_ANIMATION_MS);
    }

    const renderMetrics = getPhotoViewerRenderMetrics({
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        scale: photoViewerState.scale
    });
    const visualScale = renderMetrics?.transformScale || photoViewerState.scale;

    if (renderMetrics) {
        image.style.width = `${renderMetrics.width}px`;
        image.style.height = `${renderMetrics.height}px`;
    }
    frame.style.transform = `translate3d(calc(-50% + ${photoViewerState.translateX}px), calc(-50% + ${photoViewerState.translateY}px), 0)`;
    image.style.transform = `rotate(${photoViewerState.rotation}deg) scale(${visualScale})`;
    const zoom = getPhotoViewerRoot()?.querySelector('[data-photo-viewer-zoom]');
    if (zoom) {
        zoom.textContent = `${Math.round(photoViewerState.scale * 100)}%`;
    }
}

function constrainPhotoViewerTransform() {
    if (!photoViewerState) {
        return;
    }

    const bounds = getPhotoViewerBounds();
    if (!bounds) {
        return;
    }

    const nextTranslate = constrainPhotoViewerTranslate({
        translateX: photoViewerState.translateX,
        translateY: photoViewerState.translateY,
        bounds
    });

    photoViewerState.translateX = nextTranslate.translateX;
    photoViewerState.translateY = nextTranslate.translateY;
}

function getPhotoViewerBounds() {
    if (!photoViewerState) {
        return null;
    }

    const stage = getPhotoViewerRoot()?.querySelector('[data-photo-viewer-stage]');
    const image = getPhotoViewerRoot()?.querySelector('[data-photo-viewer-image]');
    if (!stage || !image) {
        return null;
    }

    const stageRect = stage.getBoundingClientRect();
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    if (!stageRect.width || !stageRect.height || !sourceWidth || !sourceHeight) {
        return null;
    }

    return calculatePhotoViewerBounds({
        stageWidth: stageRect.width,
        stageHeight: stageRect.height,
        sourceWidth,
        sourceHeight,
        scale: photoViewerState.scale,
        rotation: photoViewerState.rotation
    });
}

function clearPhotoRotationTimer() {
    if (!photoRotationTimer) {
        return;
    }

    window.clearTimeout(photoRotationTimer);
    photoRotationTimer = null;
}

function handlePhotoPointerDown(event) {
    const stage = event.target.closest?.('[data-photo-viewer-stage]');
    if (!stage || !photoViewerState || (event.pointerType === 'mouse' && event.button !== 0)) {
        return;
    }

    event.preventDefault();
    stage.setPointerCapture?.(event.pointerId);
    photoGestureState.pointers.set(event.pointerId, getPointerPoint(event));
    syncPhotoGestureStart();
}

function handlePhotoPointerMove(event) {
    if (!photoViewerState || !photoGestureState.pointers.has(event.pointerId)) {
        return;
    }

    event.preventDefault();
    photoGestureState.pointers.set(event.pointerId, getPointerPoint(event));
    const points = Array.from(photoGestureState.pointers.values());

    if (points.length >= 2 && photoGestureState.pinchStart) {
        const current = getGestureMetrics(points[0], points[1]);
        const start = photoGestureState.pinchStart;
        photoViewerState.scale = clamp(start.scale * (current.distance / Math.max(start.distance, 1)), getMinimumPhotoScale(), getMaximumPhotoScale());
        photoViewerState.translateX = start.translateX + current.centerX - start.centerX;
        photoViewerState.translateY = start.translateY + current.centerY - start.centerY;
        updatePhotoViewerTransform();
        return;
    }

    if (points.length === 1 && photoGestureState.dragStart) {
        const point = points[0];
        photoViewerState.translateX = photoGestureState.dragStart.translateX + point.x - photoGestureState.dragStart.x;
        photoViewerState.translateY = photoGestureState.dragStart.translateY + point.y - photoGestureState.dragStart.y;
        updatePhotoViewerTransform();
    }
}

function handlePhotoPointerEnd(event) {
    if (!photoGestureState.pointers.has(event.pointerId)) {
        return;
    }

    photoGestureState.pointers.delete(event.pointerId);
    syncPhotoGestureStart();
}

function handlePhotoWheel(event) {
    if (!photoViewerState || !event.target.closest?.('[data-photo-viewer]')) {
        return;
    }

    event.preventDefault();
    const stage = getPhotoViewerRoot()?.querySelector('[data-photo-viewer-stage]');
    const rect = stage?.getBoundingClientRect();
    const focalPoint = rect
        ? { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }
        : undefined;
    zoomPhoto(event.deltaY < 0 ? 1.12 : 0.88, focalPoint);
}

function handlePhotoDoubleClick(event) {
    if (!photoViewerState || !event.target.closest?.('[data-photo-viewer-stage]')) {
        return;
    }

    event.preventDefault();
    if (photoViewerState.scale > 1.2) {
        resetPhotoTransform();
        return;
    }

    photoViewerState.scale = 2.2;
    updatePhotoViewerTransform();
}

function syncPhotoGestureStart() {
    const points = Array.from(photoGestureState.pointers.values());
    photoGestureState.dragStart = null;
    photoGestureState.pinchStart = null;

    if (!photoViewerState || points.length === 0) {
        return;
    }

    if (points.length === 1) {
        photoGestureState.dragStart = {
            x: points[0].x,
            y: points[0].y,
            translateX: photoViewerState.translateX,
            translateY: photoViewerState.translateY
        };
        return;
    }

    const metrics = getGestureMetrics(points[0], points[1]);
    photoGestureState.pinchStart = {
        ...metrics,
        scale: photoViewerState.scale,
        translateX: photoViewerState.translateX,
        translateY: photoViewerState.translateY
    };
}

function createPhotoGestureState() {
    return {
        pointers: new Map(),
        dragStart: null,
        pinchStart: null
    };
}

function getPointerPoint(event) {
    return {
        x: event.clientX,
        y: event.clientY
    };
}

function getGestureMetrics(first, second) {
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    return {
        distance: Math.hypot(dx, dy),
        angle: Math.atan2(dy, dx) * 180 / Math.PI,
        centerX: (first.x + second.x) / 2,
        centerY: (first.y + second.y) / 2
    };
}

function isPhotoViewerOpen() {
    return Boolean(photoViewerState && document.querySelector('[data-photo-viewer]'));
}

function normalizePhotoIndex(index, length) {
    if (!length) {
        return 0;
    }

    return ((Number(index) % length) + length) % length;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
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
    const closeContextPanel = event.target.closest('[data-action="close-context-panel"]');
    if (closeContextPanel) {
        event.preventDefault();
        closeMobileContextPanel();
        return;
    }

    const openContextPanel = event.target.closest('[data-action="open-context-panel"]');
    if (openContextPanel) {
        event.preventDefault();
        openMobileContextPanel();
        return;
    }

    if (isMobileContextPanelOpen && refs.rightPage?.classList.contains('context-panel') && !event.target.closest('.paper-page-right.context-panel')) {
        closeMobileContextPanel();
        return;
    }

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

    const closePhotoViewer = event.target.closest('[data-action="close-photo-viewer"]');
    if (closePhotoViewer) {
        event.preventDefault();
        closePhotoViewerDialog();
        return;
    }

    const openPhoto = event.target.closest('[data-action="open-photo-viewer"]');
    if (openPhoto) {
        event.preventDefault();
        const photos = getPhotoViewerItems(openPhoto);
        openPhotoViewer(photos, Number(openPhoto.dataset.photoIndex || 0));
        return;
    }

    const photoAction = event.target.closest('[data-photo-action]');
    if (photoAction) {
        event.preventDefault();
        handlePhotoViewerAction(photoAction.dataset.photoAction);
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
            {
                replace: true,
                focusId: 'ledgerSearch',
                animate: false,
                keepContextPanelOpen: isMobileContextPanelOpen
            }
        );
        return;
    }

    const ledgerToggle = event.target.closest('[data-ledger-toggle]');
    if (ledgerToggle) {
        event.preventDefault();
        const key = ledgerToggle.getAttribute('data-ledger-toggle');
        const value = ledgerToggle.getAttribute('data-value') || 'all';
        if (key) {
            updateLedgerRoute({ [key]: value }, {
                replace: true,
                animate: false,
                preserveRightScroll: true,
                keepContextPanelOpen: isMobileContextPanelOpen
            });
        }
        return;
    }

    const latestAction = event.target.closest('[data-action="open-latest"]');
    if (latestAction) {
        event.preventDefault();
        if (travelModel?.latestRecord) {
            lastReadingHash = getEntryBackgroundHash();
            lastEntryFocusId = '';
            navigateTo({ name: 'entry', params: { id: travelModel.latestRecord.id } });
        }
        return;
    }

    const entryCard = event.target.closest('[data-open-entry]');
    if (entryCard && !event.target.closest('a, button, input')) {
        event.preventDefault();
        lastReadingHash = getEntryBackgroundHash();
        lastEntryFocusId = entryCard.id || '';
        navigateTo({ name: 'entry', params: { id: entryCard.dataset.openEntry } });
        return;
    }

    const routeAnchor = event.target.closest('a[href^="#"]');
    if (routeAnchor) {
        event.preventDefault();
        const href = routeAnchor.getAttribute('href');
        if (href.startsWith('#entry')) {
            lastReadingHash = getEntryBackgroundHash();
            lastEntryFocusId = '';
        }
        navigateTo(href);
    }
}

function getEntryBackgroundHash() {
    if (activeRoute?.name === 'entry' || activeRoute?.name === 'photos') {
        return lastReadingHash || '#ledger';
    }

    return serializeRoute(activeRoute || { name: 'ledger', params: {} });
}

function handleDocumentKeydown(event) {
    if (isPhotoViewerOpen()) {
        if (event.key === 'Escape') {
            event.preventDefault();
            closePhotoViewerDialog();
            return;
        }

        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            showPhotoAt((photoViewerState.index || 0) - 1);
            return;
        }

        if (event.key === 'ArrowRight') {
            event.preventDefault();
            showPhotoAt((photoViewerState.index || 0) + 1);
            return;
        }

        if (event.key === '+' || event.key === '=') {
            event.preventDefault();
            zoomPhoto(1.16);
            return;
        }

        if (event.key === '-' || event.key === '_') {
            event.preventDefault();
            zoomPhoto(0.86);
            return;
        }

        if (event.key === '0') {
            event.preventDefault();
            resetPhotoTransform();
            return;
        }
    }

    if (event.key === 'Escape') {
        if (isMobileContextPanelOpen) {
            event.preventDefault();
            closeMobileContextPanel();
            return;
        }

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

    updateLedgerRoute(nextParams, {
        replace: true,
        focusId: filter.id || '',
        animate: false,
        preserveRightScroll: true,
        keepContextPanelOpen: isMobileContextPanelOpen
    });
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
    syncMobileContextPanelState();
    queuePhotoSleevePreviewSync();

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
    const activeName = routeName === 'entry' || routeName === 'photos' ? 'ledger' : routeName;
    document.querySelectorAll('[data-route-link]').forEach((link) => {
        const isActive = link.dataset.routeLink === activeName;
        link.classList.toggle('chapter-tab-active', isActive);
        link.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
}

function openMobileContextPanel() {
    if (!refs.rightPage?.classList.contains('context-panel')) {
        return;
    }

    isMobileContextPanelOpen = true;
    syncMobileContextPanelState();
    requestAnimationFrame(() => refs.rightPage?.focus({ preventScroll: true }));
}

function closeMobileContextPanel() {
    restoreFocusBeforeHidingContextPanel();
    isMobileContextPanelOpen = false;
    syncMobileContextPanelState();
}

function restoreFocusBeforeHidingContextPanel() {
    if (!refs.rightPage || !refs.rightPage.contains(document.activeElement)) {
        return;
    }

    const toggle = document.querySelector('[data-action="open-context-panel"]');
    if (toggle instanceof HTMLElement && !toggle.disabled) {
        toggle.focus({ preventScroll: true });
        return;
    }

    if (refs.stage instanceof HTMLElement) {
        refs.stage.focus({ preventScroll: true });
        return;
    }

    document.activeElement?.blur?.();
}

function lockMobileContextPageScroll() {
    if (isMobileContextPageScrollLocked) {
        return;
    }

    mobileContextScrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    isMobileContextPageScrollLocked = true;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${mobileContextScrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
}

function unlockMobileContextPageScroll() {
    if (!isMobileContextPageScrollLocked) {
        return;
    }

    isMobileContextPageScrollLocked = false;
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    window.scrollTo(0, mobileContextScrollY);
    mobileContextScrollY = 0;
}

function syncMobileContextPanelState() {
    const hasContextPanel = Boolean(refs.rightPage?.classList.contains('context-panel'));
    const supportsMobilePanel = hasContextPanel && isMobileLayout();

    if (!supportsMobilePanel) {
        isMobileContextPanelOpen = false;
    }

    const isOpen = supportsMobilePanel && isMobileContextPanelOpen;
    refs.shell?.classList.toggle('mobile-context-panel-open', isOpen);
    document.documentElement.classList.toggle('mobile-context-panel-open', isOpen);
    document.body.classList.toggle('mobile-context-panel-open', isOpen);
    if (isOpen) {
        lockMobileContextPageScroll();
    } else {
        unlockMobileContextPageScroll();
    }

    if (refs.rightPage) {
        if (supportsMobilePanel) {
            refs.rightPage.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
            refs.rightPage.setAttribute('role', 'dialog');
            refs.rightPage.setAttribute('aria-modal', 'true');
            refs.rightPage.setAttribute('tabindex', '-1');
            refs.rightPage.toggleAttribute('inert', !isOpen);
        } else {
            refs.rightPage.removeAttribute('aria-hidden');
            refs.rightPage.removeAttribute('role');
            refs.rightPage.removeAttribute('aria-modal');
            refs.rightPage.removeAttribute('tabindex');
            refs.rightPage.removeAttribute('inert');
        }
    }

    document.querySelectorAll('[data-action="open-context-panel"]').forEach((button) => {
        button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
}

function isMobileLayout() {
    return window.matchMedia?.(MOBILE_CONTEXT_PANEL_QUERY).matches
        ?? ((window.innerWidth || document.documentElement.clientWidth || 1024) <= 760);
}

function setPages(leftHtml, rightHtml, rightPageMode = '', options = {}) {
    const rightScrollTop = options.preserveRightScroll ? refs.rightPage.scrollTop : 0;
    const keepContextPanelOpen = Boolean(options.keepContextPanelOpen && isMobileContextPanelOpen);

    refs.leftPage.innerHTML = leftHtml;
    refs.rightPage.className = ['paper-page', 'paper-page-right', rightPageMode].filter(Boolean).join(' ');
    refs.rightPage.innerHTML = rightHtml;
    isMobileContextPanelOpen = keepContextPanelOpen;
    refs.leftPage.scrollTop = 0;
    refs.rightPage.scrollTop = 0;
    if (rightScrollTop) {
        refs.rightPage.scrollTop = rightScrollTop;
    }
    syncMobileContextPanelState();

    if (isMobileContextPanelOpen) {
        requestAnimationFrame(() => refs.rightPage?.focus({ preventScroll: true }));
    }
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
        const hasNote = hasRecordNoteContent(record);
        const noteMatch = normalized.note === 'all' || (normalized.note === 'filled' ? hasNote : !hasNote);
        const searchMatch = !query || record.searchText.includes(query);
        return yearMatch && monthMatch && provinceMatch && cityMatch && visitMatch && mediaMatch && noteMatch && searchMatch;
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
            ${renderRecordPaperclip()}
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

function renderPhotoSleeve(record, options = {}) {
    if (!record.photo_folder || !Array.isArray(record.photos) || record.photos.length === 0) {
        return '<p class="photo-note">这篇记录没有照片附件。</p>';
    }

    const { previewRows = 0, showViewAll = false } = options;
    const isPreview = Number.isFinite(previewRows) && previewRows > 0;
    const shouldRenderViewAll = showViewAll && isPreview && record.photos.length > previewRows;

    return `
        <div class="photo-sleeve${isPreview ? ' photo-sleeve-preview' : ''}"${isPreview ? ` data-preview-rows="${previewRows}"` : ''} aria-label="照片附件">
            ${record.photos.map((photo, index) => {
                const src = `${record.photo_folder}/${photo}`;
                const alt = `${record.title} · ${photo}`;
                return `
                <button class="photo-sleeve-button" type="button" data-action="open-photo-viewer" data-photo-index="${index}" data-photo-src="${escapeHtml(src)}" data-photo-alt="${escapeHtml(alt)}" aria-label="打开照片 ${escapeHtml(photo)}">
                    <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">
                    <span>${escapeHtml(String(index + 1).padStart(2, '0'))}</span>
                </button>
            `;
            }).join('')}
            ${shouldRenderViewAll ? `
                <a class="paper-button photo-sleeve-action" href="${serializeRoute({ name: 'photos', params: { id: record.id } })}" data-action="view-all-photos">
                    查看全部照片（${record.photos.length} 张）
                </a>
            ` : ''}
        </div>
    `;
}

function syncPhotoSleevePreviewRows() {
    document.querySelectorAll('.photo-sleeve-preview').forEach((sleeve) => {
        observePhotoSleevePreview(sleeve);
        const previewRows = Number(sleeve.dataset.previewRows || ENTRY_PHOTO_PREVIEW_ROWS);
        const columnCount = getPhotoSleeveColumnCount(sleeve);
        const visibleLimit = columnCount * previewRows;
        const buttons = Array.from(sleeve.querySelectorAll('.photo-sleeve-button'));
        const action = sleeve.querySelector('[data-action="view-all-photos"]');

        buttons.forEach((button, index) => {
            button.hidden = index >= visibleLimit;
        });

        if (action) {
            action.hidden = buttons.length <= visibleLimit;
        }
    });
}

function queuePhotoSleevePreviewSync() {
    syncPhotoSleevePreviewRows();

    if (photoPreviewResizeTimer) {
        window.clearTimeout(photoPreviewResizeTimer);
    }
    if (photoPreviewLateResizeTimer) {
        window.clearTimeout(photoPreviewLateResizeTimer);
    }

    photoPreviewResizeTimer = window.setTimeout(() => {
        photoPreviewResizeTimer = null;
        syncPhotoSleevePreviewRows();
    }, 160);
    photoPreviewLateResizeTimer = window.setTimeout(() => {
        photoPreviewLateResizeTimer = null;
        syncPhotoSleevePreviewRows();
    }, 900);
}

function observePhotoSleevePreview(sleeve) {
    if (!('ResizeObserver' in window)) {
        return;
    }

    if (!photoSleeveResizeObserver) {
        photoSleeveResizeObserver = new ResizeObserver(() => {
            queuePhotoSleevePreviewSync();
        });
    }

    photoSleeveResizeObserver.observe(sleeve);
}

function getPhotoSleeveColumnCount(sleeve) {
    const columns = window.getComputedStyle(sleeve).gridTemplateColumns;
    const columnCount = columns.split(' ').filter(Boolean).length;

    return Math.max(1, columnCount || 1);
}

function filterToggleButton(label, key, value, activeValue) {
    const active = value === activeValue;

    return `
        <button class="index-segment${active ? ' index-segment-active' : ''}" type="button" data-ledger-toggle="${escapeHtml(key)}" data-value="${escapeHtml(value)}" aria-pressed="${active ? 'true' : 'false'}">
            ${escapeHtml(label)}
        </button>
    `;
}

function getCityFilterOptions(province) {
    const normalizedProvince = normalizeFilterValue(province);

    return travelModel.filterOptions.cities.filter(city => normalizedProvince === 'all' || city.province === normalizedProvince);
}

function hasActiveLedgerFilter(params) {
    const normalized = normalizeLedgerParams(params);

    return normalized.year !== 'all'
        || normalized.month !== 'all'
        || normalized.province !== 'all'
        || normalized.city !== 'all'
        || normalized.visit !== 'all'
        || normalized.media !== 'all'
        || normalized.note !== 'all'
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
        note: normalizeNote(params.note),
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

function normalizeNote(note) {
    return note === 'filled' || note === 'empty' ? note : 'all';
}

function normalizeLedgerSort(sort) {
    return LEDGER_SORT_OPTIONS.has(sort) ? sort : DEFAULT_LEDGER_SORT;
}

function getTurnDirection(previousRoute, nextRoute) {
    if (!previousRoute) return 'forward';

    const order = ['cover', 'ledger', 'archive', 'place', 'entry', 'photos'];
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

function hasRecordNoteContent(record) {
    if (typeof record.descMarkdown === 'string' && record.descMarkdown.trim()) {
        return Boolean(record.descMarkdown.replace(/^#\s+.*(?:\n|$)/, '').trim());
    }

    return Boolean(String(record.descBodyHtml || '').replace(/<[^>]*>/g, '').trim());
}

function getTodayDate() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
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
