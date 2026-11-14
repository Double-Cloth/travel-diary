// 保留原扩展名，避免同名图片或视频的预览互相覆盖；输入为已编码的项目相对 URL。
export function getMediaPreviewUrl(src) {
    if (typeof src !== 'string') return '';
    const path = src.split('?')[0];
    if (!/^data\/(photos|videos)\/.+/.test(path) && path !== 'data/profile/profile-picture.png') return '';
    try {
        if (/[\\#]/.test(path) || !path.split('/').every(part => part && !/[\\/\u0000-\u001f]/.test(decodeURIComponent(part)) && !['.', '..'].includes(decodeURIComponent(part)))) return '';
    } catch { return ''; }
    return path.replace(/^data\//, '.cache/media-previews/') + '.jpg' + src.slice(path.length);
}

const pending = new Map();
const imageRequests = new WeakMap();
const previews = new Map();
const previewUrls = new WeakMap();
const MAXIMUM_PREVIEW_BYTES = 32 * 1024 * 1024;
const MAXIMUM_PREVIEW_COUNT = 256;
let previewBytes = 0;
let cacheGeneration = 0;
const queue = [];
let active = 0;
const CACHE_NAME = 'travel-media-previews-canvas-v1';

function releasePreviewUrl(blob) {
    const entry = previewUrls.get(blob);
    if (!entry) return;
    entry.cached = false;
    if (!entry.users) {
        URL.revokeObjectURL(entry.url);
        previewUrls.delete(blob);
    }
}

// 保留压缩结果和 Blob URL，页面重绘与列表筛选无需再次请求或生成缩略图。
function rememberPreview(key, blob) {
    const previous = previews.get(key);
    if (previous) {
        previewBytes -= previous.size;
        releasePreviewUrl(previous);
        previews.delete(key);
    }
    previews.set(key, blob);
    previewBytes += blob.size;
    while (previewBytes > MAXIMUM_PREVIEW_BYTES || previews.size > MAXIMUM_PREVIEW_COUNT) {
        const [oldest, value] = previews.entries().next().value;
        previews.delete(oldest);
        previewBytes -= value.size;
        releasePreviewUrl(value);
    }
    return blob;
}

export function clearMediaPreviewCache() {
    cacheGeneration++;
    pending.clear();
    for (const blob of previews.values()) {
        releasePreviewUrl(blob);
    }
    previews.clear();
    previewBytes = 0;
}

export function isMediaPreviewVisible(target) {
    if (!target.isConnected || target.closest?.('[hidden]')) return false;
    const rect = target.getBoundingClientRect();
    const height = globalThis.innerHeight || globalThis.window?.innerHeight;
    const width = globalThis.innerWidth || globalThis.window?.innerWidth;
    if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= height
        || rect.right <= 0 || rect.left >= width) return false;
    // 独立滚动纸页、折叠区和对话框的裁切也属于不可见区域。
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
        // 折叠内容仍可能返回有效矩形，只有 summary 内的预览保持可见。
        if (parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(target)) return false;
        if (parent.tagName === 'DIALOG' && !parent.open) return false;
        const style = getComputedStyle(parent);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY + style.overflowX)) {
            const bounds = parent.getBoundingClientRect();
            if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (rect.bottom <= bounds.top || rect.top >= bounds.bottom)) return false;
            if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (rect.right <= bounds.left || rect.left >= bounds.right)) return false;
        }
    }
    return true;
}

const visibleTasks = new Map();
let visibilityObserver;
let removalObserver;
let fallbackListening = false;
let visibilityCheckTimer;

function scheduleVisibilityCheck() {
    if (visibilityCheckTimer !== undefined) return;
    // 列表项可在 async 工厂返回后才挂载，等本轮 DOM 更新结束再清理离开页面的目标。
    visibilityCheckTimer = setTimeout(() => {
        visibilityCheckTimer = undefined;
        checkVisibleTasks();
    }, 0);
}

function releaseVisibilityObservers() {
    if (visibleTasks.size) return;
    visibilityObserver?.disconnect();
    visibilityObserver = undefined;
    removalObserver?.disconnect();
    removalObserver = undefined;
    clearTimeout(visibilityCheckTimer);
    visibilityCheckTimer = undefined;
    if (fallbackListening) {
        removeEventListener('scroll', checkVisibleTasks, true);
        removeEventListener('resize', checkVisibleTasks);
        removeEventListener('toggle', checkVisibleTasks, true);
        fallbackListening = false;
    }
}

function checkVisibleTasks() {
    for (const [target, start] of visibleTasks) {
        if (!target.isConnected) {
            visibilityObserver?.unobserve(target);
            visibleTasks.delete(target);
        } else if (isMediaPreviewVisible(target)) start();
    }
    releaseVisibilityObservers();
}

// 所有缩略图共用观察器；DOM 被替换时及时解除观察，旧列表不继续读取。
export function observeMediaVisibility(target, task) {
    if (!visibilityObserver && typeof IntersectionObserver === 'function') {
        visibilityObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (entry.isIntersecting && isMediaPreviewVisible(entry.target)) visibleTasks.get(entry.target)?.();
            }
        }, { rootMargin: '0px', threshold: [0, 0.0001] });
    }
    const stop = () => {
        if (visibleTasks.get(target) !== start) return;
        visibleTasks.delete(target);
        visibilityObserver?.unobserve(target);
        releaseVisibilityObservers();
    };
    const start = () => { stop(); void task(); };
    visibleTasks.set(target, start);
    visibilityObserver?.observe(target);
    if (!removalObserver && typeof MutationObserver === 'function') {
        removalObserver = new MutationObserver(scheduleVisibilityCheck);
        removalObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'class', 'style'] });
    }
    if (!visibilityObserver && !fallbackListening && globalThis.addEventListener) {
        fallbackListening = true;
        addEventListener('scroll', checkVisibleTasks, true);
        addEventListener('resize', checkVisibleTasks);
        addEventListener('toggle', checkVisibleTasks, true);
    }
    // 取消后重新观察时目标可能一直处于相交状态，主动检查保证它能恢复加载。
    scheduleVisibilityCheck();
    return stop;
}

// 每次最多处理两个媒体，重复列表项共用读取与生成任务。
function schedule(task) {
    return new Promise((resolve, reject) => {
        queue.push(async () => {
            active += 1;
            try { resolve(await task()); } catch (error) { reject(error); }
            finally { active -= 1; queue.shift()?.(); }
        });
        if (active < 2) queue.shift()?.();
    });
}

// 列表缓存缺失、本地待上传文件和批量生成共用压缩逻辑。
export async function createMediaPreview(source, kind, { width: limitWidth = 640, height: limitHeight = 640, fit = 'contain', quality = 0.78 } = {}) {
    const video = kind === 'video';
    const media = document.createElement(video ? 'video' : 'img');
    const localUrl = source instanceof Blob ? URL.createObjectURL(source) : '';
    let bitmap;
    if (video) { media.muted = true; media.playsInline = true; media.preload = 'auto'; }
    try {
        // 本地大图优先在解码时缩小，避免多附件编辑时长期保留完整像素缓冲。
        if (!video && source instanceof Blob && typeof createImageBitmap === 'function') {
            try {
                bitmap = fit === 'cover'
                    ? await createImageBitmap(source, { resizeWidth: limitWidth, resizeQuality: 'medium' })
                    : await createImageBitmap(source);
            }
            catch { /* 部分浏览器或编码不支持时继续使用图片元素解码。 */ }
        }
        if (!bitmap) await new Promise((resolve, reject) => {
            const finish = error => {
                clearTimeout(timeout);
                media.onload = media.onloadeddata = media.onerror = null;
                error ? reject(error) : resolve();
            };
            const timeout = setTimeout(() => finish(new Error('媒体预览超时。')), 20000);
            media.onload = media.onloadeddata = () => finish();
            media.onerror = () => finish(new Error('浏览器无法解码此媒体。'));
            media.src = localUrl || source;
        });
        const width = bitmap ? bitmap.width : video ? media.videoWidth : media.naturalWidth;
        const height = bitmap ? bitmap.height : video ? media.videoHeight : media.naturalHeight;
        if (!width || !height) throw new Error('媒体尺寸无效。');
        const scale = Math.min(1, limitWidth / width, limitHeight / height);
        const canvas = document.createElement('canvas');
        canvas.width = fit === 'cover' ? limitWidth : Math.max(1, Math.round(width * scale));
        canvas.height = fit === 'cover' ? limitHeight : Math.max(1, Math.round(height * scale));
        // 大图在 CPU 画布直接缩小，减少上传完整像素到 GPU 后再读回编码的开销。
        const context = canvas.getContext('2d', { alpha: false, willReadFrequently: !video && width * height > 16 * 1024 * 1024 });
        if (!context) throw new Error('无法创建媒体预览。');
        context.fillStyle = '#f3e4bd';
        context.fillRect(0, 0, canvas.width, canvas.height);
        const ratio = canvas.width / canvas.height;
        const cropWidth = fit === 'cover' && width / height > ratio ? height * ratio : width;
        const cropHeight = fit === 'cover' && width / height < ratio ? width / ratio : height;
        context.drawImage(bitmap || media, (width - cropWidth) / 2, (height - cropHeight) / 2, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (!blob) throw new Error('无法压缩媒体。');
        return blob;
    } finally {
        if (video) media.pause();
        media.removeAttribute('src');
        if (video) media.load();
        if (localUrl) URL.revokeObjectURL(localUrl);
        bitmap?.close();
    }
}

async function putPreview(url, blob, etag) {
    const saved = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', 'If-Match': etag }, body: blob, signal: AbortSignal.timeout(20000) });
    if (saved.status === 409) throw Object.assign(new Error('原文件已更新，请刷新重试。'), { status: 409 });
    if (!saved.ok) throw new Error('无法保存缩略图。');
}

function requirePreview(isNeeded) {
    if (!isNeeded()) throw new DOMException('预览已离开可见区域', 'AbortError');
}

async function browserPreview(source, kind, url, isNeeded) {
    let cache;
    try { if (globalThis.caches) cache = await caches.open(CACHE_NAME); }
    catch { /* 缓存禁用时仍显示本次生成的缩略图。 */ }
    const cacheKey = new URL(url || `.cache/media-previews/recycle/${encodeURIComponent(source)}.jpg`, document.baseURI);
    requirePreview(isNeeded);
    if (url) {
        const head = await fetch(source, { method: 'HEAD', cache: 'no-cache', signal: AbortSignal.timeout(20000) });
        if (!head.ok) throw new Error('原文件不可用。');
        const version = [head.headers.get('etag'), head.headers.get('last-modified'), head.headers.get('content-length')].join(':');
        cacheKey.searchParams.set('source', version);
    }
    // 回收站 URL 含不可变的项目 ID 与归档路径，无需读取原文件验证版本。
    const cached = await cache?.match(cacheKey.href);
    if (cached) return cached.blob();
    // 远端预览缺失或回收站尚未缓存时，才读取原文件生成缩略图。
    requirePreview(isNeeded);
    const blob = await createMediaPreview(source, kind);
    try { await cache?.put(cacheKey.href, new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } })); }
    catch { /* 浏览器配额不足时不阻断阅读。 */ }
    return blob;
}

async function getPreview(source, kind, isNeeded) {
    const url = getMediaPreviewUrl(source);
    if (!url) {
        const target = new URL(source, document.baseURI);
        if (target.origin !== new URL(document.baseURI).origin || !target.pathname.endsWith('/api/travel-data')
            || target.searchParams.get('mode') !== 'recycle-file' || !target.searchParams.get('id') || !target.searchParams.get('path')) throw new Error('无效的媒体路径。');
        return browserPreview(source, kind, '', isNeeded);
    }
    requirePreview(isNeeded);
    // 缓存命中只读取缩略图，静态站也无需逐张探测原文件或等待主机检测。
    const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(20000) });
    if (response.status === 200 && response.headers.get('content-type')?.startsWith('image/jpeg')) return response.blob();
    await response.body?.cancel();
    if (response.status === 404) return browserPreview(source, kind, url, isNeeded);
    if (response.status !== 204) throw new Error('无法读取预览缓存。');
    requirePreview(isNeeded);
    const blob = await createMediaPreview(source, kind);
    try { await putPreview(url, blob, response.headers.get('etag')); }
    catch (error) {
        if (error.status === 409) throw error;
        // 缓存只读或空间不足时仍显示本次生成结果。
    }
    return blob;
}

export async function getMediaPreviewBlob(source, kind, isNeeded = () => true) {
    const key = `${kind}:${source}`;
    if (previews.has(key)) {
        const blob = previews.get(key);
        previews.delete(key);
        previews.set(key, blob);
        return blob;
    }
    let request = pending.get(key);
    if (!request) {
        const generation = cacheGeneration;
        request = { consumers: new Set([isNeeded]) };
        pending.set(key, request);
        request.promise = schedule(async () => {
            const isNeeded = () => generation === cacheGeneration && [...request.consumers].some(needed => needed());
            requirePreview(isNeeded);
            const blob = await getPreview(source, kind, isNeeded);
            return generation === cacheGeneration ? rememberPreview(key, blob) : blob;
        }).finally(() => { if (pending.get(key) === request) pending.delete(key); });
    } else request.consumers.add(isNeeded);
    return request.promise;
}

// 已在本机压缩的待上传文件可直接补齐服务器缓存，不重新读取远端原文件。
export async function saveMediaPreview(source, blob) {
    const url = getMediaPreviewUrl(source);
    if (!url) throw new Error('无效的媒体路径。');
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (![200, 204].includes(response.status)) throw new Error('无法保存缩略图。');
    await putPreview(url, blob, response.headers.get('etag'));
    rememberPreview(`${source.startsWith('data/videos/') ? 'video' : 'image'}:${source}`, blob);
}

export function loadMediaPreview(image, source, kind, isNeeded = () => image.isConnected) {
    const previous = imageRequests.get(image);
    if (previous?.source === source && previous.kind === kind && previous.generation === cacheGeneration) return previous.promise;
    previous?.release?.();
    const request = { source, kind, generation: cacheGeneration };
    imageRequests.set(image, request);
    request.promise = (async () => {
        try {
            const blob = await getMediaPreviewBlob(source, kind, isNeeded);
            if (!image.isConnected || imageRequests.get(image) !== request || request.generation !== cacheGeneration) return;
            let entry = previewUrls.get(blob);
            if (!entry) {
                entry = { url: URL.createObjectURL(blob), users: 0, cached: previews.get(`${kind}:${source}`) === blob };
                previewUrls.set(blob, entry);
            }
            // 缓存淘汰不能撤销尚未完成解码的 URL，同一路径的并发图片各自持有引用。
            entry.users++;
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                image.removeEventListener?.('load', release);
                image.removeEventListener?.('error', failed);
                entry.users--;
                if (!entry.cached && !entry.users) {
                    URL.revokeObjectURL(entry.url);
                    previewUrls.delete(blob);
                }
            };
            const failed = () => {
                release();
                if (imageRequests.get(image) === request) imageRequests.delete(image);
            };
            request.release = release;
            image.addEventListener?.('load', release, { once: true });
            image.addEventListener?.('error', failed, { once: true });
            // 已经通过可见性检测，避免原生 lazy 再延迟 Blob 解码。
            image.loading = 'eager';
            image.src = entry.url;
        } catch (error) {
            const current = imageRequests.get(image) === request && request.generation === cacheGeneration;
            if (current) imageRequests.delete(image);
            if (error.name === 'AbortError') throw error;
            if (current && image.isConnected) image.dispatchEvent(new Event('error'));
        }
    })();
    return request.promise;
}

export function releaseMediaPreview(image) {
    const request = imageRequests.get(image);
    imageRequests.delete(image);
    request?.release?.();
}

export function observeMediaPreview(image, source, kind, target = image) {
    let stop;
    const observe = () => {
        stop = observeMediaVisibility(target, async () => {
            try { await loadMediaPreview(image, source, kind, () => isMediaPreviewVisible(target)); }
            catch (error) { if (error.name === 'AbortError' && target.isConnected) observe(); }
        });
    };
    observe();
    return () => stop?.();
}
