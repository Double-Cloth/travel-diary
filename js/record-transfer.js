import { escapeHtml, getMediaFileUrl } from './utils.js?v=2.1.52';
import { createPasswordGate } from './record-password.js?v=2.1.52';
import { detectWriterCapability, probeWriterService } from './writer-capability.js?v=2.1.52';
import { createOperationProgress, downloadWithProgress, uploadWithProgress } from './operation-progress.js?v=2.1.52';
import { readZipSource, createZipBlob, readSourceText, sourceOf } from './zip-stream.mjs';
import { readBackupRecords, selectBackupRecords, recordBackupEntries, sortBackupRecords } from './record-backup.mjs?v=2.1.52';
import { verifyBackupPassword } from './backup-password.js?v=2.1.52';
import { MAXIMUM_ARCHIVE_BYTES } from './file-limits.mjs?v=2.1.52';
import { compareBackup, fileSignature } from './record-diff.mjs?v=2.1.52';
import { recordIdentity } from './record-identity.mjs?v=2.1.52';
import { createContentPreviewScope } from './content-preview.js?v=2.1.52';

import { renderRecordDifference, loadDifferenceMedia } from './record-diff-view.js?v=2.1.52';

export function createRecordTransfer(onImported, getRecords) {
    const dialog = document.createElement('dialog');
    dialog.className = 'record-transfer management-dialog entry-sheet';
    dialog.setAttribute('aria-labelledby', 'recordTransferTitle');
    dialog.innerHTML = `
        <div class="record-transfer-card">
            <header class="management-heading"><div><h2 id="recordTransferTitle"></h2><p data-record-transfer-note></p></div><button class="paper-button management-secondary" type="button" data-record-transfer-cancel>关闭</button></header>
            <label class="field-label" for="recordTransferSearch">搜索日期、地点或文件名</label>
            <div class="management-search"><input id="recordTransferSearch" type="search" autocomplete="off" placeholder="筛选要备份的日记"><button class="media-text-button" type="button" data-record-transfer-reset hidden>清除搜索</button></div>
            <div class="record-transfer-toolbar">
                <button class="paper-button management-secondary" type="button" data-record-transfer-all>全选筛选结果</button>
                <button class="paper-button management-secondary" type="button" data-record-transfer-clear>清空全部选择</button>
                <button class="paper-button management-secondary" type="button" data-record-transfer-changes>选中新增和修改的记录</button>
            </div>
            <ul class="record-transfer-list" data-record-transfer-list aria-label="选择旅行记录"></ul>
            <p class="management-empty" data-record-transfer-empty role="status" hidden></p>
            <p data-record-transfer-error role="alert"></p>
            <div class="management-footer">
                <p data-record-transfer-count role="status" aria-live="polite"></p>
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
    let comparisons = new Map();
    let importAuthorization;
    let importProgress;
    let previews = createContentPreviewScope();
    const status = message => {
        const output = document.querySelector('[data-data-transfer-status]');
        if (output) output.textContent = message;
    };
    const restoreFocus = () => { if (trigger?.isConnected) trigger.focus(); else document.getElementById('journalStage')?.focus(); };
    const close = () => { dialog.close(); previews.dispose(); restoreFocus(); };
    const error = message => { dialog.querySelector('[data-record-transfer-error]').textContent = message; };
    function startImportProgress() {
        importProgress?.remove();
        return importProgress = createOperationProgress('导入部分记录');
    }
    function setBusy(value) {
        busy = value;
        dialog.setAttribute('aria-busy', String(value));
        dialog.querySelectorAll('button, input').forEach(control => {
            control.disabled = value || (control.type === 'checkbox' && mode === 'import' && comparisons.get(control.value)?.status === 'conflict');
        });
        updateSelection();
    }

    function filteredRecords() {
        const query = dialog.querySelector('input[type="search"]').value.trim().toLowerCase();
        return records.filter(record => [record.date, record.descTitle, record.country, record.admin_area, record.locality, record.desc_md]
            .some(value => String(value || '').toLowerCase().includes(query)));
    }

    function render() {
        previews.dispose();
        previews = createContentPreviewScope();
        const filtered = filteredRecords();
        dialog.querySelector('[data-record-transfer-list]').innerHTML = filtered.map(record => {
            const comparison = comparisons.get(record.desc_md);
            const unavailable = mode === 'import' && comparison?.status === 'conflict';
            const labels = { added: '新增记录', same: '内容相同，导入时自动跳过', changed: '内容不同，勾选后采用备份', conflict: '路径冲突，无法导入' };
            return `<li><label><input type="checkbox" value="${escapeHtml(record.desc_md)}"${selected.has(record.desc_md) ? ' checked' : ''}${unavailable ? ' disabled' : ''}>
                <span><strong>${escapeHtml(record.descTitle || comparison?.markdown?.match(/^#\s+(.+)$/m)?.[1] || record.locality || record.desc_md)}</strong>
                <small>${escapeHtml([record.date, record.country, record.admin_area, record.locality].filter(Boolean).join(' · '))}${mode === 'import' ? ` · ${labels[comparison?.status] || ''}` : ''}</small></span></label>
                ${mode === 'import' ? renderRecordDifference(record, comparison) : ''}</li>`;
        }).join('');
        dialog.querySelector('[data-record-transfer-empty]').hidden = filtered.length > 0;
        dialog.querySelector('[data-record-transfer-list]').hidden = !filtered.length;
        dialog.querySelector('[data-record-transfer-empty]').textContent = records.length ? '没有匹配的日记，清除搜索后可查看全部记录。' : mode === 'export' ? '还没有可导出的日记，新增日记后再来备份。' : '备份中没有可导入的日记，请重新选择备份。';
        dialog.querySelectorAll('input').forEach(control => { if (busy) control.disabled = true; });
        updateSelection();
    }

    dialog.addEventListener('toggle', async event => {
        const details = event.target;
        if (!details.matches('[data-diff-record]')) return;
        const scope = previews;
        const files = new Map((entries || []).map(entry => [entry.name, entry.data]));
        await loadDifferenceMedia(details, comparisons.get(details.dataset.diffRecord), scope, (name, side) => {
            if (side === 'before') return { url: getMediaFileUrl(name) };
            if (!files.has(name)) throw new Error('备份中缺少这个附件。');
            return { source: files.get(name) };
        }, () => scope === previews);
    }, true);

    function updateSelection() {
        const filtered = filteredRecords();
        const hidden = selected.size - filtered.filter(record => selected.has(record.desc_md)).length;
        dialog.querySelector('[data-record-transfer-count]').textContent = `显示 ${filtered.length} / ${records.length} 篇 · 已选 ${selected.size} 篇${hidden ? `（含筛选外 ${hidden} 篇）` : ''}`;
        dialog.querySelector('[data-record-transfer-reset]').hidden = !dialog.querySelector('input[type="search"]').value;
        dialog.querySelector('[data-record-transfer-submit]').disabled = busy || selected.size === 0;
        dialog.querySelector('[data-record-transfer-clear]').disabled = busy || selected.size === 0;
        dialog.querySelector('[data-record-transfer-all]').disabled = busy || !filtered.some(record => !selected.has(record.desc_md) && (mode !== 'import' || comparisons.get(record.desc_md)?.status !== 'conflict'));
        dialog.querySelector('[data-record-transfer-changes]').disabled = busy || !records.length;
    }

    function open(nextMode, nextRecords) {
        mode = nextMode;
        dialog.classList.toggle('record-transfer-import', mode === 'import');
        records = sortBackupRecords(nextRecords);
        selected.clear();
        dialog.querySelector('input[type="search"]').value = '';
        dialog.querySelector('input[type="search"]').placeholder = mode === 'export' ? '筛选要备份的日记' : '筛选要导入的日记';
        dialog.querySelector('#recordTransferTitle').textContent = mode === 'export' ? '导出部分记录' : '导入部分记录';
        dialog.querySelector('[data-record-transfer-note]').textContent = mode === 'export'
            ? '日记按日期由近到远排列。备份包含正文、图片和视频，导入时会验证导出时的访问密码。'
            : '勾选要合并的日记，有差异时采用备份，相同内容会跳过。其他记录、个人资料和密码保持不变。替换前的数据会留在回收站。';
        dialog.querySelector('[data-record-transfer-changes]').hidden = mode !== 'export';
        dialog.querySelector('[data-record-transfer-submit]').textContent = mode === 'export' ? '导出所选记录' : '确认合并所选记录';
        error('');
        render();
        dialog.showModal();
        dialog.querySelector('input[type="search"]').focus();
    }

    async function requireService() {
        const capability = await detectWriterCapability();
        if (!capability.partialRecords) throw new Error('当前服务尚不支持部分记录备份，请重启服务器后再试。');
        if (!capability.recordManagement) throw new Error('请重启服务器以使用记录差异对比和增量备份。');
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
            const download = await downloadWithProgress(url, `travel-diary-records-${date}.zip`, progress, { responseTimeout: 8 * 60 * 60 * 1000 });
            progress.remove();
            status(download.cancelled ? '已取消导出。' : download.handedOff ? '所选记录备份已交给浏览器下载，请查看下载列表。' : `已导出 ${paths.length} 条记录及其媒体文件。`);
        } catch (failure) { progress.fail(failure); throw failure; }
    }

    async function upload(file, capability, currentPassword, backupPassword, progress) {
        try {
            progress.throwIfCancelled();
            progress.phase('正在上传所选记录…');
            const url = new URL('api/travel-data?mode=merge', window.location.href);
            const response = await uploadWithProgress(url, {
                method: 'POST', credentials: 'same-origin', body: file, signal: progress.signal,
                headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': capability.token,
                    ...(currentPassword === undefined ? {} : { 'X-Travel-Current-Password': currentPassword }),
                    ...(backupPassword === undefined ? {} : { 'X-Travel-Backup-Password': backupPassword }) }
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
            progress.fail(failure);
            throw failure;
        }
    }

    async function importRecords(context, capability, currentPassword, backupPassword = currentPassword, progress = startImportProgress()) {
        const chosen = selectBackupRecords(context.records, context.paths);
        try {
            progress.setCancelable(true);
            progress.phase('正在整理所选日记和附件…');
            const plan = Object.fromEntries(chosen.map(record => [record.desc_md, context.comparisons.get(record.desc_md).expected]));
            const file = await createZipBlob([...recordBackupEntries(context.entries, chosen, { includeAuth: true }),
                { name: 'data/record-merge.json', data: JSON.stringify(plan) }], (loaded, total) => {
                progress.signal.throwIfAborted();
                progress.update(loaded, total, '正在整理正文及媒体文件…');
            });
            progress.signal.throwIfAborted();
            if (file.size > MAXIMUM_ARCHIVE_BYTES) throw new Error('所选记录 ZIP 不能超过 100 GiB。');
            return await upload(file, capability, currentPassword, backupPassword, progress);
        } catch (failure) {
            progress.fail(failure);
            if (progress.signal.aborted) { status('已取消导入。'); return null; }
            throw failure;
        }
    }

    const requestBackupPassword = createPasswordGate((result, context) => context.resolve(result), {
        title: '输入备份时的密码', description: '请输入导出这份备份时使用的 6 位数字访问密码。合并后，此网站的访问密码保持不变。',
        verifying: '正在验证备份并合并记录…',
        verifyPassword: async (password, context) => {
            await verifyBackupPassword(context.entries, context.capability, context.currentPassword, password);
            return importRecords(context, context.capability, context.currentPassword, password);
        },
        onCancel: context => { status('已取消导入。'); context?.resolve(null); }
    });

    async function performImport(context, capability, currentPassword) {
        const paths = context.paths.filter(path => context.comparisons.get(path)?.status !== 'same');
        const skipped = context.paths.length - paths.length;
        if (!paths.length) {
            status(`所选 ${skipped} 条记录与当前内容相同，无需导入。`);
            return null;
        }
        context = { ...context, paths };
        const progress = startImportProgress();
        progress.setCancelable(false, '正在验证备份密码，请稍候。');
        progress.phase('正在验证备份密码…');
        try { await verifyBackupPassword(context.entries, capability, currentPassword); }
        catch (failure) {
            if (failure.code !== 'BACKUP_PASSWORD_INVALID') { progress.fail(failure); throw failure; }
            progress.remove();
            return new Promise((resolve, reject) => {
                void requestBackupPassword({ ...context, capability, currentPassword, resolve }).catch(reject);
            });
        }
        return importRecords(context, capability, currentPassword, currentPassword, progress);
    }

    async function loadInventory(context, currentPassword) {
        const progress = createOperationProgress('检查记录变更');
        progress.phase('正在检查记录、正文及媒体内容…');
        try {
            const capability = context.mode === 'import' ? await requireService() : await probeWriterService();
            if (!capability.recordManagement) throw new Error('请重启服务器以使用记录差异对比和增量备份。');
            let response;
            for (let attempt = 0; attempt < 3; attempt += 1) {
                response = await fetch(new URL('api/travel-data?mode=inventory', window.location.href), { credentials: 'same-origin', cache: 'no-store', signal: progress.signal });
                if (response.status !== 409 || attempt === 2) break;
                // 导出刚结束时，等待服务端完成备份状态写入并释放数据锁。
                await new Promise(resolve => setTimeout(resolve, 100));
                progress.signal.throwIfAborted();
            }
            const result = await response.json();
            if (!response.ok || !Array.isArray(result.records)) throw new Error(result.error || '无法读取当前记录，请重试。');
            if (context.mode === 'import') {
                comparisons = await compareBackup(context.records, context.entries, result);
                const changed = [...comparisons.values()].filter(comparison => comparison.status === 'changed' && comparison.markdownChanged);
                let next = 0;
                await Promise.all(Array.from({ length: Math.min(8, changed.length) }, async () => {
                    while (next < changed.length) {
                        const comparison = changed[next++];
                        const name = comparison.previous.desc_md;
                        if (result.signatures[name] === 'missing') { comparison.currentMarkdown = '当前正文文件缺失。'; continue; }
                        const response = await fetch(new URL(name, window.location.href), { cache: 'no-store', signal: AbortSignal.any([progress.signal, AbortSignal.timeout(20000)]) });
                        if (!response.ok) throw new Error('无法读取当前正文，请重新选择备份后比较。');
                        const bytes = await readSourceText(sourceOf(await response.blob()));
                        if (await fileSignature(bytes) !== result.signatures[name]) throw new Error('比较期间当前正文已变化，请重新选择备份。');
                        comparison.currentMarkdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                    }
                }));
                progress.signal.throwIfAborted();
                entries = context.entries;
                importAuthorization = { capability, currentPassword };
                open('import', context.records);
            } else {
                progress.signal.throwIfAborted();
                const titles = new Map(getRecords().map(record => [record.desc_md, record.descTitle]));
                records = sortBackupRecords(result.records.map(record => ({ ...record, descTitle: titles.get(record.desc_md) })));
                selected.clear();
                for (const record of result.records) {
                    const id = recordIdentity(record);
                    if (result.backup.records[id] !== result.fingerprints[id]) selected.add(record.desc_md);
                }
                render();
                dialog.querySelector('[data-record-transfer-note]').textContent = `已选择 ${selected.size} 条新增或有变化的记录（含正文、信息和媒体内容）。`
                    + (result.backup.confirmedAt ? `最近导出：${new Date(result.backup.confirmedAt).toLocaleString()}。` : '尚无导出记录，已选择全部记录。')
                    + '导出传输完成后自动更新记录状态，请妥善保存 ZIP 文件。';
                if (!dialog.open) dialog.showModal();
            }
            return capability;
        } finally { progress.remove(); }
    }
    const authorizeImport = createPasswordGate((capability, _context, currentPassword) => {
        trigger = document.activeElement;
        importAuthorization = { capability, currentPassword };
        input.click();
    }, {
        title: '验证访问密码', description: '输入此网站现在使用的 6 位数字访问密码，然后选择备份并比较记录。',
        staticMessage: '静态页面不提供记录导入。'
    });
    function openExport(paths) {
        trigger = document.activeElement;
        entries = undefined;
        importAuthorization = undefined;
        comparisons = new Map();
        open('export', getRecords());
        paths.forEach(path => { if (records.some(record => record.desc_md === path)) selected.add(path); });
        render();
    }
    const authorizeExport = createPasswordGate((_capability, paths) => openExport(paths), {
        title: '验证访问密码', description: '输入此网站现在使用的 6 位数字访问密码，然后选择要导出的记录。',
        staticMessage: '当前站点为静态只读页面，不提供部分记录或行程备份导出。'
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
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (busy) return; importAuthorization = undefined; close(); });
    dialog.addEventListener('click', event => {
        if (busy) return;
        if (event.target.closest('[data-record-transfer-cancel]')) { importAuthorization = undefined; close(); }
        if (event.target.closest('[data-record-transfer-reset]')) { dialog.querySelector('input[type="search"]').value = ''; render(); dialog.querySelector('input[type="search"]').focus(); }
        if (event.target.closest('[data-record-transfer-all]')) { filteredRecords().filter(record => mode !== 'import' || comparisons.get(record.desc_md)?.status !== 'conflict').forEach(record => selected.add(record.desc_md)); render(); }
        if (event.target.closest('[data-record-transfer-clear]')) { selected.clear(); render(); }
        if (event.target.closest('[data-record-transfer-changes]')) {
            if (busy) return;
            setBusy(true);
            void loadInventory({ mode: 'export' }).catch(failure => error(failure.message)).finally(() => { setBusy(false); });
        }
        if (event.target.closest('[data-record-transfer-submit]') && selected.size) {
            const context = { mode, paths: [...selected], records, entries, comparisons };
            close();
            if (mode === 'import' && importAuthorization) {
                const { capability, currentPassword } = importAuthorization;
                importAuthorization = undefined;
                setBusy(true);
                void (async () => {
                    try {
                        await performImport(context, capability, currentPassword);
                    } catch (failure) { status(failure.message); }
                    finally { setBusy(false); }
                })();
            } else if (mode === 'export') {
                setBusy(true);
                void exportRecords(context.paths).catch(failure => status(failure.message)).finally(() => setBusy(false));
            }
            else status('验证已失效，请重新选择备份。');
        }
    });
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('cancel', () => { importAuthorization = undefined; restoreFocus(); });
    input.addEventListener('change', async () => {
        const file = input.files[0];
        input.value = '';
        if (busy) return;
        const authorization = importAuthorization;
        importAuthorization = undefined;
        if (!file) { restoreFocus(); return; }
        if (!authorization) { status('验证已失效，请重新选择备份。'); restoreFocus(); return; }
        setBusy(true);
        try {
            if (file.size > MAXIMUM_ARCHIVE_BYTES) throw new Error('ZIP 备份不能超过 100 GiB。');
            const incomingEntries = await readZipSource(file);
            const incomingRecords = await readBackupRecords(incomingEntries);
            await loadInventory({ mode: 'import', records: incomingRecords, entries: incomingEntries }, authorization.currentPassword);
        } catch (failure) { status(`无法读取备份：${failure.message}`); restoreFocus(); }
        finally { setBusy(false); }
    });

    return {
        chooseExport(paths = []) {
            if (busy || dialog.open) return;
            return authorizeExport(paths);
        },
        chooseImport() {
            if (busy || dialog.open) return;
            return authorizeImport();
        }
    };
}
