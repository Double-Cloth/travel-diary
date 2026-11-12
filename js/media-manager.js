import { escapeHtml, getMediaFileUrl } from './utils.js?v=2.1.112';
import { createPasswordGate } from './record-password.js?v=2.1.112';
import { detectWriterCapability } from './writer-capability.js?v=2.1.112';
import { createMediaFileLink, showMediaFilePreviewError } from './media-file-link.js?v=2.1.112';
import { enhanceCustomSelects } from './custom-select.js?v=2.1.112';

function sizeLabel(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function createMediaManager(onReferencesRemoved = async () => {}) {
    const dialog = document.createElement('dialog');
    dialog.className = 'record-transfer media-manager management-dialog entry-sheet';
    dialog.setAttribute('aria-labelledby', 'mediaManagerTitle');
    dialog.innerHTML = `<div class="record-transfer-card">
        <header class="management-heading"><div><h2 id="mediaManagerTitle">媒体整理</h2><p>查看文件的使用情况，整理不再需要的图片和视频。</p></div><button class="paper-button management-secondary" type="button" data-media-close>关闭</button></header>
        <p class="media-manager-status" data-media-summary role="status" aria-live="polite"></p>
        <dl class="media-space-summary" data-media-space hidden></dl>
        <div class="media-manager-navigation"><h3 id="mediaFilesTitle">文件检查</h3><button class="media-text-button" type="button" data-media-refresh>重新检查</button></div>
        <section id="mediaFilesPanel" class="media-files-section" aria-labelledby="mediaFilesTitle">
        <div class="media-manager-filters">
            <div class="media-filter-field"><label for="mediaFilterButton" class="field-label">查看</label><select id="mediaFilter" data-custom-select data-media-filter aria-label="文件分类"><option value="unused">未被日记使用</option><option value="missing">日记中的缺失文件</option><option value="shared">多篇日记共用</option><option value="all">全部现有文件</option></select></div>
            <div class="media-filter-field"><label class="field-label" for="mediaSearch">搜索文件名、路径或日记地点</label><div class="management-search"><input id="mediaSearch" type="search" autocomplete="off" data-media-search placeholder="筛选当前分类的文件"><button class="media-text-button" type="button" data-media-reset hidden>清除搜索</button></div></div>
        </div>
        <p class="media-filter-hint" data-media-hint></p>
        <div class="media-selection-tools" data-media-select-tools><button class="paper-button management-secondary" type="button" data-media-all>全选可选结果</button><button class="paper-button management-secondary" type="button" data-media-clear disabled>清空全部选择</button></div>
        <ul class="record-transfer-list media-file-list" data-media-list data-media-viewer-group aria-label="媒体文件"></ul></section>
        <p data-media-error role="alert"></p>
        <div class="management-footer media-selection" data-media-selection><p data-media-count role="status" aria-live="polite"></p><button class="paper-button" type="button" data-media-trash disabled>移入回收站</button><p class="media-selection-note">移入后仍占用空间，可在工具箱的回收站恢复或永久删除。</p></div></div>`;
    document.body.append(dialog);
    enhanceCustomSelects(dialog);
    let report;
    let capability;
    let trigger;
    let busy = false;
    let stale = true;
    const selected = new Set();
    const selectedMissing = new Set();
    const isMissing = () => dialog.querySelector('[data-media-filter]').value === 'missing';
    const currentSelection = () => isMissing() ? selectedMissing : selected;
    const selectable = file => isMissing() ? capability?.mediaReferenceRemoval : !file.records.length;
    const error = message => { dialog.querySelector('[data-media-error]').textContent = message; };
    const owners = file => file.records.map(record => `<a href="#entry?id=${encodeURIComponent(record.record_id)}" data-media-record>${escapeHtml(record.date)} ${escapeHtml(record.locality)}</a>`).join('、');

    function filteredFiles() {
        if (!report) return [];
        const filter = dialog.querySelector('[data-media-filter]').value;
        const query = dialog.querySelector('[data-media-search]').value.trim().toLowerCase();
        return (filter === 'missing' ? report.missing : report.files.filter(file => filter === 'all' || (filter === 'shared' ? file.records.length > 1 : !file.records.length)))
            .filter(file => [file.path, ...file.records.flatMap(record => [record.date, record.locality])].some(value => String(value || '').toLowerCase().includes(query)));
    }

    function syncControls() {
        dialog.setAttribute('aria-busy', String(busy));
        dialog.querySelectorAll('button, input, select').forEach(element => { element.disabled = busy; });
        dialog.querySelectorAll('[data-media-path]').forEach(element => { element.disabled = busy || stale || element.dataset.mediaUnavailable === 'true'; });
        if (report) count();
        else dialog.querySelectorAll('[data-media-all], [data-media-clear], [data-media-trash]').forEach(element => { element.disabled = true; });
        enhanceCustomSelects(dialog);
    }

    function count() {
        const selection = currentSelection();
        const missing = isMissing();
        const files = (missing ? report.missing : report.files).filter(file => selection.has(file.path));
        const visible = filteredFiles();
        const hidden = files.length - visible.filter(file => selection.has(file.path)).length;
        dialog.querySelector('[data-media-count]').textContent = `显示 ${visible.length} 个 · 已选 ${files.length} 个${missing ? '缺失文件' : '文件'}${hidden ? `（含筛选外 ${hidden} 个）` : ''}${missing ? '' : ` · ${sizeLabel(files.reduce((sum, file) => sum + file.size, 0))}`}`;
        const action = dialog.querySelector('[data-media-trash]');
        action.textContent = missing ? '删除所选引用' : '移入回收站';
        action.disabled = !files.length || busy || stale || (missing && !capability?.mediaReferenceRemoval);
        dialog.querySelector('.media-selection-note').textContent = missing ? '从所有关联日记中删除所选缺失文件的引用，保留其他附件及正文。' : '移入后仍占用空间，可在工具箱的回收站恢复或永久删除。';
        dialog.querySelector('[data-media-clear]').disabled = !(selected.size || selectedMissing.size) || busy;
        dialog.querySelector('[data-media-all]').disabled = busy || stale || !visible.some(file => selectable(file) && !selection.has(file.path));
        dialog.querySelector('[data-media-reset]').hidden = !dialog.querySelector('[data-media-search]').value;
    }

    function render() {
        const available = new Set(report.files.filter(file => !file.records.length).map(file => file.path));
        for (const path of selected) if (!available.has(path)) selected.delete(path);
        const missing = new Set(report.missing.map(file => file.path));
        for (const path of selectedMissing) if (!missing.has(path)) selectedMissing.delete(path);
        dialog.querySelector('[data-media-summary]').textContent = `已检查 ${report.files.length} 个现有文件${report.missing.length ? ` · 日记中有 ${report.missing.length} 个文件找不到` : ' · 日记引用的文件均存在'}`;
        const space = dialog.querySelector('[data-media-space]');
        space.hidden = false;
        space.innerHTML = [['媒体文件占用', report.totalBytes], ['可整理的未使用文件', report.unusedBytes]].map(([label, bytes]) => `<div><dt>${label}</dt><dd>${sizeLabel(bytes)}</dd></div>`).join('');
        const counts = { unused: report.files.filter(file => !file.records.length).length, missing: report.missing.length, shared: report.files.filter(file => file.records.length > 1).length, all: report.files.length };
        const labels = { unused: '未被日记使用', missing: '日记中的缺失文件', shared: '多篇日记共用', all: '全部现有文件' };
        for (const option of dialog.querySelector('[data-media-filter]').options) option.textContent = `${labels[option.value]}（${counts[option.value]}）`;
        renderFiles();
        count();
        enhanceCustomSelects(dialog);
    }

    function renderFiles() {
        const filter = dialog.querySelector('[data-media-filter]').value;
        dialog.querySelector('[data-media-hint]').textContent = {
            unused: `以下文件没有被任何日记使用，共 ${sizeLabel(report.unusedBytes)}。`,
            missing: '日记引用了这些文件，但文件已不存在。'
                + (capability?.mediaReferenceRemoval ? '' : '请重启日记服务以启用删除引用。'),
            shared: '这些文件仍被多篇日记使用，不能清理。',
            all: '已被日记使用的文件仅供查看；未被日记使用的文件可以勾选清理。'
        }[filter];
        const files = filteredFiles();
        let mediaIndex = 0;
        const rows = files.map(file => {
            const row = document.createElement('li');
            row.className = 'media-health-file';
            if (filter === 'shared') row.classList.add('media-health-file-readonly');
            else {
                const selection = document.createElement('label');
                const available = selectable(file);
                selection.innerHTML = `<input type="checkbox" data-media-path data-media-unavailable="${!available}" value="${escapeHtml(file.path)}"${currentSelection().has(file.path) ? ' checked' : ''}${available ? '' : ' disabled'}><span class="sr-only">${available ? '选择' : '不可选择'} ${escapeHtml(file.path)}</span>`;
                if (!available) selection.title = filter === 'missing' ? '请重启日记服务以启用删除引用' : '文件仍被日记使用，不能清理';
                row.append(selection);
            }
            const content = document.createElement('div');
            const missing = filter === 'missing';
            const url = missing ? '' : getMediaFileUrl(file.path);
            const link = createMediaFileLink({
                path: file.path, src: url, name: file.path.split('/').at(-1),
                kind: file.path.startsWith('data/videos/') ? 'video' : 'image', index: mediaIndex,
                detail: missing ? `${file.path} · 文件缺失` : `${file.path} · ${sizeLabel(file.size)}`
            });
            if (url) mediaIndex++;
            else {
                link.querySelector('.media-file-detail').textContent = `${file.path} · ${missing ? '文件缺失' : '路径无效'}`;
                showMediaFilePreviewError(link, missing ? '文件缺失' : '无法预览');
            }
            const references = document.createElement('small');
            references.innerHTML = file.records.length ? owners(file) : '未被日记使用';
            content.append(link, references);
            row.append(content);
            return row;
        });
        const list = dialog.querySelector('[data-media-list]');
        list.replaceChildren(...rows);
        if (!files.length) list.innerHTML = `<li class="media-empty">${dialog.querySelector('[data-media-search]').value.trim() ? '没有匹配的文件，请清除搜索或切换分类。' : filter === 'unused' ? '没有未被日记使用的文件，无需清理。' : filter === 'missing' ? '没有缺失文件。' : filter === 'shared' ? '没有多篇共用的文件。' : '还没有图片或视频。'}</li>`;
        const canSelect = filter !== 'shared' && (currentSelection().size > 0 || files.some(selectable));
        dialog.querySelector('[data-media-selection]').hidden = !canSelect;
        dialog.querySelector('[data-media-select-tools]').hidden = !canSelect;
        count();
    }

    async function request(payload) {
        busy = true;
        error('');
        syncControls();
        dialog.querySelector('[data-media-summary]').textContent = payload ? '正在处理媒体文件…' : '正在检查媒体文件和引用…';
        try {
            capability = await detectWriterCapability();
            if (!capability.recordManagement) throw new Error('请重启服务器后再使用媒体整理。');
            if (payload?.action === 'remove-missing' && !capability.mediaReferenceRemoval) throw new Error('请重启日记服务后再删除缺失文件的引用。');
            const response = await fetch(new URL('api/travel-data?mode=media-health', window.location.href), {
                credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(120000), ...(payload ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Travel-Token': capability.token }, body: JSON.stringify({ ...payload, revision: report.revision }) } : {})
            });
            let result;
            try { result = await response.json(); }
            catch { throw new Error('媒体检查返回了无法识别的结果，请重新检查后再试。'); }
            if (!response.ok || !Array.isArray(result.files)) throw new Error(result.error || '文件检查失败，请重试。');
            report = result;
            stale = false;
            render();
            if (payload?.action === 'trash') dialog.querySelector('[data-media-summary]').textContent = '已移入回收站，可从日记工具箱打开回收站恢复。';
            if (payload?.action === 'remove-missing') {
                dialog.querySelector('[data-media-summary]').textContent = `已从所有关联日记中删除 ${payload.paths.length} 个缺失文件的引用。`;
                try { await onReferencesRemoved(); }
                catch { error('引用已删除，但页面数据刷新失败，请手动刷新页面。'); }
            }
        } catch (failure) {
            stale = true;
            error(failure.name === 'TimeoutError' ? '媒体检查超时，请重新检查后再试。' : failure instanceof TypeError ? '无法连接日记服务，请检查网络后重新检查。' : failure.message);
            dialog.querySelector('[data-media-summary]').textContent = '操作未完成，请重新检查后再试。';
        } finally {
            busy = false;
            syncControls();
            if (payload) dialog.querySelector('[data-media-refresh]').focus();
        }
    }

    function close() {
        if (busy) return;
        dialog.close();
        if (trigger?.isConnected) trigger.focus();
        else document.getElementById('journalStage')?.focus();
    }
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('change', event => {
        if (busy) return;
        if (event.target.matches('[data-media-filter]') && report) { renderFiles(); syncControls(); }
        if (event.target.matches('[data-media-path]')) {
            const selection = currentSelection();
            if (event.target.checked) selection.add(event.target.value); else selection.delete(event.target.value);
            count();
        }
    });
    dialog.addEventListener('input', event => {
        if (event.target.matches('[data-media-search]') && report && !busy) { renderFiles(); syncControls(); }
    });
    dialog.addEventListener('click', async event => {
        if (busy) return;
        if (event.target.closest('[data-media-close]')) { close(); return; }
        if (event.target.closest('[data-media-record]') && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { close(); return; }
        if (event.target.closest('[data-media-refresh]')) { await request(); return; }
        if (!report) return;
        if (event.target.closest('[data-media-reset]')) { dialog.querySelector('[data-media-search]').value = ''; renderFiles(); dialog.querySelector('[data-media-search]').focus(); }
        if (event.target.closest('[data-media-all]') && !stale) { filteredFiles().filter(selectable).forEach(file => currentSelection().add(file.path)); renderFiles(); count(); }
        if (event.target.closest('[data-media-clear]')) { selected.clear(); selectedMissing.clear(); renderFiles(); count(); }
        let payload;
        if (event.target.closest('[data-media-trash]') && currentSelection().size && !stale) {
            payload = { action: isMissing() ? 'remove-missing' : 'trash', paths: [...currentSelection()] };
        }
        if (payload) {
            await request(payload);
        }
    });
    return createPasswordGate(async () => {
        trigger = document.activeElement;
        report = undefined;
        stale = true;
        selected.clear();
        selectedMissing.clear();
        dialog.querySelector('[data-media-search]').value = '';
        dialog.querySelector('[data-media-reset]').hidden = true;
        dialog.querySelector('[data-media-filter]').value = 'unused';
        dialog.querySelector('[data-media-space]').hidden = true;
        dialog.querySelector('[data-media-selection]').hidden = true;
        dialog.querySelector('[data-media-select-tools]').hidden = true;
        for (const selector of ['[data-media-list]', '[data-media-count]', '[data-media-hint]']) dialog.querySelector(selector).textContent = '';
        dialog.showModal();
        await request();
    }, { title: '验证访问密码', description: '输入此网站现在使用的 6 位数字访问密码，整理媒体文件。', staticMessage: '静态页面不提供媒体整理，请使用本机服务。' });
}
