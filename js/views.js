import { currentState, getTravelRecords } from './state.js';
import { buildFallbackTitle, escapeHtml, formatDateForCard } from './utils.js';
import { closeSidebar, showPage } from './navigation.js';

let yearScrollFrame = null;

export function renderLoadingState() {
    const container = document.getElementById('diaryContainer');
    if (container) {
        container.innerHTML = '<div class="empty-state">Loading diary entries...</div>';
    }
}

export function renderStats(stats) {
    const statsHeader = document.getElementById('statsHeader');
    if (!statsHeader) return;

    statsHeader.innerHTML = `
        <div class="stat-item-compact">
            <span class="stat-label-compact">日志</span>
            <span class="stat-value-compact">${stats.total}</span>
        </div>
        <div class="stat-item-compact">
            <span class="stat-label-compact">国家</span>
            <span class="stat-value-compact">${stats.countries}</span>
        </div>
        <div class="stat-item-compact">
            <span class="stat-label-compact">省份</span>
            <span class="stat-value-compact">${stats.provinces}</span>
        </div>
        <div class="stat-item-compact">
            <span class="stat-label-compact">城市</span>
            <span class="stat-value-compact">${stats.cities}</span>
        </div>
    `;
}

export function renderProfile(stats) {
    const profileStats = document.getElementById('profileStats');
    const visitedPlaces = document.getElementById('visitedPlaces');
    const records = getTravelRecords();

    if (profileStats) {
        profileStats.innerHTML = createStatCards(stats, [
            ['total', '旅行记录'],
            ['countries', '国家'],
            ['provinces', '省份'],
            ['cities', '城市']
        ]);
    }

    if (!visitedPlaces) return;

    const placeMap = new Map();

    records.forEach(record => {
        const isChina = record.country === '中国';
        const key = isChina ? `${record.country}-${record.province}` : record.country;
        const label = isChina ? record.province : record.country;
        const scope = isChina ? '省份' : '国家';
        const current = placeMap.get(key) || {
            country: record.country,
            province: isChina ? record.province : '',
            label,
            scope,
            count: 0,
            cities: new Set(),
            latestDate: ''
        };

        current.count += 1;
        current.cities.add(record.city);
        if (!current.latestDate || record.date > current.latestDate) {
            current.latestDate = record.date;
        }

        placeMap.set(key, current);
    });

    const places = Array.from(placeMap.values())
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'));

    visitedPlaces.innerHTML = places.map((place, index) => {
        const cityCount = place.cities.size;
        const stampCount = Math.min(place.count, 6);
        const stamps = Array.from({ length: stampCount }, () => '<span class="visited-stamp"></span>').join('');
        const stampMore = place.count > stampCount ? `<span class="visited-stamp-more">+${place.count - stampCount}</span>` : '';

        return `
            <button type="button" class="visited-item visited-item-button" data-country="${escapeHtml(place.country)}" data-province="${escapeHtml(place.province)}">
                <div class="visited-rank">${index + 1}</div>
                <div class="visited-main">
                    <div class="visited-title-row">
                        <strong>${escapeHtml(place.label)}</strong>
                        <span class="visited-scope">${escapeHtml(place.scope)}</span>
                    </div>
                    <div class="visited-meta">
                        <span class="visited-meta-item"><strong>${place.count}</strong> 次到访</span>
                        <span class="visited-meta-item">${cityCount} 座城市</span>
                        <time datetime="${escapeHtml(place.latestDate)}">最近 ${escapeHtml(place.latestDate)}</time>
                        <span class="visited-stamp-track" aria-label="${place.count} 次到访">${stamps}${stampMore}</span>
                    </div>
                </div>
            </button>
        `;
    }).join('');

    visitedPlaces.querySelectorAll('.visited-item-button').forEach(button => {
        button.addEventListener('click', () => {
            openLocationView(
                button.getAttribute('data-country'),
                button.getAttribute('data-province'),
                ''
            );
        });
    });
}

export function initYears() {
    const yearTabs = document.getElementById('yearTabs');
    if (!yearTabs) return;

    const years = new Set(getTravelRecords().map(record => record.date.split('-')[0]));
    const sortedYears = Array.from(years).sort((a, b) => b.localeCompare(a));

    let html = '<button class="category-tab category-tab-active" data-year="All">全部时间</button>';
    sortedYears.forEach(year => {
        html += `<button class="category-tab" data-year="${escapeHtml(year)}">${escapeHtml(year)}</button>`;
    });
    yearTabs.innerHTML = html;

    updateYearTabs();

    if (!yearTabs.dataset.listenerAttached) {
        yearTabs.addEventListener('click', (event) => {
            const btn = event.target.closest('.category-tab');
            if (!btn) return;

            const selectedYear = btn.getAttribute('data-year');
            if (!selectedYear) return;

            currentState.year = selectedYear;
            renderDiary();
            updateYearTabs();
            closeSidebar();
            showPage('journey', { scrollTop: false });
            scrollToYear(selectedYear);
        });
    }

    yearTabs.dataset.listenerAttached = 'true';

    if (!yearTabs.dataset.scrollListenerAttached) {
        window.addEventListener('scroll', scheduleYearScrollSync, { passive: true });
        window.addEventListener('resize', scheduleYearScrollSync);
        yearTabs.dataset.scrollListenerAttached = 'true';
    }
}

export function updateYearTabs() {
    document.querySelectorAll('.category-tab').forEach(tab => {
        const isActive = tab.getAttribute('data-year') === currentState.year;
        tab.classList.toggle('category-tab-active', isActive);
        tab.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

export function setupFilters() {
    const searchInput = document.getElementById('searchInput');
    const sortBtn = document.getElementById('sortBtn');

    if (searchInput) {
        searchInput.addEventListener('input', (event) => {
            currentState.search = event.target.value.trim().toLowerCase();
            renderDiary();
            updateYearTabs();
        });
    }

    if (sortBtn) {
        sortBtn.setAttribute('aria-label', currentState.sortDesc ? '当前排序：最新优先' : '当前排序：最早优先');
        sortBtn.addEventListener('click', () => {
            currentState.sortDesc = !currentState.sortDesc;
            sortBtn.innerHTML = createSortButtonContent(currentState.sortDesc);
            sortBtn.setAttribute('aria-label', currentState.sortDesc ? '当前排序：最新优先' : '当前排序：最早优先');
            renderDiary();
            updateYearTabs();
            showPage('journey');
        });
    }
}

function createSortButtonContent(sortDesc) {
    return sortDesc
        ? `<span>最新优先</span>
            <span class="icon-sort" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" focusable="false">
                    <path d="M8 2v12m0 0 5-5m-5 5-5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
            </span>`
        : `<span>最早优先</span>
            <span class="icon-sort" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" focusable="false">
                    <path d="M8 14V2m0 0 5 5M8 2 3 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
            </span>`;
}

export function renderDiary() {
    const container = document.getElementById('diaryContainer');
    if (!container) return;

    const currentHeight = container.offsetHeight;
    if (currentHeight > 0) {
        container.style.minHeight = currentHeight + 'px';
    }

    container.innerHTML = '';

    const tempRecords = [...getTravelRecords()].sort((a, b) => a.date.localeCompare(b.date));
    const visitTracker = new Set();
    const processedRecords = tempRecords.map(record => {
        const locationKey = `${record.country}-${record.province}-${record.city}`;
        const isRepeated = visitTracker.has(locationKey);
        visitTracker.add(locationKey);
        return { ...record, isRepeated };
    });

    let filtered = processedRecords.filter(record => record.searchText.includes(currentState.search));

    filtered.sort((a, b) => {
        return currentState.sortDesc
            ? b.date.localeCompare(a.date)
            : a.date.localeCompare(b.date);
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state">没有找到匹配的旅行记录。</div>';
        return;
    }

    const yearGroups = new Map();
    filtered.forEach(record => {
        const year = record.date.split('-')[0];
        if (!yearGroups.has(year)) {
            yearGroups.set(year, []);
        }
        yearGroups.get(year).push(record);
    });

    const sortedYears = Array.from(yearGroups.keys()).sort((a, b) => {
        return currentState.sortDesc ? b.localeCompare(a) : a.localeCompare(b);
    });

    const yearColors = ['#cc785c', '#5db8a6', '#e8a55a', '#7b8cc4', '#9d7ba8', '#5a9e6f', '#c47d5a'];
    let colorIndex = 0;

    sortedYears.forEach(year => {
        const entries = yearGroups.get(year);
        const dotColor = yearColors[colorIndex % yearColors.length];
        colorIndex += 1;

        const yearHeader = document.createElement('div');
        yearHeader.className = 'year-section-header';
        yearHeader.id = `year-section-${year}`;
        yearHeader.style.setProperty('--year-dot-color', dotColor);
        yearHeader.innerHTML = `<span class="year-label">${escapeHtml(year)}</span>`;
        container.appendChild(yearHeader);

        let currentMonth = '';
        entries.forEach(record => {
            const monthNum = record.date.substring(5, 7);
            if (monthNum !== currentMonth) {
                currentMonth = monthNum;
                const monthSep = document.createElement('div');
                monthSep.className = 'month-separator';
                const d = new Date(record.date + 'T00:00:00');
                const monthName = d.toLocaleString('en-US', { month: 'long' });
                monthSep.innerHTML = `<span class="month-label">${escapeHtml(monthName)}</span>`;
                container.appendChild(monthSep);
            }

            container.appendChild(createDiaryEntry(record, dotColor, true));
        });
    });

    setTimeout(() => {
        container.style.minHeight = '';
    }, 400);

    scheduleYearScrollSync();
}

function scrollToYear(year) {
    const target = year === 'All'
        ? document.getElementById('journal')
        : document.getElementById(`year-section-${year}`);

    if (!target) return;

    requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

function scheduleYearScrollSync() {
    if (yearScrollFrame !== null) return;

    yearScrollFrame = requestAnimationFrame(() => {
        yearScrollFrame = null;
        syncYearWithScrollPosition();
    });
}

function syncYearWithScrollPosition() {
    if (document.body.dataset.page !== 'journey') return;

    const journal = document.getElementById('journal');
    const headers = Array.from(document.querySelectorAll('.year-section-header'));
    if (!journal || headers.length === 0) return;

    const navHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-height')) || 64;
    const threshold = navHeight + 48;
    let activeYear = 'All';

    headers.forEach(header => {
        if (header.getBoundingClientRect().top <= threshold) {
            activeYear = header.id.replace('year-section-', '');
        }
    });

    if (currentState.year === activeYear) return;

    currentState.year = activeYear;
    updateYearTabs();
}

export function renderLocationFromHash() {
    if (!window.location.hash || !window.location.hash.startsWith('#location')) {
        return false;
    }

    try {
        const query = window.location.hash.split('?')[1] || '';
        const params = new URLSearchParams(query);
        const country = params.get('country') || '';
        const province = params.get('province') || '';
        const city = params.get('city') || '';
        showPage('journey', { updateHash: false, scrollTop: false });
        renderLocationPage(country, province, city);
        return true;
    } catch (e) {
        return false;
    }
}

export function renderLocationPage(country, province, city) {
    const container = document.getElementById('diaryContainer');
    if (!container) return;

    const locationLabel = getLocationArchiveLabel(country, province, city);
    const matching = getTravelRecords().filter(record => (
        (country ? record.country === country : true) &&
        (province ? record.province === province : true) &&
        (city ? record.city === city : true)
    ));
    const visits = matching.length;

    container.innerHTML = `
        <div class="location-hero">
            <button class="location-back">返回</button>
            <div class="location-head">
                <p class="eyebrow">Location archive</p>
                <h1 class="display-lg">${escapeHtml(locationLabel)}</h1>
                <div class="location-sub">${visits} 次到访</div>
            </div>
        </div>
        <div class="location-entries" id="locationEntries"></div>
    `;

    const backBtn = container.querySelector('.location-back');
    if (backBtn) backBtn.addEventListener('click', returnToDiary);

    const entriesContainer = document.getElementById('locationEntries');
    if (matching.length === 0) {
        entriesContainer.innerHTML = '<div class="empty-state">没有找到这个地点的旅行记录。</div>';
        return;
    }

    matching
        .sort((a, b) => b.date.localeCompare(a.date))
        .forEach(record => {
            entriesContainer.appendChild(createDiaryEntry(record, '#cc785c', false));
        });
}

function createStatCards(stats, items) {
    return items.map(([key, label]) => `
        <div class="stat-card">
            <span>${stats[key]}</span>
            <strong>${label}</strong>
        </div>
    `).join('');
}

function createDiaryEntry(record, dotColor, includeFooter) {
    const entryDiv = document.createElement('div');
    entryDiv.className = 'diary-entry diary-entry-clickable';
    entryDiv.setAttribute('data-md-path', record.desc_md || '');
    entryDiv.style.setProperty('--year-line-color', dotColor);

    const locationText = getLocationText(record);
    const footerHtml = includeFooter
        ? `<div class="entry-footer">
                <a href="#" class="tag link-location" data-country="${escapeHtml(record.country)}" data-province="${escapeHtml(record.province)}" data-city="${escapeHtml(record.city)}">
                    ${escapeHtml(record.country === '中国' ? record.province : record.country)}
                </a>
                ${record.isRepeated ? '<span class="badge-repeat">再次到访</span>' : ''}
            </div>`
        : '';

    entryDiv.innerHTML = `
        <div class="entry-date">${formatDateForCard(record.date)}</div>
        <div class="entry-body">
            <div class="entry-header"></div>
            <div class="entry-location">${escapeHtml(locationText)}</div>
            <div class="entry-desc entry-title"><h1>${escapeHtml(record.descTitle || buildFallbackTitle(record))}</h1></div>
            ${footerHtml}
        </div>
    `;

    entryDiv.addEventListener('click', (event) => {
        const ignore = event.target.closest('button, a, .entry-photo, .link-location');
        if (ignore) return;
        openEntryModal(record);
    });

    const link = entryDiv.querySelector('.link-location');
    if (link) {
        link.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            openLocationView(
                link.getAttribute('data-country'),
                link.getAttribute('data-province'),
                link.getAttribute('data-city')
            );
        });
    }

    return entryDiv;
}

function getLocationText(record) {
    if (record.province === record.city) {
        return record.country === '中国' ? record.city : `${record.country} ${record.city}`;
    }

    return record.country === '中国'
        ? `${record.province} ${record.city}`
        : `${record.country} ${record.province} ${record.city}`;
}

function getLocationArchiveLabel(country, province, city) {
    if (country === '中国') {
        if (city) {
            return province && province !== city ? `${province} · ${city}` : city;
        }

        return province || country || '地点';
    }

    if (city) {
        return [country, province && province !== city ? province : '', city]
            .filter(Boolean)
            .join(' ');
    }

    return province ? `${country} ${province}` : (country || '地点');
}

function openEntryModal(record) {
    let overlay = document.getElementById('entryModalOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'entryModalOverlay';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-card" role="dialog" aria-modal="true">
                <button class="modal-close" aria-label="关闭">×</button>
                <div class="modal-scroll" tabindex="0"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) closeEntryModal();
        });

        overlay.querySelector('.modal-close').addEventListener('click', closeEntryModal);
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeEntryModal();
        });
    }

    const scrollContainer = overlay.querySelector('.modal-scroll');
    if (!scrollContainer) return;

    let contentHtml = `<h1 class="modal-title">${escapeHtml(record.descTitle || buildFallbackTitle(record))}</h1>`;
    contentHtml += `<div class="modal-meta"><time datetime="${escapeHtml(record.date || '')}">${escapeHtml(record.date || '')}</time></div>`;
    contentHtml += `<div class="markdown-content modal-markdown">${record.descBodyHtml || ''}</div>`;

    if (record.photo_folder && record.photos && record.photos.length > 0) {
        contentHtml += '<div class="modal-photos">';
        record.photos.forEach(photo => {
            const imgPath = `${record.photo_folder}/${photo}`;
            const fallbackSvg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150"><rect fill="#f5f0e8" width="200" height="150"/><text fill="#8e8b82" font-family="sans-serif" font-size="14" x="50%" y="50%" text-anchor="middle" dominant-baseline="middle">No Image</text></svg>');
            contentHtml += `<img src="${imgPath}" alt="${escapeHtml(photo)}" class="modal-photo" loading="lazy" onerror="this.onerror=null; this.src='data:image/svg+xml;utf8,${fallbackSvg}';">`;
        });
        contentHtml += '</div>';
    }

    scrollContainer.innerHTML = contentHtml;
    document.body.classList.add('modal-open');
    overlay.style.display = 'flex';
    setTimeout(() => scrollContainer.focus(), 60);
}

function closeEntryModal() {
    const overlay = document.getElementById('entryModalOverlay');
    if (!overlay) return;

    overlay.style.display = 'none';
    document.body.classList.remove('modal-open');
}

function openLocationView(country, province, city) {
    showPage('journey', { updateHash: false });

    const state = { view: 'location', country, province, city };
    const title = `${city || province || country} - Travel Diary`;
    const url = `#location?country=${encodeURIComponent(country || '')}&province=${encodeURIComponent(province || '')}&city=${encodeURIComponent(city || '')}`;
    history.pushState(state, title, url);
    renderLocationPage(country, province, city);
}

function returnToDiary() {
    if (history.state && history.state.view === 'location') {
        history.back();
        return;
    }

    history.replaceState({ view: 'page', page: 'journey' }, document.title, '#journey');
    showPage('journey', { updateHash: false });
    renderDiary();
    updateYearTabs();
}
