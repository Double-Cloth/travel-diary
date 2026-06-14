import { loadTravelData, loadTravelRecords, analyzeData } from './data.js';
import { pageFromHash, setupInteractions, showPage } from './navigation.js';
import { getTravelRecords, setTravelRecords } from './state.js';
import { escapeHtml } from './utils.js';
import {
    initYears,
    renderDiary,
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
        renderProfile(initialStats);
        initYears();
        setupFilters();
        renderDiary();
        setupInteractions();
        initHomeRouteInteractions();
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

function initHomeRouteInteractions() {
    const routeArt = document.getElementById('homeRouteArt');
    const routeToggle = document.getElementById('homeRouteToggle');

    if (!routeArt || !routeToggle) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const compactView = window.matchMedia('(max-width: 768px)');

    const setRouteActive = (isActive) => {
        routeArt.classList.toggle('home-route-art-active', isActive);
        routeToggle.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    };

    const toggleRoute = () => {
        setRouteActive(!routeArt.classList.contains('home-route-art-active'));
    };

    const resetTilt = () => {
        routeArt.style.setProperty('--route-tilt-x', '0deg');
        routeArt.style.setProperty('--route-tilt-y', '0deg');
        routeArt.style.setProperty('--route-glow-x', '54%');
        routeArt.style.setProperty('--route-glow-y', '48%');
    };

    routeToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleRoute();
    });

    routeArt.addEventListener('click', (event) => {
        if (compactView.matches || event.target.closest('button')) return;
        toggleRoute();
    });

    routeArt.addEventListener('pointermove', (event) => {
        if (reduceMotion.matches || compactView.matches) return;

        const rect = routeArt.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;

        routeArt.style.setProperty('--route-tilt-x', `${(0.5 - y) * 7}deg`);
        routeArt.style.setProperty('--route-tilt-y', `${(x - 0.5) * 9}deg`);
        routeArt.style.setProperty('--route-glow-x', `${Math.round(x * 100)}%`);
        routeArt.style.setProperty('--route-glow-y', `${Math.round(y * 100)}%`);
    });

    routeArt.addEventListener('pointerleave', resetTilt);
    routeArt.addEventListener('blur', resetTilt, true);
}
