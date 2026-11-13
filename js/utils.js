export function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function getMediaFileUrl(path) {
    if (typeof path !== 'string' || !/^data\/(photos|videos)\//.test(path)
        || /[\\\u0000-\u001f\u007f]/.test(path) || !path.split('/').every(part => part && part !== '.' && part !== '..')) return '';
    try {
        return path.split('/').map(encodeURIComponent).join('/');
    } catch {
        return '';
    }
}

export function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function buildFallbackTitle(record) {
    return record.locality || record.city || record.adminArea || record.province || record.country || record.date;
}
