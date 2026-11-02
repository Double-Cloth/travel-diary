// 保留原扩展名，避免同名图片或视频的预览互相覆盖；输入为已编码的项目相对 URL。
export function getMediaPreviewUrl(src) {
    if (typeof src !== 'string' || !/^data\/(photos|videos)\/.+/.test(src)) return '';
    return src.replace(/^data\/(photos|videos)\//, '.cache/media-previews/$1/') + '.jpg';
}

const pending = new Map();
const queue = [];
let active = 0;
let staticHost;
const CACHE_NAME = 'travel-media-previews-canvas-v1';

// 每次最多解码两个媒体，重复列表项共用一次生成任务。
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

async function isStaticHost() {
    staticHost ??= fetch('index.html', { method: 'HEAD', cache: 'no-store' })
        .then(response => response.headers.get('X-Travel-Media-Cache') !== 'disk-v1')
        .catch(() => false);
    return staticHost;
}

export async function createMediaPreview(source, kind) {
    const video = kind === 'video';
    const media = document.createElement(video ? 'video' : 'img');
    if (video) { media.muted = true; media.playsInline = true; media.preload = 'auto'; }
    try {
        await new Promise((resolve, reject) => {
            const finish = error => {
                clearTimeout(timeout);
                media.onload = media.onloadeddata = media.onerror = null;
                error ? reject(error) : resolve();
            };
            const timeout = setTimeout(() => finish(new Error('媒体预览超时。')), 20000);
            media.onload = media.onloadeddata = () => finish();
            media.onerror = () => finish(new Error('浏览器无法解码此媒体。'));
            media.src = source;
        });
        const width = video ? media.videoWidth : media.naturalWidth;
        const height = video ? media.videoHeight : media.naturalHeight;
        if (!width || !height) throw new Error('媒体尺寸无效。');
        const scale = Math.min(1, 640 / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('无法创建媒体预览。');
        context.fillStyle = '#f3e4bd';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(media, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.78));
        if (!blob) throw new Error('无法压缩媒体。');
        return blob;
    } finally {
        if (video) media.pause();
        media.removeAttribute('src');
        if (video) media.load();
    }
}

async function getPreview(source, kind) {
    const url = getMediaPreviewUrl(source);
    if (!url) throw new Error('无效的媒体路径。');
    const isStatic = await isStaticHost();
    let cache;
    try { if (isStatic && globalThis.caches) cache = await caches.open(CACHE_NAME); } catch { /* 缓存不可用时仍可显示本次预览。 */ }
    let signature = '';
    let cacheKey;
    if (isStatic) {
        // 静态站不能写服务器目录；用源文件验证信息隔离浏览器缓存。
        const head = await fetch(source, { method: 'HEAD', cache: 'no-cache' });
        if (!head.ok) throw new Error('原文件不可用。');
        const version = [head.headers.get('etag'), head.headers.get('last-modified'), head.headers.get('content-length')].join(':');
        cacheKey = new URL(url, document.baseURI);
        cacheKey.searchParams.set('source', version);
        const cached = await cache?.match(cacheKey.href);
        if (cached) return cached.blob();
    } else {
        const response = await fetch(url, { cache: 'no-cache' });
        if (response.status === 200) return response.blob();
        if (response.status !== 204) throw new Error('无法读取预览缓存。');
        signature = response.headers.get('etag');
    }
    const blob = await createMediaPreview(source, kind);
    if (isStatic) {
        try { await cache?.put(cacheKey.href, new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } })); } catch { /* 浏览器配额不足时不阻断阅读。 */ }
    } else {
        const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', 'If-Match': signature }, body: blob });
        if (response.status === 409) throw new Error('原文件已更新，请刷新重试。');
        // 缓存目录只读或空间不足时仍显示已生成的压缩预览。
    }
    return blob;
}

export async function loadMediaPreview(image, source, kind) {
    const key = `${kind}:${source}`;
    if (!pending.has(key)) pending.set(key, schedule(() => getPreview(source, kind)).finally(() => pending.delete(key)));
    try {
        const blob = await pending.get(key);
        if (!image.isConnected) return;
        const url = URL.createObjectURL(blob);
        const release = () => URL.revokeObjectURL(url);
        image.addEventListener('load', release, { once: true });
        image.addEventListener('error', release, { once: true });
        image.src = url;
    } catch {
        if (image.isConnected) image.dispatchEvent(new Event('error'));
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
