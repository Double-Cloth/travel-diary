import { parseMarkdown, getSafeInlineUrl } from './data.js';
import { escapeHtml } from './utils.js';

export function splitMarkdown(source, fallbackTitle = '') {
    const normalized = source.replace(/\r\n?/g, '\n');
    const match = normalized.match(/^# ([^\n]*)(?:\n|$)/);
    return match
        ? { title: match[1], body: normalized.slice(match[0].length).replace(/^\n/, '') }
        : { title: fallbackTitle, body: normalized };
}

export function previewHtml(markdown, title) {
    const parsed = parseMarkdown(markdown);
    return `<h1>${escapeHtml(title)}</h1>${parsed.bodyHtml || '<p><br></p>'}`;
}

function escapeMarkdown(text) {
    return text.replace(/\\/g, '\\\\').replace(/([*~^=`\[\]])/g, '\\$1').replace(/(^|\n)([#-])/g, '$1\\$2');
}

// 只序列化日记解析器支持的结构；复制进来的 HTML 不进入源码或文件。
export function previewToMarkdown(root) {
    const walk = node => {
        if (node.nodeType === 3) return escapeMarkdown(node.nodeValue.replace(/\u00a0/g, ' '));
        if (node.nodeType !== 1) return '';
        const tag = node.tagName.toLowerCase();
        if (['script', 'style', 'iframe', 'img', 'object'].includes(tag)) return '';
        const content = [...node.childNodes].map(walk).join('');
        const wrappers = { strong: '**', b: '**', em: '*', i: '*', del: '~~', s: '~~', strike: '~~', mark: '==', sup: '^', sub: '~' };
        if (wrappers[tag]) return `${wrappers[tag]}${content}${wrappers[tag]}`;
        if (tag === 'code') return '`' + node.textContent.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
        if (tag === 'a') {
            const href = node.getAttribute('href') || '';
            return getSafeInlineUrl(href) && !/[\s()]/.test(href)
                ? `[${content}](${href})` : content;
        }
        if (tag === 'br') return '\n';
        if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${tag === 'h1' ? node.textContent : content.trim()}\n\n`;
        if (tag === 'li') return `- ${content.trim()}\n`;
        if (tag === 'ul' || tag === 'ol') return content + '\n';
        if (tag === 'p' || tag === 'div') return '\n\n' + content.trim() + '\n\n';
        return content;
    };
    return [...root.childNodes].map(walk).join('').replace(/\n{3,}/g, '\n\n').trim();
}
