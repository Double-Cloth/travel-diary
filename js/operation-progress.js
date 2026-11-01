const MEMORY_DOWNLOAD_LIMIT = 256 * 1024 * 1024;

export function formatProgressBytes(bytes) {
    if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
    const units = ['KiB', 'MiB', 'GiB'];
    let value = bytes / 1024;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${value.toFixed(1)} ${units[index]}`;
}

export function createOperationProgress(title) {
    const activeModal = document.querySelector('dialog[open]');
    const host = activeModal?.open ? activeModal : document.body;
    const root = document.createElement('section');
    root.className = 'operation-progress operation-progress-floating';
    root.setAttribute('aria-label', title);
    root.innerHTML = `<div class="operation-progress-heading"><strong data-progress-title></strong><button type="button" class="paper-button" data-progress-dismiss aria-label="关闭进度提示" hidden>关闭</button></div>
        <p data-progress-message role="status" aria-live="polite" aria-atomic="true"></p>
        <progress max="100" aria-label="${title}" data-progress-bar></progress>
        <p class="operation-progress-detail" data-progress-detail></p>`;
    root.querySelector('[data-progress-title]').textContent = title;
    const message = root.querySelector('[data-progress-message]');
    const bar = root.querySelector('[data-progress-bar]');
    const detail = root.querySelector('[data-progress-detail]');
    const dismiss = root.querySelector('[data-progress-dismiss]');
    let timer;
    let finished = false;
    let lastAnnouncement = '';
    let lastRender = 0;
    host.append(root);
    // 统一进入顶层悬浮显示；挂在当前 dialog 下以保留模态期间的交互能力。
    if (typeof root.showPopover === 'function') {
        root.setAttribute('popover', 'manual');
        root.showPopover();
    }
    function remove() { clearTimeout(timer); root.remove?.(); }
    dismiss.addEventListener('click', remove);
    function phase(text) {
        if (finished) return;
        message.textContent = text;
        bar.removeAttribute?.('value');
        detail.textContent = '正在处理…';
        lastAnnouncement = '';
        lastRender = 0;
    }
    function update(loaded, total, text = '正在处理…', unit = 'bytes') {
        if (finished) return;
        const now = Date.now();
        if (now - lastRender < 80 && loaded !== total) return;
        lastRender = now;
        const known = Number.isFinite(total) && total > 0;
        const percent = known ? Math.min(100, Math.floor(Math.max(0, loaded) / total * 100)) : null;
        if (known) bar.value = percent;
        else bar.removeAttribute?.('value');
        const amounts = unit === 'files'
            ? `${loaded} / ${total} 项`
            : `${formatProgressBytes(loaded)}${known ? ` / ${formatProgressBytes(total)}` : ''}`;
        detail.textContent = `${percent === null ? '' : `${percent}% · `}${amounts}`;
        // 视觉数值持续更新，读屏仅播报阶段与每 10% 的里程碑。
        const announcement = `${text}${percent === null ? '' : ` ${Math.floor(percent / 10) * 10}%`}`;
        if (announcement !== lastAnnouncement) { message.textContent = announcement; lastAnnouncement = announcement; }
    }
    function finish(text, failed = false) {
        if (finished) return;
        finished = true;
        root.setAttribute('data-state', failed ? 'error' : 'complete');
        message.textContent = text;
        if (failed) bar.removeAttribute?.('value');
        else bar.value = 100;
        bar.hidden = failed;
        detail.textContent = failed ? '请重试，或查看操作提示。' : '处理完成';
        dismiss.hidden = false;
        if (!failed) {
            timer = setTimeout(remove, 6000);
            timer.unref?.();
        }
    }
    phase('正在准备…');
    return { phase, update, complete: text => finish(text), fail: error => finish(error?.message || String(error), true), remove };
}

// Fetch 尚不提供普遍可用的上传进度事件；原生 XHR 保留同源 Cookie、令牌和 HTTP 错误响应。
export function uploadWithProgress(url, options, onProgress, onUploaded = () => {}) {
    if (typeof XMLHttpRequest === 'undefined') return fetch(url, options);
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(options.method || 'POST', url);
        xhr.timeout = options.timeout || 8 * 60 * 60 * 1000;
        for (const [name, value] of Object.entries(options.headers || {})) xhr.setRequestHeader(name, value);
        xhr.upload.onprogress = event => onProgress?.(event.loaded, event.lengthComputable ? event.total : 0);
        xhr.upload.onload = onUploaded;
        xhr.onload = () => resolve({
            ok: xhr.status >= 200 && xhr.status < 300,
            status: xhr.status,
            json: async () => JSON.parse(xhr.responseText)
        });
        xhr.onerror = () => reject(new Error('网络连接中断，请检查网络后重试。'));
        xhr.ontimeout = () => reject(new Error('传输超时，请稍后重试。'));
        xhr.onabort = () => reject(new Error('传输已取消。'));
        xhr.send(options.body);
    });
}

export function saveBlobDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    startNativeDownload(url, name);
    const timer = setTimeout(() => URL.revokeObjectURL(url), 60000);
    timer.unref?.();
}

function startNativeDownload(url, name) {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
}

export async function downloadWithProgress(url, name, progress, options = {}) {
    let writable;
    let reader;
    try {
        // 支持时直接流式写盘，大视频与备份不会在内存中累积。
        if (typeof window.showSaveFilePicker === 'function') {
            try {
                const handle = await window.showSaveFilePicker({ suggestedName: name });
                writable = await handle.createWritable();
            } catch (error) {
                if (error.name === 'AbortError') { progress.remove(); return { cancelled: true }; }
                if (error.name !== 'SecurityError') throw error;
            }
        }
        progress.phase('正在连接并准备下载…');
        const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(8 * 60 * 60 * 1000), ...options });
        if (!response.ok) {
            let result;
            try { result = await response.json(); } catch { /* 非 JSON 响应使用通用提示。 */ }
            throw new Error(result?.error || `下载失败（HTTP ${response.status}）。`);
        }
        const total = response.headers.get('Content-Encoding') ? 0 : Number(response.headers.get('Content-Length')) || 0;
        async function handOff() {
            if (reader) await reader.cancel();
            else await response.body?.cancel();
            startNativeDownload(url, name);
            progress.remove();
            // 浏览器接管后，网页无法观测其落盘进度，不能宣称已下载完成。
            return { handedOff: true };
        }
        if (!writable && total > MEMORY_DOWNLOAD_LIMIT) return await handOff();
        if (!response.body?.getReader) throw new Error('当前浏览器不支持流式下载，请使用较新的浏览器。');
        reader = response.body.getReader();
        const parts = [];
        let loaded = 0;
        progress.update(0, total, '正在下载…');
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            loaded += value.byteLength;
            if (writable) await writable.write(value);
            else {
                if (loaded > MEMORY_DOWNLOAD_LIMIT) return await handOff();
                parts.push(value);
            }
            progress.update(loaded, total, '正在下载…');
        }
        progress.phase('下载传输完成，正在保存文件…');
        if (writable) { await writable.close(); writable = null; }
        else saveBlobDownload(new Blob(parts, { type: response.headers.get('Content-Type') || 'application/octet-stream' }), name);
        progress.complete(writable === null ? '文件已保存。' : '文件已传输完成，已交给浏览器保存。');
        return { handedOff: false };
    } catch (error) {
        try { await reader?.cancel(); } catch { /* 保留原始错误。 */ }
        try { await writable?.abort(); } catch { /* 保留原始错误。 */ }
        progress.fail(error);
        throw error;
    } finally {
        reader?.releaseLock();
    }
}
