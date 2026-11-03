import { escapeHtml, getMediaFileUrl } from './utils.js';
import { createPasswordGate } from './record-password.js?v=20261103-record-management-v1';
import { detectWriterCapability } from './writer-capability.js?v=20261103-record-management-v1';
import { confirmFeedback } from './feedback-dialog.js?v=20261102-native-preview-v1';

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
    dialog.innerHTML = `<div class="record-transfer-card"><h2 id="mediaManagerTitle">媒体体检与空间管理</h2>
        <p data-media-summary role="status" aria-live="polite"></p>
        <p>体检检查文件是否存在及被哪些记录引用。清理只处理未引用的文件，先移入回收区；永久删除后才释放空间。</p>
        <div class="record-transfer-toolbar"><label>查看 <select data-media-filter><option value="unused">未引用文件</option><option value="missing">缺失文件</option><option value="shared">共享文件</option><option value="all">全部文件</option></select></label>
            <button class="paper-button" type="button" data-media-refresh>重新体检</button><button class="paper-button" type="button" data-media-all>全选未引用文件</button>
            <button class="paper-button" type="button" data-media-clear>取消选择</button></div>
        <p data-media-count role="status"></p><ul class="record-transfer-list" data-media-list></ul>
        <button class="paper-button" type="button" data-media-trash disabled>移入回收区</button>
        <section class="media-trash"><h3>媒体回收区</h3><p data-media-trash-size></p><ul data-media-batches></ul></section>
        <p data-media-error role="alert"></p><div class="data-import-confirm-actions"><button class="paper-button" type="button" data-media-close>关闭</button></div></div>`;
    document.body.append(dialog);
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
    }

    function render() {
        selected.clear();
        dialog.querySelector('[data-media-summary]').textContent = `${report.files.length} 个媒体文件，占用 ${sizeLabel(report.totalBytes)}；${report.missing.length} 个缺失引用，${report.files.filter(file => file.records.length > 1).length} 个共享文件；未引用文件可释放 ${sizeLabel(report.unusedBytes)}。`;
        renderFiles();
        dialog.querySelector('[data-media-trash-size]').textContent = `占用 ${sizeLabel(report.trashBytes)}。恢复保留原路径；目标已存在时不会覆盖。`;
        dialog.querySelector('[data-media-batches]').innerHTML = report.trash.length ? report.trash.map(batch => `<li><p>${escapeHtml(new Date(batch.createdAt).toLocaleString())} · ${batch.files.length} 个文件 · ${sizeLabel(batch.files.reduce((sum, file) => sum + file.size, 0))}</p>
            <details><summary>查看文件</summary><ul>${batch.files.map(file => `<li>${escapeHtml(file.path)} · ${sizeLabel(file.size)}</li>`).join('')}</ul></details>
            <button class="paper-button" type="button" data-media-restore="${batch.id}">恢复这批文件</button>
            <button class="paper-button sheet-delete-button" type="button" data-media-purge="${batch.id}">永久删除这批文件</button></li>`).join('') : '<li>回收区为空。</li>';
        count();
    }

    function renderFiles() {
        const filter = dialog.querySelector('[data-media-filter]').value;
        const files = filter === 'missing' ? report.missing : report.files.filter(file => filter === 'all' || (filter === 'shared' ? file.records.length > 1 : !file.records.length));
        dialog.querySelector('[data-media-list]').innerHTML = files.length ? files.map(file => {
            const url = getMediaFileUrl(file.path);
            return `<li><div class="media-health-file">${!file.records.length ? `<label><input type="checkbox" data-media-path value="${escapeHtml(file.path)}"${selected.has(file.path) ? ' checked' : ''}><span class="sr-only">选择 ${escapeHtml(file.path)}</span></label>` : ''}
                <div>${filter === 'missing' || !url ? escapeHtml(file.path) : `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(file.path)}</a>`}
                <small>${filter === 'missing' ? '文件缺失' : sizeLabel(file.size)} · ${file.records.length ? owners(file) : '未被任何记录引用'}</small></div></div></li>`;
        }).join('') : '<li>此分类没有需要处理的文件。</li>';
        dialog.querySelector('[data-media-all]').hidden = !['all', 'unused'].includes(filter);
    }

    async function request(payload) {
        busy = true;
        error('');
        dialog.querySelectorAll('button, input, select').forEach(element => { element.disabled = true; });
        dialog.querySelector('[data-media-summary]').textContent = payload ? '正在处理媒体文件…' : '正在检查媒体文件和引用…';
        try {
            capability = await detectWriterCapability();
            if (!capability.recordManagement) throw new Error('请重启服务器后再使用媒体体检。');
            const response = await fetch(new URL('api/travel-data?mode=media-health', window.location.href), {
                credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(120000), ...(payload ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Travel-Token': capability.token }, body: JSON.stringify({ ...payload, revision: report.revision }) } : {})
            });
            const result = await response.json();
            if (!response.ok || !Array.isArray(result.files)) throw new Error(result.error || '媒体体检失败，请重试。');
            report = result;
            render();
        } catch (failure) {
            error(failure.message);
            dialog.querySelector('[data-media-summary]').textContent = '操作未完成，请重新体检后再试。';
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
        for (const selector of ['[data-media-list]', '[data-media-batches]', '[data-media-count]', '[data-media-trash-size]']) dialog.querySelector(selector).textContent = '';
        dialog.showModal();
        await request();
    }, { title: '验证访问密码', description: '输入此网站现在使用的 6 位数字访问密码，管理媒体文件。', staticMessage: '静态页面不提供媒体体检与清理，请使用本机服务。' });
}
