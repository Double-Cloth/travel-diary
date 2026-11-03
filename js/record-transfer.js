import { escapeHtml } from './utils.js';
import { createPasswordGate } from './record-password.js?v=20261103-backup-auth-v2';
import { detectWriterCapability } from './writer-capability.js?v=20261103-backup-auth-v2';
import { createOperationProgress, downloadWithProgress, uploadWithProgress } from './operation-progress.js?v=20261101-progress-timing-v1';
import { readZipSource, createZipBlob } from './zip-stream.mjs';
import { readBackupRecords, selectBackupRecords, recordBackupEntries, sortBackupRecords } from './record-backup.mjs?v=20261103-backup-auth-v2';
import { verifyBackupPassword } from './backup-password.js?v=20261103-backup-auth-v2';
import { MAXIMUM_ARCHIVE_BYTES } from './file-limits.mjs';

export function createRecordTransfer(onImported, getRecords) {
    const dialog = document.createElement('dialog');
    dialog.className = 'record-transfer entry-sheet';
    dialog.setAttribute('aria-labelledby', 'recordTransferTitle');
    dialog.innerHTML = `
        <div class="record-transfer-card">
            <h2 id="recordTransferTitle"></h2>
            <p data-record-transfer-note></p>
            <label class="field-label" for="recordTransferSearch">搜索日期、地点或文件名</label>
            <input id="recordTransferSearch" type="search" autocomplete="off" placeholder="筛选要备份的日记">
            <div class="record-transfer-toolbar">
                <button class="paper-button" type="button" data-record-transfer-all>全选筛选结果</button>
                <button class="paper-button" type="button" data-record-transfer-clear>取消选择</button>
                <span data-record-transfer-count role="status" aria-live="polite"></span>
            </div>
            <ul class="record-transfer-list" data-record-transfer-list aria-label="选择旅行记录"></ul>
            <p data-record-transfer-empty hidden>没有匹配的记录。</p>
            <p data-record-transfer-error role="alert"></p>
            <div class="data-import-confirm-actions">
                <button class="paper-button" type="button" data-record-transfer-cancel>取消</button>
                <button class="paper-button" type="button" data-record-transfer-submit disabled></button>
            </div>
        </div>`;
    document.body.append(dialog);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.hidden = true;
    input.setAttribute('aria-label', '选择包含旅行记录的 ZIP 备份');
    document.body.append(input);
    const selected = new Set();
    let records = [];
    let entries;
    let mode;
    let trigger;
    let busy = false;
    const status = message => {
        const output = document.querySelector('[data-data-transfer-status]');
        if (output) output.textContent = message;
    };
    const restoreFocus = () => { if (trigger?.isConnected) trigger.focus(); };
    const close = () => { dialog.close(); restoreFocus(); };
    const error = message => { dialog.querySelector('[data-record-transfer-error]').textContent = message; };

    function filteredRecords() {
        const query = dialog.querySelector('input[type="search"]').value.trim().toLowerCase();
        return records.filter(record => [record.date, record.descTitle, record.country, record.admin_area, record.locality, record.desc_md]
            .some(value => String(value || '').toLowerCase().includes(query)));
    }

    function render() {
        const filtered = filteredRecords();
        const currentPaths = new Set(getRecords().map(record => record.desc_md));
        dialog.querySelector('[data-record-transfer-list]').innerHTML = filtered.map(record => {
            const updated = mode === 'import' && currentPaths.has(record.desc_md);
            return `<li><label><input type="checkbox" value="${escapeHtml(record.desc_md)}"${selected.has(record.desc_md) ? ' checked' : ''}>
                <span><strong>${escapeHtml(record.descTitle || record.locality || record.desc_md)}</strong>
                <small>${escapeHtml([record.date, record.country, record.admin_area, record.locality].filter(Boolean).join(' · '))}${mode === 'import' ? updated ? ' · 更新已有记录' : ' · 新增记录' : ''}</small></span></label></li>`;
        }).join('');
        dialog.querySelector('[data-record-transfer-empty]').hidden = filtered.length > 0;
        dialog.querySelector('[data-record-transfer-all]').disabled = filtered.length === 0;
        updateSelection();
    }

    function updateSelection() {
        dialog.querySelector('[data-record-transfer-count]').textContent = `已选 ${selected.size} / ${records.length} 条`;
        dialog.querySelector('[data-record-transfer-submit]').disabled = selected.size === 0;
    }

    function open(nextMode, nextRecords) {
        mode = nextMode;
        records = sortBackupRecords(nextRecords);
        selected.clear();
        dialog.querySelector('input[type="search"]').value = '';
        dialog.querySelector('#recordTransferTitle').textContent = mode === 'export' ? '导出部分记录' : '导入部分记录';
        dialog.querySelector('[data-record-transfer-note]').textContent = mode === 'export'
            ? '日记按日期由近到远排列。备份包含正文、图片和视频，导入时会验证导出时的访问密码。'
            : '勾选要合并的日记。同正文路径的记录将被更新，其余新增；未选记录、头像、署名和当前密码均保留。更新无法撤销，建议先备份。';
        dialog.querySelector('[data-record-transfer-submit]').textContent = mode === 'export' ? '导出所选记录' : '确认合并所选记录';
        error('');
        render();
        dialog.showModal();
        dialog.querySelector('input[type="search"]').focus();
    }

    async function requireService() {
        const capability = await detectWriterCapability();
        if (!capability.partialRecords) throw new Error('当前服务尚不支持部分记录备份，请重启服务器后再试。');
        return capability;
    }

    async function exportRecords(paths) {
        const progress = createOperationProgress('导出部分记录');
        try {
            const capability = await requireService();
            const url = new URL('api/travel-data', window.location.href);
            url.searchParams.set('mode', 'select');
            const response = await fetch(url, {
                method: 'POST', credentials: 'same-origin', signal: progress.signal,
                headers: { 'Content-Type': 'application/json', 'X-Travel-Token': capability.token }, body: JSON.stringify({ paths })
            });
            const result = await response.json();
            if (!response.ok || !result.selection) throw new Error(result.error || '无法准备所选记录。');
            url.search = '';
            url.searchParams.set('selection', result.selection);
            const date = new Date().toLocaleDateString('sv-SE');
            const download = await downloadWithProgress(url, `travel-diary-records-${date}.zip`, progress);
            status(download.cancelled ? '已取消导出。' : download.handedOff ? '所选记录备份已交给浏览器下载，请查看下载列表。' : `已导出 ${paths.length} 条记录及其媒体文件。`);
        } catch (failure) { progress.fail(failure); throw failure; }
    }

    async function upload(file, capability, currentPassword, backupPassword = currentPassword) {
        const progress = createOperationProgress('导入部分记录');
        try {
            const url = new URL('api/travel-data?mode=merge', window.location.href);
            const response = await uploadWithProgress(url, {
                method: 'POST', credentials: 'same-origin', body: file, signal: progress.signal,
                headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': capability.token,
                    'X-Travel-Current-Password': currentPassword, 'X-Travel-Backup-Password': backupPassword }
            }, (loaded, total) => progress.update(loaded, total, '正在上传所选记录…'), () => {
                progress.setCancelable(false);
                progress.phase('正在校验并合并所选记录…');
            });
            const result = await response.json();
            if (!response.ok || !result.imported || !result.merged) throw Object.assign(new Error(result.error || '部分记录导入失败，请检查服务器版本。'), { code: result.code });
            progress.phase('记录已合并，正在刷新页面…');
            let refreshFailed = false;
            try { await onImported(); } catch { refreshFailed = true; }
            const message = `已新增 ${result.addedRecords} 条、更新 ${result.updatedRecords} 条记录。`
                + (result.missingMediaReferences ? `有 ${result.missingMediaReferences} 个媒体引用缺少文件。` : '')
                + (refreshFailed ? '页面刷新失败，请手动刷新。' : '');
            status(message);
            progress.complete(message);
            return result;
        } catch (failure) {
            if (progress.signal.aborted) { progress.fail(failure); status('已取消导入。'); return null; }
            progress.remove();
            throw failure;
        }
    }

    async function importRecords(context, capability, currentPassword, backupPassword = currentPassword) {
        const chosen = selectBackupRecords(context.records, context.paths);
        const progress = createOperationProgress('整理所选记录');
        let file;
        try {
            file = await createZipBlob(recordBackupEntries(context.entries, chosen, { includeAuth: true }), (loaded, total) => {
                progress.signal.throwIfAborted();
                progress.update(loaded, total, '正在整理正文及媒体文件…');
            });
            progress.signal.throwIfAborted();
            progress.remove();
        } catch (failure) {
            progress.fail(failure);
            if (progress.signal.aborted) { status('已取消导入。'); return null; }
            throw failure;
        }
        if (file.size > MAXIMUM_ARCHIVE_BYTES) throw new Error('所选记录 ZIP 不能超过 100 GiB。');
        return upload(file, capability, currentPassword, backupPassword);
    }

    const requestBackupPassword = createPasswordGate((result, context) => context.resolve(result), {
        title: '验证备份密码', description: '备份密码与当前密码不同。请输入备份的访问密码；合并后保留当前密码。',
        verifying: '正在验证备份并合并记录…',
        verifyPassword: async (password, context) => {
            await verifyBackupPassword(context.entries, context.capability, context.currentPassword, password);
            return importRecords(context, context.capability, context.currentPassword, password);
        },
        onCancel: context => { status('已取消导入。'); context?.resolve(null); }
    });
    const authorize = createPasswordGate(async (capability, context, currentPassword) => {
        if (busy) return;
        busy = true;
        try {
            capability = await requireService();
            if (context.mode === 'export') await exportRecords(context.paths);
            else {
                try {
                    await verifyBackupPassword(context.entries, capability, currentPassword);
                } catch (failure) {
                    if (failure.code !== 'BACKUP_PASSWORD_INVALID') throw failure;
                    await new Promise((resolve, reject) => {
                        void requestBackupPassword({ ...context, capability, currentPassword, resolve }).catch(reject);
                    });
                    return;
                }
                await importRecords(context, capability, currentPassword);
            }
        } finally { busy = false; }
    }, {
        title: '部分记录备份验证', description: '输入当前的 6 位数字密码；导入备份与当前密码相同时无需重复输入。',
        staticMessage: '当前站点为静态只读页面，不提供部分记录导入导出。'
    });

    dialog.addEventListener('input', event => {
        if (event.target.type === 'search') render();
    });
    dialog.addEventListener('change', event => {
        if (event.target.type !== 'checkbox') return;
        if (event.target.checked) selected.add(event.target.value);
        else selected.delete(event.target.value);
        updateSelection();
    });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => {
        if (event.target.closest('[data-record-transfer-cancel]')) close();
        if (event.target.closest('[data-record-transfer-all]')) { filteredRecords().forEach(record => selected.add(record.desc_md)); render(); }
        if (event.target.closest('[data-record-transfer-clear]')) { selected.clear(); render(); }
        if (event.target.closest('[data-record-transfer-submit]') && selected.size) {
            const context = { mode, paths: [...selected], records, entries };
            close();
            void authorize(context).catch(failure => status(failure.message));
        }
    });
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('cancel', restoreFocus);
    input.addEventListener('change', async () => {
        const file = input.files[0];
        input.value = '';
        if (!file || busy) return;
        busy = true;
        try {
            if (file.size > MAXIMUM_ARCHIVE_BYTES) throw new Error('ZIP 备份不能超过 100 GiB。');
            entries = await readZipSource(file);
            open('import', await readBackupRecords(entries));
        } catch (failure) { status(`无法读取备份：${failure.message}`); restoreFocus(); }
        finally { busy = false; }
    });

    return {
        chooseExport() {
            if (busy || dialog.open) return;
            trigger = document.activeElement;
            entries = undefined;
            open('export', getRecords());
        },
        chooseImport() {
            if (busy || dialog.open) return;
            trigger = document.activeElement;
            input.click();
        }
    };
}
