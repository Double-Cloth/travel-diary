import { escapeHtml } from './utils.js?v=2.1.47';
import { parseMarkdown } from './data.js?v=2.1.47';
import { createMediaFileLink } from './media-file-link.js?v=2.1.47';
import { createMediaPreview } from './media-preview.mjs?v=2.1.47';
import { sourceOf, readSourceText } from './zip-stream.mjs';

export function markdownPreview(source) {
    const parsed = parseMarkdown(source);
    const title = source.match(/^#\s+(.+)$/m)?.[1];
    return `<div class="content-preview-markdown markdown-content">${title ? `<h3>${escapeHtml(title)}</h3>` : ''}${parsed.bodyHtml || '<p class="record-diff-empty">无内容</p>'}</div>`;
}

export function mediaKind(name) {
    if (/\.(png|jpe?g|webp|gif|avif|heic|heif|bmp)$/i.test(name)) return 'image';
    if (/\.(mp4|webm|mov|m4v|ogv)$/i.test(name)) return 'video';
    return '';
}

// 一个对话框共用预览生命周期；筛选、关闭或刷新时释放临时 URL 和未完成的读取。
export function createContentPreviewScope() {
    const urls = new Set();
    const controller = new AbortController();
    const tasks = new Map();
    const queue = [];
    let active = 0;
    let disposed = false;
    const objectUrl = blob => {
        if (disposed) throw new DOMException('预览已关闭', 'AbortError');
        const url = URL.createObjectURL(blob);
        urls.add(url);
        return url;
    };
    const drain = () => {
        while (!disposed && active < 2 && queue.length) {
            const task = queue.shift();
            active++;
            void task().finally(() => { active--; drain(); });
        }
    };
    const observer = new IntersectionObserver(items => {
        for (const item of items) if (item.isIntersecting) {
            observer.unobserve(item.target);
            const task = tasks.get(item.target);
            tasks.delete(item.target);
            if (task) queue.push(task);
        }
        drain();
    });
    return {
        dispose() {
            disposed = true;
            controller.abort();
            observer.disconnect();
            tasks.clear();
            queue.length = 0;
            urls.forEach(url => URL.revokeObjectURL(url));
            urls.clear();
        },
        async file({ name, url, source, detail = '', index = 0, collapsible = true }) {
            const kind = mediaKind(name);
            if (kind) {
                const blob = source ? sourceOf(source).blob || new Blob([await readSourceText(sourceOf(source))]) : null;
                const src = blob ? objectUrl(blob) : url;
                const link = createMediaFileLink({ name: name.split('/').pop(), src, thumbnailSrc: '', blob, kind, index, detail: detail || name });
                tasks.set(link, async () => {
                    try {
                        const preview = await createMediaPreview(src, kind);
                        if (disposed || !link.isConnected) return;
                        const image = document.createElement('img');
                        image.alt = '';
                        image.src = objectUrl(preview);
                        link.querySelector('.media-file-thumbnail').append(image);
                    } catch {
                        if (!disposed) link.querySelector('.media-file-thumbnail > span').textContent = '无法预览';
                    }
                });
                observer.observe(link);
                return link;
            }
            const entry = document.createElement(collapsible ? 'details' : 'div');
            entry.className = 'content-file-preview';
            const summary = document.createElement(collapsible ? 'summary' : 'p');
            if (!collapsible) summary.className = 'content-file-heading';
            const label = document.createElement('span');
            label.textContent = `${name.split('/').pop()}${detail ? ` · ${detail}` : ''}`;
            summary.append(label);
            entry.append(summary);
            if (!/\.(md|json|txt)$/i.test(name)) { label.textContent += ' · 暂不支持预览'; return entry; }
            let loaded = false;
            const load = async () => {
                if ((collapsible && !entry.open) || loaded) return;
                loaded = true;
                entry.querySelector('.content-file-body')?.remove();
                const content = document.createElement('div');
                content.className = 'content-file-body';
                content.textContent = '正在读取内容…';
                entry.append(content);
                try {
                    let bytes;
                    if (source) bytes = await readSourceText(sourceOf(source));
                    else {
                        const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
                        if (!response.ok) throw new Error('内容已变化或不可用，请刷新后重试。');
                        if (Number(response.headers.get('Content-Length')) > 16 * 1024 * 1024) throw new Error('文件过大，请恢复后查看。');
                        bytes = new Uint8Array(await response.arrayBuffer());
                    }
                    if (disposed) return;
                    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                    if (/\.md$/i.test(name)) content.innerHTML = markdownPreview(text);
                    else if (name === 'data/travel_data.json') {
                        const records = JSON.parse(text);
                        if (!Array.isArray(records)) throw new Error('日记目录格式无效。');
                        content.innerHTML = `<ul class="content-record-list">${records.map(record => `<li><strong>${escapeHtml([record.date, record.locality].filter(Boolean).join(' · ') || '未命名日记')}</strong><small>${escapeHtml([record.country, record.admin_area, record.trip_id].filter(Boolean).join(' · '))}</small><small>${(record.photos || []).length} 张图片 · ${(record.videos || []).length} 个视频</small></li>`).join('')}</ul>`;
                    } else {
                        const pre = document.createElement('pre');
                        pre.textContent = /\.json$/i.test(name) ? JSON.stringify(JSON.parse(text), null, 2) : text;
                        content.replaceChildren(pre);
                    }
                } catch (failure) {
                    if (disposed) return;
                    content.textContent = failure.message;
                    loaded = false;
                    if (!collapsible) {
                        const retry = document.createElement('button');
                        retry.type = 'button';
                        retry.className = 'media-text-button';
                        retry.textContent = '重新读取';
                        retry.addEventListener('click', load);
                        content.append(retry);
                    }
                }
            };
            if (collapsible) entry.addEventListener('toggle', load);
            else void load();
            return entry;
        }
    };
}
