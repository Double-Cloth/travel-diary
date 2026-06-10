let travelRecords = [];

let currentState = {
    search: '',
    year: 'All',
    sortDesc: true
};

function formatDateForCard(dateStr) {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr + 'T00:00:00');
        const day = d.getDate().toString().padStart(2, '0');
        const month = d.toLocaleString('en-US', { month: 'short' });
        const year = d.getFullYear();
        return `<time datetime="${escapeHtml(dateStr)}"><span class="date-day">${day}</span><span class="date-month">${escapeHtml(month)} ${year}</span></time>`;
    } catch (e) {
        return `<time datetime="${escapeHtml(dateStr)}">${escapeHtml(dateStr)}</time>`;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    void initApp();
});

async function initApp() {
    try {
        renderLoadingState();
        const travelData = await loadTravelData();
        travelRecords = await loadTravelRecords(travelData);

        const initialStats = analyzeData();
        renderStats(initialStats);
        initYears();
        setupFilters();
        renderDiary();
        setupInteractions();
        // Handle back/forward for location pages
        window.addEventListener('popstate', (e) => {
            const state = e.state || {};
            if (state && state.view === 'location') {
                renderLocationPage(state.country, state.province, state.city);
            } else {
                // default to diary list
                renderDiary();
                updateYearTabs();
            }
        });
        window.addEventListener('hashchange', () => {
            if (!renderLocationFromHash()) {
                renderDiary();
                updateYearTabs();
            }
        });
        // If URL contains a location hash on initial load, render it
        renderLocationFromHash();
    } catch (error) {
        const container = document.getElementById('diaryContainer');
        if (container) {
            container.innerHTML = `<div class="empty-state" style="color: var(--error);">Error loading diary entries: ${escapeHtml(error.message)}</div>`;
        }
        console.error('Initial Load Error:', error);
    }
}

async function loadTravelData() {
    const dataPath = new URL('data/travel_data.json', window.location.href).href;
    const response = await fetch(dataPath, { cache: 'no-store' });

    if (!response.ok) {
        throw new Error(`Failed to load travel data (${response.status})`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
        throw new Error('Travel data file must contain an array.');
    }

    return data;
}

function renderLoadingState() {
    const container = document.getElementById('diaryContainer');
    if (container) {
        container.innerHTML = '<div class="empty-state">Loading diary entries...</div>';
    }
}

async function loadTravelRecords(records) {
    const hydratedRecords = [];

    for (const record of records) {
        try {
            const markdown = await fetchMarkdown(record.desc_md);
            const parsedMarkdown = parseMarkdown(markdown, record);

            hydratedRecords.push({
                ...record,
                descMarkdown: markdown,
                descTitle: parsedMarkdown.title,
                descBodyHtml: parsedMarkdown.bodyHtml,
                searchText: parsedMarkdown.searchText
            });
        } catch (error) {
            const fallbackTitle = buildFallbackTitle(record);
            const fallbackSearchText = [record.country, record.province, record.city, fallbackTitle].join(' ').toLowerCase();

            hydratedRecords.push({
                ...record,
                descMarkdown: '',
                descTitle: fallbackTitle,
                descBodyHtml: `<p class="markdown-load-error">Markdown load failed for ${escapeHtml(record.desc_md || '')}.</p>`,
                searchText: fallbackSearchText
            });
        }
    }

    return hydratedRecords;
}

async function fetchMarkdown(markdownPath) {
    if (!markdownPath) {
        return '';
    }

    const resolvedPath = new URL(markdownPath, window.location.href).href;

    try {
        const response = await fetch(resolvedPath, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`Failed to load ${markdownPath} (${response.status})`);
        }

        return response.text();
    } catch (error) {
        const retryResponse = await fetch(resolvedPath, { cache: 'no-store' });
        if (!retryResponse.ok) {
            throw error;
        }

        return retryResponse.text();
    }
}

function parseMarkdown(markdown, record) {
    const normalized = (markdown || '').replace(/\r\n/g, '\n').trim();
    const titleMatch = normalized.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : buildFallbackTitle(record);
    const bodyMarkdown = normalized.replace(/^#\s+.*(?:\n|$)/, '').trim();
    const bodyHtml = markdownToHtml(bodyMarkdown);
    const searchText = [record.country, record.province, record.city, title, plainTextFromMarkdown(bodyMarkdown)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    return {
        title,
        // `bodyHtml` intentionally does NOT include the top-level title.
        // Title is exposed separately as `descTitle` so list cards show only the H1.
        bodyHtml,
        searchText
    };
}

function buildFallbackTitle(record) {
    return record.city || record.province || record.country || record.date;
}

function markdownToHtml(markdown) {
    if (!markdown) {
        return '';
    }

    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const htmlParts = [];
    let paragraphLines = [];
    let listItems = [];

    const flushParagraph = () => {
        if (!paragraphLines.length) {
            return;
        }

        const paragraph = paragraphLines
            .map(line => formatInlineMarkdown(line.trim()))
            .filter(Boolean)
            .join('<br>');
        if (paragraph) {
            htmlParts.push(`<p>${paragraph}</p>`);
        }
        paragraphLines = [];
    };

    const flushList = () => {
        if (!listItems.length) {
            return;
        }

        htmlParts.push(`<ul>${listItems.map(item => `<li>${formatInlineMarkdown(item)}</li>`).join('')}</ul>`);
        listItems = [];
    };

    lines.forEach((line) => {
        const trimmed = line.trim();

        if (!trimmed) {
            flushParagraph();
            flushList();
            return;
        }

        const headingMatch = trimmed.match(/^(#{2,6})\s+(.+)$/);
        if (headingMatch) {
            flushParagraph();
            flushList();
            const level = headingMatch[1].length;
            htmlParts.push(`<h${level}>${formatInlineMarkdown(headingMatch[2])}</h${level}>`);
            return;
        }

        if (trimmed.startsWith('- ')) {
            flushParagraph();
            listItems.push(trimmed.slice(2).trim());
            return;
        }

        if (listItems.length) {
            flushList();
        }

        paragraphLines.push(trimmed);
    });

    flushParagraph();
    flushList();

    return htmlParts.join('');
}

function formatInlineMarkdown(text) {
    return escapeHtml(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
}

function plainTextFromMarkdown(markdown) {
    return (markdown || '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^[-*+]\s+/gm, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/`(.+?)`/g, '$1')
        .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
        .replace(/[>_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function analyzeData() {
    const visitedCountries = new Set();
    const visitedProvinces = new Set();
    const visitedCities = new Set();

    travelRecords.forEach(record => {
        visitedCountries.add(record.country);
        visitedProvinces.add(`${record.country}-${record.province}`);
        visitedCities.add(`${record.country}-${record.province}-${record.city}`);
    });

    return {
        countries: visitedCountries.size,
        provinces: visitedProvinces.size,
        cities: visitedCities.size,
        total: travelRecords.length
    };
}

function renderStats(stats) {
    const statsHeader = document.getElementById('statsHeader');
    if (!statsHeader) return;

    statsHeader.innerHTML = `
        <div class="stat-item-compact">
            <span class="stat-label-compact">Entries</span>
            <span class="stat-value-compact">${stats.total}</span>
        </div>
        <div class="stat-item-compact">
            <span class="stat-label-compact">Countries</span>
            <span class="stat-value-compact">${stats.countries}</span>
        </div>
        <div class="stat-item-compact">
            <span class="stat-label-compact">Provinces</span>
            <span class="stat-value-compact">${stats.provinces}</span>
        </div>
        <div class="stat-item-compact">
            <span class="stat-label-compact">Cities</span>
            <span class="stat-value-compact">${stats.cities}</span>
        </div>
    `;
}

function initYears() {
    const yearTabs = document.getElementById('yearTabs');
    if (!yearTabs) return;

    const years = new Set(travelRecords.map(r => r.date.split('-')[0]));
    const sortedYears = Array.from(years).sort((a, b) => b.localeCompare(a));

    let html = '<button class="category-tab category-tab-active" data-year="All">All Time</button>';
    sortedYears.forEach(y => {
        html += '<button class="category-tab" data-year="' + y + '">' + y + '</button>';
    });
    yearTabs.innerHTML = html;

    updateYearTabs();

    if (!yearTabs.dataset.listenerAttached) {
        yearTabs.addEventListener('click', (e) => {
            const btn = e.target.closest('.category-tab');
            if (!btn) return;

            const selectedYear = btn.getAttribute('data-year');
            if (!selectedYear || selectedYear === currentState.year) return;

            currentState.year = selectedYear;
            renderDiary();
            updateYearTabs();
            scrollToJournal();

            document.body.classList.remove('sidebar-open');
            const overlay = document.querySelector('.sidebar-overlay');
            if (overlay) overlay.remove();
            const hamburger = document.getElementById('hamburgerBtn');
            if (hamburger) hamburger.setAttribute('aria-expanded', 'false');
        });
    }

    yearTabs.dataset.listenerAttached = 'true';
}

function updateYearTabs() {
    document.querySelectorAll('.category-tab').forEach(tab => {
        const isActive = tab.getAttribute('data-year') === currentState.year;
        tab.classList.toggle('category-tab-active', isActive);
        tab.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function scrollToJournal() {
    const targetEl = document.getElementById('journal') || document.getElementById('diaryContainer');
    if (!targetEl) return;

    const topOffset = targetEl.getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top: topOffset, behavior: 'smooth' });
}

function setupInteractions() {
    const navLinks = {
        '#journal': '#journal',
        '#destinations': '.sidebar',
        '#about': '#about'
    };

    document.querySelectorAll('.nav-goto').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const targetSelector = navLinks[link.getAttribute('href')];
            const targetEl = document.querySelector(targetSelector);
            if (targetEl) {
                // Offset fixed top navigation.
                const topOffset = targetEl.getBoundingClientRect().top + window.scrollY - 80;
                window.scrollTo({ top: topOffset, behavior: 'smooth' });
                closeSidebar();
            }
        });
    });

    // Mobile hamburger -> toggle sidebar drawer
    const hamburger = document.getElementById('hamburgerBtn');
    function closeSidebar() {
        document.body.classList.remove('sidebar-open');
        const overlay = document.querySelector('.sidebar-overlay');
        if (overlay) overlay.remove();
        if (hamburger) hamburger.setAttribute('aria-expanded', 'false');
    }

    if (hamburger) {
        hamburger.addEventListener('click', (e) => {
            const isOpen = document.body.classList.toggle('sidebar-open');
            hamburger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

            if (isOpen) {
                // create overlay
                let overlay = document.querySelector('.sidebar-overlay');
                if (!overlay) {
                    overlay = document.createElement('div');
                    overlay.className = 'sidebar-overlay';
                    document.body.appendChild(overlay);
                    overlay.addEventListener('click', closeSidebar);
                }
            } else {
                const overlay = document.querySelector('.sidebar-overlay');
                if (overlay) overlay.remove();
            }
        });

        // close on escape
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') closeSidebar();
        });
    }
}

function setupFilters() {
    const searchInput = document.getElementById('searchInput');
    const sortBtn = document.getElementById('sortBtn');

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            currentState.search = e.target.value.trim().toLowerCase();
            renderDiary();
            updateYearTabs();
        });
    }

    if (sortBtn) {
        sortBtn.addEventListener('click', () => {
            currentState.sortDesc = !currentState.sortDesc;
            sortBtn.innerHTML = currentState.sortDesc
                ? '<span>Newest First</span><span class="icon-sort" style="color: var(--muted); font-size: 16px;">↓</span>'
                : '<span>Oldest First</span><span class="icon-sort" style="color: var(--muted); font-size: 16px;">↑</span>';
            renderDiary();
            updateYearTabs();
            window.scrollTo({ top: document.getElementById('diaryContainer').offsetTop - 120, behavior: 'smooth' });
        });
    }
}

function renderDiary() {
    const container = document.getElementById('diaryContainer');
    if (!container) return;

    const currentHeight = container.offsetHeight;
    if (currentHeight > 0) {
        container.style.minHeight = currentHeight + 'px';
    }

    container.innerHTML = '';

    const tempRecords = [...travelRecords].sort((a, b) => a.date.localeCompare(b.date));
    const visitTracker = new Set();

    const processedRecords = tempRecords.map(record => {
        const locationKey = record.country + '-' + record.province + '-' + record.city;
        const isRepeated = visitTracker.has(locationKey);
        visitTracker.add(locationKey);
        return Object.assign({}, record, { isRepeated: isRepeated });
    });

    let filtered = processedRecords.filter(record => {
        const matchYear = currentState.year === 'All' || record.date.startsWith(currentState.year);
        const matchSearch = record.searchText.includes(currentState.search);
        return matchYear && matchSearch;
    });

    filtered.sort((a, b) => {
        return currentState.sortDesc
            ? b.date.localeCompare(a.date)
            : a.date.localeCompare(b.date);
    });

    if (filtered.length === 0) {
        const emptyMessage = currentState.year === 'All'
            ? 'No memories found for your search.'
            : `No memories found in ${escapeHtml(currentState.year)}.`;
        container.innerHTML = '<div class="empty-state">' + emptyMessage + '</div>';
        return;
    }

    // Group by year
    const yearGroups = new Map();
    filtered.forEach(record => {
        const year = record.date.split('-')[0];
        if (!yearGroups.has(year)) {
            yearGroups.set(year, []);
        }
        yearGroups.get(year).push(record);
    });

    // Sort year keys according to sort order
    const sortedYears = Array.from(yearGroups.keys()).sort((a, b) => {
        return currentState.sortDesc ? b.localeCompare(a) : a.localeCompare(b);
    });

    // Year dot color palette
    const yearColors = ['#cc785c', '#5db8a6', '#e8a55a', '#7b8cc4', '#9d7ba8', '#5a9e6f', '#c47d5a'];
    let colorIdx = 0;

    let firstYearHeader = null;

    sortedYears.forEach(year => {
        const entries = yearGroups.get(year);
        const dotColor = yearColors[colorIdx % yearColors.length];
        colorIdx++;

        // Year section header
        const yearHeader = document.createElement('div');
        yearHeader.className = 'year-section-header';
        yearHeader.id = 'year-section-' + year;
        yearHeader.style.setProperty('--year-dot-color', dotColor);
        yearHeader.innerHTML = '<span class="year-label">' + year + '</span>';
        container.appendChild(yearHeader);

        if (!firstYearHeader) {
            firstYearHeader = yearHeader;
        }

        // Render entries for this year with month separators
        let currentMonth = '';
        entries.forEach(record => {
            const monthNum = record.date.substring(5, 7);
            if (monthNum !== currentMonth) {
                currentMonth = monthNum;
                const monthSep = document.createElement('div');
                monthSep.className = 'month-separator';
                const d = new Date(record.date + 'T00:00:00');
                const monthName = d.toLocaleString('en-US', { month: 'long' });
                monthSep.innerHTML = '<span class="month-label">' + monthName + '</span>';
                container.appendChild(monthSep);
            }
            let locationText = record.country === '中国'
                ? record.province + ' ' + record.city
                : record.country + ' ' + record.province + ' ' + record.city;

            if (record.province === record.city) {
                locationText = record.country === '中国'
                    ? record.city
                    : record.country + ' ' + record.city;
            }

            const entryDiv = document.createElement('div');
            entryDiv.className = 'diary-entry diary-entry-clickable';
            entryDiv.setAttribute('data-md-path', record.desc_md || '');
            entryDiv.style.setProperty('--year-line-color', dotColor);

            const dateHtml = formatDateForCard(record.date);

            entryDiv.innerHTML =
                '<div class="entry-date">' + dateHtml + '</div>' +
                '<div class="entry-body">' +
                    '<div class="entry-header"></div>' +
                    '<div class="entry-location">' + escapeHtml(locationText) + '</div>' +
                    '<div class="entry-desc entry-title"><h1>' + escapeHtml(record.descTitle || buildFallbackTitle(record)) + '</h1></div>' +
                    '<div class="entry-footer">' +
                        '<a href="#" class="tag link-location" data-country="' + escapeHtml(record.country) + '" data-province="' + escapeHtml(record.province) + '" data-city="' + escapeHtml(record.city) + '">' +
                            escapeHtml(record.country === '中国' ? record.province : record.country) +
                        '</a>' +
                        (record.isRepeated ? '<span class="badge-repeat">Repeat Visit</span>' : '') +
                    '</div>' +
                '</div>';

            entryDiv.addEventListener('click', (e) => {
                const ignore = e.target.closest('button, a, .entry-photo, .link-location');
                if (ignore) return;
                openEntryModal(record);
            });

            setTimeout(() => {
                const link = entryDiv.querySelector('.link-location');
                if (link) {
                    link.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        const country = link.getAttribute('data-country');
                        const province = link.getAttribute('data-province');
                        const city = link.getAttribute('data-city');
                        openLocationView(country, province, city);
                    });
                }
            }, 0);

            container.appendChild(entryDiv);
        });
    });

    setTimeout(() => {
        container.style.minHeight = '';
    }, 400);
}

/* Modal: show full markdown + images */
function openEntryModal(record) {
    // create overlay if not present
    let overlay = document.getElementById('entryModalOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'entryModalOverlay';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-card" role="dialog" aria-modal="true">
                <button class="modal-close" aria-label="Close">×</button>
                <div class="modal-scroll" tabindex="0"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        // close handlers
        overlay.addEventListener('click', (ev) => {
            if (ev.target === overlay) closeEntryModal();
        });

        overlay.querySelector('.modal-close').addEventListener('click', closeEntryModal);
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape') closeEntryModal();
        });
    }

    const scrollContainer = overlay.querySelector('.modal-scroll');
    if (!scrollContainer) return;

    // build content: title + bodyHtml + photos
    let contentHtml = '';
    contentHtml += `<h1 class="modal-title">${escapeHtml(record.descTitle || buildFallbackTitle(record))}</h1>`;
    // show entry date following DESIGN.md's typography and muted color tokens
    contentHtml += `<div class="modal-meta"><time datetime="${escapeHtml(record.date || '')}">${escapeHtml(record.date || '')}</time></div>`;
    contentHtml += `<div class="markdown-content modal-markdown">${record.descBodyHtml || ''}</div>`;

    if (record.photo_folder && record.photos && record.photos.length > 0) {
        contentHtml += '<div class="modal-photos">';
        record.photos.forEach(photo => {
            const imgPath = `${record.photo_folder}/${photo}`;
            const fallbackSvg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150"><rect fill="#f5f0e8" width="200" height="150"/><text fill="#8e8b82" font-family="sans-serif" font-size="14" x="50%" y="50%" text-anchor="middle" dominant-baseline="middle">No Image</text></svg>');
            contentHtml += `<img src="${imgPath}" alt="${photo}" class="modal-photo" loading="lazy" onerror="this.onerror=null; this.src='data:image/svg+xml;utf8,${fallbackSvg}';">`;
        });
        contentHtml += '</div>';
    }

    scrollContainer.innerHTML = contentHtml;
    document.body.classList.add('modal-open');
    overlay.style.display = 'flex';
    // focus the scroll container for accessibility
    setTimeout(() => scrollContainer.focus(), 60);
}

function closeEntryModal() {
    const overlay = document.getElementById('entryModalOverlay');
    if (!overlay) return;
    overlay.style.display = 'none';
    document.body.classList.remove('modal-open');
}

/* Location view: open a dedicated page showing entries for a specific location */
function renderLocationFromHash() {
    if (!window.location.hash || !window.location.hash.startsWith('#location')) {
        return false;
    }

    try {
        const q = window.location.hash.split('?')[1] || '';
        const params = new URLSearchParams(q);
        const country = params.get('country') || '';
        const province = params.get('province') || '';
        const city = params.get('city') || '';
        renderLocationPage(country, province, city);
        return true;
    } catch (e) {
        return false;
    }
}

function openLocationView(country, province, city) {
    // push history state
    const state = { view: 'location', country, province, city };
    const title = `${city || province || country} - Travel Diary`;
    const url = `#location?country=${encodeURIComponent(country||'')}&province=${encodeURIComponent(province||'')}&city=${encodeURIComponent(city||'')}`;
    history.pushState(state, title, url);
    renderLocationPage(country, province, city);
}

function renderLocationPage(country, province, city) {
    const container = document.getElementById('diaryContainer');
    if (!container) return;

    // Header/hero for location
    const locationLabel = country === '中国' ? `${province} · ${city}` : `${country} ${city}`;
    const matching = travelRecords.filter(r => (
        (country ? r.country === country : true) &&
        (province ? r.province === province : true) &&
        (city ? r.city === city : true)
    ));

    const visits = matching.length;

    container.innerHTML = `
        <div class="location-hero">
            <button class="location-back">← Back</button>
            <div class="location-head">
                <h1 class="display-lg">${escapeHtml(locationLabel)}</h1>
                <div class="location-sub">${visits} visit${visits !== 1 ? 's' : ''}</div>
            </div>
        </div>
        <div class="location-entries" id="locationEntries"></div>
    `;

    const backBtn = container.querySelector('.location-back');
    if (backBtn) backBtn.addEventListener('click', returnToDiary);

    const entriesContainer = document.getElementById('locationEntries');
    matching.sort((a,b)=> b.date.localeCompare(a.date));
    matching.forEach(record => {
        const el = document.createElement('div');
        el.className = 'diary-entry diary-entry-clickable';
        const dateHtml = formatDateForCard(record.date);
        
        // Reuse the normal card location format.
        let locText = record.country === '中国'
            ? `${record.province} ${record.city}`
            : `${record.country} ${record.province} ${record.city}`;
        if (record.province === record.city) {
            locText = record.country === '中国' ? record.city : `${record.country} ${record.city}`;
        }

        el.innerHTML = `
            <div class="entry-date">${dateHtml}</div>
            <div class="entry-body">
                <div class="entry-header"></div>
                <div class="entry-location">${escapeHtml(locText)}</div>
                <div class="entry-desc entry-title"><h1>${escapeHtml(record.descTitle||buildFallbackTitle(record))}</h1></div>
            </div>
        `;
        el.addEventListener('click', (e)=>{
            const ignore = e.target.closest('button, a, .entry-photo');
            if (ignore) return;
            openEntryModal(record);
        });
        entriesContainer.appendChild(el);
    });
}

function returnToDiary() {
    if (history.state && history.state.view === 'location') {
        history.back();
        return;
    }

    history.replaceState({}, document.title, window.location.pathname + window.location.search);
    renderDiary();
    updateYearTabs();
    scrollToJournal();
}
