const originals = new Map();
const pending = new Map();
const imageRequests = new WeakMap();
const MAXIMUM_ORIGINAL_BYTES = 128 * 1024 * 1024;
const MAXIMUM_ORIGINAL_COUNT = 32;
let originalBytes = 0;
let cacheGeneration = 0;

// 原图只在查看器打开后读取，独立于缩略图按最近使用顺序保留。
async function getOriginalImage(source) {
    const cached = originals.get(source);
    if (cached) {
        originals.delete(source);
        originals.set(source, cached);
        return cached;
    }
    let request = pending.get(source);
    if (!request) {
        const generation = cacheGeneration;
        request = (async () => {
            const response = await fetch(source, { credentials: 'same-origin', signal: AbortSignal.timeout(20000) });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error('无法读取原图。');
            }
            // 超过缓存池的图片沿用原地址显示，避免挤出其他已缓存图片。
            if (Number(response.headers.get('Content-Length')) > MAXIMUM_ORIGINAL_BYTES) {
                await response.body?.cancel();
                return null;
            }
            const blob = await response.blob();
            if (generation !== cacheGeneration || blob.size > MAXIMUM_ORIGINAL_BYTES) return null;
            const entry = { blob, url: '' };
            originals.set(source, entry);
            originalBytes += blob.size;
            while (originalBytes > MAXIMUM_ORIGINAL_BYTES || originals.size > MAXIMUM_ORIGINAL_COUNT) {
                const [oldest, value] = originals.entries().next().value;
                originals.delete(oldest);
                originalBytes -= value.blob.size;
                if (value.url) URL.revokeObjectURL(value.url);
            }
            return entry;
        })().finally(() => { if (pending.get(source) === request) pending.delete(source); });
        pending.set(source, request);
    }
    return request;
}

export function clearOriginalImageCache() {
    cacheGeneration++;
    pending.clear();
    for (const entry of originals.values()) {
        if (entry.url) URL.revokeObjectURL(entry.url);
    }
    originals.clear();
    originalBytes = 0;
}

export function loadOriginalImage(image, source) {
    const previous = imageRequests.get(image);
    if (previous?.source === source && previous.generation === cacheGeneration) return previous.promise;
    const request = { source, generation: cacheGeneration };
    imageRequests.set(image, request);
    request.promise = (async () => {
        let entry;
        try {
            // 待上传文件的 Blob URL 已由编辑器持有，无需重复读取和创建。
            if (!/^(blob:|data:)/i.test(source)) entry = await getOriginalImage(source);
        } catch {
            // 跨域或网络读取受限时沿用图片元素的原生加载能力，下次打开仍可重试缓存。
        }
        if (!image.isConnected || request.generation !== cacheGeneration
            || imageRequests.get(image) !== request) return;
        if (entry && originals.get(source) === entry) {
            if (!entry.url) entry.url = URL.createObjectURL(entry.blob);
            image.src = entry.url;
        } else {
            imageRequests.delete(image);
            image.src = source;
        }
    })();
    return request.promise;
}
