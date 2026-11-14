const { sourceForPreview } = require('./media-preview-store.js');

// 复用已有浏览器压缩脚本，合并并发请求并限制为一个后台生成进程。
function createMediaPreviewGenerator(root, build = (...args) => require('../scripts/build-media-previews.js').buildMediaPreviews(...args), options = {}) {
    const pending = new Map();
    const queue = [];
    let running = false;
    let wake;

    async function run() {
        while (queue.length) {
            const batch = new Map();
            const takeBatch = () => {
                const items = queue.splice(0, 2);
                for (const item of items) batch.set(item.path, item);
                return items.map(item => item.path);
            };
            const previews = takeBatch();
            try {
                await build(root, {
                    browser: process.env.TRAVEL_BROWSER_PATH || options.browserPath,
                    progressTimeoutMs: options.progressTimeoutMs,
                    previews, log() {},
                    onProgress(path) {
                        // 写入完成即交还请求，后续可见项无需等待浏览器退出和目录清理。
                        batch.get(path)?.resolve();
                        batch.delete(path);
                        pending.delete(path);
                    },
                    async nextBatch(signal) {
                        // 短暂保留空闲浏览器，接续客户端释放并发槽后发来的请求。
                        if (!queue.length && !signal.aborted) await new Promise(resolve => {
                            const finish = () => {
                                clearTimeout(timer);
                                signal.removeEventListener('abort', finish);
                                wake = undefined;
                                resolve();
                            };
                            const timer = setTimeout(finish, 500);
                            wake = finish;
                            signal.addEventListener('abort', finish, { once: true });
                        });
                        return signal.aborted ? [] : takeBatch();
                    }
                });
                for (const item of batch.values()) item.resolve();
            } catch (error) {
                for (const item of batch.values()) item.reject(error);
            } finally {
                for (const item of batch.values()) pending.delete(item.path);
            }
        }
        running = false;
    }

    return function generate(urlPath) {
        if (!sourceForPreview(urlPath)) return Promise.reject(new Error('无效的媒体预览路径。'));
        if (pending.has(urlPath)) return pending.get(urlPath);
        if (pending.size >= 16) return Promise.reject(new Error('媒体预览繁忙，请稍后重试。'));
        const task = new Promise((resolve, reject) => queue.push({ path: urlPath, resolve, reject }));
        pending.set(urlPath, task);
        wake?.();
        if (!running) {
            running = true;
            setImmediate(() => { void run(); });
        }
        return task;
    };
}

module.exports = { createMediaPreviewGenerator };
