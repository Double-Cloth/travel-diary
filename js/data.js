import { buildFallbackTitle, escapeHtml } from './utils.js';

export async function loadTravelData() {
    const dataPath = new URL('data/travel_data.json', window.location.href).href;
    const response = await fetch(dataPath);

    if (!response.ok) {
        throw new Error(`Failed to load travel data (${response.status})`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
        throw new Error('Travel data file must contain an array.');
    }

    return data;
}

export async function loadTravelRecords(records) {
    return Promise.all(records.map(async (record) => {
        try {
            const markdown = await fetchMarkdown(record.desc_md);
            const parsedMarkdown = parseMarkdown(markdown, record);

            return {
                ...record,
                descMarkdown: markdown,
                descTitle: parsedMarkdown.title,
                descBodyHtml: parsedMarkdown.bodyHtml,
                searchText: parsedMarkdown.searchText
            };
        } catch (error) {
            const fallbackTitle = buildFallbackTitle(record);
            const fallbackSearchText = [record.country, record.province, record.city, fallbackTitle].join(' ').toLowerCase();

            return {
                ...record,
                descMarkdown: '',
                descTitle: fallbackTitle,
                descBodyHtml: `<p class="markdown-load-error">Markdown load failed for ${escapeHtml(record.desc_md || '')}.</p>`,
                searchText: fallbackSearchText
            };
        }
    }));
}

async function fetchMarkdown(markdownPath) {
    if (!markdownPath) {
        return '';
    }

    const resolvedPath = new URL(markdownPath, window.location.href).href;

    try {
        const response = await fetch(resolvedPath);
        if (!response.ok) {
            throw new Error(`Failed to load ${markdownPath} (${response.status})`);
        }

        return response.text();
    } catch (error) {
        const retryResponse = await fetch(resolvedPath);
        if (!retryResponse.ok) {
            throw error;
        }

        return retryResponse.text();
    }
}

function parseMarkdown(markdown, record) {
    const normalized = (markdown || '').replace(/\r\n/g, '\n').trim();
    const titleMatch = normalized.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : buildFallbackTitle(record);
    const bodyMarkdown = normalized.replace(/^#\s+.*(?:\n|$)/, '').trim();
    const bodyHtml = markdownToHtml(bodyMarkdown);
    const searchText = [record.country, record.province, record.city, title, plainTextFromMarkdown(bodyMarkdown)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    return {
        title,
        bodyHtml,
        searchText
    };
}

function markdownToHtml(markdown) {
    if (!markdown) {
        return '';
    }

    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const htmlParts = [];
    let paragraphLines = [];
    let listItems = [];

    const flushParagraph = () => {
        if (!paragraphLines.length) {
            return;
        }

        const paragraph = paragraphLines
            .map(line => formatInlineMarkdown(line.trim()))
            .filter(Boolean)
            .join('<br>');

        if (paragraph) {
            htmlParts.push(`<p>${paragraph}</p>`);
        }

        paragraphLines = [];
    };

    const flushList = () => {
        if (!listItems.length) {
            return;
        }

        htmlParts.push(`<ul>${listItems.map(item => `<li>${formatInlineMarkdown(item)}</li>`).join('')}</ul>`);
        listItems = [];
    };

    lines.forEach((line) => {
        const trimmed = line.trim();

        if (!trimmed) {
            flushParagraph();
            flushList();
            return;
        }

        const headingMatch = trimmed.match(/^(#{2,6})\s+(.+)$/);
        if (headingMatch) {
            flushParagraph();
            flushList();
            const level = headingMatch[1].length;
            htmlParts.push(`<h${level}>${formatInlineMarkdown(headingMatch[2])}</h${level}>`);
            return;
        }

        if (trimmed.startsWith('- ')) {
            flushParagraph();
            listItems.push(trimmed.slice(2).trim());
            return;
        }

        if (listItems.length) {
            flushList();
        }

        paragraphLines.push(trimmed);
    });

    flushParagraph();
    flushList();

    return htmlParts.join('');
}

function formatInlineMarkdown(text) {
    const inlineTokens = [];
    const stashToken = (html) => {
        const token = `\uE000${inlineTokens.length}\uE001`;
        inlineTokens.push(html);
        return token;
    };

    let html = escapeHtml(text)
        .replace(/`([^`\n]+?)`/g, (_, code) => stashToken(`<code>${code}</code>`))
        .replace(/\[([^\]\n]+?)\]\(([^)\s]+?)\)/g, (_, label, url) => formatInlineLink(label, url))
        .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
        .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>')
        .replace(/==([^=\n]+?)==/g, '<mark>$1</mark>')
        .replace(/\^([^^\n]+?)\^/g, '<sup>$1</sup>')
        .replace(/~([^~\n]+?)~/g, '<sub>$1</sub>')
        .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');

    inlineTokens.forEach((tokenHtml, index) => {
        html = html.replace(new RegExp(`\\uE000${index}\\uE001`, 'g'), tokenHtml);
    });

    return html;
}

function formatInlineLink(label, url) {
    const safeUrl = getSafeInlineUrl(url);
    if (!safeUrl) {
        return label;
    }

    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

function getSafeInlineUrl(url) {
    const trimmed = String(url || '').trim();
    const normalized = trimmed.replace(/&amp;/g, '&').toLowerCase();

    if (/^(javascript|data|vbscript):/.test(normalized)) {
        return '';
    }

    if (/^[a-z][a-z0-9+.-]*:/.test(normalized) && !/^(https?:|mailto:)/.test(normalized)) {
        return '';
    }

    return trimmed;
}

function plainTextFromMarkdown(markdown) {
    return (markdown || '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^[-*+]\s+/gm, '')
        .replace(/\[([^\]\n]+?)\]\(([^)\s]+?)\)/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/==(.+?)==/g, '$1')
        .replace(/\^(.+?)\^/g, '$1')
        .replace(/~(.+?)~/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/`(.+?)`/g, '$1')
        .replace(/[>_=^~]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
