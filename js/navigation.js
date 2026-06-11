import { currentState } from './state.js';

const appPages = ['home', 'journey', 'profile'];

export function pageFromHash(hash) {
    if (hash && hash.startsWith('#location')) return 'journey';

    const page = (hash || '').replace('#', '');
    return appPages.includes(page) ? page : 'home';
}

export function showPage(page, options = {}) {
    const targetPage = appPages.includes(page) ? page : 'home';
    const updateHash = options.updateHash !== false;
    const scrollTop = options.scrollTop !== false;

    document.querySelectorAll('.app-page').forEach(section => {
        const isActive = section.dataset.page === targetPage;
        section.hidden = !isActive;
        section.classList.toggle('page-active', isActive);
    });

    document.querySelectorAll('.nav-links .nav-goto').forEach(link => {
        const hrefPage = pageFromHash(link.getAttribute('href'));
        link.classList.toggle('nav-active', hrefPage === targetPage);
        link.setAttribute('aria-current', hrefPage === targetPage ? 'page' : 'false');
    });

    currentState.page = targetPage;
    document.body.dataset.page = targetPage;

    if (updateHash && window.location.hash !== `#${targetPage}`) {
        history.pushState({ view: 'page', page: targetPage }, document.title, `#${targetPage}`);
    }

    if (scrollTop) {
        window.scrollTo({ top: 0, behavior: 'auto' });
    }
}

export function closeSidebar() {
    const hamburger = document.getElementById('hamburgerBtn');

    document.body.classList.remove('sidebar-open');
    document.querySelector('.sidebar-overlay')?.remove();
    hamburger?.setAttribute('aria-expanded', 'false');
}

export function setupInteractions() {
    document.querySelectorAll('.nav-goto').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            showPage(pageFromHash(link.getAttribute('href')));
            closeSidebar();
        });
    });

    const hamburger = document.getElementById('hamburgerBtn');
    if (!hamburger) return;

    hamburger.addEventListener('click', () => {
        const isOpen = document.body.classList.toggle('sidebar-open');
        hamburger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

        if (isOpen) {
            let overlay = document.querySelector('.sidebar-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = 'sidebar-overlay';
                document.body.appendChild(overlay);
                overlay.addEventListener('click', closeSidebar);
            }
            return;
        }

        document.querySelector('.sidebar-overlay')?.remove();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeSidebar();
        }
    });
}
