const MEMORY_DOWNLOAD_LIMIT = 256 * 1024 * 1024;
const TRANSFER_TIMEOUT = 8 * 60 * 60 * 1000;
const TRANSFER_IDLE_TIMEOUT = 2 * 60 * 1000;

// 总时限允许大文件慢速传输；无字节进展时单独超时，避免断网后等待数小时。
function monitorTransfer(options, interruptionMessage, url) {
    const controller = new AbortController();
    const signal = controller.signal;
    let idleTimer;
    const abort = () => controller.abort(options.signal.reason);
    const offline = () => controller.abort(new Error(interruptionMessage));
    let observeNetwork = true;
    try {
        const hostname = new URL(url, window.location?.href).hostname;
        // 外网离线不影响本机服务器；回环地址按实际请求错误和停滞判断。
        observeNetwork = hostname !== 'localhost' && hostname !== '[::1]' && !/^127\.\d+\.\d+\.\d+$/.test(hostname);
    } catch { /* 相对地址缺少页面上下文时仍保留断网检测。 */ }
    const totalTimer = setTimeout(() => controller.abort(new Error(`传输超时。${interruptionMessage}`)), options.timeout ?? TRANSFER_TIMEOUT);
    totalTimer.unref?.();
    function pause() { clearTimeout(idleTimer); }
    function touch(timeout = options.idleTimeout ?? TRANSFER_IDLE_TIMEOUT) {
        pause();
        if (signal.aborted) return;
        idleTimer = setTimeout(() => controller.abort(new Error(`长时间没有传输进展。${interruptionMessage}`)), timeout);
        idleTimer.unref?.();
    }
    function wait(pending) {
        return new Promise((resolve, reject) => {
            const interrupted = () => reject(signal.reason);
            signal.addEventListener('abort', interrupted, { once: true });
            Promise.resolve(pending).then(resolve, reject).finally(() => signal.removeEventListener('abort', interrupted));
            if (signal.aborted) interrupted();
        });
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    if (observeNetwork) window.addEventListener?.('offline', offline);
    if (options.signal?.aborted) abort();
    else if (observeNetwork && window.navigator?.onLine === false) offline();
    return { signal, touch, pause, wait, abort: reason => controller.abort(reason), dispose() {
        pause();
        clearTimeout(totalTimer);
        options.signal?.removeEventListener('abort', abort);
        if (observeNetwork) window.removeEventListener?.('offline', offline);
    } };
}

export function formatProgressBytes(bytes) {
    if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
    const units = ['KiB', 'MiB', 'GiB'];
    let value = bytes / 1024;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${value.toFixed(1)} ${units[index]}`;
}

export function createOperationProgress(title) {
    const root = document.createElement('section');
    root.className = 'operation-progress operation-progress-floating';
    root.setAttribute('aria-label', title);
    root.innerHTML = `<div class="operation-progress-heading"><strong data-progress-title></strong><div class="operation-progress-actions"><button type="button" class="paper-button" data-progress-cancel>取消</button><button type="button" class="paper-button" data-progress-dismiss aria-label="关闭进度提示" hidden>关闭</button></div></div>
        <p data-progress-message role="status" aria-live="polite" aria-atomic="true"></p>
        <progress max="100" aria-label="${title}" data-progress-bar></progress>
        <p class="operation-progress-detail" data-progress-detail></p>`;
    root.querySelector('[data-progress-title]').textContent = title;
    const message = root.querySelector('[data-progress-message]');
    const bar = root.querySelector('[data-progress-bar]');
    const detail = root.querySelector('[data-progress-detail]');
    const dismiss = root.querySelector('[data-progress-dismiss]');
    const cancelButton = root.querySelector('[data-progress-cancel]');
    const controller = new AbortController();
    let timer;
    let finished = false;
    let lastAnnouncement = '';
    let lastRender = 0;
    let shown = false;
    let removed = false;
    let modalHost;
    function releaseModal() {
        modalHost?.removeEventListener?.('close', moveToPage);
        modalHost = undefined;
    }
    function moveToPage() {
        releaseModal();
        if (removed) return;
        // 密码窗口关闭后，完成或错误提示仍需留在可见页面上。
        document.body.append(root);
        if (typeof root.showPopover === 'function') root.showPopover();
    }
    function show() {
        if (shown || removed) return;
        shown = true;
        const activeModal = document.querySelector('dialog[open]');
        const host = activeModal?.open ? activeModal : document.body;
        host.append(root);
        if (host === activeModal) {
            modalHost = activeModal;
            modalHost.addEventListener?.('close', moveToPage);
        }
        // 实际处理开始后才显示；挂在此时的 dialog 下以保留模态期间的交互能力。
        if (typeof root.showPopover === 'function') {
            root.setAttribute('popover', 'manual');
            root.showPopover();
        }
    }
    function remove() { removed = true; clearTimeout(timer); releaseModal(); root.remove?.(); }
    dismiss.addEventListener('click', remove);
    function setCancelable(value, reason = '服务器正在处理，暂不能取消。') {
        cancelButton.disabled = !value || controller.signal.aborted || finished;
        cancelButton.title = value ? '取消当前操作' : reason;
    }
    function cancel() {
        if (finished || cancelButton.disabled) return;
        controller.abort(new DOMException('操作已取消。', 'AbortError'));
        cancelButton.disabled = true;
        message.textContent = '正在取消…';
        detail.textContent = '正在停止传输或处理…';
        bar.removeAttribute('value');
    }
    cancelButton.addEventListener('click', cancel);
    function phase(text) {
        if (finished || controller.signal.aborted) return;
        show();
        message.textContent = text;
        bar.removeAttribute?.('value');
        detail.textContent = '正在处理…';
        lastAnnouncement = '';
        lastRender = 0;
    }
    function update(loaded, total, text = '正在处理…', unit = 'bytes') {
        if (finished || controller.signal.aborted) return;
        show();
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
        const cancelled = controller.signal.aborted;
        root.setAttribute('data-state', cancelled ? 'cancelled' : failed ? 'error' : 'complete');
        message.textContent = cancelled ? '操作已取消。' : text;
        if (failed || cancelled) bar.removeAttribute?.('value');
        else bar.value = 100;
        bar.hidden = failed || cancelled;
        detail.textContent = cancelled ? '可重新开始操作。' : failed ? '请重试，或查看操作提示。' : '处理完成';
        cancelButton.hidden = true;
        dismiss.hidden = false;
        if (!failed) {
            timer = setTimeout(remove, 6000);
            timer.unref?.();
        }
    }
    return { phase, update, complete: text => finish(text), fail: error => finish(error?.message || String(error), true), remove,
        signal: controller.signal, cancel, setCancelable, throwIfCancelled: () => controller.signal.throwIfAborted() };
}

// Fetch 尚不提供普遍可用的上传进度事件；原生 XHR 保留同源 Cookie、令牌和 HTTP 错误响应。
export function uploadWithProgress(url, options, onProgress, onUploaded = () => {}) {
    const interruptionMessage = '网络连接中断，操作结果尚未确认。请恢复网络后另开页面核对，再决定是否重试。';
    if (typeof XMLHttpRequest === 'undefined') {
        const monitor = monitorTransfer(options, interruptionMessage, url);
        // 无上传进度事件时无法区分慢速上传与停滞，仅使用断网检测和总时限。
        if (monitor.signal.aborted) { monitor.dispose(); return Promise.reject(monitor.signal.reason); }
        return monitor.wait(fetch(url, { ...options, signal: monitor.signal }))
            .finally(() => monitor.dispose());
    }
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const monitor = monitorTransfer(options, interruptionMessage, url);
        const signal = monitor.signal;
        let settled = false;
        let uploaded = false;
        let loaded = 0;
        const abort = () => { settle(reject, signal.reason); xhr.abort(); };
        function settle(callback, value) {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', abort);
            monitor.dispose();
            callback(value);
        }
        if (signal.aborted) { settle(reject, signal.reason); return; }
        xhr.upload.onprogress = event => {
            if (settled || uploaded) return;
            if (event.loaded > loaded) { loaded = event.loaded; monitor.touch(); }
            onProgress?.(event.loaded, event.lengthComputable ? event.total : 0);
        };
        xhr.upload.onload = () => {
            if (settled) return;
            uploaded = true;
            // 服务端校验大备份期间可能没有响应字节，继续使用总时限和断网监听。
            monitor.pause();
            onUploaded();
        };
        xhr.onload = () => settle(resolve, {
            ok: xhr.status >= 200 && xhr.status < 300,
            status: xhr.status,
            json: async () => JSON.parse(xhr.responseText)
        });
        xhr.onerror = () => settle(reject, new Error(interruptionMessage));
        xhr.ontimeout = () => settle(reject, new Error(`传输超时。${interruptionMessage}`));
        xhr.onabort = () => settle(reject, signal?.reason || new DOMException('传输已取消。', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        try {
            xhr.open(options.method || 'POST', url);
            xhr.timeout = options.timeout ?? TRANSFER_TIMEOUT;
            for (const [name, value] of Object.entries(options.headers || {})) xhr.setRequestHeader(name, value);
            monitor.touch();
            xhr.send(options.body);
        }
        catch (error) { settle(reject, error); }
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
    let response;
    let monitor;
    const cancellation = AbortSignal.any([progress.signal, options.signal].filter(Boolean));
    try {
        cancellation.throwIfAborted();
        // 支持时直接流式写盘，大视频与备份不会在内存中累积。
        if (typeof window.showSaveFilePicker === 'function') {
            try {
                const handle = await window.showSaveFilePicker({ suggestedName: name });
                cancellation.throwIfAborted();
                writable = await handle.createWritable();
            } catch (error) {
                if (error.name === 'AbortError' && !cancellation.aborted) { progress.remove(); return { cancelled: true }; }
                if (error.name !== 'SecurityError') throw error;
            }
        }
        monitor = monitorTransfer({ ...options, signal: cancellation }, '下载连接中断，请检查网络后重新下载；未完成的文件不会保存。', url);
        const { signal } = monitor;
        progress.phase('正在连接并准备下载…');
        signal.throwIfAborted();
        monitor.touch(options.responseTimeout);
        response = await monitor.wait(fetch(url, { credentials: 'same-origin', ...options, signal }));
        if (!response.ok) {
            let result;
            try { result = await monitor.wait(response.json()); } catch { signal.throwIfAborted(); /* 非 JSON 响应使用通用提示。 */ }
            throw new Error(result?.error || `下载失败（HTTP ${response.status}）。`);
        }
        const length = response.headers.get('Content-Encoding') ? null : response.headers.get('Content-Length');
        const expected = length !== null && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : null;
        const total = expected ?? 0;
        const backupReceipt = response.headers.get('X-Travel-Backup-Receipt');
        async function handOff() {
            monitor.pause();
            if (reader) await reader.cancel();
            else await response.body?.cancel();
            signal.throwIfAborted();
            let nativeHref = url;
            if (backupReceipt) {
                const nativeUrl = new URL(url, window.location.href);
                nativeUrl.searchParams.set('backupReceipt', backupReceipt);
                nativeHref = nativeUrl.href;
            }
            startNativeDownload(nativeHref, name);
            progress.remove();
            // 浏览器接管后，网页无法观测其落盘进度，不能宣称已下载完成。
            return { handedOff: true, ...(backupReceipt ? { backupReceipt } : {}) };
        }
        if (!writable && total > MEMORY_DOWNLOAD_LIMIT) return await handOff();
        if (!response.body?.getReader) throw new Error('当前浏览器不支持流式下载，请使用较新的浏览器。');
        reader = response.body.getReader();
        const parts = [];
        // 合并网络小块，减少 File System Access 跨进程写盘次数，并保持固定内存占用。
        const writeBuffer = writable ? new Uint8Array(1024 * 1024) : null;
        let buffered = 0;
        let loaded = 0;
        progress.update(0, total, '正在下载…');
        while (true) {
            monitor.touch();
            const { done, value } = await monitor.wait(reader.read());
            monitor.pause();
            signal.throwIfAborted();
            if (done) break;
            loaded += value.byteLength;
            if (expected !== null && loaded > expected) throw new Error('下载长度与服务器声明不符，文件未保存。请重新下载。');
            if (writable) {
                for (let offset = 0; offset < value.byteLength;) {
                    signal.throwIfAborted();
                    const length = Math.min(writeBuffer.byteLength - buffered, value.byteLength - offset);
                    writeBuffer.set(value.subarray(offset, offset + length), buffered);
                    buffered += length;
                    offset += length;
                    if (buffered === writeBuffer.byteLength) {
                        await writable.write(writeBuffer);
                        buffered = 0;
                    }
                }
            }
            else {
                if (loaded > MEMORY_DOWNLOAD_LIMIT) return await handOff();
                parts.push(value);
            }
            progress.update(loaded, total, '正在下载…');
        }
        if (expected !== null && loaded !== expected) throw new Error('下载不完整，文件未保存。请检查网络后重新下载。');
        signal.throwIfAborted();
        if (buffered) await writable.write(writeBuffer.subarray(0, buffered));
        signal.throwIfAborted();
        monitor.dispose();
        progress.setCancelable?.(false, '文件正在保存，暂不能取消。');
        progress.phase('下载传输完成，正在保存文件…');
        if (writable) { await writable.close(); writable = null; }
        else saveBlobDownload(new Blob(parts, { type: response.headers.get('Content-Type') || 'application/octet-stream' }), name);
        progress.complete(writable === null ? '文件已保存。' : '文件已传输完成，已交给浏览器保存。');
        return { handedOff: false, ...(backupReceipt ? { backupReceipt } : {}) };
    } catch (error) {
        if (monitor?.signal.aborted) error = monitor.signal.reason;
        else if (error instanceof TypeError) error = new Error('下载连接中断，请检查网络后重新下载；未完成的文件不会保存。', { cause: error });
        monitor?.abort(error);
        try { await reader?.cancel(); } catch { /* 保留原始错误。 */ }
        if (!reader) { try { await response?.body?.cancel(); } catch { /* 保留原始错误。 */ } }
        try { await writable?.abort(); } catch { /* 保留原始错误。 */ }
        progress.fail(error);
        if (progress.signal?.aborted || options.signal?.aborted) return { cancelled: true };
        throw error;
    } finally {
        monitor?.dispose();
        reader?.releaseLock();
    }
}
