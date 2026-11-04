import { getMediaFileUrl } from './utils.js?v=2.1.34';
import { getMediaPreviewUrl, observeMediaPreview } from './media-preview.mjs?v=2.1.34';

export function createMediaFileLink({ path, src = getMediaFileUrl(path), thumbnailSrc = getMediaPreviewUrl(src), blob, name, kind, index = 0, detail = '' }) {
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
    if (thumbnailSrc) {
        const media = document.createElement('img');
        media.alt = '';
        media.loading = 'lazy';
        media.decoding = 'async';
        media.fetchPriority = 'low';
        media.width = 84;
        media.height = 64;
        media.addEventListener('error', () => {
            media.hidden = true;
            fallback.textContent = '无法预览';
        }, { once: true });
        thumbnail.append(media);
        if (thumbnailSrc.startsWith('blob:')) media.src = thumbnailSrc;
        else observeMediaPreview(media, src, kind);
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
    return link;
}

export function mediaOrderIcon(direction) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${direction < 0 ? 'm6 11 6-6 6 6M12 5v14' : 'm6 13 6 6 6-6M12 19V5'}"/></svg>`;
}
