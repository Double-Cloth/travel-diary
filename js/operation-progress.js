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
    function handOff() {
        if (finished || controller.signal.aborted) return;
        phase('已交给浏览器下载');
        finished = true;
        root.setAttribute('data-state', 'browser-managed');
        detail.textContent = '请在浏览器下载列表查看进度、取消下载或确认保存结果。';
        cancelButton.hidden = true;
        dismiss.hidden = false;
        dismiss.textContent = '关闭提示';
        dismiss.setAttribute('aria-label', '关闭进度提示，下载仍由浏览器管理');
        timer = setTimeout(remove, 6000);
        timer.unref?.();
    }
    return { phase, update, handOff, complete: text => finish(text), fail: error => finish(error?.message || String(error), true), remove,
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

export function saveBlobDownload(blob, name, progress) {
    progress?.throwIfCancelled();
    const url = URL.createObjectURL(blob);
    try {
        startNativeDownload(url, name);
        progress?.handOff();
    } catch (error) {
        URL.revokeObjectURL(url);
        progress?.fail(error);
        throw error;
    }
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
    let monitor;
    const cancellation = AbortSignal.any([progress.signal, options.signal].filter(Boolean));
    try {
        cancellation.throwIfAborted();
        // 仅预检权限和文件是否可用，正文统一由浏览器下载管理器接收及保存。
        monitor = monitorTransfer({ ...options, signal: cancellation }, '下载准备中断，请检查网络后重新下载。', url);
        monitor.signal.throwIfAborted();
        monitor.touch(options.responseTimeout);
        const response = await monitor.wait(fetch(url, { ...options, credentials: 'same-origin', method: 'HEAD', signal: monitor.signal }));
        monitor.signal.throwIfAborted();
        if (!response.ok) throw new Error(`下载准备失败（HTTP ${response.status}），请确认文件可用及登录状态后重试。`);
        startNativeDownload(url, name);
        progress.handOff();
        return { handedOff: true };
    } catch (error) {
        if (monitor?.signal.aborted) error = monitor.signal.reason;
        else if (error instanceof TypeError) error = new Error('下载准备中断，请检查网络后重新下载。', { cause: error });
        monitor?.abort(error);
        progress.fail(error);
        if (cancellation.aborted) return { cancelled: true };
        throw error;
    } finally {
        monitor?.dispose();
    }
}
