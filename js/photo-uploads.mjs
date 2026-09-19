import { pinyinSlug } from './slug.mjs';

export const MAXIMUM_MEDIA_FILE_BYTES = 96 * 1024 * 1024;

export function readUploads(value = []) {
    if (!Array.isArray(value)) throw new Error('所选媒体数据无效。');
    const ids = new Set();
    return value.map(media => {
        if (!media || typeof media.id !== 'string' || !/^[a-f0-9]{32}$/.test(media.id) || ids.has(media.id)
            || typeof media.name !== 'string' || media.name.length > 200 || typeof media.data !== 'string') {
            throw new Error('媒体标识、文件名或内容无效。');
        }
        ids.add(media.id);
        const encoded = media.data;
        if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('媒体内容无效。');
        const size = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
        if (size > MAXIMUM_MEDIA_FILE_BYTES) throw new Error('单个图片或视频不能超过 96 MiB。');
        let head;
        try { head = atob(encoded.slice(0, 128)); }
        catch { throw new Error('媒体编码无效。'); }
        const detected = detectMediaFormat(head);
        if (!detected) throw new Error('仅支持 JPEG、PNG、GIF、WebP 图片，以及 MP4、WebM、Ogg 视频。');
        return { id: media.id, name: media.name, data: encoded, ...detected, size };
    });
}

function detectMediaFormat(head) {
    if (head.startsWith('\x89PNG\r\n\x1a\n')) return { kind: 'image', extension: 'png', mimeType: 'image/png' };
    if (head.startsWith('\xff\xd8\xff')) return { kind: 'image', extension: 'jpg', mimeType: 'image/jpeg' };
    if (/^GIF8[79]a/.test(head)) return { kind: 'image', extension: 'gif', mimeType: 'image/gif' };
    if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return { kind: 'image', extension: 'webp', mimeType: 'image/webp' };
    if (head.length >= 12 && head.slice(4, 8) === 'ftyp') return { kind: 'video', extension: 'mp4', mimeType: 'video/mp4' };
    if (head.startsWith('\x1aE\xdf\xa3')) return { kind: 'video', extension: 'webm', mimeType: 'video/webm' };
    if (head.startsWith('OggS')) return { kind: 'video', extension: 'ogv', mimeType: 'video/ogg' };
    return null;
}

function safeStem(value, fallback) {
    return pinyinSlug(value.replace(/\.[^.]*$/, ''), fallback, { keepPlaceSuffix: true }).slice(0, 160);
}

export function storedMediaNames(existingNames, uploads, fallbackPrefix = 'media') {
    const used = new Set();
    const reserve = preferred => {
        const dot = preferred.lastIndexOf('.');
        const stem = dot > 0 ? preferred.slice(0, dot) : preferred;
        const extension = dot > 0 ? preferred.slice(dot) : '';
        let name = preferred;
        let sequence = 2;
        while (used.has(name.toLocaleLowerCase('en-US'))) {
            name = `${stem}-${sequence}${extension}`;
            sequence += 1;
        }
        used.add(name.toLocaleLowerCase('en-US'));
        return name;
    };
    const allocate = (preferred, extension, fallback) => {
        const stem = safeStem(preferred, fallback);
        let suffix = '';
        let sequence = 1;
        let name;
        do {
            name = `${stem}${suffix}.${extension}`;
            sequence += 1;
            suffix = `-${sequence}`;
        } while (used.has(name.toLocaleLowerCase('en-US')));
        used.add(name.toLocaleLowerCase('en-US'));
        return name;
    };
    const existing = existingNames.map(reserve);
    const uploaded = uploads.map((media, index) => allocate(media.name, media.extension, `${fallbackPrefix}-${String(existing.length + index + 1).padStart(3, '0')}`));
    return [...existing, ...uploaded];
}

export function storedPhotoNames(existingNames, uploads) {
    return storedMediaNames(existingNames, uploads, 'photo');
}
