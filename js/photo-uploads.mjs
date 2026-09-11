export function readUploads(value = []) {
    if (!Array.isArray(value)) throw new Error('上传照片格式无效。');
    const ids = new Set();
    return value.map(photo => {
        if (!photo || typeof photo.id !== 'string' || !/^[a-f0-9]{32}$/.test(photo.id) || ids.has(photo.id)
            || typeof photo.name !== 'string' || photo.name.length > 200 || typeof photo.data !== 'string') {
            throw new Error('上传照片的标识、名称或内容无效。');
        }
        ids.add(photo.id);
        const encoded = photo.data;
        if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('照片内容无效。');
        const size = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
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

function safeStem(value, fallback) {
    const stem = value.normalize('NFKC').replace(/\.[^.]*$/, '').trim()
        .replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 160);
    return stem && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(stem) ? stem : fallback;
}

export function storedPhotoNames(existingNames, uploads) {
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
    const uploaded = uploads.map((photo, index) => allocate(photo.name, photo.extension, `photo-${String(existing.length + index + 1).padStart(3, '0')}`));
    return [...existing, ...uploaded];
}
