export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_PHOTO_BYTES = 30 * 1024 * 1024;
export const MAX_PHOTOS = 20;
export const MAX_DRAFT_BYTES = 44 * 1024 * 1024;

export function readUploads(value = []) {
    if (!Array.isArray(value) || value.length > MAX_PHOTOS) throw new Error('每条记录最多上传 20 张照片。');
    let total = 0;
    const ids = new Set();
    return value.map(photo => {
        if (!photo || typeof photo.id !== 'string' || !/^[a-f0-9]{32}$/.test(photo.id) || ids.has(photo.id)
            || typeof photo.name !== 'string' || photo.name.length > 200 || typeof photo.data !== 'string') {
            throw new Error('上传照片的标识、名称或内容无效。');
        }
        ids.add(photo.id);
        const encoded = photo.data;
        if (!encoded.length || encoded.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 || encoded.length % 4
            || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('照片内容无效，单张照片不能超过 10 MB。');
        const size = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
        total += size;
        if (size > MAX_PHOTO_BYTES || total > MAX_TOTAL_PHOTO_BYTES) throw new Error('单张照片上限 10 MB，全部照片合计上限 30 MB。');
        let head;
        try { head = atob(encoded.slice(0, 32)); }
        catch { throw new Error('照片编码无效。'); }
        const extension = head.startsWith('\x89PNG\r\n\x1a\n') ? 'png'
            : head.startsWith('\xff\xd8\xff') ? 'jpg'
            : /^GIF8[79]a/.test(head) ? 'gif'
            : head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP' ? 'webp' : '';
        if (!extension) throw new Error('仅支持 JPEG、PNG、GIF 和 WebP 图片。');
        return { id: photo.id, name: photo.name, data: encoded, extension, size };
    });
}

export function uploadFileName(photo) {
    return `photo-${photo.id}.${photo.extension}`;
}

export function copiedPhotoName(name, index) {
    return `existing-${String(index + 1).padStart(3, '0')}-${name}`;
}
