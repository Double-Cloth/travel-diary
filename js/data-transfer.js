import { createPasswordGate, createPasswordSetup } from './record-password.js?v=20260912-import-password';

function setStatus(message) {
    const output = document.querySelector('[data-data-transfer-status]');
    if (output) output.textContent = message;
}

export function createDataTransfer(onImported) {
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
            <p class="data-import-confirm-note" id="dataImportConfirmDescription">将替换全部日记、照片、头像和访问密码。请先备份当前数据。</p>
            <p class="data-import-confirm-file">已选择 <strong data-import-file-name></strong></p>
            <div class="data-import-confirm-actions">
                <button class="paper-button" type="button" data-import-cancel>暂不导入</button>
                <button class="paper-button data-import-confirm-submit" type="button" data-import-confirm>确认导入</button>
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
    const requestImportPassword = createPasswordSetup({
        title: '设置导入密码',
        description: '备份未设置访问密码，请设置新的 6 位数字密码。',
        confirmation: '请再次输入相同密码；导入完成后将使用此密码。'
    });
    let busy = false;
    let importTrigger;
    let currentImportPassword = '';
    let confirmationResolver;

    function isLocalWriterHost() {
        return ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
    }

    function getExportHref() {
        const url = new URL(isLocalWriterHost() ? 'api/travel-data' : 'travel-diary-data.zip', window.location.href);
        if (!isLocalWriterHost()) url.searchParams.set('v', Date.now().toString());
        return url.href;
    }

    async function localToken() {
        if (!isLocalWriterHost()) {
            throw new Error('请在本机通过 localhost 打开页面后再操作。');
        }
        const response = await fetch(new URL('api/travel-records', window.location.href), { cache: 'no-store' });
        const result = await response.json();
        if (!response.ok || !result.token) throw new Error('本地数据服务不可用，请重新启动项目。');
        return result.token;
    }

    function noteExportStarted() {
        setStatus('全部数据备份已开始下载。');
    }

    function exportAll(downloadName = 'travel-diary-data.zip') {
        const link = document.createElement('a');
        link.href = getExportHref();
        link.download = downloadName;
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
        noteExportStarted();
    }

    function chooseImportWithPassword(password) {
        if (busy) return;
        currentImportPassword = password;
        importTrigger = document.activeElement;
        input.click();
    }

    const requestImportAuthorization = createPasswordGate(chooseImportWithPassword, {
        title: '导入数据验证',
        description: '输入当前 6 位数字密码后选择备份。',
        verifying: '验证成功，正在选择备份…',
        actionError: '无法开始导入，请重试。'
    });

    function chooseImport() {
        if (busy) return;
        if (!isLocalWriterHost()) {
            setStatus('导入仅支持本机 localhost 页面；当前页面仍可导出备份。');
            return;
        }
        void requestImportAuthorization();
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

    function finishConfirmation(confirmed) {
        if (!confirmationResolver) return;
        const resolve = confirmationResolver;
        confirmationResolver = null;
        dialog.close();
        restoreImportFocus();
        resolve(confirmed);
    }

    function confirmImport(file) {
        if (dialog.open || confirmationResolver) return Promise.resolve(false);
        dialog.querySelector('[data-import-file-name]').textContent = file.name;
        return new Promise(resolve => {
            confirmationResolver = resolve;
            dialog.showModal();
            dialog.querySelector('[data-import-cancel]').focus();
        });
    }

    async function uploadArchive(file, token, currentPassword, password = '') {
        const headers = {
            'Content-Type': 'application/zip',
            'X-Travel-Token': token,
            'X-Travel-Current-Password': currentPassword
        };
        if (password) headers['X-Travel-Import-Password'] = password;
        const response = await fetch(new URL('api/travel-data', window.location.href), {
            method: 'POST',
            headers,
            body: file,
            signal: AbortSignal.timeout(120000)
        });
        let result;
        try { result = await response.json(); }
        catch { throw new Error('全部数据导入返回了无法识别的结果。'); }
        return { response, result };
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
        const currentPassword = currentImportPassword;
        currentImportPassword = '';
        if (!file || busy) return;
        if (!await confirmImport(file)) return;
        busy = true;
        setStatus('正在校验备份并导入数据…');
        try {
            const token = await localToken();
            let { response, result } = await uploadArchive(file, token, currentPassword);
            if (!response.ok && result.code === 'IMPORT_PASSWORD_REQUIRED') {
                setStatus('备份校验通过，请设置新的访问密码。');
                const password = await requestImportPassword();
                if (!password) {
                    setStatus('已取消导入，当前数据未修改。');
                    return;
                }
                setStatus('正在设置密码并导入已校验的备份…');
                ({ response, result } = await uploadArchive(file, token, currentPassword, password));
            }
            if (!response.ok || !result.imported) throw new Error(result.error || '全部数据导入失败。');
            try { await onImported(); }
            catch {
                setStatus('数据已导入，页面刷新失败。请手动刷新后查看。');
                showImportSuccess('数据已导入，页面刷新失败。请手动刷新后查看。');
                return;
            }
            setStatus('');
            showImportSuccess();
        } catch (error) {
            setStatus(error.message);
        } finally {
            busy = false;
        }
    });

    return { chooseImport, exportAll, getExportHref, noteExportStarted };
}
