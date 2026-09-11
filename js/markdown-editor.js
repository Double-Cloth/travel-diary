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

function highlightedInline(source) {
    const token = /(`(?:\\.|[^`\n])+`|\[[^\]\n]*\]\([^\n)]*\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|==[^=\n]+==|\*[^*\n]+\*|_[^_\n]+_)/g;
    let output = '';
    let offset = 0;
    for (const match of source.matchAll(token)) {
        output += escapeHtml(source.slice(offset, match.index));
        const value = match[0];
        const kind = value.startsWith('`') ? 'code' : value.startsWith('[') ? 'link' : 'emphasis';
        output += `<span class="md-${kind}">${escapeHtml(value)}</span>`;
        offset = match.index + value.length;
    }
    return output + escapeHtml(source.slice(offset));
}

export function highlightMarkdown(source) {
    let inFence = false;
    return source.replace(/\r\n?/g, '\n').split('\n').map(line => {
        const fence = line.match(/^(\s*)(```+|~~~+)(.*)$/);
        if (fence) {
            inFence = !inFence;
            return `${escapeHtml(fence[1])}<span class="md-fence">${escapeHtml(fence[2])}</span><span class="md-meta">${escapeHtml(fence[3])}</span>`;
        }
        if (inFence) return `<span class="md-code">${escapeHtml(line)}</span>`;
        const heading = line.match(/^(\s{0,3})(#{1,6})(\s+)(.*)$/);
        if (heading) return `${escapeHtml(heading[1])}<span class="md-marker">${heading[2]}</span>${escapeHtml(heading[3])}<span class="md-heading">${highlightedInline(heading[4])}</span>`;
        const quote = line.match(/^(\s*)(>+)(\s?)(.*)$/);
        if (quote) return `${escapeHtml(quote[1])}<span class="md-marker">${quote[2]}</span>${escapeHtml(quote[3])}${highlightedInline(quote[4])}`;
        const list = line.match(/^(\s*)([-+*]|\d+\.)(\s+)(.*)$/);
        if (list) return `${escapeHtml(list[1])}<span class="md-marker">${escapeHtml(list[2])}</span>${escapeHtml(list[3])}${highlightedInline(list[4])}`;
        return highlightedInline(line);
    }).join('\n');
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
