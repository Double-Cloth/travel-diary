import { escapeHtml, getMediaFileUrl } from './utils.js?v=2.1.77';
import { createPasswordGate } from './record-password.js?v=2.1.77';
import { detectWriterCapability } from './writer-capability.js?v=2.1.77';
import { confirmFeedback } from './feedback-dialog.js?v=2.1.77';
import { createContentPreviewScope, mediaKind } from './content-preview.js?v=2.1.77';
import { enhanceCustomSelects } from './custom-select.js?v=2.1.77';
import { renderRecordDifference, loadDifferenceMedia } from './record-diff-view.js?v=2.1.77';
import { recordIdentity } from './record-identity.mjs?v=2.1.77';

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

export function createRecycleManager(onRestored, { onClose, isActive = () => true } = {}) {
    const dialog = document.createElement('dialog');
    dialog.className = 'record-transfer recycle-manager management-dialog entry-sheet';
    dialog.setAttribute('aria-labelledby', 'recycleManagerTitle');
    dialog.innerHTML = `<div class="record-transfer-card">
        <header class="management-heading"><div><h2 id="recycleManagerTitle">回收站</h2><p>勾选内容后，可预览恢复变化、恢复或永久清除。</p></div><button class="paper-button management-secondary" type="button" data-recycle-close>关闭</button></header>
        <div class="recycle-toolbar"><p data-recycle-status></p><div class="recycle-toolbar-actions"><button class="paper-button management-secondary" type="button" data-recycle-refresh>刷新</button><button class="paper-button recycle-purge" type="button" data-recycle-clear disabled>清空回收站</button></div></div>
        <div class="recycle-filter-bar"><div class="recycle-search-field"><label class="field-label" for="recycleSearch">筛选回收内容</label><div class="management-search"><input id="recycleSearch" type="search" autocomplete="off" data-recycle-search placeholder="搜索标题、类型、地点或文件路径"><button class="media-text-button" type="button" data-recycle-reset hidden>清除搜索</button></div></div><div class="media-selection-tools"><button class="paper-button management-secondary" type="button" data-recycle-all disabled>全选当前结果</button><button class="paper-button management-secondary" type="button" data-recycle-none disabled>全不选</button></div></div>
        <p class="recycle-notice" data-recycle-notice role="status" aria-live="polite"></p><p data-recycle-error role="alert"></p>
        <ul class="recycle-list" data-recycle-list></ul>
        <footer class="management-footer recycle-selection"><p data-recycle-count role="status" aria-live="polite">尚未选择内容</p><div class="recycle-selection-actions"><button class="paper-button" type="button" data-recycle-restore disabled>恢复所选内容</button><button class="paper-button recycle-purge" type="button" data-recycle-purge-selected disabled>清除所选内容</button></div><p class="recycle-selection-note" data-recycle-selection-note>恢复前可展开预览；清除所选内容后无法找回。</p></footer></div>`;
    document.body.append(dialog);
    let report;
    let busy = false;
    let stale = true;
    let clearSupported = false;
    let selectionSupported = false;
    let purgeSelectionSupported = false;
    let trigger;
    let previews = createContentPreviewScope();
    let previewQueue = Promise.resolve();
    const selected = new Map();
    const targets = new Map();
    const expandedItems = new Set();
    let suspended = false;
    let scrollTop = 0;
    let returnFocus;
    const error = message => { dialog.querySelector('[data-recycle-error]').textContent = message; };
    const notice = message => { dialog.querySelector('[data-recycle-notice]').textContent = message; };
    const types = { record: '日记', files: '文件', version: '旧版本', snapshot: '整站数据' };
    function filteredItems() {
        const query = dialog.querySelector('[data-recycle-search]').value.trim().toLowerCase();
        return (report?.items || []).filter(item => [item.title, types[item.kind], new Date(item.createdAt).toLocaleString(),
            ...item.files.map(file => file.path), ...(item.records.length ? item.records : item.mediaReferences || []).flatMap(record => [record.date, record.country, record.admin_area, record.locality])]
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
        dialog.querySelector('[data-recycle-all]').disabled = busy || stale || !selectionSupported || !filteredItems().some(item => !selected.has(item.id));
        dialog.querySelector('[data-recycle-none]').disabled = busy || !selected.size;
        dialog.querySelector('[data-recycle-purge-selected]').disabled = busy || stale || !purgeSelectionSupported || !selected.size;
        dialog.querySelector('[data-recycle-purge-selected]').title = purgeSelectionSupported ? '' : '重启日记服务后可用';
        const items = (report?.items || []).filter(item => selected.has(item.id));
        const hidden = items.length - filteredItems().filter(item => selected.has(item.id)).length;
        const pending = [...selected.values()].filter(state => state.phase === 'pending').length;
        const failed = [...selected.values()].filter(state => state.phase === 'error').length;
        const exclusive = items.length > 1 && items.some(item => item.kind === 'snapshot' || item.files.some(file => file.path === 'data/travel_data.json'));
        dialog.querySelector('[data-recycle-count]').textContent = items.length ? `已选 ${items.length} 个项目${hidden ? `（含筛选外 ${hidden} 个）` : ''} · ${sizeLabel(items.flatMap(item => item.files).reduce((sum, file) => sum + file.size, 0))}${pending ? ` · 正在生成 ${pending} 项预览` : failed ? ` · ${failed} 项需处理` : ''}` : '尚未选择内容';
        dialog.querySelector('[data-recycle-restore]').disabled = busy || stale || !selectionSupported || !items.length || pending > 0 || failed > 0 || exclusive;
        const selectionNote = dialog.querySelector('[data-recycle-selection-note]');
        selectionNote.dataset.recycleSelectionIssue = String(exclusive || failed > 0);
        selectionNote.textContent = exclusive ? '整站数据或包含日记目录的旧版本需要单独恢复；仍可清除所选内容。' : failed ? '请处理所选项目中的提示，预览全部就绪后才能恢复；仍可清除所选内容。' : '恢复前可展开预览；清除所选内容后无法找回。';
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
        return `<details class="recycle-restore-preview"><summary>预览恢复后的变化 <small>${state.changes.length ? `${state.changes.length} 项内容` : '内容相同'}</small></summary><div class="recycle-preview-body">${state.changes.length ? `<p class="recycle-restore-note">以下为这个项目恢复后的变化。确认恢复后才会写入。</p>${state.changes.map(({ record }) => `<div class="recycle-preview-change"><p class="recycle-preview-path" title="${escapeHtml(record.desc_md)}">${recordLink(record, restoreChangeTitle(record, state.comparisons.get(record.desc_md)), state.comparisons.get(record.desc_md)?.previous)}</p>${renderRecordDifference(record, state.comparisons.get(record.desc_md), {
            afterLabel: '恢复后', note: '', previewLabel: '预览恢复后的正文', collapsible: state.changes.length > 1, mediaLink: (name, side) => mediaLink(name, side, state)
        })}</div>`).join('')}` : '<p class="recycle-restore-note">回收内容与当前内容一致，无需恢复。</p>'}</div></details>`;
    }
    function currentRecord(record, previous) {
        return report.currentRecords?.find(candidate => [record, previous].some(value => value && (recordIdentity(value) === recordIdentity(candidate) || value.desc_md === candidate.desc_md)));
    }
    function recordLink(record, label = record.desc_md, previous) {
        const current = currentRecord(record, previous);
        if (current) return `<a href="#entry?id=${encodeURIComponent(recordIdentity(current))}&from=recycle" data-recycle-record>${escapeHtml(label)}</a>`;
        return escapeHtml(label);
    }
    function mediaLink(name, side, state) {
        if (!mediaKind(name)) return escapeHtml(name);
        const url = side === 'after' && state.savedPaths.has(name) ? recycleUrl(state.id, state.savedFiles.get(name) || name) : getMediaFileUrl(name);
        return `<a href="${escapeHtml(url)}" data-action="open-media-viewer" data-media-src="${escapeHtml(url)}" data-media-name="${escapeHtml(name)}" data-media-alt="${escapeHtml(name)}" data-media-kind="${mediaKind(name)}" data-media-index="0">${escapeHtml(name)}</a>`;
    }
    function contentsMarkup(item) {
        const diaries = item.files.filter(file => /\.md$/i.test(file.path));
        const attachments = item.files.filter(file => !/\.md$/i.test(file.path));
        const list = category => `<ul class="media-file-list content-preview-list" data-recycle-files="${item.id}" data-recycle-category="${category}" data-media-viewer-group></ul>`;
        const fold = diaries.length > 0 && attachments.length > 0;
        return `<div class="recycle-contents">${diaries.length ? list('diaries') : ''}${attachments.length ? fold ? `<details class="recycle-attachments"><summary><span>查看媒体与附件</span><small>${attachments.length} 个文件</small></summary>${list('attachments')}</details>` : list('attachments') : ''}</div>`;
    }
    async function loadContents(list, item, scope) {
        const diaries = item.files.filter(file => /\.md$/i.test(file.path));
        const fold = diaries.length > 1 || (diaries.length > 0 && diaries.length < item.files.length);
        for (const file of item.files) {
            if (/\.md$/i.test(file.path) !== (list.dataset.recycleCategory === 'diaries')) continue;
            if (!list.isConnected || scope !== previews) return;
            const row = document.createElement('li');
            row.title = file.path;
            try { row.append(await scope.file({ name: file.path, url: recycleUrl(item.id, file.path), detail: mediaKind(file.path) ? `${file.path} · ${sizeLabel(file.size)}` : sizeLabel(file.size), index: list.querySelectorAll('[data-action="open-media-viewer"]').length, collapsible: fold })); }
            catch (failure) { row.textContent = `${file.path}：${failure.message}`; }
            if (scope !== previews || !list.isConnected || (!dialog.open && !suspended)) return;
            if (/\.md$/i.test(file.path)) {
                const label = row.querySelector('.content-file-preview > summary > span, .content-file-heading > span');
                if (label) label.innerHTML = `${recordLink({ desc_md: file.path }, file.path.split('/').pop())} · ${sizeLabel(file.size)}`;
            }
            list.append(row);
        }
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
    }
    function render() {
        previews.dispose();
        previews = createContentPreviewScope();
        const items = filteredItems();
        dialog.querySelector('[data-recycle-status]').textContent = `显示 ${items.length} / ${report.items.length} 个回收项目 · 共 ${sizeLabel(report.totalBytes)}`;
        dialog.querySelector('[data-recycle-reset]').hidden = !dialog.querySelector('[data-recycle-search]').value;
        dialog.querySelector('[data-recycle-list]').innerHTML = items.length ? items.map(item => `<li data-recycle-item="${item.id}">
            <div class="recycle-item-header">
            <label class="recycle-item-choice"><input type="checkbox" data-recycle-select value="${item.id}" aria-label="选择 ${escapeHtml(item.title)}"><strong>${escapeHtml(item.title)}</strong></label>
            <button class="media-text-button recycle-item-toggle" type="button" data-recycle-toggle="${item.id}" aria-controls="recycleBody-${item.id}" aria-expanded="${expandedItems.has(item.id)}" aria-label="${expandedItems.has(item.id) ? '收起' : '展开'} ${escapeHtml(item.title)}">${expandedItems.has(item.id) ? '收起' : '展开'}</button>
            <small class="recycle-item-meta"><span>${types[item.kind] || '文件'}</span>${item.records.length ? `<span>${item.records.length} 篇日记</span>` : ''}<span>${item.files.length} 个文件</span><span>${sizeLabel(item.files.reduce((sum, file) => sum + file.size, 0))}</span><time>${escapeHtml(new Date(item.createdAt).toLocaleString())}</time></small></div>
            <div class="recycle-item-body" id="recycleBody-${item.id}"${expandedItems.has(item.id) ? '' : ' hidden'}>
            ${item.kind === 'snapshot' ? '<p class="recycle-restore-note">恢复会替换全部日记和个人资料；当前数据会先存入回收站，访问密码保持不变。请单独选择此项恢复。</p>' : item.kind === 'version' ? '<p class="recycle-restore-note">恢复到原位置；被替换的当前文件也会存入回收站。</p>' : ''}
            ${(item.records.length ? item.records : item.mediaReferences || []).map(record => `<p class="recycle-record-info">${recordLink(record, [record.date, record.country, record.admin_area, record.locality].filter(Boolean).join(' · '))}</p>`).join('')}
            ${contentsMarkup(item)}
            ${item.kind === 'files' && !item.mediaReferences?.length && item.files.some(file => mediaKind(file.path)) ? `<div class="recycle-target" data-recycle-selected-only${selected.has(item.id) ? '' : ' hidden'}><label class="field-label" for="recycleTarget-${item.id}">恢复到</label><select id="recycleTarget-${item.id}" data-custom-select data-recycle-target="${item.id}"><option value="">${item.title === '编辑日记时移除的媒体' ? '请选择原日记' : '仅恢复文件'}</option>${(report.currentRecords || []).map(record => `<option value="${escapeHtml(record.desc_md)}"${targets.get(item.id) === record.desc_md ? ' selected' : ''}>${escapeHtml([record.date, record.locality].filter(Boolean).join(' · '))}</option>`).join('')}</select><p class="recycle-restore-note">选择日记后，同时补回附件列表；其他日记信息保持不变。</p><p class="recycle-target-link" data-recycle-target-link></p></div>` : item.mediaReferences?.length ? '<p class="recycle-restore-note">恢复文件并补回原日记的附件列表，保留之后修改的内容。</p>' : ''}
            <div data-recycle-diff="${item.id}"${selected.has(item.id) ? '' : ' hidden'}>${previewMarkup(selected.get(item.id))}</div>
            </div></li>`).join('') : `<li class="media-empty">${report.items.length ? '没有匹配的回收项目，清除搜索后可查看全部内容。' : '回收站为空。删除的内容会显示在这里。'}</li>`;
        dialog.querySelectorAll('[data-recycle-files]').forEach(list => { void loadContents(list, report.items.find(item => item.id === list.dataset.recycleFiles), previews); });
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
        const differences = details.matches('[data-diff-record]') ? [details] : details.matches('.recycle-restore-preview') && details.open ? [...details.querySelectorAll('section[data-diff-record]')] : [];
        for (const difference of differences) {
            const id = details.closest('[data-recycle-item]').dataset.recycleItem;
            const state = selected.get(id);
            const scope = previews;
            await loadDifferenceMedia(difference, state?.comparisons?.get(difference.dataset.diffRecord), scope, (name, side) => ({
                url: side === 'after' && state.savedPaths.has(name) ? recycleUrl(id, state.savedFiles.get(name) || name) : getMediaFileUrl(name)
            }), () => scope === previews && state === selected.get(id));
        }
    }, true);
    function selectItem(item) {
        const state = { id: item.id, targetDescMd: targets.get(item.id) || '', phase: 'pending' };
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
                    body: JSON.stringify({ action: 'preview', id: item.id, targetDescMd: state.targetDescMd, revision: report.revision })
                });
                const result = await response.json();
                if (!response.ok || !Array.isArray(result.changes) || !result.previewToken) throw new Error(result.error || '无法比较恢复内容，请刷新后重试。');
                if (!isCurrent()) return;
                Object.assign(state, { phase: 'ready', previewToken: result.previewToken, changes: result.changes, savedPaths: new Set(result.savedPaths), savedFiles: new Map((result.savedFiles || []).map(file => [file.path, file.sourcePath])), comparisons: new Map(result.changes.map(({ record, comparison }) => [record.desc_md, {
                    ...comparison, previousMediaPaths: new Set(comparison.previousMediaPaths), incomingMediaPaths: new Set(comparison.incomingMediaPaths)
                }])) });
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
            if (event.target.checked) selectItem(report.items.find(item => item.id === id));
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
        if (event.target.closest('[data-recycle-none]')) { selected.clear(); render(); return; }
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
            const selections = [...selected.values()].map(({ id, targetDescMd, previewToken }) => ({ id, targetDescMd, previewToken }));
            const items = report.items.filter(item => selected.has(item.id));
            const snapshot = items.some(item => item.kind === 'snapshot');
            const hidden = items.length - filteredItems().filter(item => selected.has(item.id)).length;
            await confirmAction(`将恢复所选 ${items.length} 个项目${hidden ? `（含筛选范围外的 ${hidden} 个）` : ''}：${items.map(item => `「${item.title}」`).join('、')}。${snapshot ? '全部日记和个人资料将恢复到这个时间点，访问密码保持不变。' : ''}被替换的当前内容会先存入回收站。`, { title: '恢复所选内容？', confirmLabel: '恢复所选内容', danger: false }, { action: 'restore-selected', selections });
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
        scrollTop = dialog.scrollTop;
        dialog.close();
    }
    const authorizeOpen = createPasswordGate(async () => {
        if (!isActive()) return;
        if (suspended && report) {
            suspended = false;
            dialog.showModal();
            returnFocus?.focus({ preventScroll: true });
            dialog.scrollTop = scrollTop;
            return;
        }
        trigger = document.activeElement;
        report = undefined;
        selected.clear();
        targets.clear();
        expandedItems.clear();
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
