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
        || path.includes('\\') || !path.split('/').every(part => part && part !== '.' && part !== '..')) return '';
    return path.split('/').map(encodeURIComponent).join('/');
}

export function buildFallbackTitle(record) {
    return record.locality || record.city || record.adminArea || record.province || record.country || record.date;
}
