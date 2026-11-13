import { getMediaFileUrl } from './utils.js?v=2.1.134';
import { getMediaPreviewUrl, observeMediaPreview, observeMediaVisibility } from './media-preview.mjs?v=2.1.134';

export function createMediaFileLink({ path, src = getMediaFileUrl(path), thumbnailSrc = getMediaPreviewUrl(src), loadThumbnail, blob, name, kind, index = 0, detail = '' }) {
    const link = document.createElement(src ? 'a' : 'span');
    link.className = 'media-file-link';
    if (blob) link.mediaBlob = blob;
    if (src) {
        link.href = src;
        Object.assign(link.dataset, {
            action: 'open-media-viewer', mediaSrc: src, mediaName: name,
            mediaAlt: name, mediaKind: kind, mediaIndex: String(index)
        });
        link.setAttribute('aria-label', `查看文件：${name}`);
    }
    const thumbnail = document.createElement('span');
    thumbnail.className = 'media-file-thumbnail';
    thumbnail.setAttribute('aria-hidden', 'true');
    const fallback = document.createElement('span');
    fallback.textContent = kind === 'video' ? '视频' : '图片';
    thumbnail.append(fallback);
    if (thumbnailSrc || loadThumbnail) {
        const media = document.createElement('img');
        media.alt = '';
        media.loading = 'lazy';
        media.decoding = 'async';
        media.fetchPriority = 'low';
        media.width = 84;
        media.height = 64;
        media.addEventListener('error', () => {
            showMediaFilePreviewError(link);
        }, { once: true });
        thumbnail.append(media);
        if (loadThumbnail || thumbnailSrc.startsWith('blob:')) {
            observeMediaVisibility(media, async () => {
                try {
                    const url = loadThumbnail ? await loadThumbnail() : thumbnailSrc;
                    if (!url) throw new Error('无法生成预览。');
                    if (media.isConnected) { media.loading = 'eager'; media.src = url; }
                } catch { if (media.isConnected) media.dispatchEvent(new Event('error')); }
            });
        }
        else observeMediaPreview(media, src, kind);
    }
    if (kind === 'video') {
        const play = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        play.setAttribute('class', 'media-file-play');
        play.setAttribute('viewBox', '0 0 24 24');
        play.setAttribute('focusable', 'false');
        const triangle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        triangle.setAttribute('d', 'M9 6v12l10-6z');
        play.append(triangle);
        thumbnail.append(play);
    }
    const text = document.createElement('span');
    text.className = 'media-file-description';
    const filename = document.createElement('span');
    filename.className = 'media-file-name';
    filename.textContent = name;
    const note = document.createElement('span');
    note.className = 'media-file-detail';
    note.textContent = src ? detail : '路径无效，请检查高级设置';
    text.append(filename, note);
    link.append(thumbnail, text);
    if (!src && !blob) showMediaFilePreviewError(link);
    return link;
}

export function showMediaFilePreviewError(link, message = '无法预览') {
    const thumbnail = link.querySelector('.media-file-thumbnail');
    thumbnail.classList.add('is-media-error');
    thumbnail.querySelector('span').textContent = message;
    link.title = message;
}

export function mediaOrderIcon(direction) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${direction < 0 ? 'm6 11 6-6 6 6M12 5v14' : 'm6 13 6 6 6-6M12 19V5'}"/></svg>`;
}
