import { loadTravelData, loadTravelRecords } from './data.js';
import { buildFallbackTitle, escapeHtml } from './utils.js';

const DEFAULT_LEDGER_SORT = 'desc';
const PAGE_TURN_MS = 560;

const refs = {};
let travelModel = null;
let activeRoute = null;
let pageTurnTimer = null;
let lastReadingHash = '#ledger';

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
    const countries = buildLocationIndex(enhanced);
    const latestRecord = recordsDesc[0] || null;

    return {
        records: enhanced,
        recordsDesc,
        recordsById,
        years,
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

    setPages(`
        <div class="cover-page">
            <p class="journal-label">封面</p>
            <h1>把走过的城市，收进一本旅行手账。</h1>
            <p class="page-copy">每一次出发都变成纸页、行李牌和路线账。翻开它，可以按日期回看，也可以从地点重新进入记忆。</p>
            <div class="cover-actions">
                <a class="brass-button" href="#ledger">翻开路线账</a>
                <a class="paper-button" href="#archive">查看档案夹</a>
            </div>
            <dl class="tag-stats" aria-label="旅行统计">
                ${statTag('日志', stats.total)}
                ${statTag('国家', stats.countries)}
                ${statTag('省份', stats.provinces)}
                ${statTag('城市', stats.cities)}
            </dl>
        </div>
    `, `
        <div class="pocket-page">
            <p class="journal-label">最近一次出发</p>
            ${latest ? renderLatestTicket(latest) : '<p class="empty-note">还没有旅行记录。</p>'}
            <div class="route-sketch" aria-hidden="true">
                ${travelModel.recordsDesc.slice(0, 6).map((record, index) => `
                    <span class="route-dot" style="--x:${12 + index * 15}%; --y:${78 - (index % 3) * 19}%"></span>
                `).join('')}
                <span class="route-line"></span>
            </div>
        </div>
    `);
}

function renderLedger(params = {}) {
    const ledgerParams = normalizeLedgerParams(params);
    const filtered = getLedgerRecords(ledgerParams);

    setPages(`
        <div class="ledger-page">
            <header class="page-head">
                <p class="journal-label">路线账</p>
                <h1>按时间回看每一次出发。</h1>
            </header>
            ${renderLedgerControls(ledgerParams, 'ledgerSearch')}
            <div class="year-bookmarks" aria-label="年份书签">
                ${yearLink('全部', 'all', ledgerParams)}
                ${travelModel.years.map(year => yearLink(year, year, ledgerParams)).join('')}
            </div>
            <div class="timeline-list" id="ledgerList">
                ${filtered.length ? filtered.map(renderLedgerEntry).join('') : '<div class="empty-note">没有找到匹配的旅行记录。</div>'}
            </div>
        </div>
    `, `
        <aside class="map-pocket">
            <p class="journal-label">夹页</p>
            <h2>路线地图口袋</h2>
            <div class="filter-summary">
                <span>${ledgerParams.year === 'all' ? '全部年份' : `${ledgerParams.year} 年`}</span>
                <span>${ledgerParams.sort === 'asc' ? '最早优先' : '最新优先'}</span>
                <span>${ledgerParams.q ? `搜索：${escapeHtml(ledgerParams.q)}` : '未搜索'}</span>
            </div>
            <button class="brass-toggle" type="button" data-action="toggle-sort">
                ${ledgerParams.sort === 'asc' ? '切回最新优先' : '切到最早优先'}
            </button>
            <button class="paper-button full-width" type="button" data-action="open-drawer">打开皮革筛选抽屉</button>
            <div class="province-strip">
                ${travelModel.countries.flatMap(country => country.provinces).slice(0, 10).map(renderMiniLuggageTag).join('')}
            </div>
        </aside>
    `);
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
                <p class="journal-label">档案夹</p>
                <h1>按地点抽出一张行李牌。</h1>
            </header>
            <label class="field-label" for="archiveSearch">搜索国家、省份或城市</label>
            <div class="ink-field">
                <input id="archiveSearch" type="search" value="${escapeHtml(params.q || '')}" autocomplete="off" placeholder="例如：云南、苏州、北京">
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
    `);
}

function renderEntryRoute(params = {}) {
    const record = travelModel.recordsById.get(params.id);
    const ledgerParams = record ? { year: record.year, q: '', sort: DEFAULT_LEDGER_SORT } : { year: 'all', q: '', sort: DEFAULT_LEDGER_SORT };
    renderLedger(ledgerParams);
    openEntrySheet(record);
}

function renderLoading() {
    setPages(`
        <div class="loading-page">
            <p class="journal-label">正在打开手账</p>
            <h1>正在整理旅行纸页...</h1>
        </div>
    `, '<div class="loading-page muted-page"></div>');
}

function renderFatalError(error) {
    setPages(`
        <div class="loading-page">
            <p class="journal-label">加载失败</p>
            <h1>手账暂时打不开。</h1>
            <p class="page-copy">${escapeHtml(error.message)}</p>
        </div>
    `, '<div class="loading-page muted-page"></div>');
}

function renderDrawer() {
    if (!refs.drawer || !travelModel) return;

    const route = activeRoute || parseRoute();
    const ledgerParams = route.name === 'ledger' ? normalizeLedgerParams(route.params) : { year: 'all', q: '', sort: DEFAULT_LEDGER_SORT };

    refs.drawer.innerHTML = `
        <div class="drawer-grip" aria-hidden="true"></div>
        <div class="drawer-head">
            <h2>皮革筛选抽屉</h2>
            <button class="icon-button" type="button" data-action="close-drawer" aria-label="关闭筛选">×</button>
        </div>
        <label class="field-label" for="drawerSearch">路线搜索</label>
        <div class="ink-field">
            <input id="drawerSearch" type="search" value="${escapeHtml(ledgerParams.q)}" autocomplete="off" placeholder="搜索城市或记录">
        </div>
        <div class="drawer-years">
            ${yearLink('全部', 'all', ledgerParams)}
            ${travelModel.years.map(year => yearLink(year, year, ledgerParams)).join('')}
        </div>
        <button class="brass-toggle full-width" type="button" data-action="toggle-sort">
            ${ledgerParams.sort === 'asc' ? '最早优先' : '最新优先'}
        </button>
    `;
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
        </article>
    `;

    requestAnimationFrame(() => {
        refs.sheet.querySelector('.entry-sheet')?.focus({ preventScroll: true });
    });
}

function closeEntrySheet(options = {}) {
    if (!refs.sheet) return;

    refs.sheet.classList.remove('entry-sheet-root-open');
    refs.sheet.setAttribute('aria-hidden', 'true');
    refs.sheet.innerHTML = '';

    if (options.restoreHash) {
        navigateTo(lastReadingHash || '#ledger', { replace: true });
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
    }, 160);
}

function handleDocumentClick(event) {
    const closeEntry = event.target.closest('[data-action="close-entry"]');
    if (closeEntry) {
        event.preventDefault();
        closeEntrySheet({ restoreHash: true });
        return;
    }

    const drawerAction = event.target.closest('[data-action="open-drawer"], [data-action="close-drawer"]');
    if (drawerAction) {
        event.preventDefault();
        drawerAction.dataset.action === 'open-drawer' ? openDrawer() : closeDrawer();
        return;
    }

    if (event.target.closest('#drawerToggle')) {
        event.preventDefault();
        toggleDrawer();
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

    const entryCard = event.target.closest('[data-open-entry]');
    if (entryCard && !event.target.closest('a, button, input')) {
        event.preventDefault();
        lastReadingHash = serializeRoute(activeRoute?.name === 'entry' ? { name: 'ledger', params: {} } : activeRoute);
        navigateTo({ name: 'entry', params: { id: entryCard.dataset.openEntry } });
        return;
    }

    const routeAnchor = event.target.closest('a[href^="#"]');
    if (routeAnchor) {
        event.preventDefault();
        navigateTo(routeAnchor.getAttribute('href'));
    }
}

function handleDocumentKeydown(event) {
    if (event.key === 'Escape') {
        if (refs.sheet?.classList.contains('entry-sheet-root-open')) {
            closeEntrySheet({ restoreHash: true });
            return;
        }

        closeDrawer();
        return;
    }

    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-open-entry]')) {
        event.preventDefault();
        lastReadingHash = serializeRoute(activeRoute || { name: 'ledger', params: {} });
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
            <div class="ink-field">
                <input id="${inputId}" type="search" value="${escapeHtml(params.q)}" autocomplete="off" placeholder="搜索城市、省份或日记内容">
            </div>
            <button class="filter-chip" type="button" data-action="open-drawer">筛选抽屉</button>
        </div>
    `;
}

function renderLedgerEntry(record) {
    return `
        <article class="ledger-entry" data-open-entry="${escapeHtml(record.id)}" tabindex="0" role="button" aria-label="打开 ${escapeHtml(record.title)} 日记">
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
        <article class="latest-ticket" data-open-entry="${escapeHtml(record.id)}" tabindex="0" role="button" aria-label="打开最近日记">
            <time datetime="${escapeHtml(record.date || '')}">${escapeHtml(record.date || '')}</time>
            <h2>${escapeHtml(record.title)}</h2>
            <p>${escapeHtml(getLocationText(record))}</p>
            <span>点击展开浮起纸页</span>
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

function openDrawer() {
    refs.drawer.classList.add('journal-drawer-open');
    refs.drawer.setAttribute('aria-hidden', 'false');
    refs.drawerToggle?.setAttribute('aria-expanded', 'true');
    document.body.classList.add('drawer-open');
}

function closeDrawer() {
    refs.drawer?.classList.remove('journal-drawer-open');
    refs.drawer?.setAttribute('aria-hidden', 'true');
    refs.drawerToggle?.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('drawer-open');
}

function toggleDrawer() {
    refs.drawer?.classList.contains('journal-drawer-open') ? closeDrawer() : openDrawer();
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
