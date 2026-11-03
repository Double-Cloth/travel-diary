import { escapeHtml } from './utils.js?v=2.1.10';
import { createPasswordGate } from './record-password.js?v=2.1.10';
import { detectWriterCapability } from './writer-capability.js?v=2.1.10';
import { confirmFeedback } from './feedback-dialog.js?v=2.1.10';
import { createContentPreviewScope, mediaKind } from './content-preview.js?v=2.1.10';
import { enhanceCustomSelects } from './custom-select.js?v=2.1.10';

function sizeLabel(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function createRecycleManager(onRestored) {
    const dialog = document.createElement('dialog');
    dialog.className = 'record-transfer recycle-manager management-dialog entry-sheet';
    dialog.setAttribute('aria-labelledby', 'recycleManagerTitle');
    dialog.innerHTML = `<div class="record-transfer-card">
        <header class="management-heading"><div><h2 id="recycleManagerTitle">回收站</h2><p>删除的内容和替换前的版本保留在这里，可预览或恢复。永久删除后无法找回。</p></div><button class="paper-button management-secondary" type="button" data-recycle-close>关闭</button></header>
        <label class="field-label" for="recycleSearch">搜索标题、类型、日记地点或文件路径</label><div class="management-search"><input id="recycleSearch" type="search" autocomplete="off" data-recycle-search placeholder="查找要恢复的内容"><button class="media-text-button" type="button" data-recycle-reset hidden>清除搜索</button></div>
        <div class="recycle-toolbar"><p data-recycle-status></p><div class="recycle-toolbar-actions"><button class="paper-button" type="button" data-recycle-refresh>刷新</button><button class="paper-button recycle-purge" type="button" data-recycle-clear disabled>清空回收站</button></div></div>
        <p class="recycle-notice" data-recycle-notice role="status" aria-live="polite"></p><p data-recycle-error role="alert"></p><ul class="recycle-list" data-recycle-list></ul></div>`;
    document.body.append(dialog);
    let report;
    let busy = false;
    let stale = true;
    let clearSupported = false;
    let trigger;
    let previews = createContentPreviewScope();
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
        dialog.querySelectorAll('[data-recycle-close], [data-recycle-refresh]').forEach(button => { button.disabled = busy; });
        dialog.querySelectorAll('[data-recycle-search], [data-recycle-reset]').forEach(control => { control.disabled = busy; });
        const clear = dialog.querySelector('[data-recycle-clear]');
        clear.disabled = busy || stale || !clearSupported || !report?.items.length;
        clear.title = clearSupported ? '' : '重启日记服务后可用';
        dialog.querySelectorAll('[data-recycle-restore], [data-recycle-purge], .recycle-target select, .recycle-target button').forEach(control => { control.disabled = busy || stale; });
        enhanceCustomSelects(dialog);
    }
    function render() {
        previews.dispose();
        previews = createContentPreviewScope();
        const items = filteredItems();
        dialog.querySelector('[data-recycle-status]').textContent = `显示 ${items.length} / ${report.items.length} 个回收项目 · 共 ${sizeLabel(report.totalBytes)}`;
        dialog.querySelector('[data-recycle-reset]').hidden = !dialog.querySelector('[data-recycle-search]').value;
        dialog.querySelector('[data-recycle-list]').innerHTML = items.length ? items.map(item => `<li>
            <div class="recycle-item-heading"><span class="recycle-kind">${types[item.kind] || '文件'}</span><time>${escapeHtml(new Date(item.createdAt).toLocaleString())}</time></div>
            <h3>${escapeHtml(item.title)}</h3><p>${item.records.length ? `${item.records.length} 篇日记 · ` : ''}${item.files.length} 个文件 · ${sizeLabel(item.files.reduce((sum, file) => sum + file.size, 0))}</p>
            ${item.kind === 'snapshot' ? '<p class="recycle-restore-note">恢复会替换全部日记和个人资料；当前数据会先存入回收站，访问密码保持不变。</p>' : item.kind === 'version' ? '<p class="recycle-restore-note">恢复到原位置；被替换的当前文件也会存入回收站。</p>' : ''}
            ${(item.records.length ? item.records : item.mediaReferences || []).map(record => `<p class="recycle-record-info">${escapeHtml([record.date, record.country, record.admin_area, record.locality].filter(Boolean).join(' · '))}</p>`).join('')}
            <details class="recycle-contents" data-recycle-contents="${item.id}"><summary>查看内容与附件 <small>${item.files.length} 个文件</small></summary><ul class="media-file-list content-preview-list" data-recycle-files data-media-viewer-group></ul></details>
            ${item.kind === 'files' && !item.mediaReferences?.length && item.files.some(file => mediaKind(file.path)) ? `<div class="recycle-target"><label class="field-label" for="recycleTarget-${item.id}">恢复到</label><select id="recycleTarget-${item.id}" data-custom-select data-recycle-target="${item.id}"><option value="">${item.title === '编辑日记时移除的媒体' ? '请选择原日记' : '仅恢复文件'}</option>${(report.currentRecords || []).map(record => `<option value="${escapeHtml(record.desc_md)}">${escapeHtml([record.date, record.locality].filter(Boolean).join(' · '))}</option>`).join('')}</select><p class="recycle-restore-note">选择日记后，同时补回附件列表；其他日记信息保持不变。</p></div>` : item.mediaReferences?.length ? '<p class="recycle-restore-note">恢复文件并补回原日记的附件列表，保留之后修改的内容。</p>' : ''}
            <div class="recycle-item-actions"><button class="paper-button recycle-purge" type="button" data-recycle-purge="${item.id}">永久删除</button><button class="paper-button" type="button" data-recycle-restore="${item.id}">恢复${item.kind === 'snapshot' ? '全部数据' : item.kind === 'version' ? '此版本' : item.kind === 'record' ? '日记' : '文件'}</button></div></li>`).join('') : `<li class="media-empty">${report.items.length ? '没有匹配的回收项目，清除搜索后可查看全部内容。' : '回收站为空。删除的内容会显示在这里。'}</li>`;
        enhanceCustomSelects(dialog);
        syncControls();
    }
    dialog.addEventListener('toggle', async event => {
        const details = event.target;
        if (!details.matches('[data-recycle-contents]') || !details.open || details.dataset.loaded) return;
        details.dataset.loaded = 'true';
        const scope = previews;
        const item = report?.items.find(item => item.id === details.dataset.recycleContents);
        const list = details.querySelector('[data-recycle-files]');
        for (const file of item?.files || []) {
            if (!details.isConnected || scope !== previews) return;
            const row = document.createElement('li');
            const url = new URL('api/travel-data?mode=recycle-file', window.location.href);
            url.searchParams.set('id', item.id);
            url.searchParams.set('path', file.path);
            try { row.append(await scope.file({ name: file.path, url: url.href, detail: `${file.path} · ${sizeLabel(file.size)}`, index: list.querySelectorAll('[data-action="open-media-viewer"]').length })); }
            catch (failure) { row.textContent = `${file.path}：${failure.message}`; }
            if (scope !== previews || !details.isConnected || !dialog.open) return;
            list.append(row);
        }
    }, true);
    async function request(payload) {
        busy = true;
        error('');
        syncControls();
        const actions = { restore: '正在恢复，请稍候…', purge: '正在永久删除，请稍候…', clear: '正在清空回收站，请稍候…' };
        notice(payload ? actions[payload.action] : '正在读取回收站…');
        try {
            const capability = await detectWriterCapability();
            clearSupported = capability.recycleClear;
            if (!capability.recyclePreviews) throw new Error('请重启服务器后再使用回收站预览与附件恢复。');
            if (payload?.action === 'clear' && !capability.recycleClear) throw new Error('服务尚未更新，请重启日记服务后再清空回收站。');
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
            notice(payload?.action === 'clear' ? '回收站已清空。' : payload?.action === 'purge' ? '已永久删除这个项目。' : payload?.action === 'restore' ? '内容已恢复。' : clearSupported ? '' : '请重启日记服务以启用「清空回收站」。');
            if (payload?.action === 'restore') {
                try { await onRestored(); }
                catch { error('内容已恢复，页面刷新失败，请手动刷新。'); }
            }
        } catch (failure) {
            stale = true;
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
        previews.dispose();
        if (trigger?.isConnected) trigger.focus();
        else document.getElementById('journalStage')?.focus();
    }
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('input', event => {
        if (event.target.matches('[data-recycle-search]') && report && !busy) render();
    });
    dialog.addEventListener('click', async event => {
        if (busy) return;
        if (event.target.closest('[data-recycle-close]')) { close(); return; }
        if (event.target.closest('[data-recycle-refresh]')) { await request(); return; }
        if (event.target.closest('[data-recycle-reset]')) { dialog.querySelector('[data-recycle-search]').value = ''; render(); dialog.querySelector('[data-recycle-search]').focus(); return; }
        if (event.target.closest('[data-recycle-clear]')) {
            if (stale || !report?.items.length) return;
            busy = true;
            try {
                if (await confirmFeedback(`将永久删除回收站中的全部 ${report.items.length} 个项目（${sizeLabel(report.totalBytes)}）。当前日记和资料保持不变，删除后无法恢复。`, { title: '清空回收站？', confirmLabel: '清空回收站' })) {
                    await request({ action: 'clear' });
                }
            } finally { busy = false; }
            return;
        }
        const button = event.target.closest('[data-recycle-restore], [data-recycle-purge]');
        if (!button || !report || stale) return;
        const purge = Boolean(button.dataset.recyclePurge);
        const id = button.dataset.recyclePurge || button.dataset.recycleRestore;
        const item = report.items.find(item => item.id === id);
        if (!item) return;
        const targetDescMd = dialog.querySelector(`[data-recycle-target="${id}"]`)?.value;
        if (!purge && item.kind === 'files' && item.title === '编辑日记时移除的媒体' && !item.mediaReferences?.length && !targetDescMd) {
            error('这份旧媒体未保存日记关联，请先选择原日记。');
            dialog.querySelector(`#recycleTarget-${id}Button`)?.focus();
            return;
        }
        const message = purge ? `将永久删除「${item.title}」及其中的 ${item.files.length} 个文件，删除后无法恢复。`
            : item.kind === 'snapshot' ? '将全部日记和个人资料恢复到这个时间点。当前数据会先存入回收站；访问密码保持不变。'
                : item.kind === 'version' ? '将文件恢复到原位置，被替换的当前文件会先存入回收站。'
                    : item.kind === 'record' ? '将日记和附件恢复到原位置。遇到同名但内容不同的文件时会停止，不会覆盖。'
                        : targetDescMd || item.mediaReferences?.length ? '将文件恢复到原位置，并补回对应日记的附件列表。日记中之后修改的内容保持不变。'
                            : '仅将文件恢复到原位置，不修改日记内容。';
        busy = true;
        try {
            if (await confirmFeedback(message, { title: purge ? '永久删除这个项目？' : '恢复这个项目？', confirmLabel: purge ? '永久删除' : '恢复', danger: purge })) {
                await request({ action: purge ? 'purge' : 'restore', id, ...(targetDescMd ? { targetDescMd } : {}) });
            }
        } finally { busy = false; }
    });
    return createPasswordGate(async () => {
        trigger = document.activeElement;
        report = undefined;
        stale = true;
        dialog.querySelector('[data-recycle-search]').value = '';
        dialog.querySelector('[data-recycle-reset]').hidden = true;
        dialog.querySelector('[data-recycle-status]').textContent = '';
        dialog.querySelector('[data-recycle-list]').replaceChildren();
        dialog.showModal();
        await request();
    }, { title: '验证访问密码', description: '输入此网站的 6 位数字访问密码，查看和恢复回收站内容。', staticMessage: '静态页面不提供回收站，请使用本机服务。' });
}
