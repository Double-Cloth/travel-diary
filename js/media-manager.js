import { escapeHtml, getMediaFileUrl } from './utils.js';
import { createPasswordGate } from './record-password.js?v=20261103-record-management-v1';
import { detectWriterCapability } from './writer-capability.js?v=20261103-record-management-v1';
import { confirmFeedback } from './feedback-dialog.js?v=20261102-native-preview-v1';
import { enhanceCustomSelects } from './custom-select.js?v=20261018-select-scroll-focus-v1';

function sizeLabel(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function createMediaManager() {
    const dialog = document.createElement('dialog');
    dialog.className = 'record-transfer media-manager entry-sheet';
    dialog.setAttribute('aria-labelledby', 'mediaManagerTitle');
    dialog.innerHTML = `<div class="record-transfer-card">
        <header class="media-manager-heading"><div><h2 id="mediaManagerTitle">媒体整理</h2><p>检查图片与视频，整理未使用的文件。</p></div><button class="paper-button" type="button" data-media-close>关闭</button></header>
        <p class="media-manager-status" data-media-summary role="status" aria-live="polite"></p>
        <dl class="media-space-summary" data-media-space hidden></dl>
        <section class="media-files-section" aria-labelledby="mediaFilesTitle"><div class="media-section-heading"><h3 id="mediaFilesTitle">文件检查</h3><button class="paper-button" type="button" data-media-refresh>重新检查</button></div>
        <div class="media-filter-row"><label for="mediaFilterButton" class="field-label">文件分类</label><select id="mediaFilter" data-custom-select data-media-filter aria-label="文件分类"><option value="unused">未使用</option><option value="missing">已缺失</option><option value="shared">多篇共用</option><option value="all">全部文件</option></select></div>
        <p class="media-filter-hint" data-media-hint></p>
        <ul class="record-transfer-list" data-media-list></ul>
        <div class="media-selection" data-media-selection><div class="media-selection-tools"><button class="paper-button" type="button" data-media-all>全选未使用文件</button><button class="paper-button" type="button" data-media-clear disabled>取消选择</button></div><p data-media-count role="status"></p><button class="paper-button" type="button" data-media-trash disabled>移入回收区</button></div></section>
        <section class="media-trash" aria-labelledby="mediaTrashTitle"><div class="media-section-heading"><h3 id="mediaTrashTitle">回收区</h3><span data-media-trash-size></span></div><p>移入后可恢复，永久删除才会释放空间。</p><ul data-media-batches></ul></section>
        <p data-media-error role="alert"></p></div>`;
    document.body.append(dialog);
    enhanceCustomSelects(dialog);
    let report;
    let capability;
    let trigger;
    let busy = false;
    const selected = new Set();
    const error = message => { dialog.querySelector('[data-media-error]').textContent = message; };
    const owners = file => file.records.map(record => `<a href="#entry?id=${encodeURIComponent(record.record_id)}" data-media-record>${escapeHtml(record.date)} ${escapeHtml(record.locality)}</a>`).join('、');

    function count() {
        const files = report.files.filter(file => selected.has(file.path));
        dialog.querySelector('[data-media-count]').textContent = `已选 ${files.length} 个文件 · ${sizeLabel(files.reduce((sum, file) => sum + file.size, 0))}`;
        dialog.querySelector('[data-media-trash]').disabled = !files.length || busy;
        dialog.querySelector('[data-media-clear]').disabled = !files.length || busy;
    }

    function render() {
        selected.clear();
        dialog.querySelector('[data-media-summary]').textContent = `检查完成 · ${report.files.length} 个文件 · ${report.missing.length} 个缺失 · ${report.files.filter(file => file.records.length > 1).length} 个多篇共用`;
        const space = dialog.querySelector('[data-media-space]');
        space.hidden = false;
        space.innerHTML = [['媒体占用', report.totalBytes], ['未使用文件', report.unusedBytes], ['回收区占用', report.trashBytes]].map(([label, bytes]) => `<div><dt>${label}</dt><dd>${sizeLabel(bytes)}</dd></div>`).join('');
        renderFiles();
        dialog.querySelector('[data-media-trash-size]').textContent = `${report.trash.length} 批 · ${sizeLabel(report.trashBytes)}`;
        dialog.querySelector('[data-media-batches]').innerHTML = report.trash.length ? report.trash.map(batch => `<li><p class="media-batch-title">${escapeHtml(new Date(batch.createdAt).toLocaleString())}<small>${batch.files.length} 个文件 · ${sizeLabel(batch.files.reduce((sum, file) => sum + file.size, 0))}</small></p>
            <details><summary>查看文件</summary><ul>${batch.files.map(file => `<li>${escapeHtml(file.path)} · ${sizeLabel(file.size)}</li>`).join('')}</ul></details>
            <div class="media-batch-actions"><button class="paper-button" type="button" data-media-restore="${batch.id}">恢复</button>
            <button class="paper-button sheet-delete-button" type="button" data-media-purge="${batch.id}">永久删除</button></div></li>`).join('') : '<li class="media-empty">回收区为空。</li>';
        count();
        enhanceCustomSelects(dialog);
    }

    function renderFiles() {
        const filter = dialog.querySelector('[data-media-filter]').value;
        dialog.querySelector('[data-media-hint]').textContent = {
            unused: '未被笔记使用的文件。可打开确认内容，再移入回收区。',
            missing: '笔记引用了这些文件，但文件已不存在。请从备份恢复，或修改对应笔记。',
            shared: '这些文件被多篇笔记共用，不能在此清理。',
            all: '查看全部图片与视频，仅未使用的文件可选中清理。'
        }[filter];
        const files = filter === 'missing' ? report.missing : report.files.filter(file => filter === 'all' || (filter === 'shared' ? file.records.length > 1 : !file.records.length));
        dialog.querySelector('[data-media-list]').innerHTML = files.length ? files.map(file => {
            const url = getMediaFileUrl(file.path);
            return `<li><div class="media-health-file">${!file.records.length ? `<label><input type="checkbox" data-media-path value="${escapeHtml(file.path)}"${selected.has(file.path) ? ' checked' : ''}><span class="sr-only">选择 ${escapeHtml(file.path)}</span></label>` : ''}
                <div><span class="media-health-name">${filter === 'missing' || !url ? escapeHtml(file.path.split('/').at(-1)) : `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(file.path.split('/').at(-1))}</a>`}</span><small class="media-health-path">${escapeHtml(file.path)}</small>
                <small>${filter === 'missing' ? '文件缺失' : sizeLabel(file.size)} · ${file.records.length ? owners(file) : '未被笔记使用'}</small></div></div></li>`;
        }).join('') : `<li class="media-empty">${filter === 'unused' ? '没有未使用的文件，无需清理。' : filter === 'missing' ? '没有缺失文件。' : filter === 'shared' ? '没有多篇共用的文件。' : '还没有图片或视频。'}</li>`;
        dialog.querySelector('[data-media-selection]').hidden = !['all', 'unused'].includes(filter);
        count();
    }

    async function request(payload) {
        busy = true;
        error('');
        dialog.querySelectorAll('button, input, select').forEach(element => { element.disabled = true; });
        dialog.querySelector('[data-media-summary]').textContent = payload ? '正在处理媒体文件…' : '正在检查媒体文件和引用…';
        try {
            capability = await detectWriterCapability();
            if (!capability.recordManagement) throw new Error('请重启服务器后再使用媒体整理。');
            const response = await fetch(new URL('api/travel-data?mode=media-health', window.location.href), {
                credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(120000), ...(payload ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Travel-Token': capability.token }, body: JSON.stringify({ ...payload, revision: report.revision }) } : {})
            });
            const result = await response.json();
            if (!response.ok || !Array.isArray(result.files)) throw new Error(result.error || '文件检查失败，请重试。');
            report = result;
            render();
        } catch (failure) {
            error(failure.message);
            dialog.querySelector('[data-media-summary]').textContent = '操作未完成，请重新检查后再试。';
        } finally {
            busy = false;
            dialog.querySelectorAll('button, input, select').forEach(element => { element.disabled = false; });
            if (report) count();
            else dialog.querySelector('[data-media-trash]').disabled = true;
        }
    }

    function close() {
        if (busy) return;
        dialog.close();
        if (trigger?.isConnected) trigger.focus();
    }
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('change', event => {
        if (event.target.matches('[data-media-filter]') && report) renderFiles();
        if (event.target.matches('[data-media-path]')) {
            if (event.target.checked) selected.add(event.target.value); else selected.delete(event.target.value);
            count();
        }
    });
    dialog.addEventListener('click', async event => {
        if (busy) return;
        if (event.target.closest('[data-media-close], [data-media-record]')) close();
        if (event.target.closest('[data-media-refresh]')) await request();
        if (!report) return;
        if (event.target.closest('[data-media-all]')) { report.files.filter(file => !file.records.length).forEach(file => selected.add(file.path)); renderFiles(); count(); }
        if (event.target.closest('[data-media-clear]')) { selected.clear(); renderFiles(); count(); }
        let payload;
        let message;
        if (event.target.closest('[data-media-trash]') && selected.size) {
            payload = { action: 'trash', paths: [...selected] };
            message = `将 ${selected.size} 个未引用文件移入媒体回收区？确认前可点击文件名检查内容。此操作可恢复，暂不释放磁盘空间。`;
        }
        const restore = event.target.closest('[data-media-restore]');
        const purge = event.target.closest('[data-media-purge]');
        if (restore) { payload = { action: 'restore', id: restore.dataset.mediaRestore }; message = '将这批文件恢复到原路径？已有同名文件时整批停止，不会覆盖。'; }
        if (purge) { payload = { action: 'purge', id: purge.dataset.mediaPurge }; message = '永久删除这批媒体文件以释放空间？删除后无法恢复，请确认已备份需要保留的文件。'; }
        if (payload) {
            busy = true;
            try {
                if (await confirmFeedback(message, { title: purge ? '永久删除媒体？' : restore ? '恢复媒体？' : '移入媒体回收区？', confirmLabel: purge ? '永久删除' : '确认' })) {
                    await request(payload);
                }
            } finally { busy = false; }
        }
    });
    return createPasswordGate(async () => {
        trigger = document.activeElement;
        report = undefined;
        selected.clear();
        dialog.querySelector('[data-media-space]').hidden = true;
        dialog.querySelector('[data-media-selection]').hidden = true;
        for (const selector of ['[data-media-list]', '[data-media-batches]', '[data-media-count]', '[data-media-trash-size]', '[data-media-hint]']) dialog.querySelector(selector).textContent = '';
        dialog.showModal();
        enhanceCustomSelects(dialog);
        await request();
    }, { title: '验证访问密码', description: '输入此网站现在使用的 6 位数字访问密码，整理媒体文件。', staticMessage: '静态页面不提供媒体整理，请使用本机服务。' });
}
