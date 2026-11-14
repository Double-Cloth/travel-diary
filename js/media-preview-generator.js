const { sourceForPreview } = require('./media-preview-store.js');

// 复用已有浏览器压缩脚本，合并并发请求并限制为一个后台生成进程。
function createMediaPreviewGenerator(root, build = (...args) => require('../scripts/build-media-previews.js').buildMediaPreviews(...args), options = {}) {
    const pending = new Map();
    const queue = [];
    let running = false;

    async function run() {
        while (queue.length) {
            const batch = queue.splice(0, 2);
            try {
                await build(root, {
                    browser: process.env.TRAVEL_BROWSER_PATH || options.browserPath,
                    progressTimeoutMs: options.progressTimeoutMs,
                    previews: batch.map(item => item.path), log() {}
                });
                for (const item of batch) item.resolve();
            } catch (error) {
                for (const item of batch) item.reject(error);
            } finally {
                for (const item of batch) pending.delete(item.path);
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
        if (!running) {
            running = true;
            setImmediate(() => { void run(); });
        }
        return task;
    };
}

module.exports = { createMediaPreviewGenerator };
