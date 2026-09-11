function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

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

    async function localToken() {
        if (!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) {
            throw new Error('全部数据只能在本机 npm start 页面导入或导出。');
        }
        const response = await fetch(new URL('api/travel-records', window.location.href), { cache: 'no-store' });
        const result = await response.json();
        if (!response.ok || !result.token) throw new Error('本地数据服务不可用，请重新启动项目。');
        return result.token;
    }

    async function exportAll() {
        if (busy) return;
        busy = true;
        setStatus('正在打包 data 目录…');
        try {
            const token = await localToken();
            const response = await fetch(new URL('api/travel-data', window.location.href), {
                headers: { 'X-Travel-Token': token }, cache: 'no-store'
            });
            if (!response.ok) {
                const result = await response.json().catch(() => ({}));
                throw new Error(result.error || '全部数据导出失败。');
            }
            const today = new Date().toISOString().slice(0, 10);
            downloadBlob(await response.blob(), `travel-diary-data-${today}.zip`);
            setStatus('已发起全部数据 ZIP 下载。');
        } catch (error) {
            setStatus(error.message);
        } finally {
            busy = false;
        }
    }

    function chooseImport() {
        if (busy) return;
        input.click();
    }

    input.addEventListener('change', async () => {
        const file = input.files[0];
        input.value = '';
        if (!file || busy) return;
        if (!window.confirm('导入将完整替换当前 data 目录。请确认已导出当前数据备份后再继续。')) return;
        busy = true;
        setStatus('正在校验并导入全部数据…');
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
            setStatus(`已导入 ${result.files} 个文件，页面数据已刷新。`);
        } catch (error) {
            setStatus(error.message);
        } finally {
            busy = false;
        }
    });

    return { exportAll, chooseImport };
}
