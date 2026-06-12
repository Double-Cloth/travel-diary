import { loadTravelData, loadTravelRecords, analyzeData } from './data.js';
import { pageFromHash, setupInteractions, showPage } from './navigation.js';
import { getTravelRecords, setTravelRecords } from './state.js';
import { escapeHtml } from './utils.js';
import {
    initYears,
    renderDiary,
    renderHomeStats,
    renderLoadingState,
    renderLocationFromHash,
    renderLocationPage,
    renderProfile,
    renderStats,
    setupFilters,
    updateYearTabs
} from './views.js';

document.addEventListener('DOMContentLoaded', () => {
    void initApp();
});

async function initApp() {
    try {
        renderLoadingState();

        const travelData = await loadTravelData();
        setTravelRecords(await loadTravelRecords(travelData));

        const initialStats = analyzeData(getTravelRecords());
        renderStats(initialStats);
        renderHomeStats(initialStats);
        renderProfile(initialStats);
        initYears();
        setupFilters();
        renderDiary();
        setupInteractions();
        showPage(pageFromHash(window.location.hash), { updateHash: false, scrollTop: false });

        window.addEventListener('popstate', (event) => {
            const state = event.state || {};
            if (state && state.view === 'location') {
                showPage('journey', { updateHash: false, scrollTop: false });
                renderLocationPage(state.country, state.province, state.city);
                return;
            }

            showPage(pageFromHash(window.location.hash), { updateHash: false, scrollTop: false });
            renderDiary();
            updateYearTabs();
        });

        window.addEventListener('hashchange', () => {
            if (!renderLocationFromHash()) {
                showPage(pageFromHash(window.location.hash), { updateHash: false, scrollTop: false });
                renderDiary();
                updateYearTabs();
            }
        });

        renderLocationFromHash();
    } catch (error) {
        const container = document.getElementById('diaryContainer');
        if (container) {
            container.innerHTML = `<div class="empty-state empty-state-error">Error loading diary entries: ${escapeHtml(error.message)}</div>`;
        }
        console.error('Initial Load Error:', error);
    }
}
