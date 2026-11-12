import { escapeHtml, getMediaFileUrl } from './utils.js?v=2.1.126';
import { createPasswordGate } from './record-password.js?v=2.1.126';
import { detectWriterCapability } from './writer-capability.js?v=2.1.126';
import { confirmFeedback } from './feedback-dialog.js?v=2.1.126';
import { createContentPreviewScope, mediaKind } from './content-preview.js?v=2.1.126';
import { enhanceCustomSelects } from './custom-select.js?v=2.1.126';
import { renderRecordDifference, loadDifferenceMedia } from './record-diff-view.js?v=2.1.126';
import { recordIdentity } from './record-identity.mjs?v=2.1.126';
import { buildRecycleTree, buildRestorePreviewTree, groupRecycleItems, recycleRestoreConflicts, recycleRecordLabel, recycleFileType, recycleSelectionGroups, selectRecycleParts } from './recycle-tree.mjs?v=2.1.126';

function sizeLabel(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function restoreChangeTitle(record, comparison) {
    const diary = record.date ? record : comparison.previous?.date ? comparison.previous : null;
    if (diary) {
        const attachmentFields = ['photo_folder', 'photos', 'video_folder', 'videos'];
        const parts = [comparison.fields.some(key => !attachmentFields.includes(key)) ? '信息' : '',
            comparison.markdownChanged ? '正文' : '',
            comparison.media.length || comparison.fields.some(key => attachmentFields.includes(key)) ? '附件' : ''].filter(Boolean);
        const type = comparison.status === 'changed' && parts.length ? `日记${parts.join('、')}` : '日记';
        return [type, diary.date, diary.locality || diary.admin_area || diary.country].filter(Boolean).join(' · ');
    }
    const name = record.desc_md;
    if (name === 'data/profile/owner-name.txt') return '个人署名';
    if (name === 'data/profile/profile-picture.png') return '个人头像';
    const kind = mediaKind(name);
    const type = kind === 'image' ? '图片' : kind === 'video' ? '视频' : /\.md$/i.test(name) ? '正文文件' : '文件';
    return `${type} · ${name.split('/').pop()}`;
}

const folderIcon = '<svg class="recycle-node-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M3 9h18"/></svg>';
const fileIcon = '<svg class="recycle-node-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 3H5v18h14V8Z"/><path d="M14 3v5h5M8 12h8M8 16h6"/></svg>';

function fileDisplayName(name) {
    return ({ 'data/travel_data.json': '日记索引', 'data/profile/owner-name.txt': '个人署名', 'data/profile/profile-picture.png': '个人头像' })[name] || name.split('/').pop();
}

export function createRecycleManager(onRestored, { onClose, isActive = () => true } = {}) {
    const dialog = document.createElement('dialog');
    dialog.className = 'record-transfer recycle-manager management-dialog entry-sheet';
    dialog.setAttribute('aria-labelledby', 'recycleManagerTitle');
    dialog.innerHTML = `<div class="record-transfer-card">
        <header class="management-heading"><div><h2 id="recycleManagerTitle">回收站</h2><p>勾选内容后，可预览恢复变化、恢复或永久清除。</p></div><button class="paper-button management-secondary" type="button" data-recycle-close>关闭</button></header>
        <div class="recycle-toolbar"><p data-recycle-status></p><div class="recycle-toolbar-actions"><button class="paper-button management-secondary" type="button" data-recycle-refresh>刷新</button><button class="paper-button recycle-purge" type="button" data-recycle-clear disabled>清空回收站</button></div></div>
        <div class="recycle-filter-bar"><div class="recycle-search-field"><label class="field-label" for="recycleSearch">筛选回收内容</label><div class="management-search"><input id="recycleSearch" type="search" autocomplete="off" data-recycle-search placeholder="搜索标题、类型、地点或文件路径"><button class="media-text-button" type="button" data-recycle-reset hidden>清除搜索</button></div></div><div class="media-selection-tools"><button class="paper-button management-secondary" type="button" data-recycle-all disabled>全选当前结果</button><button class="paper-button management-secondary" type="button" data-recycle-none disabled>取消选择</button></div></div>
        <p class="recycle-notice" data-recycle-notice role="status" aria-live="polite"></p><p data-recycle-error role="alert"></p>
        <ul class="recycle-list" data-recycle-list tabindex="0" aria-label="回收内容"></ul>
        <footer class="management-footer recycle-selection"><p data-recycle-count role="status" aria-live="polite">尚未选择内容</p><div class="recycle-selection-actions"><button class="paper-button recycle-restore" type="button" data-recycle-restore disabled>恢复所选内容</button><button class="paper-button recycle-purge" type="button" data-recycle-purge-selected disabled>永久清除所选</button></div><p class="recycle-selection-note" data-recycle-selection-note>恢复前可展开预览；清除所选内容后无法找回。</p></footer></div>`;
    document.body.append(dialog);
    let report;
    let grouping = { groups: [], recordsByItem: new Map() };
    let busy = false;
    let stale = true;
    let clearSupported = false;
    let selectionSupported = false;
    let purgeSelectionSupported = false;
    let partsSupported = false;
    let trigger;
    let previews = createContentPreviewScope();
    let previewQueue = Promise.resolve();
    const selected = new Map();
    const targets = new Map();
    const expandedItems = new Set();
    const expandedGroups = new Set();
    const partSelections = new Map();
    const partGroups = new WeakMap();
    const directoryStates = new Map();
    const trees = new Map();
    let suspended = false;
    let scrollPosition;
    let returnFocus;
    const error = message => { dialog.querySelector('[data-recycle-error]').textContent = message; };
    const notice = message => { dialog.querySelector('[data-recycle-notice]').textContent = message; };
    const types = { record: '日记', files: '文件', version: '旧版本', snapshot: '整站数据' };
    function filteredItems() {
        const query = dialog.querySelector('[data-recycle-search]').value.trim().toLowerCase();
        return (report?.items || []).filter(item => [item.title, types[item.kind], new Date(item.createdAt).toLocaleString(),
            ...item.files.flatMap(file => [file.path, recycleFileType(file.path, mediaKind)]), ...(grouping.recordsByItem.get(item.id) || []).flatMap(record => [record.title, record.date, record.country, record.admin_area, record.locality])]
            .some(value => String(value || '').toLowerCase().includes(query)));
    }
    function syncControls() {
        dialog.setAttribute('aria-busy', String(busy));
        dialog.querySelectorAll('button, input, select').forEach(control => { control.disabled = busy; });
        dialog.querySelector('[data-recycle-clear]').disabled = busy || stale || !clearSupported || !report?.items.length;
        dialog.querySelector('[data-recycle-clear]').title = clearSupported ? '' : '重启日记服务后可用';
        dialog.querySelectorAll('[data-recycle-target], [data-recycle-select], [data-recycle-retry]').forEach(control => { control.disabled = busy || stale; });
        dialog.querySelectorAll('[data-recycle-select]').forEach(control => {
            control.disabled ||= !selectionSupported;
            control.checked = selected.has(control.value);
            control.closest('li').classList.toggle('is-selected', control.checked);
        });
        dialog.querySelectorAll('[data-recycle-item-status]').forEach(element => {
            const state = selected.get(element.dataset.recycleItemStatus);
            element.hidden = !state;
            if (!state) return;
            const count = state.parts?.filter(key => key.startsWith('diary:')).length;
            const scope = state.parts ? `已选${[count ? `${count} 篇日记` : '', state.parts.includes('profile') ? '个人资料' : '', state.parts.includes('index') ? '日记索引' : ''].filter(Boolean).join('及')}` : '已选整项';
            element.textContent = `${scope} · ${state.phase === 'pending' ? '正在生成预览' : state.phase === 'error' ? '预览需处理' : '预览就绪'}`;
        });
        dialog.querySelector('[data-recycle-all]').disabled = busy || stale || !selectionSupported || !filteredItems().some(item => !selected.has(item.id));
        dialog.querySelector('[data-recycle-none]').disabled = busy || !selected.size;
        const partial = [...selected.values()].some(state => state.parts !== undefined);
        dialog.querySelector('[data-recycle-purge-selected]').disabled = busy || stale || !purgeSelectionSupported || !selected.size || partial;
        dialog.querySelector('[data-recycle-purge-selected]').title = purgeSelectionSupported ? '' : '重启日记服务后可用';
        const items = (report?.items || []).filter(item => selected.has(item.id));
        const hidden = items.length - filteredItems().filter(item => selected.has(item.id)).length;
        const restoreItems = items.map(item => selectRecycleParts(item, selected.get(item.id).parts, report.currentRecords));
        const pending = [...selected.values()].filter(state => state.phase === 'pending').length;
        const failed = [...selected.values()].filter(state => state.phase === 'error').length;
        const exclusive = items.length > 1 && restoreItems.some(item => item.kind === 'snapshot' || item.files.some(file => file.path === 'data/travel_data.json'));
        const indexSelected = [...selected.values()].some(state => state.parts?.includes('index'));
        const conflicts = recycleRestoreConflicts(report?.items || [], report?.currentRecords || [], [...selected.values()]);
        const conflictingIds = new Set(conflicts.flatMap(group => group.items.map(item => item.id)));
        dialog.querySelectorAll('[data-recycle-conflict]').forEach(element => {
            element.hidden = !conflictingIds.has(element.dataset.recycleConflict);
            const checkbox = element.closest('[data-recycle-item]').querySelector('[data-recycle-select]');
            if (element.hidden) checkbox.removeAttribute('aria-describedby');
            else checkbox.setAttribute('aria-describedby', element.id);
        });
        dialog.querySelector('[data-recycle-count]').textContent = items.length ? `已选 ${items.length} 个项目${hidden ? `（含筛选外 ${hidden} 个）` : ''} · ${sizeLabel(restoreItems.flatMap(item => item.files).reduce((sum, file) => sum + file.size, 0))}${partial ? ' · 含部分恢复' : ''}${pending ? ` · 正在生成 ${pending} 项预览` : failed ? ` · ${failed} 项需处理` : ''}` : '尚未选择内容';
        dialog.querySelector('[data-recycle-restore]').disabled = busy || stale || !selectionSupported || !items.length || pending > 0 || failed > 0 || exclusive || conflicts.length > 0;
        const selectionNote = dialog.querySelector('[data-recycle-selection-note]');
        selectionNote.dataset.recycleSelectionIssue = String(exclusive || conflicts.length > 0 || failed > 0);
        selectionNote.textContent = exclusive ? '整站数据或日记索引每次只能恢复一个批次，请调整所选项目。' : conflicts.length ? `同一篇日记每次只能恢复一个版本。请调整「${conflicts.map(group => recycleRecordLabel(group.record)).join('」「')}」的勾选项，保留一个后恢复。` : failed ? '请处理所选项目中的提示，预览全部就绪后才能恢复。' : indexSelected ? '将替换当前整份日记索引，回退全部日记信息和附件引用。正文、附件及个人资料按各自勾选范围恢复，原回收批次完整保留。' : partial ? '仅恢复勾选的日记、归档附件及个人资料，原回收批次完整保留。永久清除需勾选整个回收项目。' : '恢复前可展开预览；清除所选内容后无法找回。';
        syncPartControls();
        dialog.querySelectorAll('[data-recycle-mode-note]').forEach(element => {
            const id = element.closest('[data-recycle-item]').dataset.recycleItem;
            element.textContent = selected.get(id)?.parts?.includes('index') ? '日记索引将整份替换，回退全部日记信息和附件引用。原回收批次完整保留。' : selected.get(id)?.parts ? '仅恢复勾选的日记、归档附件及个人资料，原回收批次完整保留。' : '勾选整个项目可恢复全部日记和个人资料，也可单独勾选日记、个人资料或日记索引。被替换的当前内容会先存入回收站。';
        });
        dialog.querySelectorAll('[data-recycle-history-count]').forEach(element => {
            const group = grouping.groups.find(group => group.key === element.dataset.recycleHistoryCount);
            const count = group.items.filter(item => selected.has(item.id)).length;
            element.textContent = count ? `已选 ${count} 次` : '';
            element.hidden = !count;
            element.closest('[data-recycle-diary]').classList.toggle('has-selection', count > 0);
        });
        dialog.querySelectorAll('[data-recycle-target-link]').forEach(element => {
            const id = element.closest('[data-recycle-item]').dataset.recycleItem;
            const record = report.currentRecords?.find(record => record.desc_md === targets.get(id));
            element.innerHTML = record ? recordLink(record, '查看目标日记') : '';
            element.hidden = !record;
        });
        enhanceCustomSelects(dialog);
    }
    function previewMarkup(state) {
        if (!state) return '';
        if (state.phase === 'pending') return '<p class="recycle-preview-status" role="status">正在生成恢复预览…</p>';
        if (state.phase === 'error') return `<p class="recycle-preview-status" role="alert">${escapeHtml(state.message)}</p><button class="media-text-button" type="button" data-recycle-retry="${state.id}">重试预览</button>`;
        return `<details class="recycle-restore-preview"><summary>预览恢复后的变化 <small>${state.changes.length ? `${state.changes.length} 项内容` : '内容相同'}</small></summary><div class="recycle-preview-body recycle-contents" data-media-viewer-group>${state.changes.length ? '<p class="recycle-restore-note">以下为这个项目恢复后的变化。确认恢复后才会写入。</p><ul class="recycle-tree" data-recycle-restore-files data-recycle-directory="" style="--recycle-depth: 0" aria-label="恢复变化目录"></ul>' : '<p class="recycle-restore-note">回收内容与当前内容一致，无需恢复。</p>'}</div></details>`;
    }
    async function loadRestoreContents(list, state) {
        if (!list || list.dataset.loaded) return;
        list.dataset.loaded = 'true';
        state.tree ||= buildRestorePreviewTree(state.changes, mediaKind, { groupSingleRecord: !grouping.groups.some(group => group.record && group.items.some(item => item.id === state.id)) });
        const node = state.tree.get(list.dataset.recycleDirectory);
        const scope = previews;
        const singleBody = node.name !== '正文' && node.files.filter(file => recycleFileType(file.path, mediaKind) === '正文' && file.comparison.markdownChanged).length === 1;
        for (const child of node.directories) {
            const row = document.createElement('li');
            const item = report.items.find(item => item.id === state.id);
            row.innerHTML = `<details class="recycle-directory" data-recycle-restore-directory><summary${child.record ? ' class="recycle-diary-summary"' : ''}>${child.record ? '' : folderIcon}<span${child.record ? ' class="recycle-directory-record"' : ''}>${child.record ? recordLink(child.record, child.name, undefined, item) : escapeHtml(child.name)}</span><small>${child.count} 项变化</small></summary><ul class="recycle-tree" data-recycle-restore-files data-recycle-directory="${escapeHtml(child.path)}" style="--recycle-depth: ${Math.min(child.depth, 4)}" aria-label="${escapeHtml(child.name)}"></ul></details>`;
            list.append(row);
        }
        let leadingRows = 0;
        for (const [index, file] of node.files.entries()) {
            if (!list.isConnected || scope !== previews || selected.get(state.id) !== state) return;
            const row = document.createElement('li');
            row.className = 'recycle-file';
            const comparison = file.comparison;
            let action = { added: '新增', removed: '移除', changed: '修改' }[comparison.status];
            if (comparison.media.length) action = !comparison.previousMediaPaths.has(file.path) ? '新增' : !comparison.incomingMediaPaths.has(file.path) ? '移除' : '内容变化';
            const label = singleBody && file.comparison.markdownChanged && recycleFileType(file.path, mediaKind) === '正文' ? '正文' : file.label || fileDisplayName(file.path);
            if (comparison.media.length && comparison.incomingMediaPaths.has(file.path) && mediaKind(file.path)) {
                const url = state.savedPaths.has(file.path) ? recycleUrl(state.id, state.savedFiles.get(file.path) || file.path) : getMediaFileUrl(file.path);
                const preview = await filePreview(file, scope, { url, size: comparison.mediaSizes?.after?.[file.path], detail: action });
                row.append(preview);
                if (scope !== previews || !list.isConnected || selected.get(state.id) !== state) return;
                (preview.querySelector('.content-file-body') || row).insertAdjacentHTML('beforeend', `<details class="recycle-change-details" data-recycle-difference="${index}"><summary>查看差异</summary><div></div></details>`);
                list.append(row);
                continue;
            }
            row.innerHTML = `<details class="content-file-preview" data-recycle-restore-file="${index}" title="${escapeHtml(file.path)}"><summary aria-label="${escapeHtml(`${restoreChangeTitle(file.record, comparison)} · ${label} · ${action}`)}">${fileIcon}<span>${escapeHtml(label)}</span><small>${action}</small></summary><div class="content-file-body"></div></details>`;
            if (label === '正文' || file.category === '日记信息') list.insertBefore(row, list.children[leadingRows++] || null);
            else list.append(row);
        }
    }
    async function filePreview(file, scope, { url, size = file.size, detail = '', label = '' }) {
        const kind = mediaKind(file.path);
        const name = fileDisplayName(file.path);
        const metadata = [kind ? kind === 'image' ? '图片' : '视频' : '', Number.isFinite(size) ? sizeLabel(size) : '', detail].filter(Boolean).join(' · ');
        let preview = await scope.file({ name: file.path, url, size, detail: kind ? metadata : '', label });
        if (kind && name !== file.path.split('/').pop()) {
            const heading = preview.querySelector('.media-file-name');
            if (heading) heading.textContent = name;
            const note = preview.querySelector('.media-file-detail');
            if (note) note.textContent = `${file.path.split('/').pop()} · ${metadata}`;
        }
        const summary = preview.querySelector('summary');
        if (summary) {
            if (!label) summary.querySelector('span').textContent = name;
            if (/\.md$/i.test(file.path) && !label) summary.querySelector('span').classList.add('recycle-body-filename');
            summary.insertAdjacentHTML('afterbegin', fileIcon);
            const sizeNote = document.createElement('small');
            sizeNote.textContent = Number.isFinite(size) ? sizeLabel(size) : '';
            summary.append(sizeNote);
        }
        const empty = preview.matches('.content-file-empty') ? preview : null;
        if (empty) {
            empty.querySelector('span').textContent = name;
            if (detail) empty.querySelector('small').textContent += ` · ${detail}`;
            empty.insertAdjacentHTML('afterbegin', fileIcon);
        }
        if (preview.matches('a.media-file-link')) preview.setAttribute('aria-label', `查看文件：${file.path}`);
        // 资料媒体复用文件入口，分类压扁后仍与署名和索引对齐。
        if (file.path.startsWith('data/profile/') && preview.matches('a.media-file-link')) {
            const entry = document.createElement('details');
            entry.className = 'content-file-preview';
            entry.title = file.path;
            entry.innerHTML = `<summary>${fileIcon}<span>${escapeHtml(name)}</span><small>${escapeHtml([Number.isFinite(size) ? sizeLabel(size) : '', detail].filter(Boolean).join(' · '))}</small></summary><div class="content-file-body"></div>`;
            entry.querySelector('.content-file-body').append(preview);
            preview = entry;
        }
        return preview;
    }
    function currentRecord(record, previous) {
        return report.currentRecords?.find(candidate => [record, previous].some(value => value && (recordIdentity(value) === recordIdentity(candidate) || value.desc_md === candidate.desc_md)));
    }
    function recordLink(record, label = record.desc_md, previous, item) {
        const current = currentRecord(record, previous);
        if (current) return `<a href="#entry?id=${encodeURIComponent(recordIdentity(current))}&from=recycle" data-recycle-record>${escapeHtml(label)}</a>`;
        if (item?.files.some(file => file.path === record.desc_md)) return `<a href="${escapeHtml(recycleUrl(item.id, record.desc_md))}" target="_blank" rel="noopener" title="查看回收的日记正文">${escapeHtml(label)}</a>`;
        return escapeHtml(label);
    }
    function mediaLink(name, side, state) {
        if (!mediaKind(name)) return escapeHtml(name);
        const url = side === 'after' && state.savedPaths.has(name) ? recycleUrl(state.id, state.savedFiles.get(name) || name) : getMediaFileUrl(name);
        return `<a href="${escapeHtml(url)}" data-action="open-media-viewer" data-media-src="${escapeHtml(url)}" data-media-name="${escapeHtml(name)}" data-media-alt="${escapeHtml(name)}" data-media-kind="${mediaKind(name)}" data-media-index="0">${escapeHtml(name)}</a>`;
    }
    function contentsMarkup(item) {
        if (!item.files.length && !itemPartGroups(item).length) return '<p class="recycle-restore-note">此项目没有归档文件。</p>';
        return `<div class="recycle-contents" data-media-viewer-group><ul class="recycle-tree" data-recycle-files="${item.id}" data-recycle-directory="" style="--recycle-depth: 0" aria-label="归档文件目录"></ul></div>`;
    }
    function syncPartControls() {
        dialog.querySelectorAll('[data-recycle-part-select]').forEach(control => {
            const id = control.closest('[data-recycle-item]').dataset.recycleItem;
            control.checked = selected.has(id) && (!partSelections.has(id) || partSelections.get(id).has(control.value));
            control.disabled = busy || stale || !partsSupported;
            control.closest('summary').classList.toggle('is-selected', control.checked);
        });
        dialog.querySelectorAll('[data-recycle-select]').forEach(control => {
            control.indeterminate = selected.has(control.value) && partSelections.has(control.value);
            if (control.indeterminate) control.checked = false;
        });
    }
    function itemPartGroups(item) {
        if (!partGroups.has(item)) partGroups.set(item, recycleSelectionGroups(item));
        return partGroups.get(item);
    }
    function directoryKey(id, name) {
        return JSON.stringify([id, dialog.querySelector('[data-recycle-search]').value.trim().toLowerCase(), name]);
    }
    function loadItemContents(id) {
        const item = report.items.find(item => item.id === id);
        const list = dialog.querySelector(`[data-recycle-item="${id}"] [data-recycle-files]`);
        if (!list) return;
        if (!trees.has(id)) trees.set(id, buildRecycleTree(item.files, dialog.querySelector('[data-recycle-search]').value, { records: item.records, mediaReferences: item.mediaReferences, displayRecords: grouping.recordsByItem.get(id), mediaKind, groupSingleRecord: item.kind === 'snapshot', includeEmptyRecords: true, preserveProfileGroup: true }));
        void loadContents(list, item, previews);
    }
    async function loadContents(list, item, scope) {
        if (list.dataset.loaded || !list.isConnected || scope !== previews) return;
        list.dataset.loaded = 'true';
        const directory = trees.get(item.id).get(list.dataset.recycleDirectory);
        const singleBody = directory.name !== '正文' && directory.files.filter(file => recycleFileType(file.path, mediaKind) === '正文').length === 1;
        for (const child of directory.directories) {
            const row = document.createElement('li');
            const open = directoryStates.get(directoryKey(item.id, child.path)) ?? false;
            const groupKey = child.record ? `diary:${child.record.desc_md}` : child.name === '个人资料' ? 'profile' : '';
            const selectable = partsSupported && itemPartGroups(item).some(group => group.key === groupKey);
            const choice = selectable ? `<label class="recycle-diary-selector"><input type="checkbox" data-recycle-part-select value="${escapeHtml(groupKey)}" aria-label="选择${child.record ? '日记 ' : ''}${escapeHtml(child.name)}"></label>` : '';
            const summaryClass = [child.record ? 'recycle-diary-summary' : '', selectable ? 'recycle-diary-choice' : '', selectable && !child.record ? 'recycle-profile-choice' : ''].filter(Boolean).join(' ');
            row.innerHTML = `<details class="recycle-directory" data-recycle-folder="${escapeHtml(child.path)}"${open ? ' open' : ''}>
                <summary${summaryClass ? ` class="${summaryClass}"` : ''} title="${escapeHtml(child.name)}">${choice}${child.record ? '' : folderIcon}<span${child.record ? ' class="recycle-directory-record"' : ''}>${child.record ? recordLink(child.record, child.name, undefined, item) : escapeHtml(child.name)}</span><small><span>${child.count ? `${child.count} 个文件` : '仅日记信息'}</span><span>${sizeLabel(child.totalBytes)}</span></small></summary>
                <ul class="recycle-tree" data-recycle-files="${item.id}" data-recycle-directory="${escapeHtml(child.path)}" style="--recycle-depth: ${Math.min(child.depth, 4)}" aria-label="${escapeHtml(child.name)}"></ul></details>`;
            list.append(row);
        }
        syncPartControls();
        // 每层独立加载，深目录不会递归占用调用栈，折叠的目录无需创建文件预览。
        for (const child of list.querySelectorAll(':scope > li > details[open] > [data-recycle-files]')) {
            queueMicrotask(() => { void loadContents(child, item, scope); });
        }
        for (const file of directory.files) {
            if (!list.isConnected || scope !== previews) return;
            const row = document.createElement('li');
            row.className = 'recycle-file';
            row.title = file.path;
            const bodyLabel = singleBody && recycleFileType(file.path, mediaKind) === '正文' ? '正文' : '';
            try {
                const preview = await filePreview(file, scope, { url: recycleUrl(item.id, file.path), label: bodyLabel });
                if (partsSupported && file.path === 'data/travel_data.json') {
                    const summary = preview.querySelector('summary');
                    summary.classList.add('recycle-index-choice');
                    summary.insertAdjacentHTML('afterbegin', '<label class="recycle-diary-selector"><input type="checkbox" data-recycle-part-select value="index" aria-label="选择日记索引"></label>');
                    summary.title = '恢复将替换当前整份索引，回退全部日记信息和附件引用。';
                }
                row.append(preview);
            }
            catch (failure) { row.textContent = `${file.path}：${failure.message}`; }
            if (scope !== previews || !list.isConnected || (!dialog.open && !suspended)) return;
            if (bodyLabel) list.prepend(row);
            else list.append(row);
        }
        syncPartControls();
    }
    function syncPreview(id) {
        const container = dialog.querySelector(`[data-recycle-diff="${id}"]`);
        if (!container) return;
        const state = selected.get(id);
        container.innerHTML = previewMarkup(state);
        container.hidden = !state;
        container.closest('li').querySelectorAll('[data-recycle-selected-only]').forEach(element => { element.hidden = !state; });
    }
    function setItemExpanded(id, expanded) {
        if (expanded) expandedItems.add(id);
        else expandedItems.delete(id);
        const item = dialog.querySelector(`[data-recycle-item="${id}"]`);
        if (!item) return;
        item.querySelector('.recycle-item-body').hidden = !expanded;
        const button = item.querySelector('[data-recycle-toggle]');
        button.setAttribute('aria-expanded', String(expanded));
        button.textContent = expanded ? '收起' : '展开';
        button.setAttribute('aria-label', `${button.textContent} ${report.items.find(item => item.id === id).title}`);
        if (expanded) loadItemContents(id);
    }
    function render() {
        previews.dispose();
        previews = createContentPreviewScope();
        trees.clear();
        const items = filteredItems();
        dialog.querySelector('[data-recycle-status]').textContent = `显示 ${items.length} / ${report.items.length} 个回收项目 · 共 ${sizeLabel(report.totalBytes)}`;
        dialog.querySelector('[data-recycle-reset]').hidden = !dialog.querySelector('[data-recycle-search]').value;
        const itemMarkup = (item, grouped = false) => {
            const records = grouping.recordsByItem.get(item.id) || [];
            const summaries = grouped || item.kind === 'snapshot' || records.length > 1 ? [] : records;
            return `<li data-recycle-item="${item.id}">
            <div class="recycle-item-header">
            <label class="recycle-item-choice"><input type="checkbox" data-recycle-select value="${item.id}" aria-label="选择 ${escapeHtml(item.title)}，${escapeHtml(new Date(item.createdAt).toLocaleString())}"><strong>${escapeHtml(item.title)}</strong></label>
            <button class="media-text-button recycle-item-toggle" type="button" data-recycle-toggle="${item.id}" aria-controls="recycleBody-${item.id}" aria-expanded="${expandedItems.has(item.id)}" aria-label="${expandedItems.has(item.id) ? '收起' : '展开'} ${escapeHtml(item.title)}">${expandedItems.has(item.id) ? '收起' : '展开'}</button>
            <small class="recycle-item-meta"><span>${types[item.kind] || '文件'}</span>${item.records.length ? `<span>${item.records.length} 篇日记</span>` : ''}<span>${item.files.length} 个文件</span><span>${sizeLabel(item.files.reduce((sum, file) => sum + file.size, 0))}</span><time datetime="${escapeHtml(item.createdAt)}">${escapeHtml(new Date(item.createdAt).toLocaleString())}</time></small>
            <p class="recycle-item-status" data-recycle-item-status="${item.id}" hidden></p>
            </div>
            <p class="recycle-version-conflict" id="recycleConflict-${item.id}" data-recycle-conflict="${item.id}" hidden>已选中同篇日记的其他回收内容，恢复前请只保留一个版本。</p>
            <div class="recycle-item-body" id="recycleBody-${item.id}"${expandedItems.has(item.id) ? '' : ' hidden'}>
            ${summaries.map(record => `<p class="recycle-record-info">${recordLink(record, recycleRecordLabel(record), undefined, item)}</p>`).join('')}
            ${item.kind === 'snapshot' ? '<p class="recycle-restore-note" data-recycle-mode-note></p>' : item.kind === 'version' ? '<p class="recycle-restore-note">恢复到原位置；被替换的当前文件也会存入回收站。</p>' : ''}
            ${contentsMarkup(item)}
            ${item.kind === 'files' && !item.mediaReferences?.length && item.files.some(file => mediaKind(file.path)) ? `<div class="recycle-target" data-recycle-selected-only${selected.has(item.id) ? '' : ' hidden'}><label class="field-label" for="recycleTarget-${item.id}">恢复到</label><select id="recycleTarget-${item.id}" data-custom-select data-recycle-target="${item.id}"><option value="">${item.title === '编辑日记时移除的媒体' ? '请选择原日记' : '仅恢复文件'}</option>${(report.currentRecords || []).map(record => `<option value="${escapeHtml(record.desc_md)}"${targets.get(item.id) === record.desc_md ? ' selected' : ''}>${escapeHtml([record.date, record.locality].filter(Boolean).join(' · '))}</option>`).join('')}</select><p class="recycle-restore-note">选择日记后，同时补回附件列表；其他日记信息保持不变。</p><p class="recycle-target-link" data-recycle-target-link></p></div>` : item.mediaReferences?.length ? '<p class="recycle-restore-note">恢复文件并补回原日记的附件列表，保留之后修改的内容。</p>' : ''}
            <div data-recycle-diff="${item.id}"${selected.has(item.id) ? '' : ' hidden'}>${previewMarkup(selected.get(item.id))}</div>
            </div></li>`;
        };
        const visible = new Set(items.map(item => item.id));
        dialog.querySelector('[data-recycle-list]').innerHTML = items.length ? grouping.groups.map(group => {
            const history = group.items.filter(item => visible.has(item.id));
            if (!history.length) return '';
            if (!group.record) return history.map(item => itemMarkup(item)).join('');
            const label = recycleRecordLabel(group.record);
            const note = group.items.some(item => item.kind === 'version' || item.kind === 'record') ? '以下回收记录属于同一篇日记，恢复时请选择一个版本。' : '以下回收记录属于同一篇日记。';
            return `<li class="recycle-diary-group" data-recycle-diary="${escapeHtml(group.key)}"><details class="recycle-diary-history" data-recycle-history="${escapeHtml(group.key)}"${expandedGroups.has(group.key) ? ' open' : ''}><summary><span>${recordLink(group.record, label, undefined, history.find(item => item.files.some(file => file.path === group.record.desc_md)))}</span><small>${history.length} 次回收${history.length !== group.items.length ? ` / 共 ${group.items.length} 次` : ''}</small><small data-recycle-history-count="${escapeHtml(group.key)}"></small></summary>${group.items.length > 1 ? `<p class="recycle-group-note">${note}</p>` : ''}<ul class="recycle-list recycle-history" aria-label="${escapeHtml(label)}的回收记录">${history.map(item => itemMarkup(item, true)).join('')}</ul></details></li>`;
        }).join('') : `<li class="media-empty">${report.items.length ? '没有匹配的回收项目，清除搜索后可查看全部内容。' : '回收站为空。删除的内容会显示在这里。'}</li>`;
        expandedItems.forEach(loadItemContents);
        syncControls();
    }
    function recycleUrl(id, name) {
        const url = new URL('api/travel-data?mode=recycle-file', window.location.href);
        url.searchParams.set('id', id);
        url.searchParams.set('path', name);
        return url.href;
    }
    dialog.addEventListener('toggle', async event => {
        const details = event.target;
        if (details.matches('[data-recycle-history]')) {
            if (details.open) expandedGroups.add(details.dataset.recycleHistory);
            else expandedGroups.delete(details.dataset.recycleHistory);
            return;
        }
        if (details.matches('[data-recycle-difference]')) {
            if (!details.open || details.dataset.loaded) return;
            const state = selected.get(details.closest('[data-recycle-item]').dataset.recycleItem);
            if (state?.phase !== 'ready') return;
            details.dataset.loaded = 'true';
            const list = details.closest('[data-recycle-restore-files]');
            const file = state.tree.get(list.dataset.recycleDirectory).files[Number(details.dataset.recycleDifference)];
            const body = details.querySelector('div');
            body.innerHTML = renderRecordDifference(file.record, file.comparison, { afterLabel: '恢复后', note: '', collapsible: false, numberedFields: true,
                textLabel: file.path === 'data/profile/owner-name.txt' ? '署名' : /\.md$/i.test(file.path) ? '正文' : '文本', mediaLink: (name, side) => mediaLink(name, side, state) });
            body.querySelector('.content-preview-source')?.remove();
            const scope = previews;
            await loadDifferenceMedia(body.querySelector('[data-diff-record]'), file.comparison, scope, (name, side) => ({
                url: side === 'after' && state.savedPaths.has(name) ? recycleUrl(state.id, state.savedFiles.get(name) || name) : getMediaFileUrl(name),
                size: file.comparison.mediaSizes?.[side]?.[name]
            }), () => scope === previews && state === selected.get(state.id));
            return;
        }
        if (details.matches('.recycle-restore-preview, [data-recycle-restore-directory], [data-recycle-restore-file]')) {
            if (!details.open) return;
            const id = details.closest('[data-recycle-item]').dataset.recycleItem;
            const state = selected.get(id);
            if (state?.phase !== 'ready') return;
            if (!details.matches('[data-recycle-restore-file]')) {
                void loadRestoreContents(details.querySelector('[data-recycle-restore-files]'), state);
                return;
            }
            if (details.dataset.loaded) return;
            details.dataset.loaded = 'true';
            const list = details.closest('[data-recycle-restore-files]');
            const file = state.tree.get(list.dataset.recycleDirectory).files[Number(details.dataset.recycleRestoreFile)];
            const body = details.querySelector('.content-file-body');
            const scope = previews;
            if (file.comparison.fields.length) {
                body.innerHTML = renderRecordDifference(file.record, file.comparison, { afterLabel: '恢复后', note: '', collapsible: false, numberedFields: true });
                body.querySelector('.record-diff-section > h3')?.remove();
                return;
            }
            const exists = file.comparison.markdownChanged ? file.comparison.markdownExists?.after ?? file.comparison.status !== 'removed' : file.comparison.incomingMediaPaths.has(file.path);
            if (exists && file.comparison.markdownChanged) {
                const preview = await scope.file({ name: file.path, source: new TextEncoder().encode(file.comparison.markdown ?? ''), collapsible: false });
                if (scope !== previews || state !== selected.get(id) || !details.isConnected) return;
                if (!/\.md$/i.test(file.path)) preview.querySelector('.content-file-heading')?.remove();
                body.replaceChildren(preview);
            } else body.innerHTML = `<p class="content-preview-empty">恢复后${exists ? '文件暂不支持预览' : '无此文件'}</p>`;
            body.insertAdjacentHTML('beforeend', `<details class="recycle-change-details" data-recycle-difference="${details.dataset.recycleRestoreFile}"><summary>查看差异</summary><div></div></details>`);
            return;
        }
        if (details.matches('[data-recycle-folder]')) {
            const id = details.closest('[data-recycle-item]').dataset.recycleItem;
            directoryStates.set(directoryKey(id, details.dataset.recycleFolder), details.open);
            if (details.open) void loadContents(details.querySelector('[data-recycle-files]'), report.items.find(item => item.id === id), previews);
            return;
        }
    }, true);
    function selectItem(item) {
        const state = { id: item.id, targetDescMd: targets.get(item.id) || '', phase: 'pending',
            ...(partSelections.has(item.id) ? { parts: [...partSelections.get(item.id)] } : {}) };
        selected.set(item.id, state);
        syncPreview(item.id);
        // 串行比较避免全选时同时争用服务端数据锁；过时的任务与响应直接丢弃。
        previewQueue = previewQueue.then(async () => {
            const isCurrent = () => (dialog.open || suspended) && selected.get(item.id) === state;
            if (!isCurrent()) return;
            try {
                if (item.kind === 'files' && item.title === '编辑日记时移除的媒体' && !item.mediaReferences?.length && !state.targetDescMd) throw new Error('请先选择要恢复到的原日记，选择后自动生成预览。');
                const capability = await detectWriterCapability();
                if (!capability.recycleDiff) throw new Error('请重启日记服务后再预览恢复差异。');
                if (!isCurrent()) return;
                const response = await fetch(new URL('api/travel-data?mode=recycle-bin', window.location.href), {
                    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(120000),
                    headers: { 'Content-Type': 'application/json', 'X-Travel-Token': capability.token },
                    body: JSON.stringify({ action: 'preview', id: item.id, targetDescMd: state.targetDescMd, parts: state.parts, revision: report.revision })
                });
                const result = await response.json();
                if (!response.ok || !Array.isArray(result.changes) || !result.previewToken) throw new Error(result.error || '无法比较恢复内容，请刷新后重试。');
                if (!isCurrent()) return;
                const changes = result.changes.map(({ record, comparison }) => ({ record, comparison: {
                    ...comparison, previousMediaPaths: new Set(comparison.previousMediaPaths), incomingMediaPaths: new Set(comparison.incomingMediaPaths)
                } }));
                Object.assign(state, { phase: 'ready', previewToken: result.previewToken, changes, savedPaths: new Set(result.savedPaths), savedFiles: new Map((result.savedFiles || []).map(file => [file.path, file.sourcePath])) });
            } catch (failure) {
                if (!isCurrent()) return;
                state.phase = 'error';
                state.message = failure.name === 'TimeoutError' ? '生成预览超时，请重试。' : failure.message;
            }
            if (isCurrent()) { syncPreview(item.id); syncControls(); }
        });
    }
    async function request(payload) {
        busy = true;
        selected.clear();
        partSelections.clear();
        error('');
        syncControls();
        const actions = { 'restore-selected': '正在恢复所选内容，请稍候…', 'purge-selected': '正在清除所选内容，请稍候…', clear: '正在清空回收站，请稍候…' };
        notice(payload ? actions[payload.action] : '正在读取回收站…');
        try {
            // 等待已发送的只读预览结束，再执行写入或刷新。
            await previewQueue;
            const capability = await detectWriterCapability();
            clearSupported = capability.recycleClear;
            selectionSupported = capability.recycleSelection;
            purgeSelectionSupported = capability.recyclePurgeSelection;
            partsSupported = capability.recycleParts;
            if (!capability.recyclePreviews) throw new Error('请重启服务器后再使用回收站预览与附件恢复。');
            if (payload?.action === 'restore-selected' && !selectionSupported) throw new Error('请重启日记服务以启用选择恢复。');
            if (payload?.action === 'purge-selected' && !purgeSelectionSupported) throw new Error('请重启日记服务以启用清除所选内容。');
            if (payload?.action === 'clear' && !clearSupported) throw new Error('服务尚未更新，请重启日记服务后再清空回收站。');
            const response = await fetch(new URL('api/travel-data?mode=recycle-bin', window.location.href), {
                credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(120000),
                ...(payload ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Travel-Token': capability.token }, body: JSON.stringify({ ...payload, revision: report.revision }) } : {})
            });
            let result;
            try { result = await response.json(); }
            catch { throw new Error('回收站返回了无法识别的结果，请刷新后重试。'); }
            if (!response.ok || !Array.isArray(result.items)) throw new Error(result.error || '无法读取回收站，请刷新后重试。');
            report = result;
            grouping = groupRecycleItems(report.items, report.currentRecords);
            stale = false;
            render();
            notice(payload?.action === 'clear' ? '回收站已清空。' : payload?.action === 'purge-selected' ? '所选内容已永久清除。' : payload?.action === 'restore-selected' ? '所选内容已恢复。' : selectionSupported ? '' : '请重启日记服务以启用选择恢复。');
            if (payload?.action === 'restore-selected') {
                try { await onRestored(); }
                catch { error('内容已恢复，页面刷新失败，请手动刷新。'); }
            }
        } catch (failure) {
            stale = true;
            if (report) render();
            error(failure.name === 'TimeoutError' ? '读取回收站超时，请刷新后重试。' : failure instanceof TypeError ? '无法连接日记服务，请检查网络后刷新回收站。' : failure.message);
            notice('操作未完成。刷新回收站后可继续操作。');
        } finally {
            busy = false;
            syncControls();
            if (payload) dialog.querySelector('[data-recycle-refresh]').focus();
        }
    }
    function close() {
        if (busy) return;
        dialog.close();
        suspended = false;
        report = undefined;
        selected.clear();
        previews.dispose();
        onClose?.();
        if (trigger?.isConnected) trigger.focus();
        else document.getElementById('journalStage')?.focus();
    }
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('input', event => {
        if (event.target.matches('[data-recycle-search]') && report && !busy) render();
    });
    dialog.addEventListener('change', event => {
        if (busy || stale) return;
        if (event.target.matches('[data-recycle-select]')) {
            const id = event.target.value;
            partSelections.delete(id);
            if (event.target.checked) selectItem(report.items.find(item => item.id === id));
            else { selected.delete(id); syncPreview(id); }
            syncControls();
        }
        if (event.target.matches('[data-recycle-part-select]')) {
            const control = event.target;
            const id = control.closest('[data-recycle-item]').dataset.recycleItem;
            const item = report.items.find(item => item.id === id);
            const groups = itemPartGroups(item);
            const keys = partSelections.get(id) || new Set(selected.has(id) ? groups.map(group => group.key) : []);
            if (control.checked) keys.add(control.value);
            else keys.delete(control.value);
            partSelections.set(id, keys);
            if (keys.size) selectItem(item);
            else { selected.delete(id); syncPreview(id); }
            syncControls();
        }
        if (event.target.matches('[data-recycle-target]')) {
            const id = event.target.dataset.recycleTarget;
            targets.set(id, event.target.value);
            if (selected.has(id)) selectItem(report.items.find(item => item.id === id));
            syncControls();
        }
    });
    async function confirmAction(message, options, payload) {
        busy = true;
        syncControls();
        try { if (await confirmFeedback(message, options)) await request(payload); }
        finally { busy = false; syncControls(); }
    }
    dialog.addEventListener('click', async event => {
        const media = event.target.closest('.recycle-contents [data-action="open-media-viewer"]');
        if (media) {
            // 展开目录的先后顺序会改变 DOM 顺序，点击时使用查看器实际读取的索引。
            media.dataset.mediaIndex = String([...media.closest('[data-media-viewer-group]').querySelectorAll('[data-action="open-media-viewer"]:not([hidden])')].indexOf(media));
            return;
        }
        if (busy) return;
        const toggle = event.target.closest('[data-recycle-toggle]');
        if (toggle) { setItemExpanded(toggle.dataset.recycleToggle, !expandedItems.has(toggle.dataset.recycleToggle)); return; }
        const recordAnchor = event.target.closest('[data-recycle-record]');
        if (recordAnchor && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
            returnFocus = recordAnchor;
            suspend();
            return;
        }
        if (event.target.closest('[data-recycle-close]')) { close(); return; }
        if (event.target.closest('[data-recycle-refresh]')) { await request(); return; }
        if (event.target.closest('[data-recycle-reset]')) { dialog.querySelector('[data-recycle-search]').value = ''; render(); dialog.querySelector('[data-recycle-search]').focus(); return; }
        if (event.target.closest('[data-recycle-none]')) { selected.clear(); partSelections.clear(); render(); return; }
        if (stale || !report) return;
        if (event.target.closest('[data-recycle-all]')) {
            filteredItems().filter(item => !selected.has(item.id)).forEach(selectItem);
            syncControls();
            return;
        }
        const retry = event.target.closest('[data-recycle-retry]');
        if (retry) { selectItem(report.items.find(item => item.id === retry.dataset.recycleRetry)); syncControls(); return; }
        if (event.target.closest('[data-recycle-restore]')) {
            if (dialog.querySelector('[data-recycle-restore]').disabled) return;
            const selections = [...selected.values()].map(({ id, targetDescMd, previewToken, parts }) => ({ id, targetDescMd, previewToken, parts }));
            const items = report.items.filter(item => selected.has(item.id));
            const snapshot = items.some(item => item.kind === 'snapshot' && !selected.get(item.id).parts);
            const partial = [...selected.values()].some(state => state.parts);
            const indexSelected = [...selected.values()].some(state => state.parts?.includes('index'));
            const hidden = items.length - filteredItems().filter(item => selected.has(item.id)).length;
            await confirmAction(`将恢复所选 ${items.length} 个项目${hidden ? `（含筛选范围外的 ${hidden} 个）` : ''}：${items.map(item => `「${item.title}」`).join('、')}。${snapshot ? '全部日记和个人资料将恢复到这个时间点，访问密码保持不变。' : ''}${indexSelected ? '将替换当前整份日记索引，回退全部日记信息和附件引用，当前索引独有的日记将从目录移除。正文、附件及个人资料按各自勾选范围恢复，原回收批次完整保留。' : partial ? '部分勾选的项目仅恢复所选日记、归档附件及个人资料，原回收批次完整保留。' : ''}被替换的当前内容会先存入回收站。`, { title: '恢复所选内容？', confirmLabel: '恢复所选内容', danger: false }, { action: 'restore-selected', selections });
            return;
        }
        if (event.target.closest('[data-recycle-clear]')) {
            if (!report.items.length || !clearSupported) return;
            await confirmAction(`将永久删除回收站中的全部 ${report.items.length} 个项目（${sizeLabel(report.totalBytes)}）。当前日记和资料保持不变，删除后无法恢复。`, { title: '清空回收站？', confirmLabel: '清空回收站' }, { action: 'clear' });
            return;
        }
        if (event.target.closest('[data-recycle-purge-selected]')) {
            if (dialog.querySelector('[data-recycle-purge-selected]').disabled) return;
            const items = report.items.filter(item => selected.has(item.id));
            const hidden = items.length - filteredItems().filter(item => selected.has(item.id)).length;
            await confirmAction(`将永久清除所选 ${items.length} 个项目${hidden ? `（含筛选范围外的 ${hidden} 个）` : ''}：${items.map(item => `「${item.title}」`).join('、')}。共 ${sizeLabel(items.flatMap(item => item.files).reduce((sum, file) => sum + file.size, 0))}，清除后无法恢复。`, { title: '清除所选内容？', confirmLabel: '清除所选内容' }, { action: 'purge-selected', ids: items.map(item => item.id) });
        }
    });
    // 跳转阅读时保留当前纸面的内容与位置，返回后重新验证会话再继续。
    function suspend() {
        if (!dialog.open) return;
        suspended = true;
        scrollPosition = { paper: dialog.scrollTop, list: dialog.querySelector('[data-recycle-list]').scrollTop };
        dialog.close();
    }
    const authorizeOpen = createPasswordGate(async () => {
        if (!isActive()) return;
        if (suspended && report) {
            suspended = false;
            dialog.showModal();
            returnFocus?.focus({ preventScroll: true });
            dialog.scrollTop = scrollPosition.paper;
            dialog.querySelector('[data-recycle-list]').scrollTop = scrollPosition.list;
            return;
        }
        trigger = document.activeElement;
        report = undefined;
        selected.clear();
        targets.clear();
        expandedItems.clear();
        expandedGroups.clear();
        partSelections.clear();
        directoryStates.clear();
        trees.clear();
        returnFocus = undefined;
        stale = true;
        dialog.querySelector('[data-recycle-search]').value = '';
        dialog.querySelector('[data-recycle-reset]').hidden = true;
        dialog.querySelector('[data-recycle-status]').textContent = '';
        dialog.querySelector('[data-recycle-list]').replaceChildren();
        dialog.showModal();
        await request();
    }, { title: '验证访问密码', description: '输入此网站的 6 位数字访问密码，查看和恢复回收站内容。', staticMessage: '静态页面不提供回收站，请使用本机服务。', onCancel: onClose });
    const open = () => { if (!dialog.open) return authorizeOpen(); };
    open.suspend = suspend;
    return open;
}
