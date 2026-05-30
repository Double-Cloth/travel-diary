let travelRecords = [];

let currentState = {
    search: '',
    year: 'All',
    sortDesc: true, // true = newest first
    currentPage: 1,
    itemsPerPage: 6
};

document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

function initApp() {
    try {
        // Instead of fetch, we use the variable loaded from travel_data.js
        if (typeof travelDataLocal === 'undefined') {
            throw new Error('Local data file not loaded.');
        }
        
        travelRecords = travelDataLocal;
        
        const initialStats = analyzeData();
        renderStats(initialStats);
        initYears();
        setupFilters();
        renderDiary();
        setupInteractions();
    } catch (error) {
        const container = document.getElementById('diaryContainer');
        if (container) {
            container.innerHTML = `<div class="empty-state" style="color: var(--error);">Error loading diary entries: ${error.message}</div>`;
        }
        console.error('Initial Load Error:', error);
    }
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
        cities: visitedCities.size
    };
}

function renderStats(stats) {
    const statsHeader = document.getElementById('statsHeader');
    if (!statsHeader) return;

    statsHeader.innerHTML = `
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
                currentState.currentPage = 1; // 切换年份重置到第一页
                renderDiary();
                
                // 平滑返回顶部
                window.scrollTo({ top: document.getElementById('diaryContainer').offsetTop - 120, behavior: 'smooth' });
            }
        });
        yearTabs.dataset.listenerAttached = 'true';
    }
}

function setupInteractions() {
    // Nav Links Smoothing
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
            currentState.currentPage = 1; // 搜索重置到第一页
            renderDiary();
        });
    }

    if (sortBtn) {
        sortBtn.addEventListener('click', () => {
            currentState.sortDesc = !currentState.sortDesc;
            sortBtn.innerHTML = currentState.sortDesc 
                ? '<span>Newest First</span><span class="icon-sort" style="color: var(--muted); font-size: 16px;">↓</span>' 
                : '<span>Oldest First</span><span class="icon-sort" style="color: var(--muted); font-size: 16px;">↑</span>';
            currentState.currentPage = 1; // 排序重置到第一页
            renderDiary();
            window.scrollTo({ top: document.getElementById('diaryContainer').offsetTop - 120, behavior: 'smooth' });
        });
    }
}

function renderDiary() {
    const container = document.getElementById('diaryContainer');
    if (!container) return;
    
    // 锁定高度，防止内容替换瞬间页面坍塌导致滚动条闪跳
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
        const matchSearch = 
            record.country.toLowerCase().includes(currentState.search) ||
            record.province.toLowerCase().includes(currentState.search) ||
            record.city.toLowerCase().includes(currentState.search) ||
            record.desc.toLowerCase().includes(currentState.search);
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

    // 分页计算
    const totalItems = filtered.length;
    const totalPages = Math.ceil(totalItems / currentState.itemsPerPage);
    
    // 防止超出限制
    if (currentState.currentPage > totalPages) {
        currentState.currentPage = totalPages;
    }

    const startIndex = (currentState.currentPage - 1) * currentState.itemsPerPage;
    const endIndex = startIndex + currentState.itemsPerPage;
    const paginatedData = filtered.slice(startIndex, endIndex);

    paginatedData.forEach(record => {
        let locationText = record.country === "中国" 
            ? `${record.province} ${record.city}` 
            : `${record.country} ${record.province} ${record.city}`;

        if (record.province === record.city) {
            locationText = record.country === "中国" 
                ? record.city 
                : `${record.country} ${record.city}`;
        }

        let photosHtml = '';
        if (record.photo_folder && record.photos && record.photos.length > 0) {
            photosHtml = '<div class="entry-photos">';
            record.photos.forEach(photo => {
                const imgPath = `${record.photo_folder}/${photo}`;
                const fallbackSvg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="#f5f0e8" width="100" height="100"/><text fill="#8e8b82" font-family="sans-serif" font-size="12" x="50%" y="50%" text-anchor="middle" dominant-baseline="middle">No Image</text></svg>');
                photosHtml += `<img src="${imgPath}" alt="${photo}" class="entry-photo" loading="lazy" onerror="this.onerror=null; this.src='data:image/svg+xml;utf8,${fallbackSvg}';">`;
            });
            photosHtml += '</div>';
        }

        const entryDiv = document.createElement('div');
        entryDiv.className = 'diary-entry';

        entryDiv.innerHTML = `
            <div class="entry-header">
                <span class="entry-date">${record.date}</span>
            </div>
            <div class="entry-location">${locationText}</div>
            <div class="entry-desc">${record.desc}</div>
            ${photosHtml}
            <div class="entry-footer">
                <span class="tag">
                    ${record.country === "中国" ? record.province : record.country}
                </span>
                ${record.isRepeated ? '<span class="badge-repeat">Repeat Visit</span>' : ''}
            </div>
        `;
        container.appendChild(entryDiv);
    });

    renderPagination(totalPages);

    // 延时解除高度锁定，配合平滑滚动的动画时长 (300ms~400ms)
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
    
    // 生成分页控件
    paginationContainer.innerHTML = `
        <button class="page-btn" id="prevPageBtn" ${currentState.currentPage === 1 ? 'disabled' : ''}>← Previous</button>
        <span class="page-info">Page ${currentState.currentPage} of ${totalPages}</span>
        <button class="page-btn" id="nextPageBtn" ${currentState.currentPage === totalPages ? 'disabled' : ''}>Next →</button>
    `;

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
            // 在翻页后平滑滚动回内容顶部
            window.scrollTo({ top: document.getElementById('diaryContainer').offsetTop - 120, behavior: 'smooth' });
        }
    });
}