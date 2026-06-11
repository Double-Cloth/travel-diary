export function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function buildFallbackTitle(record) {
    return record.city || record.province || record.country || record.date;
}

export function formatDateForCard(dateStr) {
    if (!dateStr) return '';

    try {
        const d = new Date(dateStr + 'T00:00:00');
        const day = d.getDate().toString().padStart(2, '0');
        const month = d.toLocaleString('en-US', { month: 'short' });
        const year = d.getFullYear();

        return `<time datetime="${escapeHtml(dateStr)}"><span class="date-day">${day}</span><span class="date-month">${escapeHtml(month)} ${year}</span></time>`;
    } catch (e) {
        return `<time datetime="${escapeHtml(dateStr)}">${escapeHtml(dateStr)}</time>`;
    }
}
