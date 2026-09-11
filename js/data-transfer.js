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
    let busy = false;

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
        input.click();
    }

    input.addEventListener('change', async () => {
        const file = input.files[0];
        input.value = '';
        if (!file || busy) return;
        if (!window.confirm('导入后，当前全部旅行数据将被替换。请确认已备份现有数据。')) return;
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
