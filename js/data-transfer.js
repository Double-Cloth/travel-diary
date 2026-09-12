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
            <p class="data-import-confirm-note" id="dataImportConfirmDescription">导入后，当前全部旅行数据将被替换。请确认已备份现有数据。</p>
            <p class="data-import-confirm-file">已选择 <strong data-import-file-name></strong></p>
            <div class="data-import-confirm-actions">
                <button class="paper-button" type="button" data-import-cancel>暂不导入</button>
                <button class="paper-button data-import-confirm-submit" type="button" data-import-confirm>确认导入</button>
            </div>
        </div>`;
    document.body.append(dialog);
    let busy = false;
    let importTrigger;
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
            throw new Error('请在本机通过 npm start 打开页面后再操作。');
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

    function chooseImport() {
        if (busy) return;
        if (!isLocalWriterHost()) {
            setStatus('导入仅支持本机 npm start 页面；当前页面仍可导出备份。');
            return;
        }
        importTrigger = document.activeElement;
        input.click();
    }

    function restoreImportFocus() {
        if (importTrigger?.isConnected) importTrigger.focus();
        else document.querySelector('[data-action="import-all-data"]')?.focus();
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

    input.addEventListener('change', async () => {
        const file = input.files[0];
        input.value = '';
        if (!file || busy) return;
        if (!await confirmImport(file)) return;
        busy = true;
        setStatus('正在校验备份并导入数据…');
        try {
            const token = await localToken();
            const response = await fetch(new URL('api/travel-data', window.location.href), {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': token },
                body: file,
                signal: AbortSignal.timeout(120000)
            });
            const result = await response.json();
            if (!response.ok || !result.imported) throw new Error(result.error || '全部数据导入失败。');
            await onImported();
            setStatus(`已导入 ${result.files} 个文件，并刷新页面数据。`);
        } catch (error) {
            setStatus(error.message);
        } finally {
            busy = false;
        }
    });

    return { chooseImport, exportAll, getExportHref, noteExportStarted };
}
