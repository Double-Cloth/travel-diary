import { escapeHtml } from './utils.js';
import { createPasswordGate } from './record-password.js?v=20261103-record-management-v1';
import { detectWriterCapability } from './writer-capability.js?v=20261103-recycle-bin-v1';
import { confirmFeedback } from './feedback-dialog.js?v=20261102-native-preview-v1';

function sizeLabel(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function createRecycleManager(onRestored) {
    const dialog = document.createElement('dialog');
    dialog.className = 'record-transfer recycle-manager entry-sheet';
    dialog.setAttribute('aria-labelledby', 'recycleManagerTitle');
    dialog.innerHTML = `<div class="record-transfer-card">
        <header class="media-manager-heading"><div><h2 id="recycleManagerTitle">回收站</h2><p>删除的日记、文件和替换前的数据都保留在这里。永久删除后才释放空间。</p></div><button class="paper-button" type="button" data-recycle-close>关闭</button></header>
        <div class="recycle-toolbar"><p data-recycle-status role="status" aria-live="polite"></p><button class="media-text-button" type="button" data-recycle-refresh>刷新</button></div>
        <ul class="recycle-list" data-recycle-list></ul><p data-recycle-error role="alert"></p></div>`;
    document.body.append(dialog);
    let report;
    let busy = false;
    let trigger;
    const error = message => { dialog.querySelector('[data-recycle-error]').textContent = message; };
    function render() {
        dialog.querySelector('[data-recycle-status]').textContent = `${report.items.length} 个回收项目 · ${sizeLabel(report.totalBytes)}`;
        const types = { record: '日记', files: '文件', version: '旧版本', snapshot: '整站数据' };
        dialog.querySelector('[data-recycle-list]').innerHTML = report.items.length ? report.items.map(item => `<li>
            <div class="recycle-item-heading"><span class="recycle-kind">${types[item.kind] || '文件'}</span><time>${escapeHtml(new Date(item.createdAt).toLocaleString())}</time></div>
            <h3>${escapeHtml(item.title)}</h3><p>${item.records.length ? `${item.records.length} 篇日记 · ` : ''}${item.files.length} 个文件 · ${sizeLabel(item.files.reduce((sum, file) => sum + file.size, 0))}</p>
            ${item.kind === 'snapshot' ? '<p class="recycle-restore-note">恢复会替换全部日记和个人资料；当前数据会先存入回收站，访问密码保持不变。</p>' : item.kind === 'version' ? '<p class="recycle-restore-note">恢复到原位置；被替换的当前文件也会存入回收站。</p>' : ''}
            <details><summary>查看内容</summary><ul>${item.files.map(file => `<li>${escapeHtml(file.path)} <small>${sizeLabel(file.size)}</small></li>`).join('')}</ul></details>
            <div class="media-batch-actions"><button class="paper-button" type="button" data-recycle-restore="${item.id}">恢复${item.kind === 'snapshot' ? '全部数据' : ''}</button><button class="media-text-button recycle-purge" type="button" data-recycle-purge="${item.id}">永久删除</button></div></li>`).join('') : '<li class="media-empty">回收站为空。删除的内容会显示在这里。</li>';
    }
    async function request(payload) {
        busy = true;
        error('');
        dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
        dialog.querySelector('[data-recycle-status]').textContent = payload ? '正在处理，请稍候…' : '正在读取回收站…';
        try {
            const capability = await detectWriterCapability();
            if (!capability.recycleBin) throw new Error('请重启服务器后再使用回收站。');
            const response = await fetch(new URL('api/travel-data?mode=recycle-bin', window.location.href), {
                credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(120000),
                ...(payload ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Travel-Token': capability.token }, body: JSON.stringify({ ...payload, revision: report.revision }) } : {})
            });
            const result = await response.json();
            if (!response.ok || !Array.isArray(result.items)) throw new Error(result.error || '无法读取回收站，请刷新后重试。');
            report = result;
            render();
            if (payload?.action === 'restore') {
                try { await onRestored(); }
                catch { error('内容已恢复，页面刷新失败，请手动刷新。'); }
            }
        } catch (failure) {
            error(failure.message);
            dialog.querySelector('[data-recycle-status]').textContent = '操作未完成，请刷新后重试。';
        } finally {
            busy = false;
            dialog.querySelectorAll('button').forEach(button => { button.disabled = false; });
            if (payload) dialog.querySelector('[data-recycle-refresh]').focus();
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
    dialog.addEventListener('click', async event => {
        if (busy) return;
        if (event.target.closest('[data-recycle-close]')) { close(); return; }
        if (event.target.closest('[data-recycle-refresh]')) { await request(); return; }
        const button = event.target.closest('[data-recycle-restore], [data-recycle-purge]');
        if (!button || !report) return;
        const purge = Boolean(button.dataset.recyclePurge);
        const id = button.dataset.recyclePurge || button.dataset.recycleRestore;
        const item = report.items.find(item => item.id === id);
        const message = purge ? '永久删除后无法找回。请确认这份内容已不再需要。'
            : item.kind === 'snapshot' ? '将全部日记和个人资料恢复到这个时间点。当前数据会先存入回收站；访问密码保持不变。'
                : item.kind === 'version' ? '将文件恢复到原位置，被替换的当前文件会先存入回收站。'
                    : '恢复日记及文件到原位置。已有同名且内容不同的文件时会停止，保留当前内容。';
        busy = true;
        try {
            if (await confirmFeedback(message, { title: purge ? '永久删除这个项目？' : '恢复这个项目？', confirmLabel: purge ? '永久删除' : '恢复' })) {
                await request({ action: purge ? 'purge' : 'restore', id });
            }
        } finally { busy = false; }
    });
    return createPasswordGate(async () => {
        trigger = document.activeElement;
        report = undefined;
        dialog.querySelector('[data-recycle-list]').replaceChildren();
        dialog.showModal();
        await request();
    }, { title: '验证访问密码', description: '输入此网站的 6 位数字访问密码，查看和恢复回收站内容。', staticMessage: '静态页面不提供回收站，请使用本机服务。' });
}
