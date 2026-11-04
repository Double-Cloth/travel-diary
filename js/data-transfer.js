import { createPasswordGate } from './record-password.js?v=2.1.32';
import { detectWriterCapability } from './writer-capability.js?v=2.1.32';
import { MAXIMUM_ARCHIVE_BYTES } from './file-limits.mjs?v=2.1.32';
import { readZipSource } from './zip-stream.mjs';
import { createRecordTransfer } from './record-transfer.js?v=2.1.32';
import { verifyBackupPassword } from './backup-password.js?v=2.1.32';
import { createOperationProgress, downloadWithProgress, uploadWithProgress } from './operation-progress.js?v=2.1.32';

function setStatus(message) {
    const output = document.querySelector('[data-data-transfer-status]');
    if (output) output.textContent = message;
}

export function createDataTransfer(onImported, getRecords = () => []) {
    let recordTransfer;
    const partialTransfer = () => recordTransfer ||= createRecordTransfer(onImported, getRecords);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.hidden = true;
    input.setAttribute('aria-label', '选择全部旅行数据 ZIP 备份');
    document.body.append(input);
    const dialog = document.createElement('dialog');
    dialog.className = 'data-import-confirm entry-sheet';
    dialog.setAttribute('aria-labelledby', 'dataImportConfirmTitle');
    dialog.setAttribute('aria-describedby', 'dataImportConfirmDescription');
    dialog.innerHTML = `
        <div class="data-import-confirm-card">
            <div class="data-import-confirm-seal" aria-hidden="true">
                <svg viewBox="0 0 32 32" focusable="false">
                    <path d="M16 4 29 27H3L16 4Z"></path>
                    <path d="M16 11v8"></path>
                    <path d="M16 23h.01"></path>
                </svg>
            </div>
            <p class="journal-label">全部数据导入</p>
            <h2 id="dataImportConfirmTitle">替换当前旅行数据？</h2>
            <p class="data-import-confirm-note" id="dataImportConfirmDescription"></p>
            <p class="data-import-confirm-file" data-import-file-summary>已选择 <strong data-import-file-name></strong></p>
            <div class="data-import-confirm-actions">
                <button class="paper-button" type="button" data-import-cancel>暂不导入</button>
                <button class="paper-button data-import-confirm-submit" type="button" data-import-confirm>确认覆盖并继续</button>
            </div>
        </div>`;
    document.body.append(dialog);
    const successDialog = document.createElement('dialog');
    successDialog.className = 'data-import-success entry-sheet';
    successDialog.setAttribute('aria-labelledby', 'dataImportSuccessTitle');
    successDialog.setAttribute('aria-describedby', 'dataImportSuccessDescription');
    successDialog.innerHTML = `
        <div class="data-import-success-card">
            <div class="data-import-success-seal" aria-hidden="true">
                <svg viewBox="0 0 32 32" focusable="false">
                    <circle cx="16" cy="16" r="12"></circle>
                    <path d="m9.5 16.5 4.2 4.2 8.8-9.4"></path>
                </svg>
            </div>
            <p class="journal-label">全部数据导入</p>
            <h2 id="dataImportSuccessTitle">导入成功</h2>
            <p class="data-import-success-note" id="dataImportSuccessDescription">全部旅行数据已更新。</p>
            <div class="data-import-success-actions">
                <button class="paper-button data-import-success-close" type="button" data-import-success-close>完成</button>
            </div>
        </div>`;
    document.body.append(successDialog);
    let busy = false;
    let importTrigger;
    let importCapability;
    let importCurrentPassword = '';
    let confirmationResolver;
    let importUploadProgress;

    async function getExportHref(authenticatedCapability = null) {
        const capability = authenticatedCapability || await detectWriterCapability();
        if (capability.readonly) throw new Error('当前站点为静态只读页面，不提供备份导出。');
        if (!capability.authenticated || !capability.token) throw new Error('登录会话已失效，请重新输入访问密码。');
        return new URL('api/travel-data', window.location.href).href;
    }

    function writerToken(capability) {
        if (!capability?.authenticated || !capability.token) throw new Error('登录会话已失效，请重新输入访问密码。');
        return capability.token;
    }

    function noteExportStarted() {
        setStatus('全部数据备份已开始下载。');
    }

    async function exportAll(downloadName = 'travel-diary-data.zip', authenticatedCapability = null) {
        if (busy) throw new Error('另一项全部数据操作正在进行，请稍后重试。');
        busy = true;
        const progress = createOperationProgress('导出全部数据');
        try {
            const capability = authenticatedCapability || await detectWriterCapability();
            const result = await downloadWithProgress(await getExportHref(capability), downloadName, progress, { responseTimeout: 8 * 60 * 60 * 1000 });
            progress.remove();
            setStatus(result.cancelled ? '已取消导出。' : result.handedOff
                ? '备份已交给浏览器下载，请在浏览器下载列表查看进度。'
                : '全部数据备份已传输完成，请查看保存的文件。');
        } catch (error) {
            progress.fail(error);
            setStatus(`导出失败：${error.message}`);
            throw error;
        } finally { busy = false; }
    }

    async function clearAll(authenticatedCapability) {
        if (busy) throw new Error('另一项全部数据操作正在进行，请稍后重试。');
        busy = true;
        const progress = createOperationProgress('清空全部数据');
        progress.setCancelable(false, '数据正在清空，无法取消。');
        progress.phase('正在清空旅行数据…');
        setStatus('正在清空全部旅行数据…');
        try {
            const response = await fetch(new URL('api/travel-data', window.location.href), {
                method: 'DELETE',
                headers: { 'X-Travel-Token': writerToken(authenticatedCapability) },
                credentials: 'same-origin',
                signal: AbortSignal.timeout(120000)
            });
            let result;
            try { result = await response.json(); }
            catch { throw new Error('清空全部数据返回了无法识别的结果。'); }
            if (!response.ok || !result.cleared) throw new Error(result.error || '全部数据未能清空。');
            progress.phase('数据已清空，正在刷新页面…');
            try { await onImported(); }
            catch {
                const message = '全部数据已清空，页面刷新失败。请手动刷新后查看。';
                setStatus(message);
                progress.complete(message);
                return { refreshFailed: true };
            }
            setStatus('');
            progress.complete('全部旅行数据已清空。');
            return { refreshFailed: false };
        } catch (error) {
            progress.fail(error);
            setStatus(error?.message || '全部数据未能清空。');
            throw error;
        } finally {
            busy = false;
        }
    }

    function chooseImportWithAuthorization(capability, context, password) {
        if (busy) return;
        importCapability = capability;
        importCurrentPassword = password;
        importTrigger = document.activeElement;
        input.click();
    }

    const requestImportAuthorization = createPasswordGate(chooseImportWithAuthorization, {
        title: '验证访问密码',
        description: '请输入此网站现在使用的 6 位数字访问密码，然后选择备份。',
        verifying: '正在验证并选择备份…',
        actionError: '无法开始导入，请重试。',
        staticMessage: '当前站点为静态只读页面，不提供全部数据导入。',
        beforePrompt: () => confirmImport()
    });

    const requestBackupAuthorization = createPasswordGate((result, context) => context.resolve(result), {
        title: '输入备份时的密码',
        description: '请输入导出这份备份时使用的 6 位数字访问密码。导入后，网站将使用这个密码。',
        verifying: '正在验证密码并导入，请勿关闭页面…',
        verifyPassword: async (password, context) => {
            await verifyBackupPassword(context.entries, { token: context.token }, context.currentPassword, password);
            return uploadArchive(context.file, context.token, context.currentPassword, password);
        },
        onCancel: context => context?.resolve(null)
    });

    input.addEventListener('cancel', () => {
        importCapability = undefined;
        importCurrentPassword = '';
        restoreImportFocus();
    });

    async function chooseImport() {
        if (busy) return;
        await requestImportAuthorization();
    }

    function restoreImportFocus() {
        if (importTrigger?.isConnected) importTrigger.focus();
        else document.querySelector('[data-action="import-all-data"]')?.focus();
    }

    function closeImportSuccess() {
        if (!successDialog.open) return;
        successDialog.close();
        restoreImportFocus();
    }

    function showImportSuccess(message = '全部旅行数据已更新。') {
        if (successDialog.open) return;
        successDialog.querySelector('#dataImportSuccessDescription').textContent = message;
        successDialog.showModal();
        successDialog.querySelector('[data-import-success-close]').focus();
    }

    function importSuccessMessage(result) {
        const missing = Number(result?.missingMediaReferences) || 0;
        const summary = missing > 0
            ? `全部旅行数据已更新；备份中有 ${missing} 个图片或视频引用缺少对应文件，相关日记已保留，并会在页面中标明不可用媒体。`
            : '全部旅行数据已更新。';
        if (typeof result?.authPreserved !== 'boolean') return summary;
        return `${summary}${result.authPreserved ? '此网站的访问密码保持不变' : '此网站的访问密码已恢复为备份时的密码'}，请重新登录。`;
    }

    function finishConfirmation(confirmed) {
        if (!confirmationResolver) return;
        const resolve = confirmationResolver;
        confirmationResolver = null;
        dialog.close();
        restoreImportFocus();
        resolve(confirmed);
    }

    function confirmImport(file = null, hasBackupPassword = false) {
        if (dialog.open || confirmationResolver) return Promise.resolve(false);
        if (!file) importTrigger = document.activeElement;
        dialog.querySelector('#dataImportConfirmTitle').textContent = file ? '核对所选备份' : '替换当前旅行数据？';
        dialog.querySelector('[data-import-file-summary]').hidden = !file;
        dialog.querySelector('[data-import-file-name]').textContent = file?.name || '';
        dialog.querySelector('[data-import-confirm]').textContent = file ? '确认导入' : '继续验证';
        dialog.querySelector('#dataImportConfirmDescription').textContent = file
            ? (hasBackupPassword
                ? '导入后，网站访问密码将恢复为备份时的密码。若该密码与当前密码不一致，下一步将验证备份密码。'
                : '这份备份不含密码设置。导入后，此网站的访问密码保持不变。')
            : '导入会替换全部日记、图片、视频、头像和署名。替换前的数据会保存在回收站，可以恢复。';
        return new Promise(resolve => {
            confirmationResolver = resolve;
            dialog.showModal();
            dialog.querySelector('[data-import-cancel]').focus();
        });
    }

    async function uploadArchive(file, token, currentPassword, backupPassword = currentPassword) {
        importUploadProgress?.remove();
        const progress = importUploadProgress = createOperationProgress('导入全部数据');
        const headers = {
            'Content-Type': 'application/zip',
            'X-Travel-Token': token,
            ...(currentPassword === undefined ? {} : { 'X-Travel-Current-Password': currentPassword }),
            ...(backupPassword === undefined ? {} : { 'X-Travel-Backup-Password': backupPassword })
        };
        try {
            setStatus('正在校验备份并导入数据…');
            progress.phase('正在上传备份…');
            const response = await uploadWithProgress(new URL('api/travel-data', window.location.href), {
                method: 'POST', headers, body: file, credentials: 'same-origin', signal: progress.signal
            }, (loaded, total) => progress.update(loaded, total, '正在上传备份…'),
            () => {
                progress.setCancelable(false);
                progress.phase('备份上传完成，服务器正在校验并恢复数据，请勿关闭页面…');
            });
            let result;
            try { result = await response.json(); }
            catch { throw new Error('全部数据导入返回了无法识别的结果。'); }
            if (!response.ok || !result.imported) throw Object.assign(new Error(result.error || '全部数据导入失败。'), { code: result.code });
            progress.complete('备份已校验并导入。');
            return result;
        } catch (error) {
            if (progress.signal.aborted) { progress.fail(error); return null; }
            // 验证失败回到密码窗口重试，由该窗口提示错误，不遗留上一次上传的浮层。
            progress.remove();
            setStatus('');
            throw error;
        }
    }

    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        finishConfirmation(false);
    });

    dialog.addEventListener('click', event => {
        if (event.target.closest('[data-import-cancel]')) finishConfirmation(false);
        if (event.target.closest('[data-import-confirm]')) finishConfirmation(true);
    });

    dialog.addEventListener('keydown', event => {
        event.stopPropagation();
    });

    successDialog.addEventListener('cancel', event => {
        event.preventDefault();
        closeImportSuccess();
    });

    successDialog.addEventListener('click', event => {
        if (event.target.closest('[data-import-success-close]')) closeImportSuccess();
    });

    successDialog.addEventListener('keydown', event => {
        event.stopPropagation();
    });

    input.addEventListener('click', event => {
        event.stopPropagation();
    });

    input.addEventListener('change', async () => {
        const file = input.files[0];
        input.value = '';
        const capability = importCapability;
        const currentPassword = importCurrentPassword;
        importCapability = undefined;
        importCurrentPassword = '';
        if (!file || busy) return;
        if (file.size > MAXIMUM_ARCHIVE_BYTES) {
            setStatus(`全部数据 ZIP 备份不能超过 ${MAXIMUM_ARCHIVE_BYTES / 1024 / 1024} MiB，请使用文件系统备份恢复更大的档案。`);
            return;
        }
        busy = true;
        try {
            // 文件核对仍属于导入确认流程，全部确认后才在 uploadArchive 中显示进度。
            const entries = await readZipSource(file);
            if (entries.some(entry => entry.name === 'data/record-backup.json')) throw new Error('这是部分记录备份，请使用「导入部分记录」。');
            const hasBackupPassword = entries.some(entry => entry.name.toLowerCase() === '.secrets/auth.json');
            if (!await confirmImport(file, hasBackupPassword)) return;
            const token = writerToken(capability);
            let result;
            let needsBackupPassword = false;
            if (hasBackupPassword) {
                try { await verifyBackupPassword(entries, { token }, currentPassword); }
                catch (error) {
                    if (error.code !== 'BACKUP_PASSWORD_INVALID') throw error;
                    needsBackupPassword = true;
                }
            }
            if (needsBackupPassword) {
                result = await new Promise((resolve, reject) => {
                    void requestBackupAuthorization({ file, entries, token, currentPassword, resolve }).catch(reject);
                });
            } else result = await uploadArchive(file, token, currentPassword);
            if (!result) { setStatus('备份导入已取消。'); return; }
            importUploadProgress?.remove();
            const refreshProgress = createOperationProgress('刷新旅行档案');
            refreshProgress.setCancelable(false, '数据已导入，正在刷新页面。');
            refreshProgress.phase('数据已导入，正在刷新页面…');
            try { await onImported(); }
            catch {
                refreshProgress.complete('数据已导入，请手动刷新后查看。');
                setStatus('数据已导入，页面刷新失败。请手动刷新后查看。');
                showImportSuccess(`数据已导入，页面刷新失败。请手动刷新后查看。${importSuccessMessage(result)}`);
                return;
            }
            refreshProgress.complete('旅行档案已更新。');
            setStatus('');
            showImportSuccess(importSuccessMessage(result));
        } catch (error) {
            setStatus(error.message);
        } finally {
            busy = false;
        }
    });

    return { chooseImport, clearAll, exportAll, getExportHref, noteExportStarted,
        chooseRecordExport: paths => partialTransfer().chooseExport(paths), chooseRecordImport: () => partialTransfer().chooseImport() };
}
