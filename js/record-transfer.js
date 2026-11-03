import { escapeHtml } from './utils.js';
import { createPasswordGate } from './record-password.js?v=20261103-record-management-v1';
import { detectWriterCapability, probeWriterService } from './writer-capability.js?v=20261103-record-management-v1';
import { createOperationProgress, downloadWithProgress, uploadWithProgress } from './operation-progress.js?v=20261103-record-management-v1';
import { readZipSource, createZipBlob, readSourceText, sourceOf } from './zip-stream.mjs';
import { readBackupRecords, selectBackupRecords, recordBackupEntries, sortBackupRecords } from './record-backup.mjs?v=20261103-media-controls-v3';
import { verifyBackupPassword } from './backup-password.js?v=20261103-media-controls-v3';
import { MAXIMUM_ARCHIVE_BYTES } from './file-limits.mjs';
import { compareBackup, fileSignature } from './record-diff.mjs?v=20261103-record-management-v1';
import { recordIdentity } from './record-identity.mjs';

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
                <button class="paper-button" type="button" data-record-transfer-changes>选中新增和修改的记录</button>
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
    let comparisons = new Map();
    let importAuthorization;
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
        dialog.querySelector('[data-record-transfer-list]').innerHTML = filtered.map(record => {
            const comparison = comparisons.get(record.desc_md);
            const unavailable = mode === 'import' && comparison?.status === 'conflict';
            const labels = { added: '新增记录', same: '内容相同，可选择，导入时自动跳过', changed: '内容不同，勾选后采用备份', conflict: '路径冲突，无法导入' };
            return `<li><label><input type="checkbox" value="${escapeHtml(record.desc_md)}"${selected.has(record.desc_md) ? ' checked' : ''}${unavailable ? ' disabled' : ''}>
                <span><strong>${escapeHtml(record.descTitle || comparison?.markdown?.match(/^#\s+(.+)$/m)?.[1] || record.locality || record.desc_md)}</strong>
                <small>${escapeHtml([record.date, record.country, record.admin_area, record.locality].filter(Boolean).join(' · '))}${mode === 'import' ? ` · ${labels[comparison?.status] || ''}` : ''}</small></span></label>
                ${mode === 'import' ? renderDifference(record, comparison) : ''}</li>`;
        }).join('');
        dialog.querySelector('[data-record-transfer-empty]').hidden = filtered.length > 0;
        dialog.querySelector('[data-record-transfer-all]').disabled = filtered.length === 0;
        updateSelection();
    }

    function renderDifference(record, comparison) {
        if (!comparison) return '';
        if (comparison.status === 'conflict') return `<p role="status">${escapeHtml(comparison.message)}</p>`;
        if (comparison.status !== 'changed') return '';
        const previous = comparison.previous;
        const labels = { date: '日期', country: '国家 / 地区', country_code: '国家代码', admin_area: '行政区', admin_area_type: '行政区类型', locality: '目的地', locality_type: '目的地类型', trip_id: '行程', desc_md: '正文路径', photo_folder: '图片目录', photos: '图片列表', video_folder: '视频目录', videos: '视频列表' };
        return `<details class="record-diff"><summary>查看差异 · 未勾选时保留当前记录</summary>
            ${comparison.fields.length ? `<dl>${comparison.fields.map(key => `<dt>${escapeHtml(labels[key] || key)}</dt><dd>当前：${escapeHtml(JSON.stringify(previous[key] ?? ''))}<br>备份：${escapeHtml(JSON.stringify(record[key] ?? ''))}</dd>`).join('')}</dl>` : '<p>记录信息相同。</p>'}
            ${comparison.media.length ? `<p>新增、移除或内容变化的媒体：</p><ul>${comparison.media.map(name => `<li>${escapeHtml(name)}</li>`).join('')}</ul>` : '<p>媒体内容相同。</p>'}
            <div class="record-diff-columns"><div><h3>当前正文</h3><pre>${escapeHtml(comparison.currentMarkdown)}</pre></div>
                <div><h3>备份正文</h3><pre>${escapeHtml(comparison.markdown)}</pre></div></div>
        </details>`;
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
        dialog.querySelector('input[type="search"]').placeholder = mode === 'export' ? '筛选要备份的日记' : '筛选要导入的日记';
        dialog.querySelector('#recordTransferTitle').textContent = mode === 'export' ? '导出部分记录' : '导入部分记录';
        dialog.querySelector('[data-record-transfer-note]').textContent = mode === 'export'
            ? '日记按日期由近到远排列。备份包含正文、图片和视频，导入时会验证导出时的访问密码。'
            : '勾选要导入的日记。新增记录会添加到网站；内容不同的记录会采用备份内容；内容相同的记录会自动跳过。路径冲突的记录无法选择。未选中的记录、个人资料和访问密码保持不变。更新无法撤销，建议先备份。';
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
            const download = await downloadWithProgress(url, `travel-diary-records-${date}.zip`, progress);
            progress.remove();
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
            const plan = Object.fromEntries(chosen.map(record => [record.desc_md, context.comparisons.get(record.desc_md).expected]));
            file = await createZipBlob([...recordBackupEntries(context.entries, chosen, { includeAuth: true }),
                { name: 'data/record-merge.json', data: JSON.stringify(plan) }], (loaded, total) => {
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
        try { await verifyBackupPassword(context.entries, capability, currentPassword); }
        catch (failure) {
            if (failure.code !== 'BACKUP_PASSWORD_INVALID') throw failure;
            return new Promise((resolve, reject) => {
                void requestBackupPassword({ ...context, capability, currentPassword, resolve }).catch(reject);
            });
        }
        return importRecords(context, capability, currentPassword);
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
                const changed = [...comparisons.values()].filter(comparison => comparison.status === 'changed');
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
    const authorizeImport = createPasswordGate((_capability, context, currentPassword) => loadInventory(context, currentPassword), {
        title: '验证访问密码', description: '输入此网站现在使用的 6 位数字访问密码，比较要导入的记录。',
        staticMessage: '静态页面不提供记录导入。'
    });
    const authorize = createPasswordGate(async (_capability, context) => {
        if (busy) return;
        busy = true;
        try {
            await exportRecords(context.paths);
        } finally { busy = false; }
    }, {
        title: '验证访问密码', description: '请输入此网站现在使用的 6 位数字访问密码。',
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
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (busy) return; importAuthorization = undefined; close(); });
    dialog.addEventListener('click', event => {
        if (busy) return;
        if (event.target.closest('[data-record-transfer-cancel]')) { importAuthorization = undefined; close(); }
        if (event.target.closest('[data-record-transfer-all]')) { filteredRecords().filter(record => mode !== 'import' || comparisons.get(record.desc_md)?.status !== 'conflict').forEach(record => selected.add(record.desc_md)); render(); }
        if (event.target.closest('[data-record-transfer-clear]')) { selected.clear(); render(); }
        if (event.target.closest('[data-record-transfer-changes]')) {
            if (busy) return;
            busy = true;
            void loadInventory({ mode: 'export' }).catch(failure => error(failure.message)).finally(() => { busy = false; });
        }
        if (event.target.closest('[data-record-transfer-submit]') && selected.size) {
            const context = { mode, paths: [...selected], records, entries, comparisons };
            close();
            if (mode === 'import' && importAuthorization) {
                const { capability, currentPassword } = importAuthorization;
                importAuthorization = undefined;
                busy = true;
                void (async () => {
                    try {
                        await performImport(context, capability, currentPassword);
                    } catch (failure) { status(failure.message); }
                    finally { busy = false; }
                })();
            } else if (mode === 'export') void authorize(context).catch(failure => status(failure.message));
            else status('验证已失效，请重新选择备份。');
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
            const incomingEntries = await readZipSource(file);
            const incomingRecords = await readBackupRecords(incomingEntries);
            await authorizeImport({ mode: 'import', records: incomingRecords, entries: incomingEntries });
        } catch (failure) { status(`无法读取备份：${failure.message}`); restoreFocus(); }
        finally { busy = false; }
    });

    return {
        chooseExport(paths = []) {
            if (busy || dialog.open) return;
            trigger = document.activeElement;
            entries = undefined;
            importAuthorization = undefined;
            comparisons = new Map();
            open('export', getRecords());
            paths.forEach(path => { if (records.some(record => record.desc_md === path)) selected.add(path); });
            render();
        },
        chooseImport() {
            if (busy || dialog.open) return;
            trigger = document.activeElement;
            input.click();
        }
    };
}
