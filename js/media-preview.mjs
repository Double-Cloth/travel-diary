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
const queue = [];
let active = 0;
let staticHost;
const CACHE_NAME = 'travel-media-previews-canvas-v1';

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
        const context = canvas.getContext('2d', { alpha: false });
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

async function isStaticHost() {
    staticHost ??= fetch('index.html', { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(20000) })
        .then(response => response.headers.get('X-Travel-Media-Cache') !== 'disk-v1')
        .catch(() => false);
    return staticHost;
}

async function putPreview(url, blob, etag) {
    const saved = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', 'If-Match': etag }, body: blob, signal: AbortSignal.timeout(20000) });
    if (saved.status === 409) throw Object.assign(new Error('原文件已更新，请刷新重试。'), { status: 409 });
    if (!saved.ok) throw new Error('无法保存缩略图。');
}

async function browserPreview(source, kind, url) {
    let cache;
    try { if (globalThis.caches) cache = await caches.open(CACHE_NAME); }
    catch { /* 缓存禁用时仍显示本次生成的缩略图。 */ }
    const cacheKey = new URL(url || `.cache/media-previews/recycle/${encodeURIComponent(source)}.jpg`, document.baseURI);
    if (url) {
        const head = await fetch(source, { method: 'HEAD', cache: 'no-cache', signal: AbortSignal.timeout(20000) });
        if (!head.ok) throw new Error('原文件不可用。');
        const version = [head.headers.get('etag'), head.headers.get('last-modified'), head.headers.get('content-length')].join(':');
        cacheKey.searchParams.set('source', version);
    }
    // 回收站 URL 含不可变的项目 ID 与归档路径，无需读取原文件验证版本。
    const cached = await cache?.match(cacheKey.href);
    if (cached) return cached.blob();
    let blob;
    if (url) {
        const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(20000) });
        if (response.status === 200 && response.headers.get('content-type')?.startsWith('image/jpeg')) blob = await response.blob();
        else await response.body?.cancel();
    }
    blob ||= await createMediaPreview(source, kind);
    try { await cache?.put(cacheKey.href, new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } })); }
    catch { /* 浏览器配额不足时不阻断阅读。 */ }
    return blob;
}

async function getPreview(source, kind) {
    const url = getMediaPreviewUrl(source);
    if (!url) {
        const target = new URL(source, document.baseURI);
        if (target.origin !== new URL(document.baseURI).origin || !target.pathname.endsWith('/api/travel-data')
            || target.searchParams.get('mode') !== 'recycle-file' || !target.searchParams.get('id') || !target.searchParams.get('path')) throw new Error('无效的媒体路径。');
        return browserPreview(source, kind, '');
    }
    if (await isStaticHost()) return browserPreview(source, kind, url);
    const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(20000) });
    if (response.status === 200 && response.headers.get('content-type')?.startsWith('image/jpeg')) return response.blob();
    await response.body?.cancel();
    if (response.status !== 204) throw new Error('无法读取预览缓存。');
    const blob = await createMediaPreview(source, kind);
    try { await putPreview(url, blob, response.headers.get('etag')); }
    catch (error) {
        if (error.status === 409) throw error;
        // 缓存只读或空间不足时仍显示本次生成结果。
    }
    return blob;
}

export async function getMediaPreviewBlob(source, kind) {
    const key = `${kind}:${source}`;
    if (!pending.has(key)) pending.set(key, schedule(() => getPreview(source, kind)).finally(() => pending.delete(key)));
    return pending.get(key);
}

// 已在本机压缩的待上传文件可直接补齐服务器缓存，不重新读取远端原文件。
export async function saveMediaPreview(source, blob) {
    const url = getMediaPreviewUrl(source);
    if (!url) throw new Error('无效的媒体路径。');
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (![200, 204].includes(response.status)) throw new Error('无法保存缩略图。');
    await putPreview(url, blob, response.headers.get('etag'));
}

export async function loadMediaPreview(image, source, kind) {
    const request = {};
    imageRequests.set(image, request);
    try {
        const blob = await getMediaPreviewBlob(source, kind);
        if (!image.isConnected || imageRequests.get(image) !== request) return;
        const url = URL.createObjectURL(blob);
        const release = () => {
            image.removeEventListener('load', release);
            image.removeEventListener('error', release);
            URL.revokeObjectURL(url);
        };
        image.addEventListener('load', release, { once: true });
        image.addEventListener('error', release, { once: true });
        image.src = url;
    } catch {
        if (image.isConnected && imageRequests.get(image) === request) image.dispatchEvent(new Event('error'));
    }
}

export function observeMediaPreview(image, source, kind) {
    if (!('IntersectionObserver' in globalThis)) { void loadMediaPreview(image, source, kind); return; }
    const observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();
        void loadMediaPreview(image, source, kind);
    });
    observer.observe(image);
}
