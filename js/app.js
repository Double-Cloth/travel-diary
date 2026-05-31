let travelRecords = [];

let currentState = {
    search: '',
    year: 'All',
    sortDesc: true,
    currentPage: 1,
    itemsPerPage: 6
};

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
            }
        });
        // If URL contains a location hash on initial load, render it
        if (window.location.hash && window.location.hash.startsWith('#location')) {
            try {
                const q = window.location.hash.split('?')[1] || '';
                const params = new URLSearchParams(q);
                const country = params.get('country') || '';
                const province = params.get('province') || '';
                const city = params.get('city') || '';
                renderLocationPage(country, province, city);
            } catch (e) {
                // ignore parse errors and stay on diary
            }
        }
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

    let html = `<button class="category-tab ${currentState.year === 'All' ? 'category-tab-active' : ''}" data-year="All">All Time</button>`;
    sortedYears.forEach(y => {
        html += `<button class="category-tab ${currentState.year === y ? 'category-tab-active' : ''}" data-year="${y}">${y}</button>`;
    });
    yearTabs.innerHTML = html;

    if (!yearTabs.dataset.listenerAttached) {
        yearTabs.addEventListener('click', (e) => {
            if (e.target.classList.contains('category-tab')) {
                document.querySelectorAll('.category-tab').forEach(t => t.classList.remove('category-tab-active'));
                e.target.classList.add('category-tab-active');

                currentState.year = e.target.getAttribute('data-year');
                currentState.currentPage = 1;
                renderDiary();

                window.scrollTo({ top: document.getElementById('diaryContainer').offsetTop - 120, behavior: 'smooth' });
            }
        });
        yearTabs.dataset.listenerAttached = 'true';
    }
}

function setupInteractions() {
    const navLinks = {
        '#journal': '.hero-band',
        '#destinations': '.sidebar',
        '#about': '#about'
    };

    document.querySelectorAll('.nav-goto').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const targetSelector = navLinks[link.getAttribute('href')];
            const targetEl = document.querySelector(targetSelector);
            if (targetEl) {
                const topOffset = targetEl.getBoundingClientRect().top + window.scrollY - 80;
                window.scrollTo({ top: topOffset, behavior: 'smooth' });
            }
        });
    });
}

function setupFilters() {
    const searchInput = document.getElementById('searchInput');
    const sortBtn = document.getElementById('sortBtn');

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            currentState.search = e.target.value.trim().toLowerCase();
            currentState.currentPage = 1;
            renderDiary();
        });
    }

    if (sortBtn) {
        sortBtn.addEventListener('click', () => {
            currentState.sortDesc = !currentState.sortDesc;
            sortBtn.innerHTML = currentState.sortDesc
                ? '<span>Newest First</span><span class="icon-sort" style="color: var(--muted); font-size: 16px;">↓</span>'
                : '<span>Oldest First</span><span class="icon-sort" style="color: var(--muted); font-size: 16px;">↑</span>';
            currentState.currentPage = 1;
            renderDiary();
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
        const locationKey = `${record.country}-${record.province}-${record.city}`;
        const isRepeated = visitTracker.has(locationKey);
        visitTracker.add(locationKey);
        return { ...record, isRepeated };
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

    const paginationContainer = document.getElementById('paginationContainer');

    if (filtered.length === 0) {
        container.innerHTML = `<div class="empty-state">No memories found for your search.</div>`;
        if (paginationContainer) paginationContainer.style.display = 'none';
        return;
    }

    const totalItems = filtered.length;
    const totalPages = Math.ceil(totalItems / currentState.itemsPerPage);

    if (currentState.currentPage > totalPages) {
        currentState.currentPage = totalPages;
    }

    const startIndex = (currentState.currentPage - 1) * currentState.itemsPerPage;
    const endIndex = startIndex + currentState.itemsPerPage;
    const paginatedData = filtered.slice(startIndex, endIndex);

    paginatedData.forEach(record => {
        let locationText = record.country === '中国'
            ? `${record.province} ${record.city}`
            : `${record.country} ${record.province} ${record.city}`;

        if (record.province === record.city) {
            locationText = record.country === '中国'
                ? record.city
                : `${record.country} ${record.city}`;
        }

        // Card shows only the top-level title (descTitle) externally.
        const entryDiv = document.createElement('div');
        entryDiv.className = 'diary-entry diary-entry-clickable';
        entryDiv.setAttribute('data-md-path', record.desc_md || '');

        entryDiv.innerHTML = `
            <div class="entry-header">
                <span class="entry-date">${record.date}</span>
            </div>
            <div class="entry-location">${escapeHtml(locationText)}</div>
            <div class="entry-desc entry-title"><h1>${escapeHtml(record.descTitle || buildFallbackTitle(record))}</h1></div>
            <div class="entry-footer">
                <a href="#" class="tag link-location" data-country="${escapeHtml(record.country)}" data-province="${escapeHtml(record.province)}" data-city="${escapeHtml(record.city)}">
                    ${record.country === '中国' ? record.province : record.country}
                </a>
                ${record.isRepeated ? '<span class="badge-repeat">Repeat Visit</span>' : ''}
            </div>
        `;

        // Click opens a modal showing the full markdown + images.
        entryDiv.addEventListener('click', (e) => {
            // prevent clicks on interactive controls inside entry from opening modal
            const ignore = e.target.closest('button, a, .entry-photo, .link-location');
            if (ignore) return;
            openEntryModal(record);
        });

        // attach click handler for location link
        // use event delegation safe binding
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

    renderPagination(totalPages);

    setTimeout(() => {
        container.style.minHeight = '';
    }, 400);
}

function renderPagination(totalPages) {
    const paginationContainer = document.getElementById('paginationContainer');
    if (!paginationContainer) return;

    if (totalPages <= 1) {
        paginationContainer.style.display = 'none';
        return;
    }

    paginationContainer.style.display = 'flex';

    paginationContainer.innerHTML = `
        <button class="page-btn" id="firstPageBtn" ${currentState.currentPage === 1 ? 'disabled' : ''}>« First</button>
        <button class="page-btn" id="prevPageBtn" ${currentState.currentPage === 1 ? 'disabled' : ''}>← Previous</button>
        <span class="page-info">Page ${currentState.currentPage} of ${totalPages}</span>
        <button class="page-btn" id="nextPageBtn" ${currentState.currentPage === totalPages ? 'disabled' : ''}>Next →</button>
        <button class="page-btn" id="lastPageBtn" ${currentState.currentPage === totalPages ? 'disabled' : ''}>Last »</button>
    `;

    document.getElementById('firstPageBtn').addEventListener('click', () => {
        if (currentState.currentPage > 1) {
            currentState.currentPage = 1;
            renderDiary();
            window.scrollTo({ top: document.getElementById('diaryContainer').offsetTop - 120, behavior: 'smooth' });
        }
    });

    document.getElementById('prevPageBtn').addEventListener('click', () => {
        if (currentState.currentPage > 1) {
            currentState.currentPage--;
            renderDiary();
            window.scrollTo({ top: document.getElementById('diaryContainer').offsetTop - 120, behavior: 'smooth' });
        }
    });

    document.getElementById('nextPageBtn').addEventListener('click', () => {
        if (currentState.currentPage < totalPages) {
            currentState.currentPage++;
            renderDiary();
            window.scrollTo({ top: document.getElementById('diaryContainer').offsetTop - 120, behavior: 'smooth' });
        }
    });

    document.getElementById('lastPageBtn').addEventListener('click', () => {
        if (currentState.currentPage < totalPages) {
            currentState.currentPage = totalPages;
            renderDiary();
            window.scrollTo({ top: document.getElementById('diaryContainer').offsetTop - 120, behavior: 'smooth' });
        }
    });
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
function openLocationView(country, province, city) {
    // push history state
    const state = { view: 'location', country, province, city };
    const title = `${city || province || country} — Travel Diary`;
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

    // back button behavior
    const backBtn = container.querySelector('.location-back');
    if (backBtn) backBtn.addEventListener('click', () => history.back());

    const entriesContainer = document.getElementById('locationEntries');
    matching.sort((a,b)=> b.date.localeCompare(a.date));
    matching.forEach(record => {
        const el = document.createElement('div');
        el.className = 'diary-entry';
        el.innerHTML = `
            <div class="entry-header"><span class="entry-date">${escapeHtml(record.date)}</span></div>
            <div class="entry-location">${escapeHtml(record.city)}</div>
            <div class="entry-desc entry-title"><h1>${escapeHtml(record.descTitle||buildFallbackTitle(record))}</h1></div>
            <div class="entry-footer"><a href="#" class="tag link-location" data-country="${escapeHtml(record.country)}" data-province="${escapeHtml(record.province)}" data-city="${escapeHtml(record.city)}">View same place</a></div>
        `;
        el.addEventListener('click', (e)=>{
            const ignore = e.target.closest('button, a, .entry-photo');
            if (ignore) return;
            openEntryModal(record);
        });
        entriesContainer.appendChild(el);
    });
}