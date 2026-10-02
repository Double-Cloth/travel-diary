import { loadTravelData, loadTravelRecords } from './data.js';
import { createRecordEditor } from './record-editor.js?v=20260930-review-v1';
import { createPasswordChangeDialog, createPasswordGate } from './record-password.js?v=20260920-password-change-v1';
import { createDataTransfer } from './data-transfer.js?v=20260930-review-v1';
import { detectWriterCapability } from './writer-capability.js?v=20260914-auth-setup-v1';
import { createRecordDeleteDialog } from './record-delete-dialog.js?v=20260913-delete-feedback-v2';
import { confirmFeedback, showFeedback } from './feedback-dialog.js';
import { prepareProfilePicture, uploadProfilePicture } from './profile-picture.js?v=20260930-review-v1';
import { DEFAULT_OWNER_NAME, loadOwnerName, saveOwnerName } from './profile-owner.js?v=20260930-review-v1';
import { createOwnerNameDialog } from './profile-owner-dialog.js?v=20260930-review-v1';
import { buildRecordSetSnapshot, deriveOverviewAnalytics } from './analytics.mjs';
import { buildFallbackTitle, escapeHtml } from './utils.js';
import { enhanceCustomSelects } from './custom-select.js?v=20260930-review-v1';
import { buildItineraryGroups, countDistinctVisits, getVisitKey } from './visits.mjs';
import {
    formatLocationText,
    getAdminAreaFilterLabel,
    getCountryLocationLabels,
    isDomesticLocation
} from './location.mjs';
import {
    constrainPhotoViewerTranslate,
    getInitialPhotoScale as calculateInitialPhotoScale,
    getMaximumPhotoScale as calculateMaximumPhotoScale,
    getMinimumPhotoScale as calculateMinimumPhotoScale,
    getPhotoViewerBounds as calculatePhotoViewerBounds,
    getPhotoViewerRenderMetrics,
    getPhotoViewerZoomTranslate
} from './photo-viewer-transform.mjs';

const DEFAULT_LEDGER_SORT = 'desc';
const LEDGER_SORT_OPTIONS = new Set(['desc', 'asc', 'location', 'area', 'title']);
const LEDGER_FILTER_DEFAULTS = {
    year: [],
    month: [],
    country: [],
    area: [],
    locality: [],
    visit: [],
    media: [],
    note: [],
    q: '',
    sort: DEFAULT_LEDGER_SORT
};
const PAGE_TURN_MS = 920;
const MOBILE_PAGE_TURN_MS = 760;
const BOOK_COVER_TURN_MS = 1180;
const MOBILE_BOOK_COVER_OPEN_MS = 1040;
const MOBILE_BOOK_COVER_CLOSE_MS = 920;
const MOBILE_BOOK_COVER_PAINT_WAIT_MS = 240;
const SEARCH_UPDATE_DELAY_MS = 180;
const ENTRY_PHOTO_PREVIEW_ROWS = 3;
const MOBILE_CONTEXT_PANEL_QUERY = '(max-width: 760px)';
const DEFAULT_VIDEO_VOLUME = 0.85;
const VIDEO_PLAY_ICON_PATH = 'M8 5.5v13l10-6.5z';
const VIDEO_PAUSE_ICON_PATH = 'M7 5h4v14H7zm6 0h4v14h-4z';

const refs = {};
let openRecordEditor;
let openEditRecord;
let openDeleteRecord;
let openDataExport;
let openDataClear;
let openProfilePictureUpload;
let openOwnerNameChange;
let openPasswordChange;
let profilePictureCapability = null;
let profileOwnerName = DEFAULT_OWNER_NAME;
let ownerNameDialog;
let dataTransfer;
let travelModel = null;
let activeRoute = null;
let pageTurnTimer = null;
let pageTurnCleanup = null;
let lastReadingHash = '#ledger';
let renderedPageHash = '';
let lastEntryFocusId = '';
let lastReadingScrollPosition = null;
let searchRouteTimer = null;
let isSearchComposing = false;
let isMobileContextPanelOpen = false;
let isMobileContextPageScrollLocked = false;
let mobileContextScrollY = 0;
let photoPreviewResizeTimer = null;
let photoPreviewLateResizeTimer = null;
let photoSleeveResizeObserver = null;
const observedPhotoSleeves = new Set();
const PHOTO_ROTATION_ANIMATION_MS = 220;
let photoViewerState = null;
let photoViewerTrigger = null;
let photoViewerShellWasInert = false;
let photoGestureState = createPhotoGestureState();
let photoRotationTimer = null;
let photoViewerFitFrame = null;
let photoViewerStageResizeObserver = null;

document.addEventListener('DOMContentLoaded', () => {
    void initApp();
});

function getRefreshKey() {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function refreshTravelModel(cacheKey = '') {
    renderedPageHash = '';
    travelModel = deriveTravelModel(await loadTravelRecords(await loadTravelData(cacheKey), cacheKey));
}

async function initApp() {
    cacheRefs();
    bindGlobalEvents();
    syncProfilePictureImages(refs.spine);
    const recordDeleteDialog = createRecordDeleteDialog();
    const handleRecordSaved = async (savedRecord, context = {}) => {
        await refreshTravelModel(getRefreshKey());
        if (context.mode === 'edit') {
            const updatedRecord = travelModel.records.find(record => record.desc_md === savedRecord.desc_md);
            window.location.hash = updatedRecord
                ? serializeRoute({ name: 'entry', params: { id: updatedRecord.id } })
                : (lastReadingHash || '#ledger');
        } else {
            window.location.hash = '#ledger';
        }
        syncRouteFromHash({ initial: true });
    };
    const getRecords = () => travelModel?.records || [];
    const openCreateEditor = createRecordEditor(handleRecordSaved, getRecords);
    const openUpdateEditor = createRecordEditor(handleRecordSaved, getRecords);
    const requestCreateAuthorization = createPasswordGate(
        capability => openCreateEditor(null, capability),
        {
            title: '新增记录验证',
            description: '输入 6 位数字密码后继续。',
            verifying: '正在验证并打开编辑器…',
            actionError: '无法打开编辑器，请重试。',
            onStatic: () => openCreateEditor(null, { readonly: true })
        }
    );
    openRecordEditor = requestCreateAuthorization;
    const requestEditAuthorization = createPasswordGate((capability, record) => openUpdateEditor(record, capability), {
        title: '修改记录验证',
        description: '输入 6 位数字密码后修改这条旅行记录。',
        verifying: '正在验证并打开编辑器…',
        actionError: '无法打开修改窗口，请重试。',
        onStatic: record => openUpdateEditor(record, { readonly: true })
    });
    openEditRecord = requestEditAuthorization;
    const requestDeleteAuthorization = createPasswordGate(async (capability, record) => {
        try {
            if (!record) throw new Error('要删除的旅行记录已失效，请重新打开后再试。');
            const result = await deleteTravelRecord(record, capability);
            recordDeleteDialog.showSuccess(record, result);
        } catch (error) {
            recordDeleteDialog.showError(error);
        }
    }, {
        title: '删除记录验证',
        description: '输入 6 位数字密码后永久删除这条记录。',
        verifying: '正在验证并删除记录…',
        actionError: '删除记录失败，请重试。',
        staticMessage: '当前站点为静态只读页面，不支持删除记录。',
        beforePrompt: record => recordDeleteDialog.confirm(record)
    });
    refs.openEditRecord = record => openEditRecord(record);
    openDeleteRecord = requestDeleteAuthorization;
    refs.openDeleteRecord = openDeleteRecord;
    dataTransfer = createDataTransfer(async () => {
        profileOwnerName = await loadOwnerName(getRefreshKey());
        await refreshTravelModel(getRefreshKey());
        syncRouteFromHash({ initial: true });
    });
    const requestDataExportAuthorization = createPasswordGate(
        capability => dataTransfer.exportAll(`travel-diary-data-${getTodayDate()}.zip`, capability),
        {
            title: '导出数据验证',
            description: '输入 6 位数字密码后导出全部旅行数据和认证配置。',
            verifying: '正在验证并准备下载…',
            actionError: '无法导出全部数据，请重试。',
            staticMessage: '当前站点为静态只读页面，不提供全部数据导出。'
        }
    );
    openDataExport = requestDataExportAuthorization;
    openDataClear = createPasswordGate(async capability => {
        const result = await dataTransfer.clearAll(capability);
        resetProfilePicture();
        void showFeedback(
            result.refreshFailed
                ? '全部旅行数据已清空，但页面刷新失败。请手动刷新后查看。'
                : '所有旅行记录、正文、照片、视频、自定义头像和扉页署名均已清空，访问密码保持不变。',
            { label: '数据管理', title: '全部数据已清空' }
        );
    }, {
        title: '清空数据验证',
        description: '输入 6 位数字密码后永久清空全部旅行数据。',
        verifying: '正在验证并清空数据…',
        actionError: '无法清空全部数据，请重试。',
        staticMessage: '当前站点为静态只读页面，不支持清空全部数据。',
        beforePrompt: () => confirmFeedback(
            '所有旅行记录、正文、照片、视频、自定义头像和扉页署名都将被永久删除，且无法撤销。访问密码会保留。建议先导出完整备份。',
            {
                label: '危险操作',
                title: '确定清空全部数据？',
                cancelLabel: '暂不清空',
                confirmLabel: '继续验证'
            }
        )
    });
    openProfilePictureUpload = createPasswordGate(capability => {
        profilePictureCapability = capability;
        refs.profilePictureInput?.click();
    }, {
        title: '更换头像验证',
        description: '输入 6 位数字密码后选择新头像。',
        verifying: '正在验证并打开文件选择器…',
        actionError: '无法打开头像选择器，请重试。',
        staticMessage: '当前站点为静态只读页面，不支持更换头像。'
    });
    ownerNameDialog = createOwnerNameDialog();
    openOwnerNameChange = createPasswordGate(async capability => {
        try {
            const nextName = await ownerNameDialog.open(profileOwnerName);
            if (!nextName) return;
            profileOwnerName = await saveOwnerName(nextName, capability);
            refreshProfileOwnerName();
            document.querySelector('.preface-owner-plaque')?.focus();
            void showFeedback('扉页署名已更新。', { label: '扉页署名', title: '署名更新成功' });
        } catch (error) {
            void showFeedback(error?.message || '署名保存失败，请重试。', {
                label: '扉页署名',
                title: '无法保存署名'
            });
        }
    }, {
        title: '修改署名验证',
        description: '输入 6 位数字密码后修改扉页署名。',
        verifying: '正在验证并准备修改署名…',
        actionError: '无法修改署名，请重试。',
        staticMessage: '当前站点为静态只读页面，不支持修改署名。'
    });
    const showPasswordChange = createPasswordChangeDialog(async () => {
        await showFeedback(
            '访问密码已安全更新，其他设备上的旧登录会话已失效。',
            { label: '访问安全', title: '密码修改成功' }
        );
    });
    openPasswordChange = createPasswordGate(capability => showPasswordChange(capability), {
        title: '修改密码验证',
        description: '请先输入当前的 6 位数字密码。',
        verifying: '正在验证当前密码…',
        actionError: '无法开始修改密码，请重试。',
        staticMessage: '当前站点为静态只读页面，不支持修改访问密码。'
    });
    renderLoading();

    try {
        profileOwnerName = await loadOwnerName();
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
    refs.spine = document.querySelector('.journal-spine');
    refs.stage = document.getElementById('journalStage');
    refs.spread = document.getElementById('pageSpread');
    refs.leftPage = document.getElementById('leftPage');
    refs.rightPage = document.getElementById('rightPage');
    refs.closedBookCover = document.getElementById('closedBookCover');
    refs.profilePictureInput = document.getElementById('profilePictureInput');
    refs.profilePictureInput?.addEventListener('cancel', () => {
        profilePictureCapability = null;
    });
}

function refreshProfilePicture() {
    syncProfilePictureImages(document, getRefreshKey());
}

function refreshProfileOwnerName() {
    renderedPageHash = '';
    if (activeRoute) renderRoute(activeRoute, { initial: true });
}

function resetProfilePicture() {
    document.querySelectorAll('[data-profile-picture-image]').forEach((profilePicture) => {
        profilePicture.hidden = true;
        profilePicture.removeAttribute('src');
    });
}

function syncProfilePictureImages(root = document, cacheKey = '') {
    root.querySelectorAll?.('[data-profile-picture-image]').forEach((profilePicture) => {
        const source = profilePicture.dataset.src || 'data/profile/profile-picture.png';
        const profilePictureUrl = new URL(source, window.location.href);
        if (cacheKey) profilePictureUrl.searchParams.set('v', cacheKey);
        profilePicture.hidden = true;
        profilePicture.addEventListener('load', () => {
            if (profilePicture.naturalWidth > 1 || profilePicture.naturalHeight > 1) {
                profilePicture.hidden = false;
            }
        }, { once: true });
        profilePicture.addEventListener('error', () => {
            profilePicture.hidden = true;
        }, { once: true });
        profilePicture.src = profilePictureUrl.href;
    });
}

async function handleProfilePictureSelection(input) {
    const [file] = input.files || [];
    const capability = profilePictureCapability;
    profilePictureCapability = null;
    input.value = '';
    if (!file) return;
    if (!capability) {
        void showFeedback('请先点击头像并完成密码验证。', {
            label: '个人头像',
            title: '需要验证密码'
        });
        return;
    }
    const profilePictureButtons = [...document.querySelectorAll('[data-action="upload-profile-picture"]')];
    profilePictureButtons.forEach((button) => {
        button.setAttribute('aria-busy', 'true');
        button.disabled = true;
    });
    try {
        const picture = await prepareProfilePicture(file);
        await uploadProfilePicture(picture, capability);
        refreshProfilePicture();
        void showFeedback('新头像已保存。', { label: '个人头像', title: '头像更新成功' });
    } catch (error) {
        void showFeedback(error?.message || '头像处理失败，请换一张图片后重试。', {
            label: '个人头像',
            title: '无法使用这张图片'
        });
    } finally {
        profilePictureButtons.forEach((button) => {
            button.removeAttribute('aria-busy');
            button.disabled = false;
        });
    }
}

function bindGlobalEvents() {
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('error', handleMediaLoadError, true);
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
    document.addEventListener('fullscreenchange', handlePhotoViewerFullscreenChange);
    window.addEventListener('hashchange', () => syncRouteFromHash());
    window.addEventListener('resize', handleViewportResize);
}

function parseRoute(hash = window.location.hash) {
    const source = (hash || '#cover').replace(/^#/, '');
    const queryIndex = source.indexOf('?');
    const routeName = queryIndex < 0 ? source : source.slice(0, queryIndex);
    const query = queryIndex < 0 ? '' : source.slice(queryIndex + 1);
    const params = new URLSearchParams(query);

    switch (routeName || 'cover') {
        case 'cover':
            return { name: 'cover', params: {}, valid: true };
        case 'preface':
            return { name: 'preface', params: {}, valid: true };
        case 'ledger':
            return {
                name: 'ledger',
                params: {
                    year: normalizeFilterValues(params.getAll('year')),
                    month: normalizeMonth(params.getAll('month')),
                    country: normalizeFilterValues(params.getAll('country')),
                    area: normalizeFilterValues(params.getAll('area').length ? params.getAll('area') : params.getAll('province')),
                    locality: normalizeFilterValues(params.getAll('locality').length ? params.getAll('locality') : params.getAll('city')),
                    visit: normalizeVisit(params.getAll('visit')),
                    media: normalizeMedia(params.getAll('media')),
                    note: normalizeNote(params.getAll('note')),
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
                    area: params.get('area') || params.get('province') || '',
                    locality: params.get('locality') || params.get('city') || ''
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
        case 'preface':
            return '#preface';
        case 'ledger':
            {
                const ledgerParams = normalizeLedgerParams(route.params);
                appendLedgerFilterParams(params, 'year', ledgerParams.year);
                appendLedgerFilterParams(params, 'month', ledgerParams.month);
                appendLedgerFilterParams(params, 'country', ledgerParams.country);
                appendLedgerFilterParams(params, 'area', ledgerParams.area);
                appendLedgerFilterParams(params, 'locality', ledgerParams.locality);
                appendLedgerFilterParams(params, 'visit', ledgerParams.visit);
                appendLedgerFilterParams(params, 'media', ledgerParams.media);
                appendLedgerFilterParams(params, 'note', ledgerParams.note);
                if (ledgerParams.q) params.set('q', ledgerParams.q);
                if (ledgerParams.sort !== DEFAULT_LEDGER_SORT) params.set('sort', ledgerParams.sort);
            }
            return `#ledger${params.toString() ? `?${params}` : ''}`;
        case 'archive':
            if (route.params.q) params.set('q', route.params.q);
            return `#archive${params.toString() ? `?${params}` : ''}`;
        case 'place':
            if (route.params.country) params.set('country', route.params.country);
            if (route.params.area) params.set('area', route.params.area);
            if (route.params.locality) params.set('locality', route.params.locality);
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

function appendLedgerFilterParams(params, key, values) {
    values.forEach(value => params.append(key, value));
}

function syncRouteFromHash(options = {}) {
    clearSearchRouteTimer();
    isSearchComposing = false;
    if (!travelModel) return;

    const parsed = canonicalizeLocationRoute(parseRoute(window.location.hash));
    const normalizedHash = serializeRoute(parsed);

    if (!parsed.valid || !window.location.hash || normalizedHash !== window.location.hash || hasLegacyLocationQuery(window.location.hash)) {
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
    if (photoViewerState) closePhotoViewerDialog();
    const previousRoute = activeRoute;
    const shouldRestoreReadingScroll = isReturningToReadingBackground(previousRoute, route);
    activeRoute = route;

    if (shouldRestoreReadingScroll && renderedPageHash === serializeRoute(route)) {
        clearPageTurn();
        restoreReadingScrollPosition();
        restoreFocus(options.focusId, options.reopenSelectId, options.selectScrollTop);
        return;
    }
    const isSameChapter = previousRoute?.name === route.name
        && ['cover', 'preface', 'ledger', 'archive'].includes(route.name);
    const render = () => {
        refs.shell.dataset.route = route.name;
        document.body.dataset.route = route.name;
        updateChapterTabs(route.name);
        switch (route.name) {
            case 'cover':
                renderCover();
                break;
            case 'preface':
                renderPreface();
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
        renderedPageHash = serializeRoute(route);
        if (shouldRestoreReadingScroll) {
            restoreReadingScrollPosition();
        } else if (!isSameChapter && !options.initial && isMobileLayout()) {
            window.scrollTo({ top: 0, behavior: 'instant' });
        }
        restoreFocus(options.focusId, options.reopenSelectId, options.selectScrollTop);
    };
    const shouldAnimate = options.animate !== false && !options.initial && !isSameChapter;
    const crossesCover = previousRoute && (previousRoute.name === 'cover' || route.name === 'cover')
        && previousRoute.name !== route.name;
    if (crossesCover && shouldAnimate) {
        renderWithBookCover(render, route.name === 'cover' ? 'closing' : 'opening');
        return;
    }
    renderWithPageTurn(render, {
        animate: shouldAnimate,
        direction: options.direction || getTurnDirection(previousRoute, route)
    });
}

function deriveTravelModel(records) {
    const usedIds = new Set();
    const reservedIds = new Set(records.map(createRecordId));
    const recordIds = new Map(records.map((record) => {
        const baseId = createRecordId(record);
        let id = baseId;
        let suffix = 2;
        while (usedIds.has(id) || (id !== baseId && reservedIds.has(id))) id = `${baseId}-${suffix++}`;
        usedIds.add(id);
        return [record, id];
    }));
    const sortedAsc = [...records].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const firstVisitsByLocation = new Map();
    const enhancedAsc = sortedAsc.map((record) => {
        const id = recordIds.get(record);
        const year = (record.date || '').slice(0, 4) || '未知';
        const month = (record.date || '').slice(5, 7) || '';
        const locationKey = record.locationKey || [record.countryKey || record.country, record.adminArea, record.locality].filter(Boolean).join('|');
        const visitKey = getVisitKey({ ...record, id });
        const firstVisitKey = firstVisitsByLocation.get(locationKey);
        const isRepeated = Boolean(firstVisitKey && firstVisitKey !== visitKey);
        if (!firstVisitKey) {
            firstVisitsByLocation.set(locationKey, visitKey);
        }

        return {
            ...record,
            id,
            year,
            month,
            locationKey,
            visitKey,
            isRepeated,
            title: record.descTitle || buildFallbackTitle(record)
        };
    });
    const itineraryGroups = buildItineraryGroups(enhancedAsc);
    const recordsWithTripCounts = enhancedAsc.map((record) => {
        const tripGroup = itineraryGroups.get(record.visitKey);
        return {
            ...record,
            tripRecordCount: tripGroup?.count || 0,
            tripGroupLabel: tripGroup?.label || ''
        };
    });
    const enhancedByRecord = new Map(sortedAsc.map((record, index) => [record, recordsWithTripCounts[index]]));
    const enhanced = records.map(record => enhancedByRecord.get(record));
    const recordsById = new Map(enhanced.map(record => [record.id, record]));
    const recordsDesc = [...enhanced].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const years = Array.from(new Set(recordsDesc.map(record => record.year))).filter(Boolean);
    const firstDate = sortedAsc.find(record => record.date)?.date || '';
    const todayDate = getTodayDate();
    const dateRangeLabel = formatDateRange(firstDate, todayDate, 'day');
    const countries = buildLocationIndex(enhanced);
    const latestRecord = recordsDesc[0] || null;
    const yearStats = buildYearStats(enhanced);
    const monthStats = buildMonthStats(enhanced);
    const topAdminAreas = buildTopAdminAreas(countries);
    const repeatLocations = buildRepeatLocations(enhanced);
    const filterOptions = buildLedgerFilterOptions(enhanced);

    return {
        records: enhanced,
        recordsDesc,
        recordsById,
        years,
        dateRangeLabel,
        countries,
        yearStats,
        monthStats,
        topAdminAreas,
        repeatLocations,
        filterOptions,
        overviewAnalytics: deriveOverviewAnalytics(enhanced, todayDate),
        stats: {
            total: enhanced.length,
            countries: countries.length,
            adminAreas: countries.reduce((sum, country) => sum + country.adminAreas.length, 0),
            localities: new Set(enhanced.map(record => record.locationKey)).size
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
            localities: new Set(),
            firstDate: '',
            latestDate: ''
        };

        item.count += 1;
        item.localities.add(record.locationKey || getLocationText(record));
        item.firstDate = !item.firstDate || (record.date || '') < item.firstDate ? (record.date || '') : item.firstDate;
        item.latestDate = maxDate(item.latestDate, record.date);
        yearMap.set(year, item);
    });

    return Array.from(yearMap.values())
        .map(item => ({
            ...item,
            localityCount: item.localities.size,
            localities: undefined
        }))
        .sort((a, b) => b.year.localeCompare(a.year));
}

function buildTopAdminAreas(countries) {
    return countries
        .flatMap(country => country.adminAreas)
        .sort((a, b) => b.count - a.count || b.localityCount - a.localityCount || a.label.localeCompare(b.label, 'zh-CN'));
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
            localities: new Set(),
            latestDate: ''
        };

        item.count += 1;
        item.localities.add(record.locationKey || getLocationText(record));
        item.latestDate = maxDate(item.latestDate, record.date);
        monthMap.set(month, item);
    });

    return Array.from(monthMap.values())
        .map(item => ({
            ...item,
            localityCount: item.localities.size,
            localities: undefined
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
            visits: new Set(),
            firstDate: '',
            latestDate: ''
        };

        item.visits.add(getVisitKey(record));
        item.count = item.visits.size;
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
    const countryMap = new Map();
    const adminAreaMap = new Map();
    const localityMap = new Map();
    const months = new Set();

    records.forEach((record) => {
        if (record.month) {
            months.add(record.month);
        }

        const country = countryMap.get(record.countryKey) || {
            value: record.countryKey,
            label: record.country,
            countryCode: record.countryCode,
            count: 0,
            latestDate: ''
        };
        country.count += 1;
        country.latestDate = maxDate(country.latestDate, record.date);
        countryMap.set(record.countryKey, country);

        if (record.adminArea) {
            const adminArea = adminAreaMap.get(record.adminAreaKey) || {
                value: record.adminAreaKey,
                label: record.adminArea,
                country: record.country,
                countryKey: record.countryKey,
                count: 0,
                latestDate: ''
            };
            adminArea.count += 1;
            adminArea.latestDate = maxDate(adminArea.latestDate, record.date);
            adminAreaMap.set(record.adminAreaKey, adminArea);
        }

        const locality = localityMap.get(record.locationKey) || {
            value: record.locationKey,
            label: record.locality,
            country: record.country,
            countryKey: record.countryKey,
            adminArea: record.adminArea,
            adminAreaKey: record.adminAreaKey,
            count: 0,
            latestDate: ''
        };
        locality.count += 1;
        locality.latestDate = maxDate(locality.latestDate, record.date);
        localityMap.set(record.locationKey, locality);
    });

    return {
        months: Array.from(months).sort((a, b) => a.localeCompare(b)).map(month => ({
            value: month,
            label: `${Number(month)}月`
        })),
        countries: Array.from(countryMap.values())
            .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN')),
        adminAreas: Array.from(adminAreaMap.values())
            .sort((a, b) => b.count - a.count || b.latestDate.localeCompare(a.latestDate) || a.label.localeCompare(b.label, 'zh-CN')),
        localities: Array.from(localityMap.values())
            .sort((a, b) => (
                a.country.localeCompare(b.country, 'zh-CN')
                || a.adminArea.localeCompare(b.adminArea, 'zh-CN')
                || a.label.localeCompare(b.label, 'zh-CN')
            ))
    };
}

function buildLocationIndex(records) {
    const countryMap = new Map();

    records.forEach((record) => {
        const countryKey = record.countryKey || record.country || '未知国家/地区';
        const areaGroupKey = record.adminAreaKey || `country:${countryKey}`;
        const country = countryMap.get(countryKey) || {
            countryKey,
            country: countryKey,
            countryCode: record.countryCode,
            count: 0,
            visits: new Set(),
            localities: new Set(),
            areas: new Map(),
            latestDate: '',
            searchText: ''
        };
        country.country = record.country;
        const area = country.areas.get(areaGroupKey) || {
            key: areaGroupKey,
            countryKey,
            country: countryKey,
            adminArea: record.adminArea,
            label: record.adminArea || record.country,
            isCountryLevel: !record.adminArea,
            count: 0,
            visits: new Set(),
            localities: new Set(),
            latestDate: '',
            searchText: ''
        };

        country.visits.add(getVisitKey(record));
        country.count = country.visits.size;
        country.localities.add(record.locationKey);
        country.latestDate = maxDate(country.latestDate, record.date);
        country.searchText = `${country.searchText} ${record.searchText || ''}`.toLowerCase();

        area.visits.add(getVisitKey(record));
        area.count = area.visits.size;
        area.localities.add(record.locality);
        area.latestDate = maxDate(area.latestDate, record.date);
        area.searchText = `${area.searchText} ${record.searchText || ''}`.toLowerCase();

        country.areas.set(areaGroupKey, area);
        countryMap.set(countryKey, country);
    });

    return Array.from(countryMap.values())
        .map(country => ({
            ...country,
            visits: undefined,
            labels: getCountryLocationLabels(country),
            localityCount: country.localities.size,
            areas: Array.from(country.areas.values())
                .map(area => ({
                    ...area,
                    visits: undefined,
                    country: country.country,
                    localityCount: area.localities.size,
                    localities: Array.from(area.localities).filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN'))
                }))
                .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))
        }))
        .map(country => ({
            ...country,
            adminAreas: country.areas.filter(area => !area.isCountryLevel)
        }))
        .sort((a, b) => b.count - a.count || a.country.localeCompare(b.country, 'zh-CN'));
}

function renderCover() {
    // 首页只保留合上的实体封面；真实书页在翻开后才进入可访问树。
    setPages('', '');
}

function renderPreface() {
    const firstDate = travelModel.records.length
        ? travelModel.records.reduce((earliest, record) => !earliest || record.date < earliest ? record.date : earliest, '')
        : '等待第一篇';

    setPages(`
        <article class="preface-profile-page" aria-labelledby="prefaceTitle">
            <header class="preface-heading">
                <h1 id="prefaceTitle">扉页</h1>
                <p>Travel far enough, you meet yourself.</p>
            </header>

            <section class="preface-identity-sheet" aria-label="日记主人与旅程概况">
                <div class="preface-sheet-kicker" aria-hidden="true">
                    <span>TRAVEL DIARY</span>
                    <span>PERSONAL EDITION</span>
                </div>

                <div class="preface-profile-composition">
                    <button class="preface-portrait" type="button" data-action="upload-profile-picture" aria-label="更换扉页头像">
                        <span class="preface-portrait-fallback" aria-hidden="true">旅</span>
                        <img data-profile-picture-image data-src="data/profile/profile-picture.png" alt="日记主人的头像" hidden>
                        <span class="preface-photo-corner preface-photo-corner-left" aria-hidden="true"></span>
                        <span class="preface-photo-corner preface-photo-corner-right" aria-hidden="true"></span>
                    </button>

                    <div class="preface-owner-copy">
                        <p class="preface-owner-index">No.007</p>
                        <button class="preface-owner-plaque" type="button" data-action="edit-owner-name" aria-label="修改扉页署名" title="修改扉页署名">
                            <span>TRAVEL DIARY OWNER</span>
                            <strong>${escapeHtml(profileOwnerName)}</strong>
                        </button>
                        <blockquote class="preface-signature">且将新火试新茶，<br>诗酒趁年华</blockquote>
                        <span class="preface-seal" aria-hidden="true">
                            <strong>MEMORY</strong>
                            <small>ARCHIVE</small>
                        </span>
                    </div>
                </div>

                <div class="preface-route-rule" aria-hidden="true"><span></span><i></i><span></span></div>

                <dl class="preface-facts" aria-label="日记概况">
                    <div><dt>${travelModel.stats.total}</dt><dd>篇日记</dd></div>
                    <div><dt>${travelModel.stats.localities}</dt><dd>个目的地</dd></div>
                    <div><dt>${escapeHtml(firstDate)}</dt><dd>开始记录</dd></div>
                </dl>

                <footer class="preface-colophon" aria-hidden="true">
                    <span></span>
                    <span></span>
                </footer>
            </section>

            ${renderMobileContextToggle('打开日记工具箱', '新增、备份与安全管理')}
        </article>
    `, `
        ${renderContextPanelHeading('扉页', '日记工具箱')}

        <section class="preface-tool-section" aria-labelledby="prefaceWritingTitle">
            <h3 id="prefaceWritingTitle">日记维护</h3>
            <p>更改扉页中的个人头像与署名，或继续写下一段旅程。</p>
            <div class="preface-tool-actions">
                <button class="paper-button" type="button" data-action="upload-profile-picture">更换个人头像</button>
                <button class="paper-button" type="button" data-action="edit-owner-name">修改扉页署名</button>
                <button class="paper-button" type="button" data-action="add-record">新增旅行日记</button>
            </div>
        </section>

        <section class="preface-tool-section archive-data-transfer" aria-labelledby="prefaceDataTitle">
            <h3 id="prefaceDataTitle">数据备份</h3>
            <p>完整导出或导入旅行记录、媒体文件和认证配置。</p>
            <div class="preface-tool-actions">
                <button class="paper-button" type="button" data-action="export-all-data">导出全部数据</button>
                <button class="paper-button" type="button" data-action="import-all-data">导入全部数据</button>
            </div>
            <p class="archive-data-status" data-data-transfer-status role="status" aria-live="polite"></p>
        </section>

        <section class="preface-tool-section archive-access-security" aria-labelledby="prefaceSecurityTitle">
            <h3 id="prefaceSecurityTitle">访问安全</h3>
            <p>验证当前密码后设置新的 6 位数字密码。</p>
            <button class="paper-button" type="button" data-action="change-password">修改访问密码</button>
        </section>

        <section class="preface-tool-section archive-danger-zone" aria-labelledby="prefaceDangerTitle">
            <h3 id="prefaceDangerTitle">危险操作</h3>
            <p>永久清空所有旅行记录、自定义头像和扉页署名。操作前请先导出备份。</p>
            <button class="paper-button archive-data-clear" type="button" data-action="clear-all-data">清空全部数据</button>
        </section>
    `, 'dossier-page context-panel preface-tools-panel');
}

function renderRecordPaperclip() {
    return `
            <span class="record-paperclip record-paperclip-back" aria-hidden="true"></span>
            <span class="record-paperclip record-paperclip-front" aria-hidden="true"></span>`;
}

function renderLedger(params = {}, options = {}) {
    const ledgerParams = normalizeLedgerParams(params);
    const yearBookmarksScrollLeft = refs.leftPage?.querySelector('.year-bookmarks')?.scrollLeft || 0;
    const filtered = getLedgerRecords(ledgerParams);
    const resultLabel = createLedgerResultLabel(filtered.length, ledgerParams);
    const snapshot = buildRecordSetSnapshot(filtered);

    setPages(`
        <div class="ledger-page">
            <header class="page-head ledger-page-head">
                <p class="journal-label">日记目录</p>
                <h1>出发，到新的爱与喧闹中去！</h1>
            </header>
            <section class="ledger-catalog-tools" aria-label="查找与浏览日记">
                ${renderLedgerControls(ledgerParams, 'ledgerSearch')}
                <div class="ledger-browse-row">
                    <nav class="ledger-year-nav" aria-label="按年份浏览日记">
                        <span class="ledger-year-label">按年份</span>
                        <div class="year-bookmarks">
                            ${yearToggleButton('全部', 'all', ledgerParams.year)}
                            ${[...travelModel.years].sort((a, b) => a.localeCompare(b)).map(year => yearToggleButton(year, year, ledgerParams.year)).join('')}
                        </div>
                    </nav>
                </div>
            </section>
            <div class="timeline-list" id="ledgerList">
                ${filtered.length
                    ? renderLedgerGroups(filtered, ledgerParams)
                    : (travelModel.records.length ? '<div class="empty-note">没有找到匹配的旅行记录。</div>' : renderEmptyArchiveState())}
            </div>
        </div>
    `, `
            ${renderLedgerContextPanel(snapshot, resultLabel, ledgerParams)}
    `, 'map-pocket context-panel', {
        preserveRightScroll: options.preserveRightScroll,
        keepContextPanelOpen: options.keepContextPanelOpen
    });

    if (yearBookmarksScrollLeft) {
        const yearBookmarks = refs.leftPage?.querySelector('.year-bookmarks');
        if (yearBookmarks) {
            yearBookmarks.scrollLeft = yearBookmarksScrollLeft;
        }
    }
}

function renderLedgerContextPanel(snapshot, resultLabel, ledgerParams) {
    return `
        <div class="ledger-feature-filters" id="ledgerFilters" tabindex="-1">
            ${renderContextPanelHeading('索引夹层', '高级筛选')}
            ${renderLedgerSnapshot(snapshot, resultLabel)}
            ${renderLedgerResetAction(ledgerParams)}
            ${renderLedgerFilterWorkbench(ledgerParams)}
        </div>
    `;
}

function createLedgerResultLabel(count, params) {
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
        <div class="index-dashboard" aria-label="筛选结果快照" aria-live="polite">
            <div class="index-dashboard-main">
                <span>${escapeHtml(resultLabel)}</span>
                <strong class="index-dashboard-value">
                    <span>${snapshot.count}</span>
                    <small class="index-dashboard-unit">条</small>
                </strong>
            </div>
            <div class="index-dashboard-grid">
                <span><strong>${snapshot.localityCount}</strong> 个地点</span>
                <span><strong>${snapshot.adminAreaCount}</strong> 个一级行政区</span>
                <span>${escapeHtml(dateRange)}</span>
            </div>
        </div>
    `;
}

function renderLedgerFilterWorkbench(params) {
    const adminAreaLabel = getAdminAreaFilterLabel(travelModel.records, params.country.length === 1 ? params.country[0] : 'all');
    const adminAreaOptions = getAdminAreaFilterOptions(params.country);
    const localityOptions = getLocalityFilterOptions(params.country, params.area);
    const monthOptions = [
        { value: 'all', label: '全部月份' },
        ...travelModel.filterOptions.months
    ];
    const countryOptions = [
        { value: 'all', label: '全部国家 / 地区' },
        ...travelModel.filterOptions.countries.map(item => ({
            value: item.value,
            label: `${item.countryCode || item.value} · ${item.label} · ${item.count}`
        }))
    ];
    const scopedAdminAreaOptions = [
        { value: 'all', label: `全部${adminAreaLabel}` },
        ...adminAreaOptions.map(item => ({
            value: item.value,
            label: params.country.length === 0 ? `${item.label} · ${item.country}` : `${item.label} · ${item.count}`
        }))
    ];
    const scopedLocalityOptions = [
        { value: 'all', label: '全部城市 / 目的地' },
        ...localityOptions.map(item => ({
            value: item.value,
            label: params.area.length === 0
                ? `${item.label} · ${item.adminArea || item.country}`
                : item.label
        }))
    ];
    const sortOptions = [
        { value: 'desc', label: '最新优先' },
        { value: 'asc', label: '最早优先' },
        { value: 'location', label: '按地点名称' },
        { value: 'area', label: '按一级行政区归类' },
        { value: 'title', label: '按标题名称' }
    ];

    return `
        <section class="index-filter-section" aria-labelledby="indexLocationFilters">
            <h3 id="indexLocationFilters">时间与地点</h3>
            <div class="index-filter-grid">
                ${renderLedgerSelect('月份', 'month', monthOptions, params.month, { multiple: true })}
                ${renderLedgerSelect('国家 / 地区', 'country', countryOptions, params.country, { multiple: true })}
                ${renderLedgerSelect(adminAreaLabel, 'area', scopedAdminAreaOptions, params.area, { multiple: true })}
                ${renderLedgerSelect('城市 / 目的地', 'locality', scopedLocalityOptions, params.locality, { multiple: true })}
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
            <span class="field-label">媒体状态</span>
            <div class="index-media-filter" aria-label="媒体状态">
                <div class="index-segment-group index-media-filter-primary">
                    ${filterToggleButton('全部', 'media', 'all', params.media)}
                    ${filterToggleButton('有媒体', 'media', 'any', params.media)}
                    ${filterToggleButton('无媒体', 'media', 'none', params.media)}
                </div>
                <div class="index-segment-group index-media-filter-details" aria-label="有媒体的类型">
                    ${filterToggleButton('有图片', 'media', 'photos', params.media)}
                    ${filterToggleButton('有视频', 'media', 'videos', params.media)}
                </div>
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
            ${renderLedgerSelect('排序方式', 'sort', sortOptions, params.sort, { visuallyHiddenLabel: true })}
        </section>
    `;
}

function renderLedgerResetAction(params) {
    const canReset = hasActiveLedgerFilter(params) || params.sort !== DEFAULT_LEDGER_SORT;

    return `
        <div class="index-reset-anchor">
            <button class="paper-button index-reset" type="button" data-action="reset-ledger-filters"${canReset ? '' : ' disabled'}>清除筛选与排序</button>
        </div>
    `;
}

function renderLedgerSelect(label, key, options, activeValue, settings = {}) {
    const { multiple = false, visuallyHiddenLabel = false } = settings;
    const id = `ledgerFilter${key[0].toUpperCase()}${key.slice(1)}`;
    return `
        <label class="index-filter-field${visuallyHiddenLabel ? ' index-sort-field' : ''}" for="${id}Button">
            <span class="field-label${visuallyHiddenLabel ? ' sr-only' : ''}">${escapeHtml(label)}</span>
            <select id="${id}" aria-label="${escapeHtml(label)}" data-custom-select data-ledger-filter="${escapeHtml(key)}"${multiple ? ' multiple' : ''}>
                ${options.map(option => `<option value="${escapeHtml(option.value)}"${isLedgerFilterValueSelected(activeValue, option.value) ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
            </select>
        </label>
    `;
}

function renderArchive(params = {}) {
    const query = (params.q || '').trim().toLowerCase();
    const latest = travelModel.latestRecord;
    const tripCount = new Set(travelModel.records.map(record => record.visitKey).filter(Boolean)).size;
    const topYear = getTopYearStat(travelModel.yearStats);
    const topMonth = getTopMonthStat(travelModel.monthStats);
    const leadingAdminArea = travelModel.topAdminAreas[0] || null;
    const broadestAdminArea = getBroadestAdminArea(travelModel.topAdminAreas);
    const countries = travelModel.countries
        .map(country => {
            if (!query) return country;
            const countryMatch = country.country.toLowerCase().includes(query);
            const areas = countryMatch
                ? country.areas
                : country.areas.filter(area => area.searchText.includes(query));
            return { ...country, areas };
        })
        .filter(country => country.areas.length > 0);

    setPages(`
        <div class="archive-page">
            <header class="page-head">
                <h1 class="sr-only">日记归档</h1>
                <p class="journal-label">日记归档</p>
                <p class="page-copy">"I was surprised, as always, by how easy the act of leaving was, and how good it felt. The world was suddenly rich with possibility."</p>
            </header>
            <label class="field-label" for="archiveSearch">搜索国家、一级行政区或目的地</label>
            <div class="ink-field search-field">
                <input id="archiveSearch" type="search" value="${escapeHtml(params.q || '')}" autocomplete="off" placeholder="例如：云南、苏州、北京">
                <button class="search-clear" type="button" data-action="clear-search" data-target="archive" aria-label="清空地点搜索" ${params.q ? '' : 'disabled'}>×</button>
            </div>
            ${renderMobileContextToggle('打开旅行概览', '查看足迹摘要与统计')}
            <div class="archive-country-list">
                ${countries.length
                    ? countries.map(renderCountryFolder).join('')
                    : (travelModel.records.length ? '<div class="empty-note">没有找到匹配的地点。</div>' : renderEmptyArchiveState())}
            </div>
        </div>
    `, `
        <div class="archive-overview-page">
            ${renderContextPanelHeading('旅行概览', '足迹摘要')}
            <dl class="archive-journey-stats" aria-label="旅行档案概览">
                <div><dt>${travelModel.records.length}</dt><dd>段旅程</dd></div>
                <div><dt>${tripCount}</dt><dd>次出发</dd></div>
                <div><dt>${travelModel.years.length}</dt><dd>个年份</dd></div>
            </dl>
            <section class="archive-overview-span" aria-labelledby="archiveTimelineTitle">
                <h3 id="archiveTimelineTitle">记录时间轴</h3>
                <strong>${escapeHtml(travelModel.dateRangeLabel)}</strong>
                <small>共 ${travelModel.stats.total} 篇日记</small>
                ${latest ? `
                    <a class="archive-latest-entry" href="#entry?id=${encodeURIComponent(latest.id)}">
                        <span>最新一页</span>
                        <strong>${escapeHtml(latest.locality || latest.adminArea || latest.country)}</strong>
                        <small>${escapeHtml(latest.date || '')}</small>
                    </a>
                ` : ''}
            </section>
            <section class="archive-overview-block archive-overview-scope">
                <h3>足迹分布</h3>
                <div class="overview-metric-grid">
                    ${renderOverviewMetric('国家', travelModel.stats.countries)}
                    ${renderOverviewMetric('一级行政区', travelModel.stats.adminAreas)}
                    ${renderOverviewMetric('目的地', travelModel.stats.localities)}
                </div>
            </section>
            <section class="archive-overview-block archive-overview-rhythm">
                <h3>记录节奏</h3>
                <div class="archive-rhythm-metrics">
                    ${renderOverviewMetric('活跃年份', travelModel.overviewAnalytics.activeYearCount)}
                    ${renderOverviewMetric('活跃月份', `${travelModel.overviewAnalytics.activeMonthCount} / ${travelModel.overviewAnalytics.activeMonthCapacity}`)}
                    ${renderOverviewMetric('复访地点', `${travelModel.overviewAnalytics.repeatLocationCount} 处`)}
                </div>
                <div class="overview-insight-list">
                    ${renderTopYearInsight(topYear)}
                    ${renderTopMonthInsight(topMonth)}
                    ${renderLongestGapInsight(travelModel.overviewAnalytics.longestGap)}
                </div>
            </section>
            <section class="archive-overview-block">
                <h3>地点倾向</h3>
                <div class="overview-insight-list overview-location-list">
                    ${renderTopAdminAreaInsight(leadingAdminArea)}
                    ${renderBroadAdminAreaInsight(broadestAdminArea)}
                    ${renderRepeatLocationInsights(travelModel.repeatLocations)}
                </div>
            </section>
        </div>
    `, 'dossier-page context-panel');
}

function renderEmptyArchiveState() {
    return `
        <div class="empty-note archive-empty-state">
            <strong>档案盒已经准备好了</strong>
            <p>这里还没有旅行记录。可以新增第一条记录，或导入以前保存的完整数据备份。</p>
            <div class="archive-empty-actions">
                <button class="paper-button" type="button" data-action="add-record"><span aria-hidden="true">＋</span> 新增第一条记录</button>
                <button class="paper-button" type="button" data-action="import-all-data">导入数据备份</button>
            </div>
        </div>
    `;
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
            <small>${stat.count} 篇日记 · ${stat.localityCount} 个地点</small>
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
            <small>${stat.count} 篇日记 · ${stat.localityCount} 个地点</small>
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

function renderTopAdminAreaInsight(adminArea) {
    if (!adminArea) {
        return renderEmptyOverviewInsight('高频行政区', '暂无地点');
    }

    return `
        <a class="overview-insight overview-location-feature" href="${placeHash(adminArea.countryKey, adminArea.adminArea, '')}">
            <span>高频行政区</span>
            <strong>${escapeHtml(adminArea.label)}</strong>
            <small>${adminArea.count} 次到访 · ${adminArea.localityCount} 个地点</small>
        </a>
    `;
}

function renderBroadAdminAreaInsight(adminArea) {
    if (!adminArea) {
        return renderEmptyOverviewInsight('覆盖最广', '暂无地点');
    }

    return `
        <a class="overview-insight overview-location-secondary" href="${placeHash(adminArea.countryKey, adminArea.adminArea, '')}">
            <span>覆盖最广</span>
            <strong>${escapeHtml(adminArea.label)}</strong>
            <small>${adminArea.localityCount} 个地点 · 最近 ${escapeHtml(adminArea.latestDate)}</small>
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
        <a class="overview-insight overview-repeat-location" href="${placeHash(record.countryKey, record.adminArea, record.locality)}">
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
    return [...monthStats].sort((a, b) => b.count - a.count || b.localityCount - a.localityCount || a.month.localeCompare(b.month))[0] || null;
}

function getBroadestAdminArea(adminAreas = []) {
    return [...adminAreas].sort((a, b) => b.localityCount - a.localityCount || b.count - a.count || b.latestDate.localeCompare(a.latestDate))[0] || null;
}

function renderPlace(params = {}) {
    const matching = getPlaceRecords(params);
    const label = getPlaceLabel(params, matching);
    const visitCount = countDistinctVisits(matching);
    const localities = Array.from(new Set(matching.map(record => record.locality).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const adminAreaNavigation = getPlaceAdminAreaNavigation(params);

    setPages(`
        <div class="place-page">
            <div class="place-summary">
                <a class="ribbon-back" href="#archive">返回档案夹</a>
                <p class="journal-label">地点档案</p>
                <h1>${escapeHtml(label)}</h1>
                <p class="place-count">${visitCount} 次到访</p>
                <div class="city-tags">
                    ${localities.map(locality => `
                        <a class="location-chip" href="${placeHash(params.country, params.area, locality)}">${escapeHtml(locality)}</a>
                    `).join('')}
                </div>
            </div>
            ${adminAreaNavigation ? `
                <nav class="place-neighbors entry-neighbors" aria-label="相邻${escapeHtml(adminAreaNavigation.typeLabel)}">
                    <h2>相邻${escapeHtml(adminAreaNavigation.typeLabel)}</h2>
                    ${renderPlaceAdminAreaNeighbor(adminAreaNavigation.previous, 'prev', adminAreaNavigation.typeLabel)}
                    ${renderPlaceAdminAreaNeighbor(adminAreaNavigation.next, 'next', adminAreaNavigation.typeLabel)}
                </nav>
            ` : ''}
        </div>
    `, `
        <div class="place-records">
            <p class="journal-label">相关纸条</p>
            ${matching.length ? matching.map(renderLedgerEntry).join('') : '<div class="empty-note">这个地点还没有旅行记录。</div>'}
        </div>
    `, 'dossier-page place-detail-page');
}

function getPlaceAdminAreaNavigation(params = {}) {
    if (!params.area || params.locality) return null;

    const country = travelModel.countries.find(item => (
        item.countryKey === params.country || item.country === params.country
    ));
    if (!country) return null;

    const index = country.adminAreas.findIndex(area => (
        area.key === params.area || area.adminArea === params.area
    ));
    if (index < 0) return null;

    return {
        previous: country.adminAreas[index - 1] || null,
        next: country.adminAreas[index + 1] || null,
        typeLabel: country.labels.domestic ? '省份' : country.labels.adminArea
    };
}

function renderPlaceAdminAreaNeighbor(area, direction, typeLabel) {
    const prefix = direction === 'prev' ? '上一' : '下一';
    const label = `${prefix}${typeLabel}`;
    const endLabel = direction === 'prev' ? '已到首个' : '已到末个';

    if (!area) {
        return `
            <div class="place-neighbor place-neighbor-${direction} entry-neighbor entry-neighbor-empty">
                <span>${escapeHtml(label)}</span>
                <strong>${escapeHtml(endLabel)}${escapeHtml(typeLabel)}</strong>
            </div>
        `;
    }

    return `
        <button class="place-neighbor place-neighbor-${direction} entry-neighbor" type="button"
            data-action="place-${direction}"
            data-country-key="${escapeHtml(area.countryKey)}"
            data-admin-area="${escapeHtml(area.adminArea)}"
            aria-label="${escapeHtml(label)}：${escapeHtml(area.label)}">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(area.label)}</strong>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
        </button>
    `;
}

function renderEntryRoute(params = {}) {
    const record = travelModel.recordsById.get(params.id);
    const returnHash = lastReadingHash || '#ledger';

    if (!record) {
        setPages(`
            <div class="entry-book-index">
                <div class="entry-book-summary">
                    <a class="ribbon-back entry-book-back" href="${escapeHtml(returnHash)}">返回旅行路径</a>
                    <p class="journal-label">旅行日记</p>
                    <h1>没有找到这篇日记</h1>
                </div>
            </div>
        `, '<div class="empty-note">这张书页可能已被移动或删除。</div>', 'entry-book-page');
        return;
    }

    const navigation = getEntryNavigation(record);
    const position = navigation.index >= 0 ? navigation.index + 1 : 1;
    const media = getRecordMedia(record);
    setPages(`
        <article class="entry-book-index" aria-labelledby="entryBookTitle">
            <div class="entry-book-summary">
                <a class="ribbon-back entry-book-back" href="${escapeHtml(returnHash)}">返回原处</a>
                <div class="entry-book-heading">
                    <time class="entry-book-date" datetime="${escapeHtml(record.date || '')}">${escapeHtml(record.date || '日期未记')}</time>
                    <h1 id="entryBookTitle">${escapeHtml(record.title)}</h1>
                    <div class="entry-book-location">
                        <a class="location-chip" href="${placeHash(record.countryKey, record.adminArea, record.locality)}">${escapeHtml(getLocationText(record))}</a>
                        ${renderTripGroupHint(record)}
                    </div>
                </div>
            </div>
            ${media.length ? `<div class="entry-book-media">${renderPhotoSleeve(record, {
                previewRows: ENTRY_PHOTO_PREVIEW_ROWS,
                showViewAll: true
            })}</div>` : ''}
            <nav class="entry-neighbors" aria-label="相邻篇目">
                <h2>相邻篇目</h2>
                ${renderEntryNeighbor(navigation.previous, 'prev', '上一篇')}
                ${renderEntryNeighbor(navigation.next, 'next', '下一篇')}
            </nav>
            <details class="entry-management">
                <summary>记录管理</summary>
                <div class="sheet-record-actions" aria-label="记录管理">
                    <button class="paper-button" type="button" data-action="edit-record" data-record-id="${escapeHtml(record.id)}">修改记录</button>
                    <button class="paper-button sheet-delete-button" type="button" data-action="delete-record" data-record-id="${escapeHtml(record.id)}">删除记录</button>
                </div>
            </details>
        </article>
    `, `
        <article class="entry-book-article" aria-label="${escapeHtml(record.title)}正文">
            <header class="entry-running-head"><span>旅行日记</span><span>${String(position).padStart(2, '0')} / ${navigation.total || 1}</span></header>
            <div class="markdown-content">${record.descBodyHtml || '<p>这篇日记还没有正文。</p>'}</div>
        </article>
    `, 'entry-book-page');

    requestAnimationFrame(() => queuePhotoSleevePreviewSync());
}

function renderEntryNeighbor(record, direction, label) {
    if (!record) return `<div class="entry-neighbor entry-neighbor-empty"><span>${label}</span><span>已到${direction === 'prev' ? '首' : '末'}篇</span></div>`;
    return `<button class="entry-neighbor" type="button" data-action="entry-${direction}" data-entry-id="${escapeHtml(record.id)}">
        <span>${label}</span><strong>${escapeHtml(record.title)}</strong>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
    </button>`;
}

function renderEntryPhotosRoute(params = {}) {
    const record = travelModel.recordsById.get(params.id);

    if (!record) {
        setPages(`
            <div class="place-page">
                <div class="entry-photos-summary">
                    <a class="ribbon-back" href="#ledger">返回路线档案</a>
                    <p class="journal-label">媒体附件</p>
                    <h1>没有找到这篇日记</h1>
                </div>
            </div>
        `, `
            <div class="photo-note">无法加载对应的图片或视频附件。</div>
        `, 'dossier-page place-detail-page');
        return;
    }

    setPages(`
        <div class="place-page">
            <div class="entry-photos-summary">
                <a class="ribbon-back" href="${serializeRoute({ name: 'entry', params: { id: record.id } })}">返回笔记</a>
                <p class="journal-label">媒体附件</p>
                <h1>${escapeHtml(record.title)}</h1>
                <p class="place-count">${escapeHtml(getLocationText(record))} · ${record.photos?.length || 0} 张图片 · ${record.videos?.length || 0} 个视频</p>
            </div>
        </div>
    `, `
        <div class="place-records entry-photos-page">
            <p class="journal-label">全部图片与视频</p>
            ${renderPhotoSleeve(record)}
        </div>
    `, 'dossier-page place-detail-page');
}

function renderLoading() {
    refs.shell.dataset.route = document.body.dataset.route = 'loading';
    setPages(`
        <div class="loading-page">
            <p class="journal-label">正在打开档案盒</p>
            <h1>正在整理旅行档案...</h1>
        </div>
    `, '<div class="loading-page muted-page"></div>');
}

function renderFatalError(error) {
    refs.shell.dataset.route = document.body.dataset.route = 'error';
    setPages(`
        <div class="loading-page">
            <p class="journal-label">加载失败</p>
            <h1>旅行数据加载失败。</h1>
            <p class="page-copy">${escapeHtml(error.message)}</p>
            <button class="paper-button" type="button" data-action="retry-load">重新加载</button>
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
    const chronological = [...records].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const chronologicalIndex = chronological.findIndex(item => item.id === record.id);

    return {
        index,
        total: records.length,
        previous: chronologicalIndex > 0 ? chronological[chronologicalIndex - 1] : null,
        next: chronologicalIndex >= 0 && chronologicalIndex < chronological.length - 1 ? chronological[chronologicalIndex + 1] : null
    };
}

async function deleteTravelRecord(record, authenticatedCapability = null) {
    const capability = authenticatedCapability || await detectWriterCapability();
    if (!capability.methods.has('DELETE')) {
        throw new Error('服务器写入服务版本过旧，请更新或重新启动服务后再删除记录。');
    }
    const response = await fetch(capability.endpoint, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-Travel-Token': capability.token },
        credentials: 'same-origin',
        body: JSON.stringify({ desc_md: record.desc_md }),
        signal: AbortSignal.timeout(60000)
    });
    const result = await response.json();
    if (!response.ok || !result.deleted) throw new Error(result.error || '未收到服务器的删除确认。');
    try { await refreshTravelModel(getRefreshKey()); }
    catch { return { refreshFailed: true }; }
    window.location.hash = lastReadingHash || '#ledger';
    syncRouteFromHash({ initial: true });
    return { refreshFailed: false };
}

function openPhotoViewer(photos, index = 0) {
    if (!Array.isArray(photos) || photos.length === 0 || !getPhotoViewerRoot()) {
        return;
    }

    if (!photoViewerState) {
        photoViewerTrigger = document.activeElement;
        photoViewerShellWasInert = Boolean(refs.shell?.inert);
    }
    if (refs.shell) refs.shell.inert = true;
    document.body.classList.add('media-viewer-open');
    photoViewerState = {
        photos,
        index: normalizePhotoIndex(index, photos.length),
        scale: 1,
        initialScale: 1,
        rotation: 0,
        translateX: 0,
        translateY: 0,
        videoVolume: DEFAULT_VIDEO_VOLUME,
        videoMuted: false,
        videoRate: 1
    };
    photoGestureState = createPhotoGestureState();
    renderPhotoViewer();
}

function renderPhotoViewer() {
    stopObservingPhotoViewerStage();
    const previousImage = document.querySelector('[data-photo-viewer-image]');
    const previousFrame = previousImage?.complete && previousImage.naturalWidth
        ? previousImage.closest('[data-photo-viewer-frame]').cloneNode(true) : null;
    document.querySelector('[data-photo-viewer]')?.remove();
    const root = getPhotoViewerRoot();
    if (!photoViewerState || !root) {
        return;
    }

    const photo = photoViewerState.photos[photoViewerState.index];
    const isVideo = photo.kind === 'video';
    const position = `${photoViewerState.index + 1} / ${photoViewerState.photos.length}`;
    const navigationDisabled = photoViewerState.photos.length <= 1 ? ' disabled' : '';

    root.insertAdjacentHTML('beforeend', `
        <div class="photo-viewer" data-photo-viewer>
            <div class="photo-viewer-backdrop" data-action="close-photo-viewer"></div>
            <section class="photo-viewer-panel${isVideo ? ' has-video' : ''}" role="dialog" aria-modal="true" aria-label="媒体查看器" tabindex="-1">
                <div class="photo-viewer-toolbar">
                    <div class="photo-viewer-nav-group photo-viewer-control-group" aria-label="媒体切换">
                        <button class="photo-viewer-control" type="button" data-action="photo-prev" data-photo-action="prev" aria-label="上一项媒体"${navigationDisabled}>${renderPhotoViewerControlIcon('previous')}</button>
                        <span class="photo-viewer-count">${escapeHtml(position)}</span>
                        <button class="photo-viewer-control" type="button" data-action="photo-next" data-photo-action="next" aria-label="下一项媒体"${navigationDisabled}>${renderPhotoViewerControlIcon('next')}</button>
                    </div>
                </div>
                <button class="photo-viewer-control photo-viewer-close" type="button" data-action="close-photo-viewer" aria-label="关闭媒体查看器">${renderPhotoViewerControlIcon('close')}</button>
                <div class="photo-viewer-stage" data-photo-viewer-stage>
                    ${isVideo
                        ? `<div class="photo-viewer-media-frame" data-photo-viewer-frame>
                            <video class="photo-viewer-media video-viewer-video" data-photo-viewer-media data-video-viewer-video data-media-name="${escapeHtml(photo.name || '')}" src="${escapeHtml(photo.src)}" preload="metadata" playsinline aria-label="${escapeHtml(photo.alt)}"></video>
                           </div>
                           <button class="video-viewer-big-play" type="button" data-video-action="toggle-play" aria-label="播放视频">${renderVideoPlaybackIcon()}</button>`
                        : `<div class="photo-viewer-media-frame photo-viewer-image-frame" data-photo-viewer-frame>
                            <img class="photo-viewer-media photo-viewer-image" data-photo-viewer-media data-photo-viewer-image data-media-name="${escapeHtml(photo.name || '')}" src="${escapeHtml(photo.src)}" alt="${escapeHtml(photo.alt)}" decoding="async" draggable="false">
                        </div>`}
                    <div class="photo-viewer-media-error" data-photo-viewer-media-error role="status" hidden></div>
                </div>
                ${isVideo ? renderVideoControls() : renderPhotoControls()}
                <p class="photo-viewer-caption">${escapeHtml(photo.alt)}</p>
            </section>
        </div>
    `);

    enhanceCustomSelects(root.querySelector('[data-photo-viewer]'));
    observePhotoViewerStage();

    if (isVideo) {
        syncVideoMoreControlsLayout();
        const video = getViewerVideo();
        if (video) {
            video.volume = photoViewerState.videoVolume;
            video.muted = photoViewerState.videoMuted;
            video.playbackRate = photoViewerState.videoRate;
            for (const eventName of ['durationchange', 'timeupdate', 'play', 'pause', 'ended', 'volumechange', 'ratechange']) {
                video.addEventListener(eventName, syncVideoViewerControls);
            }
            video.addEventListener('click', handleViewerVideoClick);
            video.addEventListener('seeked', handleViewerVideoSeeked);
            video.addEventListener('loadedmetadata', () => {
                if (video !== getViewerVideo()) return;
                fitPhotoToStage();
                syncVideoViewerControls();
            });
            video.addEventListener('error', showVideoPlaybackError, { once: true });
            if (video.readyState >= 1) fitPhotoToStage();
            else updatePhotoViewerTransform();
            syncVideoViewerControls();
        }
        requestAnimationFrame(() => getPhotoViewerRoot()?.querySelector('.photo-viewer-panel')?.focus({ preventScroll: true }));
        return;
    }

    syncPhotoMoreControlsLayout();
    const image = getPhotoViewerRoot()?.querySelector('[data-photo-viewer-image]');
    if (previousFrame && image && !prefersReducedMotion()) {
        // 新图加载、适配完成前保留旧图，避免切换大照片时露出空白舞台。
        previousFrame.removeAttribute('data-photo-viewer-frame');
        previousFrame.querySelector('img').removeAttribute('data-photo-viewer-image');
        previousFrame.querySelector('img').removeAttribute('data-photo-viewer-media');
        previousFrame.setAttribute('aria-hidden', 'true');
        previousFrame.inert = true;
        previousFrame.style.pointerEvents = 'none';
        image.closest('[data-photo-viewer-stage]').append(previousFrame);
        const reveal = () => {
            if (!previousFrame.isConnected) return;
            const fade = previousFrame.animate([{ opacity: 1 }, { opacity: 0 }],
                { duration: 180, easing: 'ease-out', fill: 'forwards' });
            fade.finished.then(() => previousFrame.remove(), () => previousFrame.remove());
        };
        if (image.complete) requestAnimationFrame(reveal);
        else {
            image.addEventListener('load', () => requestAnimationFrame(reveal), { once: true });
            image.addEventListener('error', () => previousFrame.remove(), { once: true });
        }
    }
    if (image?.complete) {
        fitPhotoToStage();
    } else {
        if (image) {
            image.addEventListener('load', () => {
                if (image === getPhotoViewerRoot()?.querySelector('[data-photo-viewer-image]')) fitPhotoToStage();
            }, { once: true });
        }
        updatePhotoViewerTransform();
    }
    requestAnimationFrame(() => {
        getPhotoViewerRoot()?.querySelector('.photo-viewer-panel')?.focus({ preventScroll: true });
    });
}

function closePhotoViewerDialog() {
    stopObservingPhotoViewerStage();
    document.querySelector('[data-photo-viewer]')?.remove();
    photoViewerState = null;
    photoGestureState = createPhotoGestureState();
    clearPhotoRotationTimer();
    if (refs.shell) refs.shell.inert = photoViewerShellWasInert;
    document.body.classList.remove('media-viewer-open');
    if (photoViewerTrigger?.isConnected) photoViewerTrigger.focus({ preventScroll: true });
    photoViewerTrigger = null;
}

function getPhotoViewerRoot() {
    return document.body;
}

function getPhotoViewerItems(button) {
    const buttons = Array.from(button.closest('.photo-sleeve')?.querySelectorAll('[data-action="open-media-viewer"]:not([hidden])') || [button]);
    return buttons.map(item => ({
        kind: item.dataset.mediaKind === 'video' ? 'video' : 'image',
        name: item.dataset.mediaName || '',
        src: item.dataset.mediaSrc || '',
        alt: item.dataset.mediaAlt || '旅行媒体'
    })).filter(item => item.src);
}

function renderVideoControls() {
    return `
        <div class="photo-viewer-controls video-viewer-controls" aria-label="视频播放与画面控制">
            <div class="video-viewer-primary-controls">
                <button class="photo-viewer-control video-viewer-skip" type="button" data-video-action="rewind" aria-label="后退 10 秒">−10s</button>
                <button class="photo-viewer-control video-viewer-play" type="button" data-video-action="toggle-play" data-video-play aria-label="播放视频">${renderVideoPlaybackIcon()}</button>
                <button class="photo-viewer-control video-viewer-skip" type="button" data-video-action="forward" aria-label="前进 10 秒">+10s</button>
            </div>
            <span class="video-viewer-seek-label"><input class="video-viewer-range video-viewer-seek" type="range" min="0" max="0" step="0.05" value="0" data-video-seek aria-label="播放进度"></span>
            <button class="photo-viewer-control video-viewer-more-toggle" type="button" data-video-action="toggle-controls" data-video-more-toggle aria-expanded="false" aria-label="展开更多视频控制">
                <span>更多</span>
                <svg class="video-viewer-more-icon" viewBox="0 0 12 8" aria-hidden="true" focusable="false"><path d="M1 6.5 6 1.5l5 5"></path></svg>
            </button>
            <output class="video-viewer-time" data-video-time>00:00 / --:--</output>
            ${renderTransformControls('视频', 'video-viewer-transform-controls')}
            <div class="video-viewer-secondary-controls">
                <button class="photo-viewer-control video-viewer-mute" type="button" data-video-action="toggle-mute" data-video-mute aria-label="静音">静音</button>
                <label class="video-viewer-volume-label"><span class="video-viewer-volume-text" aria-hidden="true">音量</span><input class="video-viewer-range video-viewer-volume" type="range" min="0" max="1" step="0.05" value="${DEFAULT_VIDEO_VOLUME}" data-video-volume aria-label="音量"></label>
                <label class="video-viewer-rate-label"><span>倍速</span><select id="videoPlaybackRate" data-custom-select data-video-rate aria-label="播放速度"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>
                <button class="photo-viewer-control video-viewer-fullscreen" type="button" data-video-action="fullscreen" aria-label="全屏播放">全屏</button>
            </div>
        </div>`;
}

function syncVideoMoreControlsLayout() {
    const controls = getPhotoViewerRoot()?.querySelector('.video-viewer-controls');
    if (!controls) return;
    const layout = isMobileLayout() ? 'mobile' : 'desktop';
    if (controls.dataset.videoControlsLayout === layout) return;
    if (layout === 'mobile') setVideoMoreControlsOpen(false);
    controls.dataset.videoControlsLayout = layout;
}

function setVideoMoreControlsOpen(isOpen) {
    const controls = getPhotoViewerRoot()?.querySelector('.video-viewer-controls');
    const toggle = controls?.querySelector('[data-video-more-toggle]');
    if (!controls || !toggle) return;
    controls.classList.toggle('is-more-open', isOpen);
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.setAttribute('aria-label', isOpen ? '收起更多视频控制' : '展开更多视频控制');
    schedulePhotoViewerFit();
}

function renderPhotoControls() {
    return `
        <div class="photo-viewer-controls photo-viewer-image-controls" aria-label="图片显示控制">
            <div class="photo-viewer-image-primary-controls">
                ${renderRotateControls('图片旋转')}
            </div>
            <button class="photo-viewer-control photo-viewer-more-toggle" type="button" data-photo-action="toggle-controls" data-photo-more-toggle aria-expanded="false" aria-label="展开更多图片控制">
                <span>更多</span>
                <svg class="video-viewer-more-icon" viewBox="0 0 12 8" aria-hidden="true" focusable="false"><path d="M1 6.5 6 1.5l5 5"></path></svg>
            </button>
            <div class="photo-viewer-image-secondary-controls">
                ${renderZoomControls('图片缩放')}
                <button class="photo-viewer-control photo-viewer-reset" type="button" data-action="photo-reset" data-photo-action="reset" aria-label="恢复到初始适配比例">适应</button>
                <div class="photo-viewer-image-tail-controls">
                    <button class="photo-viewer-control photo-viewer-fullscreen" type="button" data-action="photo-fullscreen" data-photo-action="fullscreen" aria-label="全屏查看图片">全屏</button>
                </div>
            </div>
        </div>`;
}

function syncPhotoMoreControlsLayout() {
    const controls = getPhotoViewerRoot()?.querySelector('.photo-viewer-image-controls');
    if (!controls) return;
    const layout = isMobileLayout() ? 'mobile' : 'desktop';
    if (controls.dataset.photoControlsLayout === layout) return;
    if (layout === 'mobile') setPhotoMoreControlsOpen(false);
    controls.dataset.photoControlsLayout = layout;
}

function setPhotoMoreControlsOpen(isOpen) {
    const controls = getPhotoViewerRoot()?.querySelector('.photo-viewer-image-controls');
    const toggle = controls?.querySelector('[data-photo-more-toggle]');
    if (!controls || !toggle) return;
    controls.classList.toggle('is-more-open', isOpen);
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.setAttribute('aria-label', isOpen ? '收起更多图片控制' : '展开更多图片控制');
    schedulePhotoViewerFit();
}

function renderTransformControls(mediaLabel, className = '') {
    return `<div class="photo-viewer-transform-controls${className ? ` ${className}` : ''}" aria-label="${mediaLabel}画面控制">
        ${renderZoomControls(`${mediaLabel}缩放`)}
        <span class="photo-viewer-control-divider" aria-hidden="true"></span>
        ${renderRotateControls(`${mediaLabel}旋转`)}
        <button class="photo-viewer-control photo-viewer-reset" type="button" data-action="photo-reset" data-photo-action="reset" aria-label="恢复到初始适配比例">适应</button>
    </div>`;
}

function renderRotateControls(label) {
    return `<div class="photo-viewer-rotate-group photo-viewer-control-group" aria-label="${label}">
        <button class="photo-viewer-control" type="button" data-action="photo-rotate-left" data-photo-action="rotate-left" aria-label="向左旋转">${renderPhotoViewerControlIcon('rotate-left')}</button>
        <button class="photo-viewer-control" type="button" data-action="photo-rotate-right" data-photo-action="rotate-right" aria-label="向右旋转">${renderPhotoViewerControlIcon('rotate-right')}</button>
    </div>`;
}

function renderPhotoViewerControlIcon(name) {
    const paths = {
        previous: '<path d="m15 18-6-6 6-6"></path>',
        next: '<path d="m9 18 6-6-6-6"></path>',
        close: '<path d="M6 6l12 12M18 6 6 18"></path>',
        minus: '<path d="M5 12h14"></path>',
        plus: '<path d="M12 5v14M5 12h14"></path>',
        'rotate-left': '<path d="M8 7H3V2M3.6 6.6A9 9 0 1 1 3 15"></path>',
        'rotate-right': '<path d="M16 7h5V2M20.4 6.6A9 9 0 1 0 21 15"></path>'
    };
    return `<svg class="photo-viewer-control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || ''}</svg>`;
}

function renderVideoPlaybackIcon(isPlaying = false) {
    return `<svg class="video-viewer-play-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path data-video-play-icon d="${isPlaying ? VIDEO_PAUSE_ICON_PATH : VIDEO_PLAY_ICON_PATH}"></path></svg>`;
}

function renderZoomControls(label) {
    return `<div class="photo-viewer-zoom-group photo-viewer-control-group" aria-label="${label}">
        <button class="photo-viewer-control" type="button" data-action="photo-zoom-out" data-photo-action="zoom-out" aria-label="缩小">${renderPhotoViewerControlIcon('minus')}</button>
        <span class="photo-viewer-zoom" data-photo-viewer-zoom>100%</span>
        <button class="photo-viewer-control" type="button" data-action="photo-zoom-in" data-photo-action="zoom-in" aria-label="放大">${renderPhotoViewerControlIcon('plus')}</button>
    </div>`;
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
        case 'toggle-controls':
            setPhotoMoreControlsOpen(!getPhotoViewerRoot()?.querySelector('.photo-viewer-image-controls')?.classList.contains('is-more-open'));
            break;
        case 'fullscreen':
            void toggleViewerFullscreen().catch(showViewerFullscreenError);
            break;
        default:
            break;
    }
}

function getViewerVideo() {
    return getPhotoViewerRoot()?.querySelector('[data-video-viewer-video]') || null;
}

function handleVideoViewerAction(action) {
    const video = getViewerVideo();
    if (!video) return;
    switch (action) {
        case 'toggle-play':
            if (video.paused || video.ended) void video.play().catch(showVideoPlaybackError);
            else video.pause();
            break;
        case 'rewind':
            video.currentTime = clamp(video.currentTime - 10, 0, Number.isFinite(video.duration) ? video.duration : video.currentTime);
            break;
        case 'forward':
            video.currentTime = clamp(video.currentTime + 10, 0, Number.isFinite(video.duration) ? video.duration : video.currentTime + 10);
            break;
        case 'toggle-mute':
            video.muted = !video.muted;
            photoViewerState.videoMuted = video.muted;
            break;
        case 'toggle-controls':
            setVideoMoreControlsOpen(!getPhotoViewerRoot()?.querySelector('.video-viewer-controls')?.classList.contains('is-more-open'));
            break;
        case 'fullscreen':
            void toggleViewerFullscreen().catch(showViewerFullscreenError);
            break;
        default:
            break;
    }
    syncVideoViewerControls();
}

async function toggleViewerFullscreen() {
    if (document.fullscreenElement) {
        await document.exitFullscreen?.();
        return;
    }
    const stage = getPhotoViewerRoot()?.querySelector('[data-photo-viewer-stage]');
    await stage?.requestFullscreen?.();
}

function showViewerFullscreenError() {
    const caption = getPhotoViewerRoot()?.querySelector('.photo-viewer-caption');
    if (caption) caption.textContent = '当前浏览器无法进入全屏模式，请检查浏览器权限设置后重试。';
}

function handleViewerVideoClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (photoGestureState.suppressClick) {
        photoGestureState.suppressClick = false;
        return;
    }
    handleVideoViewerAction('toggle-play');
}

function syncVideoViewerControls() {
    const video = getViewerVideo();
    const root = getPhotoViewerRoot();
    if (!video || !root) return;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const seek = root.querySelector('[data-video-seek]');
    if (seek) {
        // 原生滑块拖动和媒体定位期间不回写范围或数值，避免真机触摸位置被重置。
        if (photoGestureState.videoSeekPointerId === null && photoGestureState.videoSeekTarget === null && !video.seeking) {
            if (duration > 0 && seek.max !== String(duration)) seek.max = String(duration);
            if (duration > 0) seek.value = String(clamp(video.currentTime || 0, 0, duration));
        }
    }
    syncVideoRangeProgress(seek);
    const volume = root.querySelector('[data-video-volume]');
    if (volume) volume.value = String(video.volume);
    syncVideoRangeProgress(volume);
    const rate = root.querySelector('[data-video-rate]');
    if (rate && document.activeElement !== rate) rate.value = String(video.playbackRate);
    const play = root.querySelector('[data-video-play]');
    const bigPlay = root.querySelector('.video-viewer-big-play');
    const isPlaying = !video.paused && !video.ended;
    if (play) {
        play.querySelector('[data-video-play-icon]')?.setAttribute('d', isPlaying ? VIDEO_PAUSE_ICON_PATH : VIDEO_PLAY_ICON_PATH);
        play.setAttribute('aria-label', isPlaying ? '暂停视频' : '播放视频');
        play.setAttribute('aria-pressed', String(isPlaying));
    }
    if (bigPlay) {
        bigPlay.hidden = isPlaying;
        bigPlay.setAttribute('aria-label', video.ended ? '重新播放视频' : '播放视频');
    }
    const mute = root.querySelector('[data-video-mute]');
    const isMuted = video.muted || video.volume === 0;
    if (mute) {
        mute.textContent = isMuted ? '静音' : '声音';
        mute.setAttribute('aria-label', isMuted ? '恢复声音' : '静音');
        mute.setAttribute('aria-pressed', String(isMuted));
    }
    const time = root.querySelector('[data-video-time]');
    const displayedTime = photoGestureState.videoSeekPointerId !== null || photoGestureState.videoSeekTarget !== null
        ? Number(seek?.value) : video.currentTime;
    if (time) time.textContent = `${formatVideoTime(displayedTime)} / ${duration ? formatVideoTime(duration) : '--:--'}`;
    if (photoViewerState) {
        photoViewerState.videoVolume = video.volume;
        photoViewerState.videoMuted = video.muted;
        photoViewerState.videoRate = video.playbackRate;
    }
}

function handleViewerVideoSeeked(event) {
    if (event.target !== getViewerVideo() || event.target.seeking) return;
    photoGestureState.videoSeekTarget = null;
    syncVideoViewerControls();
}

function commitVideoSeek(seek) {
    const video = getViewerVideo();
    const target = Number(seek.value);
    // 元数据尚不可用时不能以 0 作为时长执行跳转。
    if (!video || video.readyState < 1 || !Number.isFinite(video.duration) || video.duration <= 0 || !Number.isFinite(target)) return;
    const nextTime = clamp(target, 0, video.duration);
    if (photoGestureState.videoSeekTarget === nextTime) return;
    if (!video.seeking && Math.abs(video.currentTime - nextTime) < 0.05) return;
    photoGestureState.videoSeekTarget = nextTime;
    video.currentTime = nextTime;
}

function syncVideoRangeProgress(range) {
    if (!range) return;
    const min = Number(range.min) || 0;
    const max = Number(range.max) || 0;
    const value = Number(range.value) || 0;
    const progress = max > min ? clamp((value - min) / (max - min), 0, 1) * 100 : 0;
    range.style.setProperty('--video-range-progress', `${progress}%`);
}

function formatVideoTime(value) {
    const seconds = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return hours
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
        : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function showVideoPlaybackError() {
    const video = getViewerVideo();
    if (video?.error) {
        showViewerMediaError(video);
        return;
    }
    const caption = getPhotoViewerRoot()?.querySelector('.photo-viewer-caption');
    if (caption) caption.textContent = '视频暂时无法播放；请重试，或确认浏览器支持该文件的编码格式。';
}

function handleMediaLoadError(event) {
    const media = event.target;
    if (!media?.matches?.('.photo-sleeve-button img, .photo-sleeve-button video, [data-photo-viewer-media]')) return;

    const sleeveButton = media.closest?.('.photo-sleeve-button');
    if (sleeveButton) {
        const kind = sleeveButton.dataset.mediaKind === 'video' ? 'video' : 'image';
        const message = formatMediaReferenceError({
            kind,
            name: sleeveButton.dataset.mediaName,
            src: sleeveButton.dataset.mediaSrc
        });
        sleeveButton.classList.add('is-media-error');
        sleeveButton.setAttribute('aria-label', message);
        sleeveButton.title = message;
        sleeveButton.querySelector('.photo-sleeve-media-error')?.removeAttribute('hidden');
        return;
    }

    showViewerMediaError(media);
}

function showViewerMediaError(media) {
    const current = photoViewerState?.photos?.[photoViewerState.index] || {};
    const kind = media?.matches?.('video') ? 'video' : 'image';
    const message = formatMediaReferenceError({
        kind,
        name: media?.dataset?.mediaName || current.name,
        src: media?.currentSrc || media?.src || current.src
    });
    const root = getPhotoViewerRoot();
    const notice = root?.querySelector('[data-photo-viewer-media-error]');
    const frame = root?.querySelector('[data-photo-viewer-frame]');
    const stage = root?.querySelector('[data-photo-viewer-stage]');
    const controls = root?.querySelector('.photo-viewer-controls');
    const caption = root?.querySelector('.photo-viewer-caption');
    if (frame) frame.hidden = true;
    if (stage) stage.classList.add('is-media-error');
    if (controls) controls.hidden = true;
    const bigPlay = root?.querySelector('.video-viewer-big-play');
    if (bigPlay) bigPlay.hidden = true;
    if (notice) {
        notice.textContent = message;
        notice.hidden = false;
    }
    if (caption) {
        caption.textContent = message;
        caption.hidden = true;
    }
}

function formatMediaReferenceError({ kind = 'image', name = '', src = '' } = {}) {
    const isVideo = kind === 'video';
    const label = isVideo ? '视频' : '图片';
    const listField = isVideo ? 'videos' : 'photos';
    const folderField = isVideo ? 'video_folder' : 'photo_folder';
    const fileName = String(name || '').trim() || getMediaFileName(src) || '未命名文件';
    const path = getDisplayMediaPath(src);
    const reason = isVideo ? '不存在、无法读取或编码不受支持' : '不存在或无法读取';
    return `${label}文件“${fileName}”${reason}。请检查 travel_data.json 中 ${folderField} 与 ${listField} 的引用${path ? `（当前路径：${path}）` : ''}。`;
}

function getMediaFileName(src) {
    const path = getDisplayMediaPath(src);
    const fileName = path.split('/').filter(Boolean).at(-1) || '';
    try { return decodeURIComponent(fileName); }
    catch { return fileName; }
}

function getDisplayMediaPath(src) {
    const value = String(src || '').trim();
    if (!value) return '';
    try {
        const url = new URL(value, window.location.href);
        return decodeURIComponent(url.pathname.replace(/^\//, ''));
    } catch {
        return value.split('#')[0].split('?')[0];
    }
}

function showPhotoAt(index) {
    if (!photoViewerState) {
        return;
    }

    const nextIndex = normalizePhotoIndex(index, photoViewerState.photos.length);
    // 索引未变化时保留媒体节点，避免重新解码图片或中断视频播放。
    if (nextIndex === photoViewerState.index) return;
    photoViewerState.index = nextIndex;
    resetPhotoTransform({ render: false });
    renderPhotoViewer();
}

function fitPhotoToStage() {
    if (!photoViewerState) {
        return;
    }

    const stage = getPhotoViewerRoot()?.querySelector('[data-photo-viewer-stage]');
    const media = getViewerMedia();
    if (!stage || !media) {
        return;
    }

    photoViewerState.scale = getInitialPhotoScale(stage, media);
    photoViewerState.initialScale = photoViewerState.scale;
    photoViewerState.translateX = 0;
    photoViewerState.translateY = 0;
    updatePhotoViewerTransform();
}

function schedulePhotoViewerFit() {
    if (!photoViewerState || !isPhotoViewerOpen()) return;
    if (photoViewerFitFrame !== null) window.cancelAnimationFrame(photoViewerFitFrame);
    photoViewerFitFrame = window.requestAnimationFrame(() => {
        photoViewerFitFrame = null;
        fitPhotoToStage();
    });
}

function observePhotoViewerStage() {
    const stage = getPhotoViewerRoot()?.querySelector('[data-photo-viewer-stage]');
    if (!stage || !('ResizeObserver' in window)) return;
    photoViewerStageResizeObserver = new ResizeObserver(() => schedulePhotoViewerFit());
    photoViewerStageResizeObserver.observe(stage);
}

function stopObservingPhotoViewerStage() {
    photoViewerStageResizeObserver?.disconnect();
    photoViewerStageResizeObserver = null;
    if (photoViewerFitFrame !== null) {
        window.cancelAnimationFrame(photoViewerFitFrame);
        photoViewerFitFrame = null;
    }
}

function handlePhotoViewerFullscreenChange() {
    schedulePhotoViewerFit();
}

function getInitialPhotoScale(stage, media) {
    const stageRect = stage.getBoundingClientRect();
    const { width, height } = getViewerMediaSourceSize(media);
    return calculateInitialPhotoScale({
        stageWidth: stageRect.width,
        stageHeight: stageRect.height,
        naturalWidth: width,
        naturalHeight: height,
        allowUpscale: media.matches('[data-video-viewer-video]')
    });
}

function getViewerMedia() {
    return getPhotoViewerRoot()?.querySelector('[data-photo-viewer-media]') || null;
}

function getViewerMediaSourceSize(media = getViewerMedia()) {
    if (!media) return { width: 0, height: 0 };
    if (media.matches('[data-video-viewer-video]')) {
        return { width: media.videoWidth || 0, height: media.videoHeight || 0 };
    }
    return { width: media.naturalWidth || 0, height: media.naturalHeight || 0 };
}

function zoomPhoto(factor, focalPoint) {
    if (!photoViewerState) {
        return;
    }

    const previousScale = photoViewerState.scale;
    const nextScale = clamp(previousScale * factor, getMinimumPhotoScale(), getMaximumPhotoScale());
    if (focalPoint && previousScale > 0) {
        const nextTranslate = getPhotoViewerZoomTranslate({
            translateX: photoViewerState.translateX,
            translateY: photoViewerState.translateY,
            previousScale,
            nextScale,
            startFocalPoint: focalPoint
        });
        photoViewerState.translateX = nextTranslate.translateX;
        photoViewerState.translateY = nextTranslate.translateY;
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

    photoViewerState.scale = photoViewerState.initialScale || 1;
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

    const image = getViewerMedia();
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

    const sourceSize = getViewerMediaSourceSize(image);
    const renderMetrics = getPhotoViewerRenderMetrics({
        naturalWidth: sourceSize.width,
        naturalHeight: sourceSize.height,
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
    const image = getViewerMedia();
    if (!stage || !image) {
        return null;
    }

    const stageRect = stage.getBoundingClientRect();
    const sourceSize = getViewerMediaSourceSize(image);
    const sourceWidth = sourceSize.width || image.width;
    const sourceHeight = sourceSize.height || image.height;
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
    if (event.target.matches?.('[data-video-seek]') && getViewerVideo()
        && (event.pointerType !== 'mouse' || event.button === 0)) {
        photoGestureState.videoSeekPointerId = event.pointerId;
        return;
    }
    const stage = event.target.closest?.('[data-photo-viewer-stage]');
    if (!stage || !photoViewerState || (event.pointerType === 'mouse' && event.button !== 0)) {
        return;
    }
    if (event.target.closest?.('button, input, select, label')) {
        photoGestureState.suppressClick = false;
        return;
    }

    event.preventDefault();
    if (photoGestureState.pointers.size === 0) {
        photoGestureState.suppressClick = false;
        photoGestureState.videoTapPointerId = event.target.closest?.('[data-video-viewer-video]')
            ? event.pointerId
            : null;
    } else {
        photoGestureState.videoTapPointerId = null;
    }
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
        photoGestureState.suppressClick = true;
        const current = getGestureMetrics(points[0], points[1]);
        const start = photoGestureState.pinchStart;
        const nextScale = clamp(start.scale * (current.distance / Math.max(start.distance, 1)), getMinimumPhotoScale(), getMaximumPhotoScale());
        const currentFocalPoint = getPhotoViewerStageFocalPoint({ x: current.centerX, y: current.centerY });
        const nextTranslate = getPhotoViewerZoomTranslate({
            translateX: start.translateX,
            translateY: start.translateY,
            previousScale: start.scale,
            nextScale,
            startFocalPoint: start.focalPoint,
            currentFocalPoint
        });
        photoViewerState.scale = nextScale;
        photoViewerState.translateX = nextTranslate.translateX;
        photoViewerState.translateY = nextTranslate.translateY;
        updatePhotoViewerTransform();
        return;
    }

    if (points.length === 1 && photoGestureState.dragStart) {
        const point = points[0];
        if (Math.hypot(point.x - photoGestureState.dragStart.x, point.y - photoGestureState.dragStart.y) > 4) {
            photoGestureState.suppressClick = true;
        }
        photoViewerState.translateX = photoGestureState.dragStart.translateX + point.x - photoGestureState.dragStart.x;
        photoViewerState.translateY = photoGestureState.dragStart.translateY + point.y - photoGestureState.dragStart.y;
        updatePhotoViewerTransform();
    }
}

function handlePhotoPointerEnd(event) {
    if (photoGestureState.videoSeekPointerId === event.pointerId) {
        const seek = getPhotoViewerRoot()?.querySelector('[data-video-seek]');
        if (seek && event.type === 'pointerup') commitVideoSeek(seek);
        photoGestureState.videoSeekPointerId = null;
        syncVideoViewerControls();
        return;
    }
    if (!photoGestureState.pointers.has(event.pointerId)) {
        return;
    }

    const shouldToggleVideo = event.type === 'pointerup'
        && photoGestureState.videoTapPointerId === event.pointerId
        && photoGestureState.pointers.size === 1
        && !photoGestureState.suppressClick;
    photoGestureState.pointers.delete(event.pointerId);
    photoGestureState.videoTapPointerId = null;
    syncPhotoGestureStart();
    if (shouldToggleVideo) {
        photoGestureState.suppressClick = true;
        handleVideoViewerAction('toggle-play');
    }
}

function handlePhotoWheel(event) {
    if (!photoViewerState || !event.target.closest?.('[data-photo-viewer-stage]')) {
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
    if (!photoViewerState || photoViewerState.photos[photoViewerState.index]?.kind === 'video' || !event.target.closest?.('[data-photo-viewer-stage]')) {
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
        focalPoint: getPhotoViewerStageFocalPoint({ x: metrics.centerX, y: metrics.centerY }),
        scale: photoViewerState.scale,
        translateX: photoViewerState.translateX,
        translateY: photoViewerState.translateY
    };
}

function createPhotoGestureState() {
    return {
        pointers: new Map(),
        dragStart: null,
        pinchStart: null,
        suppressClick: false,
        videoTapPointerId: null,
        videoSeekPointerId: null,
        videoSeekTarget: null
    };
}

function getPointerPoint(event) {
    return {
        x: event.clientX,
        y: event.clientY
    };
}

function getPhotoViewerStageFocalPoint(point) {
    const stage = getPhotoViewerRoot()?.querySelector('[data-photo-viewer-stage]');
    const rect = stage?.getBoundingClientRect();
    if (!rect) {
        return null;
    }

    return {
        x: point.x - rect.left - rect.width / 2,
        y: point.y - rect.top - rect.height / 2
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
    if (!Number.isInteger(length) || length <= 0) {
        return 0;
    }
    const value = Number(index);
    if (!Number.isFinite(value)) return 0;
    return ((Math.trunc(value) % length) + length) % length;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function clearPageTurn() {
    clearTimeout(pageTurnTimer);
    pageTurnTimer = null;
    pageTurnCleanup?.();
    pageTurnCleanup = null;
    refs.closedBookCover?.removeAttribute('aria-hidden');
    refs.spread?.classList.remove('turn-forward', 'turn-back', 'book-turn-preparing');
}

let lastCoverBounds = null;
let lastCoverViewport = null;
let lastMobileCoverBackground = null;

function prepareTransitionClone(node, className) {
    const clone = node.cloneNode(true);
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    clone.querySelectorAll('[data-action]').forEach(element => element.removeAttribute('data-action'));
    clone.querySelectorAll('[tabindex]').forEach(element => element.removeAttribute('tabindex'));
    clone.classList.add(className);
    clone.setAttribute('aria-hidden', 'true');
    clone.inert = true;
    return clone;
}

function createTransitionBook() {
    const source = refs.spread.parentElement;
    const clone = prepareTransitionClone(source, 'book-transition-book');
    clone.querySelector('.closed-book-cover')?.remove();
    return { source, clone };
}

function renderWithBookCover(renderFn, mode) {
    clearPageTurn();
    if (!refs.shell || prefersReducedMotion()) {
        renderFn();
        return;
    }

    const closing = mode === 'closing';
    const mobile = isMobileLayout();
    const sameViewport = lastCoverViewport?.width === window.innerWidth
        && lastCoverViewport?.height === window.innerHeight
        && lastCoverViewport?.mobile === mobile;
    const bounds = closing ? (sameViewport ? lastCoverBounds : null)
        : refs.closedBookCover.getBoundingClientRect();
    const coverBounds = bounds?.width && bounds?.height ? bounds : (() => {
        const width = mobile
            ? Math.max(0, Math.min(342, window.innerWidth - 40, (window.innerHeight - 64) * .72))
            : refs.spread.parentElement.getBoundingClientRect().width / 2;
        const height = mobile ? width / .72 : refs.spread.parentElement.getBoundingClientRect().height - 54;
        return { top: (window.innerHeight - height) / 2, left: (window.innerWidth - width) / 2, width, height };
    })();
    lastCoverBounds = { top: coverBounds.top, left: coverBounds.left,
        width: coverBounds.width, height: coverBounds.height };
    lastCoverViewport = { width: window.innerWidth, height: window.innerHeight, mobile };

    const overlay = document.createElement('div');
    overlay.className = 'book-transition-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    const backdrop = document.createElement('div');
    backdrop.className = 'book-transition-backdrop';
    if (mobile && !closing) {
        const coverBackground = getComputedStyle(refs.spread.parentElement);
        lastMobileCoverBackground = {
            background: coverBackground.background,
            backgroundBlendMode: coverBackground.backgroundBlendMode
        };
    }
    const backdropBackground = mobile
        ? lastMobileCoverBackground
        : getComputedStyle(document.body);
    if (backdropBackground?.background) {
        backdrop.style.background = backdropBackground.background;
        backdrop.style.backgroundBlendMode = backdropBackground.backgroundBlendMode;
    }
    backdrop.style.opacity = closing ? '0' : '1';
    const scene = document.createElement('div');
    scene.className = 'book-transition-scene';
    Object.assign(scene.style, {
        top: `${coverBounds.top}px`, left: `${coverBounds.left}px`,
        width: `${coverBounds.width}px`, height: `${coverBounds.height}px`,
        opacity: closing ? '0' : '1'
    });
    const leaf = document.createElement('div');
    leaf.className = 'book-transition-leaf';
    const cover = prepareTransitionClone(refs.closedBookCover, 'book-transition-cover');
    cover.removeAttribute('data-action');
    const back = document.createElement('div');
    back.className = 'book-transition-back';
    const edge = document.createElement('div');
    edge.className = 'book-transition-edge';
    leaf.append(cover, back, edge);
    const castShadow = document.createElement('div');
    castShadow.className = 'book-transition-cast-shadow';
    scene.append(castShadow, leaf);
    overlay.append(backdrop, scene);
    document.body.append(overlay);

    let finished = false;
    let frame = null;
    const animations = [];
    let finishTimer = null;
    const shellWasInert = refs.shell.inert;
    refs.shell.inert = true;
    pageTurnCleanup = () => {
        if (finished) return;
        finished = true;
        cancelAnimationFrame(frame);
        clearTimeout(finishTimer);
        animations.forEach(animation => animation.cancel());
        if (closing) renderFn();
        overlay.remove();
        refs.shell.inert = shellWasInert;
        refs.closedBookCover?.removeAttribute('aria-hidden');
        const focusTarget = closing ? refs.closedBookCover : refs.spread.closest('main');
        focusTarget?.focus({ preventScroll: true });
    };

    if (!closing) renderFn();
    refs.closedBookCover?.setAttribute('aria-hidden', 'true');

    const startTurn = () => {
        if (finished) return;
        const { source: sourceBook, clone: transitionBook } = createTransitionBook();
        const bookBounds = sourceBook.getBoundingClientRect();
        // 封皮、衬纸与纸芯共用书脊坐标；只平移整本书，不再用移动裁剪展开正文。
        const target = {
            left: bookBounds.left + (mobile ? 0 : bookBounds.width / 2),
            top: bookBounds.top,
            width: bookBounds.width / (mobile ? 1 : 2),
            height: mobile ? Math.min(bookBounds.height,
                Math.max(coverBounds.height, window.innerHeight - bookBounds.top - 12)) : bookBounds.height
        };
        const scaleX = coverBounds.width / target.width;
        const scaleY = coverBounds.height / target.height;
        const closedMove = `translate(${coverBounds.left - target.left}px, ${coverBounds.top - target.top}px) scale(${scaleX}, ${scaleY})`;
        const turnDuration = mobile
            ? (closing ? MOBILE_BOOK_COVER_CLOSE_MS : MOBILE_BOOK_COVER_OPEN_MS)
            : BOOK_COVER_TURN_MS;
        const timing = { duration: turnDuration, fill: 'both',
            direction: closing ? 'reverse' : 'normal', easing: 'linear' };
        const movement = [
            { offset: 0, transform: closedMove },
            { offset: mobile ? .06 : .12, transform: closedMove,
                easing: 'cubic-bezier(.16,.84,.24,1)' },
            { offset: 1, transform: 'translate(0px, 0px) scale(1, 1)' }
        ];
        Object.assign(scene.style, { top: `${target.top}px`, left: `${target.left}px`,
            width: `${target.width}px`, height: `${target.height}px`, opacity: '1' });
        Object.assign(transitionBook.style, {
            top: `${bookBounds.top}px`, left: `${bookBounds.left}px`,
            width: `${bookBounds.width}px`, height: `${bookBounds.height}px`,
            transformOrigin: mobile ? 'left top' : '50% 0',
            // 手机只保留封皮下的首屏纸芯，长正文在落平后交还真实页面。
            clipPath: mobile ? `inset(0 0 ${Math.max(0, bookBounds.height - target.height)}px 0)`
                : 'inset(-40px -60px -60px 50%)'
        });
        overlay.append(transitionBook);
        const sourcePages = sourceBook.querySelectorAll('.paper-page');
        transitionBook.querySelectorAll('.paper-page').forEach((clonedPage, index) => {
            clonedPage.scrollTop = sourcePages[index]?.scrollTop || 0;
        });
        if (!mobile) {
            // 左半本直接贴在硬封皮背面，落平时与真实左页逐像素重合。
            const lining = createTransitionBook().clone;
            lining.classList.add('book-transition-lining');
            Object.assign(lining.style, { width: `${bookBounds.width}px`, height: `${bookBounds.height}px` });
            back.append(lining);
            lining.querySelectorAll('.paper-page').forEach((clonedPage, index) => {
                clonedPage.scrollTop = sourcePages[index]?.scrollTop || 0;
            });
        }
        animations.push(scene.animate(movement, timing));
        const leafFrames = mobile ? [
            { offset: 0, transform: 'rotateY(0deg)' },
            { offset: .06, transform: 'rotateY(-3deg)', easing: 'cubic-bezier(.16,.84,.24,1)' },
            { offset: .72, transform: 'rotateY(-164deg)', easing: 'cubic-bezier(.2,.7,.2,1)' },
            { offset: .94, transform: 'rotateY(-179deg)', easing: 'ease-out' },
            { offset: 1, transform: 'rotateY(-180deg)' }
        ] : [
            { offset: 0, transform: 'rotateY(0deg)' },
            { offset: .12, transform: 'rotateY(-4deg)', easing: 'cubic-bezier(.42,0,.25,1)' },
            { offset: .9, transform: 'rotateY(-178deg)', easing: 'ease-out' },
            { offset: 1, transform: 'rotateY(-180deg)' }
        ];
        animations.push(leaf.animate(leafFrames, timing));
        animations.push(transitionBook.animate(movement, timing));
        const clasp = cover.querySelector('.closed-book-clasp');
        if (clasp) animations.push(clasp.animate([
            { offset: 0, transform: 'translateX(0) rotateY(0deg)', opacity: 1 },
            { offset: .12, transform: 'translateX(22px) rotateY(-100deg)', opacity: 0 },
            { offset: 1, transform: 'translateX(22px) rotateY(-100deg)', opacity: 0 }
        ], timing));
        animations.push(castShadow.animate([
            { offset: 0, opacity: .16, transform: 'scaleX(1)' },
            { offset: .38, opacity: .45, transform: 'scaleX(.65)' },
            { offset: .58, opacity: .32, transform: 'scaleX(.18)' },
            { offset: 1, opacity: 0, transform: 'scaleX(.02)' }
        ], timing));
        animations.push(back.animate([
            { offset: 0, filter: 'brightness(.7)' },
            { offset: .5, filter: 'brightness(.7)' },
            { offset: 1, filter: 'brightness(1)' }
        ], timing));
        const backdropFrames = mobile ? [
            { offset: 0, opacity: 1, easing: 'cubic-bezier(.16,.84,.24,1)' },
            { offset: .18, opacity: .94, easing: 'cubic-bezier(.2,.7,.2,1)' },
            { offset: .72, opacity: .18, easing: 'ease-out' },
            { offset: 1, opacity: 0 }
        ] : [
            { offset: 0, opacity: 1 },
            { offset: .9, opacity: 1 },
            { offset: 1, opacity: 0 }
        ];
        animations.push(backdrop.animate(backdropFrames, timing));
        if (animations[0].finished) {
            animations[0].finished.then(() => { if (!finished) clearPageTurn(); }, () => {});
        } else {
            finishTimer = setTimeout(clearPageTurn, turnDuration);
        }
    };

    if (closing) {
        frame = requestAnimationFrame(startTurn);
        return;
    }

    // 新书页先在封面后完成首帧绘制，再沿书脊翻开封面。
    let lastFrame = 0;
    let stableFrames = 0;
    const started = performance.now();
    const awaitPaint = time => {
        if (finished) return;
        stableFrames = lastFrame && time - lastFrame < 34 ? stableFrames + 1 : 0;
        lastFrame = time;
        const minimumPaintWait = mobile ? 48 : 90;
        const maximumPaintWait = mobile ? MOBILE_BOOK_COVER_PAINT_WAIT_MS : 900;
        const requiredStableFrames = mobile ? 2 : 3;
        if ((stableFrames >= requiredStableFrames && time - started >= minimumPaintWait)
            || time - started >= maximumPaintWait) {
            startTurn();
        } else {
            frame = requestAnimationFrame(awaitPaint);
        }
    };
    frame = requestAnimationFrame(awaitPaint);
}

function cloneTurningPage(page) {
    const clone = page.cloneNode(true);
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    clone.setAttribute('aria-hidden', 'true');
    clone.inert = true;
    // 固定旧页的纸张背景，防止路由切换后套用新章节的背景。
    clone.style.background = getComputedStyle(page).background;
    // 副本只绘制可见内容；屏外记录保留等高占位，避免重复复制整本档案。
    const bounds = page.getBoundingClientRect();
    const selector = '.ledger-entry, .photo-sleeve-button';
    const originals = page.querySelectorAll(selector);
    clone.querySelectorAll(selector).forEach((node, index) => {
        const rect = originals[index].getBoundingClientRect();
        if (rect.bottom >= bounds.top - 24 && rect.top <= bounds.bottom + 24) return;
        node.replaceChildren();
        node.style.height = `${rect.height}px`;
        node.style.minHeight = `${rect.height}px`;
        node.style.boxSizing = 'border-box';
        node.style.visibility = 'hidden';
    });
    clone.classList.add('book-page-copy');
    return clone;
}

// 章节顺序与书签一致；地点和附件属于向内阅读，返回所属章节时反向翻页。
function getTurnDirection(previous, next) {
    const order = { cover: 0, preface: 1, ledger: 2, archive: 3, place: 4, entry: 5, photos: 6 };
    return (order[next?.name] ?? 0) < (order[previous?.name] ?? 0) ? 'back' : 'forward';
}

// 折线从外侧下角沿斜向推进，圆柱曲面连接未翻区域与已翻区域。
// 每条斜带共享端点；页角、正文和纸背使用同一组几何数据，不再拼接独立掀角动画。
function createPageCurlFrames(width, height, backwards, count = 18) {
    const extent = Math.hypot(width, height);
    const step = extent / count;
    const frames = Array.from({ length: count }, () => []);
    for (let frame = 0; frame <= 48; frame += 1) {
        const time = frame / 48;
        const progress = time * time * (3 - 2 * time);
        const tilt = 0.24 * (1 - progress);
        const c = Math.cos(tilt);
        const s = Math.sin(tilt);
        const radius = width * 0.12 * Math.pow(Math.sin(Math.PI * progress), .8);
        const boundary = (c * width + s * height) * (1 - progress) - Math.PI * radius * progress / 2;
        const point = u => {
            const distance = Math.max(0, u - boundary);
            if (time === 0 || distance === 0) return { u, z: 0 };
            if (radius < 0.00001) return { u: -u, z: 0 };
            const angle = Math.min(Math.PI, distance / radius);
            return { u: boundary + radius * Math.sin(angle) - Math.max(0, distance - Math.PI * radius),
                z: radius * (1 - Math.cos(angle)) };
        };
        for (let index = 0; index < count; index += 1) {
            const u = index * step;
            const first = point(u);
            const last = point(u + step);
            const du = (last.u - first.u) / step;
            const dz = (last.z - first.z) / step;
            const length = Math.hypot(du, dz) || 1;
            const mirror = backwards ? -1 : 1;
            const x = c * first.u + s * width;
            const y = s * first.u - c * width;
            const transform = `matrix3d(${mirror * c * du},${s * du},${dz},0,${-mirror * s},${c},0,0,${-mirror * c * dz / length},${-s * dz / length},${du / length},0,${backwards ? width - x : x},${y},${first.z + 1},1)`;
            const sample = flipped => {
                const sign = flipped ? -1 : 1;
                return `matrix(${c * sign},${-s * sign},${s},${c},${(flipped ? c * width : 0) - u},${width - (flipped ? s * width : 0)})`;
            };
            frames[index].push({ offset: time, transform,
                front: sample(backwards), back: sample(!backwards),
                shadow: `matrix(${mirror * c},${s},${-mirror * s},${c},${width + mirror * (c * (boundary - width * 0.1) + s * width)},${s * (boundary - width * 0.1) - c * width})`,
                shadowOpacity: 0.72 * Math.sin(Math.PI * progress),
                shade: Math.min(0.28, Math.abs(dz) * 0.24 + (du < 0 ? 0.075 * Math.sin(Math.PI * progress) : 0)),
                // 测试直接验证共享边界、起页范围和终点，避免依赖 CSS 字符串解析。
                first, last, tilt });
        }
    }
    return frames;
}

// 左侧装订边固定在原点，沿纸宽积分连续曲面；外缘先弯，落页时恢复平整。
// 返回只反放同一曲面，不镜像书脊或移动翻页支点。
function createMobilePageCurlFrames(width, count = 18) {
    const step = width / count;
    const frames = Array.from({ length: count }, () => []);
    for (let frame = 0; frame <= 48; frame += 1) {
        const time = frame / 48;
        const progress = time * time * (3 - 2 * time);
        let x = 0;
        let z = 0;
        for (let index = 0; index < count; index += 1) {
            const angle = Math.PI * progress + 1.15 * Math.sin(Math.PI * progress) * (index + .5) / count;
            const c = Math.cos(angle);
            const s = Math.sin(angle);
            const first = { x, z };
            x += step * c;
            z += step * s;
            frames[index].push({ offset: time,
                transform: `matrix3d(${c},0,${s},0,0,1,0,0,${-s},0,${c},0,${first.x},0,${first.z},1)`,
                shade: .22 * Math.sin(angle), first, last: { x, z } });
        }
    }
    return frames;
}

function renderWithPageTurn(renderFn, options = {}) {
    clearPageTurn();

    if (!refs.spread || options.animate === false || prefersReducedMotion()) {
        renderFn();
        return;
    }

    if (isMobileLayout()) {
        const bounds = refs.spread.getBoundingClientRect();
        const top = Math.max(0, bounds.top, refs.spine?.getBoundingClientRect().bottom || 0);
        const capture = () => {
            const snapshot = prepareTransitionClone(refs.spread, 'mobile-page-snapshot');
            // 固定当前路由的纸面和阅读顺序，尤其是详情页的 display: contents 布局。
            const selector = '.paper-page, .entry-book-index, .entry-book-summary, .entry-neighbors, .entry-management, .place-page, .place-summary, .place-neighbors, .entry-photos-summary';
            const originals = [refs.spread, ...refs.spread.querySelectorAll(selector)];
            [snapshot, ...snapshot.querySelectorAll(selector)].forEach((node, index) => {
                const style = getComputedStyle(originals[index]);
                for (const property of ['display', 'flexDirection', 'alignItems', 'gap', 'order',
                    'padding', 'margin', 'border', 'borderRadius', 'background', 'backgroundBlendMode',
                    'backgroundAttachment', 'boxShadow', 'minHeight', 'overflow']) {
                    node.style[property] = style[property];
                }
            });
            // 屏外记录只保留占位，减少分段绘制时复制的内容量。
            const rows = '.ledger-entry, .photo-sleeve-button';
            const originalRows = refs.spread.querySelectorAll(rows);
            snapshot.querySelectorAll(rows).forEach((node, index) => {
                const rect = originalRows[index].getBoundingClientRect();
                if (rect.bottom >= top - 24 && rect.top <= window.innerHeight + 24) return;
                node.replaceChildren();
                Object.assign(node.style, { height: `${rect.height}px`, minHeight: `${rect.height}px`,
                    boxSizing: 'border-box', visibility: 'hidden' });
            });
            snapshot.querySelectorAll('.context-panel').forEach(panel => panel.remove());
            const rect = refs.spread.getBoundingClientRect();
            Object.assign(snapshot.style, { width: `${bounds.width}px`, height: `${rect.height}px`, top: `${rect.top - top}px` });
            return snapshot;
        };
        const oldPage = capture();
        const wasInert = refs.spread.inert;
        renderFn();
        refs.spread.inert = true;
        const backwards = options.direction === 'back';
        // 前进卷起旧页，返回从左侧展开新页；旧页在新页落稳前保留在下面。
        const snapshot = backwards ? capture() : oldPage;
        const viewport = document.createElement('div');
        viewport.className = 'mobile-page-transition';
        viewport.setAttribute('aria-hidden', 'true');
        viewport.inert = true;
        viewport.classList.add(backwards ? 'mobile-page-backwards' : 'mobile-page-forwards');
        Object.assign(viewport.style, { left: `${bounds.left}px`, width: `${bounds.width}px`, top: `${top}px` });
        const leaf = document.createElement('div');
        leaf.className = 'mobile-page-leaf';
        leaf.style.transformOrigin = 'left center';
        const shadow = document.createElement('div');
        shadow.className = 'mobile-page-shadow';
        if (backwards) viewport.append(oldPage);
        viewport.append(shadow, leaf);
        // 过渡层在导航下方，只对可见纸面分段变形，不变换长正文或固定夹层。
        refs.shell.append(viewport);
        const timing = { duration: MOBILE_PAGE_TURN_MS, easing: 'linear', fill: 'both',
            direction: backwards ? 'reverse' : 'normal' };
        const frames = createMobilePageCurlFrames(bounds.width, getPageCurlStripCount(bounds.width));
        const stripWidth = bounds.width / frames.length;
        const animations = [];
        frames.forEach((keyframes, index) => {
            const strip = document.createElement('div');
            strip.className = 'mobile-page-strip';
            strip.style.width = `${stripWidth + .5}px`;
            const front = document.createElement('div');
            front.className = 'mobile-page-front';
            const copy = snapshot.cloneNode(true);
            copy.style.left = `${-index * stripWidth}px`;
            const shade = document.createElement('div');
            shade.className = 'mobile-page-shade';
            const back = document.createElement('div');
            back.className = 'mobile-page-back';
            front.append(copy, shade);
            strip.append(front, back);
            leaf.append(strip);
            animations.push(strip.animate(keyframes.map(({ offset, transform }) => ({ offset, transform })), timing));
            animations.push(shade.animate(keyframes.map(({ offset, shade }) => ({ offset, opacity: Math.max(0, shade) })), timing));
        });
        animations.push(shadow.animate([
            { opacity: 0 }, { opacity: .28, offset: .5 }, { opacity: 0 }
        ], timing));
        if (backwards) animations.push(oldPage.animate([
            { opacity: 1, offset: 0 }, { opacity: 1, offset: .88 }, { opacity: 0, offset: 1 }
        ], { ...timing, direction: 'normal' }));
        animations.forEach(animation => { animation.pause(); animation.currentTime = 0; });
        let startFrame = null;
        let cancelled = false;
        pageTurnCleanup = () => {
            cancelled = true;
            cancelAnimationFrame(startFrame);
            animations.forEach(animation => animation.cancel());
            viewport.remove();
            refs.spread.inert = wasInert;
        };
        startFrame = requestAnimationFrame(() => {
            if (cancelled) return;
            startFrame = requestAnimationFrame(() => {
                if (cancelled) return;
                animations.forEach(animation => animation.play());
                animations[0].finished.then(() => { if (!cancelled) clearPageTurn(); }, () => {});
            });
        });
        return;
    }

    const backwards = options.direction === 'back';
    const turningPage = backwards ? refs.leftPage : refs.rightPage;
    const restingPage = backwards ? refs.rightPage : refs.leftPage;
    const { width, height } = turningPage.getBoundingClientRect();
    const pageInert = [refs.leftPage.inert, refs.rightPage.inert];
    const front = cloneTurningPage(turningPage);
    const resting = cloneTurningPage(restingPage);
    const frontScroll = turningPage.scrollTop;
    const restingScroll = restingPage.scrollTop;
    renderFn();
    const reversePage = backwards ? refs.rightPage : refs.leftPage;
    const back = cloneTurningPage(reversePage);
    const leaf = document.createElement('div');
    leaf.className = 'book-turn-leaf';
    leaf.setAttribute('aria-hidden', 'true');
    leaf.inert = true;
    resting.classList.add('book-turn-resting');
    const frames = createPageCurlFrames(width, height, backwards, getPageCurlStripCount(width));
    const stripWidth = Math.hypot(width, height) / frames.length;
    const animations = [];
    const surfaces = [];
    const timing = { duration: PAGE_TURN_MS, fill: 'both', easing: 'linear' };
    // 纸张落下的最后阶段逐渐交接底页，消除副本移除瞬间的闪变。
    animations.push(resting.animate([
        { opacity: 1, offset: 0 }, { opacity: 1, offset: .72 },
        { opacity: 0, offset: .96 }, { opacity: 0, offset: 1 }
    ], timing));
    frames.forEach((keyframes) => {
        const strip = document.createElement('div');
        strip.className = 'book-curl-strip';
        strip.style.width = `${stripWidth + 0.5}px`;
        strip.style.height = `${width + height}px`;
        strip.style.transform = keyframes[0].transform;
        [front, back].forEach((source, side) => {
            const face = document.createElement('div');
            face.className = `book-curl-face${side ? ' book-curl-back' : ' book-curl-front'}`;
            const surface = document.createElement('div');
            surface.className = 'book-curl-surface';
            surface.style.width = `${width}px`;
            surface.style.height = `${height}px`;
            const copy = source.cloneNode(true);
            copy.style.width = `${width}px`;
            copy.style.height = `${height}px`;
            copy.style.left = '0';
            const shade = document.createElement('div');
            shade.className = 'book-curl-shade';
            surface.append(copy, shade);
            face.append(surface);
            strip.append(face);
            surfaces.push({ copy, scroll: side ? reversePage.scrollTop : frontScroll });
            animations.push(surface.animate(keyframes.map(frame => ({ offset: frame.offset,
                transform: side ? frame.back : frame.front })), timing));
            animations.push(shade.animate(keyframes.map(frame => ({ offset: frame.offset,
                opacity: frame.shade })), timing));
        });
        leaf.append(strip);
        animations.push(strip.animate(keyframes.map(({ offset, transform }) => ({ offset, transform })), timing));
    });
    const shadow = document.createElement('div');
    shadow.className = 'book-turn-shadow';
    const contact = document.createElement('div');
    contact.className = 'book-curl-contact';
    contact.style.width = `${width * 0.2}px`;
    contact.style.height = `${width + height}px`;
    const ambient = document.createElement('div');
    ambient.className = 'book-curl-ambient';
    ambient.style.width = `${width * 0.42}px`;
    ambient.style.height = `${width + height}px`;
    shadow.append(ambient, contact);
    animations.push(ambient.animate(frames[0].map(frame => ({ offset: frame.offset,
        transform: frame.shadow, opacity: frame.shadowOpacity * .42 })), timing));
    animations.push(contact.animate(frames[0].map(frame => ({ offset: frame.offset,
        transform: frame.shadow, opacity: frame.shadowOpacity })), timing));
    // 纸面在落稳前交还真实正文，避免分条副本与最终页面之间出现细缝闪动。
    animations.push(leaf.animate([
        { opacity: 1, offset: 0 }, { opacity: 1, offset: .92 }, { opacity: 0, offset: 1 }
    ], timing));
    refs.spread.classList.add('book-turn-preparing');
    refs.spread.append(resting, shadow, leaf);
    refs.leftPage.inert = true;
    refs.rightPage.inert = true;
    resting.scrollTop = restingScroll;
    surfaces.forEach(({ copy, scroll }) => { copy.scrollTop = scroll; });
    refs.spread.style.setProperty('--page-turn-ms', `${PAGE_TURN_MS}ms`);
    refs.spread.classList.add(backwards ? 'turn-back' : 'turn-forward');
    animations.forEach(animation => { animation.pause(); animation.currentTime = 0; });
    let startFrame = null;
    let cancelled = false;
    // 保留旧的对页直到纸张落稳，避免翻至中途时底页突然跳变。
    pageTurnCleanup = () => {
        cancelled = true;
        cancelAnimationFrame(startFrame);
        animations.forEach(animation => animation.cancel());
        leaf.remove();
        resting.remove();
        shadow.remove();
        [refs.leftPage.inert, refs.rightPage.inert] = pageInert;
    };
    // 先完成首帧栅格化，再开始掀角，防止建层耗时吃掉动画开头。
    startFrame = requestAnimationFrame(() => {
        if (cancelled) return;
        startFrame = requestAnimationFrame(() => {
            if (cancelled) return;
            refs.spread.classList.remove('book-turn-preparing');
            animations.forEach(animation => animation.play());
            if (animations[0].finished) {
                animations[0].finished.then(() => { if (!cancelled) clearPageTurn(); }, () => {});
            } else {
                pageTurnTimer = setTimeout(clearPageTurn, PAGE_TURN_MS);
            }
        });
    });
}

function getPageCurlStripCount(width) {
    const constrainedDevice = globalThis.navigator?.hardwareConcurrency
        && globalThis.navigator.hardwareConcurrency <= 4;
    if (constrainedDevice) return 12;
    return width < 520 ? 18 : 24;
}

function handleDocumentClick(event) {
    const skipLink = event.target.closest('.skip-link');
    if (skipLink) {
        event.preventDefault();
        refs.stage?.focus({ preventScroll: true });
        refs.stage?.scrollIntoView({ block: 'start' });
        return;
    }
    if (event.target.closest('[data-action="open-book"]')) {
        event.preventDefault();
        navigateTo('#preface');
        return;
    }

    if (event.target.closest('[data-action="retry-load"]')) {
        event.preventDefault();
        window.location.reload();
        return;
    }
    if (event.target.closest('[data-action="export-all-data"]')) {
        event.preventDefault();
        void openDataExport().catch(error => showFeedback(error.message));
        return;
    }
    if (event.target.closest('[data-action="import-all-data"]')) {
        event.preventDefault();
        void dataTransfer.chooseImport();
        return;
    }
    if (event.target.closest('[data-action="clear-all-data"]')) {
        event.preventDefault();
        void openDataClear().catch(error => showFeedback(error.message));
        return;
    }
    if (event.target.closest('[data-action="change-password"]')) {
        event.preventDefault();
        void openPasswordChange().catch(error => showFeedback(error.message));
        return;
    }
    if (event.target.closest('[data-action="upload-profile-picture"]')) {
        event.preventDefault();
        profilePictureCapability = null;
        void openProfilePictureUpload().catch(error => showFeedback(error.message));
        return;
    }
    if (event.target.closest('[data-action="edit-owner-name"]')) {
        event.preventDefault();
        void openOwnerNameChange().catch(error => showFeedback(error.message));
        return;
    }
    if (event.target.closest('[data-action="add-record"]')) {
        event.preventDefault();
        closeMobileContextPanel();
        void openRecordEditor().catch(error => showFeedback(error.message));
        return;
    }
    const editRecord = event.target.closest('[data-action="edit-record"]');
    if (editRecord) {
        event.preventDefault();
        const record = travelModel?.recordsById.get(editRecord.dataset.recordId);
        if (record) void refs.openEditRecord(record).catch(error => showFeedback(error.message));
        return;
    }
    const deleteRecord = event.target.closest('[data-action="delete-record"]');
    if (deleteRecord) {
        event.preventDefault();
        const record = travelModel?.recordsById.get(deleteRecord.dataset.recordId);
        if (record) void refs.openDeleteRecord(record).catch(error => showFeedback(error.message));
        return;
    }
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

    const showLedgerFilters = event.target.closest('[data-action="show-ledger-filters"]');
    if (showLedgerFilters) {
        event.preventDefault();
        if (isMobileLayout()) {
            openMobileContextPanel();
            requestAnimationFrame(scrollToLedgerFilters);
        } else {
            scrollToLedgerFilters();
        }
        return;
    }

    if (isMobileContextPanelOpen && refs.rightPage?.classList.contains('context-panel') && isMobileContextPanelDismissTarget(event.target)) {
        closeMobileContextPanel();
        return;
    }

    const clearSearch = event.target.closest('[data-action="clear-search"]');
    if (clearSearch) {
        event.preventDefault();
        handleClearSearch(clearSearch);
        return;
    }

    const closePhotoViewer = event.target.closest('[data-action="close-photo-viewer"]');
    if (closePhotoViewer) {
        event.preventDefault();
        closePhotoViewerDialog();
        return;
    }

    const openPhoto = event.target.closest('[data-action="open-media-viewer"]');
    if (openPhoto) {
        event.preventDefault();
        const photos = getPhotoViewerItems(openPhoto);
        openPhotoViewer(photos, Number(openPhoto.dataset.mediaIndex || 0));
        return;
    }

    const videoAction = event.target.closest('[data-video-action]');
    if (videoAction) {
        event.preventDefault();
        handleVideoViewerAction(videoAction.dataset.videoAction);
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
            navigateTo(
                { name: 'entry', params: { id: nextId } },
                { replace: true, direction: entryNav.dataset.action === 'entry-prev' ? 'back' : 'forward' }
            );
        }
        return;
    }

    const placeNav = event.target.closest('[data-action="place-prev"], [data-action="place-next"]');
    if (placeNav) {
        event.preventDefault();
        const countryKey = placeNav.getAttribute('data-country-key');
        const adminArea = placeNav.getAttribute('data-admin-area');
        if (countryKey && adminArea) {
            navigateTo(
                placeHash(countryKey, adminArea, ''),
                { replace: true, direction: placeNav.dataset.action === 'place-prev' ? 'back' : 'forward' }
            );
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
                focusId: isMobileLayout() ? 'ledgerFilters' : 'ledgerSearch',
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
            const currentValues = normalizeLedgerParams(activeRoute?.params)[key];
            const nextValues = key === 'year'
                ? toggleLedgerFilterValue(currentValues, value)
                : selectLedgerFilterValue(currentValues, value);
            updateLedgerRoute({ [key]: nextValues }, {
                replace: true,
                animate: false,
                preserveRightScroll: true,
                keepContextPanelOpen: isMobileContextPanelOpen
            });
        }
        return;
    }

    const entryCard = event.target.closest('[data-open-entry]');
    if (entryCard && !event.target.closest('a, button, input')) {
        event.preventDefault();
        rememberReadingContext(entryCard.id || '');
        navigateTo({ name: 'entry', params: { id: entryCard.dataset.openEntry } });
        return;
    }

    const routeAnchor = event.target.closest('a[href^="#"]');
    if (routeAnchor) {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
        event.preventDefault();
        const href = routeAnchor.getAttribute('href');
        if (href.startsWith('#entry')) {
            rememberReadingContext();
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
        if (trapPanelFocus(event, document.querySelector('.photo-viewer-panel'))) return;
        if (event.key === 'Escape' && document.fullscreenElement) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            closePhotoViewerDialog();
            return;
        }

        const video = getViewerVideo();
        if (video) {
            if (event.target.matches('input, select, button') && !['k', 'K', 'm', 'M', 'f', 'F'].includes(event.key)) return;
            if (event.key === ' ' || event.key === 'k' || event.key === 'K') {
                event.preventDefault();
                handleVideoViewerAction('toggle-play');
                return;
            }
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                const delta = event.key === 'ArrowLeft' ? -5 : 5;
                video.currentTime = clamp(video.currentTime + delta, 0, Number.isFinite(video.duration) ? video.duration : video.currentTime + Math.max(delta, 0));
                syncVideoViewerControls();
                return;
            }
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault();
                video.volume = clamp(video.volume + (event.key === 'ArrowUp' ? 0.05 : -0.05), 0, 1);
                video.muted = false;
                syncVideoViewerControls();
                return;
            }
            if (event.key === 'm' || event.key === 'M') {
                event.preventDefault();
                handleVideoViewerAction('toggle-mute');
                return;
            }
            if (event.key === 'f' || event.key === 'F') {
                event.preventDefault();
                handleVideoViewerAction('fullscreen');
            }
            return;
        }

        if (event.key === 'f' || event.key === 'F') {
            event.preventDefault();
            handlePhotoViewerAction('fullscreen');
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

    if (isMobileContextPanelOpen && !document.querySelector('dialog[open]')
        && trapPanelFocus(event, refs.rightPage)) return;

    if (event.key === 'Escape' && isMobileContextPanelOpen) {
        event.preventDefault();
        closeMobileContextPanel();
        return;
    }

    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-open-entry]')) {
        event.preventDefault();
        rememberReadingContext(event.target.id || '');
        navigateTo({ name: 'entry', params: { id: event.target.dataset.openEntry } });
    }
}

function trapPanelFocus(event, panel) {
    if (event.key !== 'Tab' || !panel) return false;
    const controls = [...panel.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
        .filter(node => !node.disabled && node.tabIndex >= 0 && !node.closest('[hidden], [inert]') && node.getClientRects().length);
    const first = controls[0];
    const last = controls.at(-1);
    if (!first) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return true;
    }
    const focused = document.activeElement;
    if (!controls.includes(focused) || (event.shiftKey ? focused === first : focused === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
        return true;
    }
    return false;
}

function rememberReadingContext(focusId = '') {
    if (activeRoute?.name === 'entry' || activeRoute?.name === 'photos') {
        return;
    }

    lastReadingHash = getEntryBackgroundHash();
    lastEntryFocusId = focusId;
    lastReadingScrollPosition = {
        left: refs.leftPage?.scrollTop || 0,
        right: refs.rightPage?.scrollTop || 0,
        windowY: window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0
    };
}

function isReturningToReadingBackground(previousRoute, nextRoute) {
    if (previousRoute?.name !== 'entry' && previousRoute?.name !== 'photos') {
        return false;
    }

    return serializeRoute(nextRoute) === lastReadingHash;
}

function restoreReadingScrollPosition() {
    if (!lastReadingScrollPosition) {
        return;
    }

    refs.leftPage.scrollTop = lastReadingScrollPosition.left;
    refs.rightPage.scrollTop = lastReadingScrollPosition.right;
    window.scrollTo(0, lastReadingScrollPosition.windowY);
}

function handleDocumentInput(event) {
    const video = getViewerVideo();
    if (video && event.target.matches('[data-video-seek]')) {
        // 拖动只预览进度，松手后统一定位；键盘和辅助技术输入仍立即生效。
        if (photoGestureState.videoSeekPointerId === null) commitVideoSeek(event.target);
        syncVideoViewerControls();
        return;
    }
    if (video && event.target.matches('[data-video-volume]')) {
        video.volume = clamp(Number(event.target.value), 0, 1);
        video.muted = false;
        syncVideoViewerControls();
        return;
    }
    if (!isSearchInput(event.target)) {
        return;
    }

    if (event.isComposing || isSearchComposing) {
        return;
    }

    scheduleSearchRouteUpdate(event.target);
}

function handleDocumentChange(event) {
    if (event.target === refs.profilePictureInput) {
        void handleProfilePictureSelection(event.target);
        return;
    }
    const video = getViewerVideo();
    if (video && event.target.matches('[data-video-seek]')) {
        commitVideoSeek(event.target);
        syncVideoViewerControls();
        return;
    }
    if (video && event.target.matches('[data-video-rate]')) {
        video.playbackRate = clamp(Number(event.target.value), 0.5, 2);
        syncVideoViewerControls();
        return;
    }
    const filter = event.target.closest('[data-ledger-filter]');
    if (!filter) {
        return;
    }

    const key = filter.getAttribute('data-ledger-filter');
    const value = filter.multiple
        ? [...filter.selectedOptions].map(option => option.value)
        : (filter.value || 'all');
    const nextParams = { [key]: value };
    const selectScrollTop = filter.multiple
        ? Number(filter.closest('.custom-select')?.dataset.customSelectScrollTop || 0)
        : 0;

    if (key === 'country') {
        nextParams.area = [];
        nextParams.locality = [];
    } else if (key === 'area') {
        nextParams.locality = [];
    }

    updateLedgerRoute(nextParams, {
        replace: true,
        focusId: filter.id || '',
        reopenSelectId: filter.multiple ? filter.id : '',
        selectScrollTop,
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
    clearPageTurn();
    syncMobileContextPanelState();
    syncVideoMoreControlsLayout();
    syncPhotoMoreControlsLayout();
    queuePhotoSleevePreviewSync();
    schedulePhotoViewerFit();
}

function applySearchRouteUpdate({ id, value }) {
    if ((id === 'ledgerSearch' && activeRoute?.name !== 'ledger')
        || (id === 'archiveSearch' && activeRoute?.name !== 'archive')) return;
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
    const activeName = routeName === 'entry' || routeName === 'photos'
        ? 'ledger'
        : (routeName === 'place' ? 'archive' : routeName);
    const chapterOrder = ['preface', 'ledger', 'archive'];
    const activeIndex = chapterOrder.indexOf(activeName);
    document.querySelectorAll('[data-route-link]').forEach((link) => {
        const isActive = link.dataset.routeLink === activeName;
        const chapterIndex = chapterOrder.indexOf(link.dataset.routeLink);
        const isTurned = activeIndex >= 0 && chapterIndex <= activeIndex;
        link.classList.toggle('chapter-tab-active', isActive);
        link.classList.toggle('chapter-tab-turned', isTurned);
        link.classList.toggle('chapter-tab-unturned', !isTurned);
        link.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
}

function isMobileContextPanelDismissTarget(target) {
    return !target.closest('.paper-page-right.context-panel, dialog');
}

function openMobileContextPanel() {
    if (!refs.rightPage?.classList.contains('context-panel')) {
        return;
    }

    isMobileContextPanelOpen = true;
    syncMobileContextPanelState();
    requestAnimationFrame(() => refs.rightPage?.focus({ preventScroll: true }));
}

function scrollToLedgerFilters() {
    const filters = refs.rightPage?.querySelector('#ledgerFilters');
    if (!filters) return;

    filters.focus({ preventScroll: true });
    refs.rightPage.scrollTo({
        top: refs.rightPage.scrollTop + filters.getBoundingClientRect().top - refs.rightPage.getBoundingClientRect().top - 12,
        behavior: prefersReducedMotion() ? 'instant' : 'smooth'
    });
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

    const toggle = document.querySelector('[data-action="open-context-panel"], [data-action="show-ledger-filters"]');
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
            refs.rightPage.setAttribute('aria-label', activeRoute?.name === 'ledger' ? '高级筛选' : '档案概览');
            refs.rightPage.setAttribute('aria-modal', 'true');
            refs.rightPage.setAttribute('tabindex', '-1');
            refs.rightPage.toggleAttribute('inert', !isOpen);
        } else {
            refs.rightPage.removeAttribute('aria-hidden');
            refs.rightPage.removeAttribute('role');
            refs.rightPage.removeAttribute('aria-modal');
            refs.rightPage.removeAttribute('tabindex');
            refs.rightPage.removeAttribute('inert');
            refs.rightPage.setAttribute('aria-label', '右页');
        }
    }
    if (refs.leftPage) refs.leftPage.inert = isOpen;
    if (refs.spine) refs.spine.inert = isOpen;

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
    syncProfilePictureImages(refs.leftPage);
    syncProfilePictureImages(refs.rightPage);
    enhanceCustomSelects(refs.leftPage);
    enhanceCustomSelects(refs.rightPage);
    isMobileContextPanelOpen = keepContextPanelOpen;
    refs.leftPage.scrollTop = 0;
    refs.rightPage.scrollTop = 0;
    if (rightScrollTop) {
        refs.rightPage.scrollTop = rightScrollTop;
    }
    syncMobileContextPanelState();

    if (isMobileContextPanelOpen) {
        requestAnimationFrame(() => {
            if (refs.rightPage?.contains(document.activeElement)) return;
            refs.rightPage?.focus({ preventScroll: true });
        });
    }
}

function getLedgerRecords(params) {
    const normalized = normalizeLedgerParams(params);
    const query = normalized.q.toLowerCase();
    const records = travelModel.records.filter((record) => {
        const yearMatch = matchesLedgerFilterValue(normalized.year, record.year);
        const monthMatch = matchesLedgerFilterValue(normalized.month, record.month);
        const countryMatch = matchesLedgerFilterValue(normalized.country, record.countryKey);
        const adminAreaMatch = matchesLedgerFilterValue(normalized.area, record.adminAreaKey);
        const localityMatch = matchesLedgerFilterValue(normalized.locality, record.locationKey);
        const visitMatch = normalized.visit.length === 0
            || normalized.visit.some(value => value === 'repeat' ? record.isRepeated : !record.isRepeated);
        const mediaMatch = matchesMediaFilter(record, normalized.media);
        const hasNote = hasRecordNoteContent(record);
        const noteMatch = normalized.note.length === 0
            || normalized.note.some(value => value === 'filled' ? hasNote : !hasNote);
        const searchMatch = !query || record.searchText.includes(query);
        return yearMatch && monthMatch && countryMatch && adminAreaMatch && localityMatch && visitMatch && mediaMatch && noteMatch && searchMatch;
    });

    return records.sort((a, b) => compareLedgerRecords(a, b, normalized.sort));
}

function matchesMediaFilter(record, media = []) {
    const filters = normalizeMedia(media);
    const hasPhotos = Array.isArray(record?.photos) && record.photos.length > 0;
    const hasVideos = Array.isArray(record?.videos) && record.videos.length > 0;
    const hasMedia = hasPhotos || hasVideos;
    if (filters.length === 0) return true;
    return filters.some(value => (
        (value === 'any' && hasMedia)
        || (value === 'photos' && hasPhotos)
        || (value === 'videos' && hasVideos)
        || (value === 'none' && !hasMedia)
    ));
}

function compareLedgerRecords(a, b, sort) {
    switch (sort) {
        case 'asc':
            return (a.date || '').localeCompare(b.date || '') || getLocationText(a).localeCompare(getLocationText(b), 'zh-CN');
        case 'location':
            return getLocationText(a).localeCompare(getLocationText(b), 'zh-CN') || (b.date || '').localeCompare(a.date || '');
        case 'area':
            return (a.adminArea || a.country || '').localeCompare(b.adminArea || b.country || '', 'zh-CN') || (b.date || '').localeCompare(a.date || '');
        case 'title':
            return (a.title || '').localeCompare(b.title || '', 'zh-CN') || (b.date || '').localeCompare(a.date || '');
        case 'desc':
        default:
            return (b.date || '').localeCompare(a.date || '') || getLocationText(a).localeCompare(getLocationText(b), 'zh-CN');
    }
}

function getPlaceRecords(params) {
    return travelModel.recordsDesc.filter(record => (
        (!params.country || record.countryKey === params.country || record.country === params.country) &&
        (!params.area || record.adminAreaKey === params.area || record.adminArea === params.area) &&
        (!params.locality || record.locationKey === params.locality || record.locality === params.locality)
    ));
}

function renderLedgerControls(params, inputId) {
    const activeFilterCount = countLedgerWorkbenchFilters(params);
    const filterLabel = activeFilterCount
        ? `筛选与排序，已启用 ${activeFilterCount} 项`
        : '筛选与排序';

    return `
        <div class="ledger-controls">
            <label class="field-label" for="${inputId}">搜索路线</label>
            <div class="ink-field search-field">
                <input id="${inputId}" type="search" value="${escapeHtml(params.q)}" autocomplete="off" aria-label="搜索国家、行政区、目的地或日记内容" placeholder="搜索地点或日记内容">
                ${params.q ? '<button class="search-clear" type="button" data-action="clear-search" data-target="ledger" aria-label="清空路线搜索">×</button>' : ''}
            </div>
            <button class="paper-button ledger-filter-trigger" type="button" data-action="show-ledger-filters" aria-controls="ledgerFilters" aria-label="${filterLabel}">
                <svg class="ledger-filter-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 6h16M7 12h10M10 18h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                </svg>
                <span>筛选<span class="ledger-filter-label-wide">与排序</span></span>
                ${activeFilterCount ? `<span class="ledger-filter-count" aria-hidden="true">${activeFilterCount}</span>` : ''}
            </button>
        </div>
    `;
}

function countLedgerWorkbenchFilters(params) {
    const normalized = normalizeLedgerParams(params);
    const filterKeys = ['month', 'country', 'area', 'locality', 'visit', 'media', 'note'];
    const filterCount = filterKeys.reduce((count, key) => count + (normalized[key].length > 0 ? 1 : 0), 0);
    return filterCount + (normalized.sort !== DEFAULT_LEDGER_SORT ? 1 : 0);
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
            <header class="ledger-year-divider">
                <h2>${escapeHtml(group.label)}</h2>
                <p>${group.records.length} 篇</p>
            </header>
            <div class="ledger-year-entries">
                ${group.records.map(renderLedgerEntry).join('')}
            </div>
        </section>
    `).join('');
}

function getLedgerGroupLabel(record, sort) {
    if (sort === 'area' || sort === 'location') {
        return record.adminArea || record.country || '未知地点';
    }

    if (sort === 'title') {
        return '按标题排序';
    }

    return record.year || (record.date || '').slice(0, 4) || '未知';
}

function getLedgerGroupAriaLabel(label, sort) {
    if (sort === 'area' || sort === 'location') {
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
                <h3>${escapeHtml(record.title)}</h3>
                <span class="entry-location">${escapeHtml(getLocationText(record))}</span>
                <div class="entry-tags">
                    <a class="location-chip" href="${placeHash(record.countryKey, record.adminArea, record.locality)}">${escapeHtml(record.adminArea || record.country)}</a>
                    ${record.isRepeated ? '<span class="repeat-stamp">再次到访</span>' : ''}
                    ${renderTripGroupHint(record)}
                </div>
            </div>
        </article>
    `;
}

function renderTripGroupHint(record) {
    const count = Number(record.tripRecordCount) || 0;
    const label = String(record.tripGroupLabel || '');
    if (!label) {
        return '';
    }

    const variant = Math.max(0, (Number.parseInt(label, 10) || 1) - 1) % 8;

    return `
        <span class="trip-stamp trip-variant-${variant}" aria-label="行程 ${escapeHtml(label)}，本次行程共有 ${count} 篇日记" title="同色同号属于同一次旅行">行程 ${escapeHtml(label)}</span>
    `;
}

function renderCountryFolder(country) {
    const scopeSummary = country.adminAreas.length
        ? `${country.adminAreas.length} 个${country.labels.adminArea}`
        : `${country.localityCount} 个${country.labels.locality}`;

    return `
        <section class="country-folder" aria-label="${escapeHtml(country.country)}">
            <div class="country-head">
                <h2>${escapeHtml(country.country)}</h2>
                <span>${escapeHtml(scopeSummary)} · ${country.count} 次到访</span>
            </div>
            <div class="luggage-grid">
                ${country.areas.map(renderLuggageTag).join('')}
            </div>
        </section>
    `;
}

function renderLuggageTag(area) {
    return `
        <a class="luggage-tag" href="${placeHash(area.countryKey, area.adminArea, '')}">
            <strong>${escapeHtml(area.label)}</strong>
            <span>${area.count} 次到访 · ${area.localityCount} 个地点</span>
            <small>最近 ${escapeHtml(area.latestDate)}</small>
        </a>
    `;
}

function renderPhotoSleeve(record, options = {}) {
    const media = getRecordMedia(record);
    if (!media.length) return '<p class="photo-note">这篇记录没有图片或视频附件。</p>';

    const { previewRows = 0, showViewAll = false } = options;
    const isPreview = Number.isFinite(previewRows) && previewRows > 0;
    const shouldRenderViewAll = showViewAll && isPreview && media.length > previewRows;

    return `
        <div class="photo-sleeve${isPreview ? ' photo-sleeve-preview' : ''}"${isPreview ? ` data-preview-rows="${previewRows}"` : ''} aria-label="图片与视频附件">
            ${media.map((item, index) => `
                <button class="photo-sleeve-button${item.kind === 'video' ? ' photo-sleeve-video' : ''}" type="button" data-action="open-media-viewer" data-media-index="${index}" data-media-kind="${item.kind}" data-media-name="${escapeHtml(item.name)}" data-media-src="${escapeHtml(item.src)}" data-media-alt="${escapeHtml(item.alt)}" aria-label="打开${item.kind === 'video' ? '视频' : '图片'} ${escapeHtml(item.name)}">
                    ${item.kind === 'video'
                        ? `<video src="${escapeHtml(item.src)}#t=0.1" muted playsinline preload="none" aria-hidden="true" tabindex="-1"></video><span class="photo-sleeve-play" aria-hidden="true">▶</span><span class="photo-sleeve-kind">视频</span>`
                        : `<img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.alt)}" loading="lazy" decoding="async" fetchpriority="low">`}
                    <span class="photo-sleeve-media-error" role="status" hidden><strong>${item.kind === 'video' ? '视频不可用' : '图片不可用'}</strong><span>${escapeHtml(item.name)}</span><small>检查 travel_data.json</small></span>
                    <span class="photo-sleeve-index">${escapeHtml(String(index + 1).padStart(2, '0'))}</span>
                </button>
            `).join('')}
            ${shouldRenderViewAll ? `
                <a class="paper-button photo-sleeve-action" href="${serializeRoute({ name: 'photos', params: { id: record.id } })}" data-action="view-all-photos">
                    查看全部媒体（${media.length} 项）
                </a>
            ` : ''}
        </div>
    `;
}

function getRecordMedia(record) {
    const photos = record.photo_folder && Array.isArray(record.photos)
        ? record.photos.map(name => ({ kind: 'image', name, src: `${record.photo_folder}/${name}`, alt: `${record.title} · ${name}` }))
        : [];
    const videos = record.video_folder && Array.isArray(record.videos)
        ? record.videos.map(name => ({ kind: 'video', name, src: `${record.video_folder}/${name}`, alt: `${record.title} · ${name}` }))
        : [];
    return [...photos, ...videos];
}

function syncPhotoSleevePreviewRows() {
    observedPhotoSleeves.forEach((sleeve) => {
        if (!sleeve.isConnected) {
            photoSleeveResizeObserver?.unobserve(sleeve);
            observedPhotoSleeves.delete(sleeve);
        }
    });
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
    if (!('ResizeObserver' in window) || observedPhotoSleeves.has(sleeve)) {
        return;
    }

    if (!photoSleeveResizeObserver) {
        photoSleeveResizeObserver = new ResizeObserver(() => {
            queuePhotoSleevePreviewSync();
        });
    }

    photoSleeveResizeObserver.observe(sleeve);
    observedPhotoSleeves.add(sleeve);
}

function getPhotoSleeveColumnCount(sleeve) {
    const columns = window.getComputedStyle(sleeve).gridTemplateColumns;
    const columnCount = columns.split(' ').filter(Boolean).length;

    return Math.max(1, columnCount || 1);
}

function filterToggleButton(label, key, value, activeValue) {
    const active = isLedgerFilterValueSelected(activeValue, value);

    return `
        <button class="index-segment${active ? ' index-segment-active' : ''}" type="button" data-ledger-toggle="${escapeHtml(key)}" data-value="${escapeHtml(value)}" aria-pressed="${active ? 'true' : 'false'}">
            ${escapeHtml(label)}
        </button>
    `;
}

function isLedgerFilterValueSelected(activeValues, value) {
    const values = normalizeFilterValues(activeValues);
    return value === 'all' ? values.length === 0 : values.includes(value);
}

function toggleLedgerFilterValue(activeValues, value) {
    if (value === 'all') return [];

    const values = normalizeFilterValues(activeValues);
    return values.includes(value)
        ? values.filter(item => item !== value)
        : [...values, value];
}

function selectLedgerFilterValue(activeValues, value) {
    if (value === 'all') return [];

    const values = normalizeFilterValues(activeValues);
    return values.includes(value) ? [] : [value];
}

function matchesLedgerFilterValue(activeValues, value) {
    return activeValues.length === 0 || activeValues.includes(value);
}

function getAdminAreaFilterOptions(country) {
    const normalizedCountries = normalizeFilterValues(country);

    return travelModel.filterOptions.adminAreas.filter(area => (
        normalizedCountries.length === 0 || normalizedCountries.includes(area.countryKey)
    ));
}

function getLocalityFilterOptions(country, area) {
    const normalizedCountries = normalizeFilterValues(country);
    const normalizedAreas = normalizeFilterValues(area);

    return travelModel.filterOptions.localities.filter(locality => (
        (normalizedCountries.length === 0 || normalizedCountries.includes(locality.countryKey))
        && (normalizedAreas.length === 0 || normalizedAreas.includes(locality.adminAreaKey))
    ));
}

function hasActiveLedgerFilter(params) {
    const normalized = normalizeLedgerParams(params);

    return normalized.year.length > 0
        || normalized.month.length > 0
        || normalized.country.length > 0
        || normalized.area.length > 0
        || normalized.locality.length > 0
        || normalized.visit.length > 0
        || normalized.media.length > 0
        || normalized.note.length > 0
        || Boolean(normalized.q);
}

function yearToggleButton(label, value, activeYears) {
    const active = isLedgerFilterValueSelected(activeYears, value);
    return `<button class="year-bookmark${active ? ' year-bookmark-active' : ''}" type="button" data-ledger-toggle="year" data-value="${escapeHtml(value)}" aria-pressed="${active ? 'true' : 'false'}">${escapeHtml(label)}</button>`;
}

function normalizeLedgerParams(params = {}) {
    return {
        year: normalizeFilterValues(params.year),
        month: normalizeMonth(params.month),
        country: normalizeFilterValues(params.country),
        area: normalizeFilterValues(params.area || params.province),
        locality: normalizeFilterValues(params.locality || params.city),
        visit: normalizeVisit(params.visit),
        media: normalizeMedia(params.media),
        note: normalizeNote(params.note),
        q: (params.q || '').trim(),
        sort: normalizeLedgerSort(params.sort)
    };
}

function normalizeMonth(month) {
    return normalizeFilterValues(month, value => /^(0[1-9]|1[0-2])$/.test(value.padStart(2, '0')))
        .map(value => value.padStart(2, '0'));
}

function normalizeFilterValues(value, validate = () => true) {
    const source = Array.isArray(value) ? value : [value];
    const normalized = source
        .map(item => String(item || ''))
        .map(item => item.trim())
        .filter(item => item && item !== 'all' && item !== 'All' && validate(item));
    return [...new Set(normalized)];
}

function normalizeVisit(visit) {
    return normalizeFilterValues(visit, value => value === 'first' || value === 'repeat').slice(0, 1);
}

function normalizeMedia(media) {
    return normalizeFilterValues(media, value => ['any', 'photos', 'videos', 'none'].includes(value)).slice(0, 1);
}

function normalizeNote(note) {
    return normalizeFilterValues(note, value => value === 'filled' || value === 'empty').slice(0, 1);
}

function normalizeLedgerSort(sort) {
    if (sort === 'province') return 'area';
    return LEDGER_SORT_OPTIONS.has(sort) ? sort : DEFAULT_LEDGER_SORT;
}

function canonicalizeLocationRoute(route) {
    if (!travelModel || !route) return route;

    if (route.name === 'ledger') {
        const params = normalizeLedgerParams(route.params);
        const country = resolveCountryFilterValues(params.country);
        const area = resolveAdminAreaFilterValues(params.area, country);
        const locality = resolveLocalityFilterValues(params.locality, country, area);

        return { ...route, params: { ...params, country, area, locality } };
    }

    if (route.name === 'place') {
        const country = resolveCountryFilterValue(route.params.country, '');
        const area = resolveAdminAreaFilterValue(route.params.area, country, '');
        const locality = resolveLocalityFilterValue(route.params.locality, country, area, '');

        return { ...route, params: { country, area, locality } };
    }

    return route;
}

function resolveCountryFilterValues(values) {
    return normalizeFilterValues(values)
        .map(value => travelModel.filterOptions.countries.find(option => (
            option.value === value || option.label === value
        ))?.value)
        .filter((value, index, all) => value && all.indexOf(value) === index);
}

function resolveAdminAreaFilterValues(values, countries = []) {
    return normalizeFilterValues(values)
        .map(value => travelModel.filterOptions.adminAreas.find(option => (
            (option.value === value || option.label === value)
            && (countries.length === 0 || countries.includes(option.countryKey))
        ))?.value)
        .filter((value, index, all) => value && all.indexOf(value) === index);
}

function resolveLocalityFilterValues(values, countries = [], areas = []) {
    return normalizeFilterValues(values)
        .map(value => travelModel.filterOptions.localities.find(option => (
            (option.value === value || option.label === value)
            && (countries.length === 0 || countries.includes(option.countryKey))
            && (areas.length === 0 || areas.includes(option.adminAreaKey))
        ))?.value)
        .filter((value, index, all) => value && all.indexOf(value) === index);
}

function resolveCountryFilterValue(value, fallback = 'all') {
    if (!value || value === 'all') return fallback;

    const match = travelModel.filterOptions.countries.find(option => (
        option.value === value || option.label === value
    ));
    return match?.value || fallback;
}

function resolveAdminAreaFilterValue(value, country = 'all', fallback = 'all') {
    if (!value || value === 'all') return fallback;

    const match = travelModel.filterOptions.adminAreas.find(option => (
        (option.value === value || option.label === value)
        && (!country || country === 'all' || option.countryKey === country)
    ));
    return match?.value || fallback;
}

function resolveLocalityFilterValue(value, country = 'all', area = 'all', fallback = 'all') {
    if (!value || value === 'all') return fallback;

    const match = travelModel.filterOptions.localities.find(option => (
        (option.value === value || option.label === value)
        && (!country || country === 'all' || option.countryKey === country)
        && (!area || area === 'all' || option.adminAreaKey === area)
    ));
    return match?.value || fallback;
}

function hasLegacyLocationQuery(hash = '') {
    return /[?&](?:province|city)=/.test(hash) || /[?&]sort=province(?:&|$)/.test(hash);
}

function getPlaceLabel(params, matching = []) {
    const record = matching[0];
    if (!record) return '地点';
    if (!params.area && !params.locality) return record.country;

    return formatLocationText({
        country: record.country,
        countryCode: record.countryCode,
        adminArea: params.area ? record.adminArea : '',
        locality: params.locality ? record.locality : ''
    }, {
        includeCountry: !isDomesticLocation(record)
    });
}

function getLocationText(record) {
    const includeCountry = (travelModel?.stats?.countries || 1) > 1 || !isDomesticLocation(record);
    return formatLocationText(record, { includeCountry });
}

function placeHash(country, adminArea, locality) {
    const countryValue = resolveCountryFilterValue(country, '');
    const areaValue = resolveAdminAreaFilterValue(adminArea, countryValue, '');
    const localityValue = resolveLocalityFilterValue(locality, countryValue, areaValue, '');

    return serializeRoute({
        name: 'place',
        params: {
            country: countryValue,
            area: areaValue,
            locality: localityValue
        }
    });
}

function createRecordId(record) {
    const file = (record.desc_md || '').split('/').pop() || '';
    return file.replace(/\.md$/i, '') || `${record.date || 'entry'}-${record.locality || record.adminArea || 'unknown'}`;
}

function maxDate(current, next) {
    return !current || (next || '') > current ? (next || '') : current;
}

function hasRecordNoteContent(record) {
    if (record.descLoadFailed) return false;
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

function restoreFocus(focusId, reopenSelectId = '', selectScrollTop = 0) {
    if (!focusId) return;

    if (reopenSelectId === focusId) {
        const trigger = document.getElementById(`${focusId}Button`);
        const wrapper = trigger?.closest('[data-custom-select]');
        if (!trigger || !wrapper) return;
        wrapper.classList.add('is-reopening');
        trigger.focus({ preventScroll: true });
        trigger.click();
        const menu = wrapper.querySelector('[data-custom-select-menu]');
        if (menu) menu.scrollTop = selectScrollTop;
        requestAnimationFrame(() => wrapper.classList.remove('is-reopening'));
        return;
    }

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
