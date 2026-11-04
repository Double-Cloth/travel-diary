import { escapeHtml } from './utils.js?v=2.1.26';
import { changedTextBlocks } from './record-diff.mjs?v=2.1.26';
import { markdownPreview } from './content-preview.js?v=2.1.26';

export function renderRecordDifference(record, comparison, { afterLabel = '备份', note = '仅显示有变化的部分。勾选这篇日记后，将采用备份内容。', previewLabel = '预览导入后的正文' } = {}) {
    if (!comparison) return '';
    if (comparison.status === 'conflict') return `<p role="status">${escapeHtml(comparison.message)}</p>`;
    if (!['changed', 'added', 'removed'].includes(comparison.status)) return '';
    const previous = comparison.previous || {};
    const labels = { date: '日期', country: '国家 / 地区', country_code: '国家代码', admin_area: '行政区', admin_area_type: '行政区类型', locality: '目的地', locality_type: '目的地类型', trip_id: '行程', desc_md: '正文路径', photo_folder: '图片目录', photos: '图片列表', video_folder: '视频目录', videos: '视频列表' };
    const formatValue = (value, other) => {
        if (!Array.isArray(value)) return String(value ?? '').trim() || '未设置';
        const changed = value.filter(item => !Array.isArray(other) || !other.includes(item));
        const removed = Array.isArray(other) && other.some(item => !value.includes(item));
        return changed.length || removed ? changed.join('、') || '无' : `顺序：${value.join('、') || '无'}`;
    };
    const blocks = comparison.markdownChanged ? changedTextBlocks(comparison.currentMarkdown, comparison.markdown) : [];
    const sections = [comparison.fields.length ? `${comparison.fields.length} 项信息` : '', blocks.length ? '正文' : '', comparison.media.length ? `${comparison.media.length} 个附件` : ''].filter(Boolean);
    const diffLines = (block, side) => {
        const removed = side === 'before';
        const count = removed ? block.countBefore : block.countAfter;
        if (!count) return '';
        const start = removed ? block.lineBefore : block.lineAfter;
        return block[side].split('\n').map((line, index) => `<div class="record-diff-line record-diff-${removed ? 'removed' : 'added'}"><span class="record-diff-line-number">${removed ? start + index : ''}</span><span class="record-diff-line-number">${removed ? '' : start + index}</span><span class="record-diff-line-sign" aria-label="${removed ? '删除' : '新增'}">${removed ? '−' : '+'}</span><code>${escapeHtml(line) || '&#8203;'}</code></div>`).join('');
    };
    return `<details class="record-diff" data-diff-record="${escapeHtml(record.desc_md)}"><summary><span>${comparison.status === 'added' ? '预览新增内容' : comparison.status === 'removed' ? '预览移除内容' : '查看差异'}</span><small>${escapeHtml(sections.join(' · '))}</small></summary>
        <div class="record-diff-body"><p class="record-diff-note">${escapeHtml(note)}</p>
        ${comparison.fields.length ? `<section class="record-diff-section"><h3>记录信息</h3><dl>${comparison.fields.map(key => `<div><dt>${escapeHtml(labels[key] || key)}</dt><dd><span class="record-diff-value record-diff-before"><small>当前</small>${escapeHtml(formatValue(previous[key], record[key]))}</span><span class="record-diff-value record-diff-after"><small>${escapeHtml(afterLabel)}</small>${escapeHtml(formatValue(record[key], previous[key]))}</span></dd></div>`).join('')}</dl></section>` : ''}
        ${blocks.length ? `<section class="record-diff-section record-diff-text"><h3>正文改动 <small>${blocks.length} 处</small></h3><p class="record-diff-legend"><span class="record-diff-removed">− 删除</span><span class="record-diff-added">+ 新增</span></p><div class="record-diff-unified" role="group" aria-label="正文差异，左侧为当前行号，右侧为${escapeHtml(afterLabel)}行号">${blocks.map(block => `<div class="record-diff-hunk"><p class="record-diff-range">@@ −${block.lineBefore - (block.countBefore ? 0 : 1)},${block.countBefore} +${block.lineAfter - (block.countAfter ? 0 : 1)},${block.countAfter} @@</p>${diffLines(block, 'before')}${diffLines(block, 'after')}</div>`).join('')}</div><details class="content-preview-source"><summary>${escapeHtml(previewLabel)}</summary>${markdownPreview(comparison.markdown)}</details></section>` : ''}
        ${comparison.media.length ? `<section class="record-diff-section"><h3>附件改动</h3><ul class="record-diff-media">${comparison.media.map((name, index) => {
            const action = !comparison.previousMediaPaths?.has(name) ? '新增' : !comparison.incomingMediaPaths?.has(name) ? '移除' : '内容变化';
            return `<li><p class="record-diff-media-heading"><span>${action}</span> ${escapeHtml(name)}</p><div class="record-diff-columns"><div class="record-diff-before"><h4>当前</h4><div data-diff-media-before="${index}" data-media-viewer-group>${comparison.previousMediaPaths?.has(name) ? '正在准备预览…' : '<p class="record-diff-empty">无此附件</p>'}</div></div><div class="record-diff-after"><h4>${escapeHtml(afterLabel)}</h4><div data-diff-media-after="${index}" data-media-viewer-group>${comparison.incomingMediaPaths?.has(name) ? '正在准备预览…' : '<p class="record-diff-empty">无此附件</p>'}</div></div></div></li>`;
        }).join('')}</ul></section>` : ''}</div>
    </details>`;
}

// 导入备份与回收站共用附件预览；调用方提供来源与生命周期检查。
export async function loadDifferenceMedia(details, comparison, scope, resolveFile, isCurrent) {
    if (!details.open || details.dataset.loaded) return;
    details.dataset.loaded = 'true';
    for (const [index, name] of (comparison?.media || []).entries()) {
        for (const side of ['before', 'after']) {
            if (!(side === 'before' ? comparison.previousMediaPaths : comparison.incomingMediaPaths)?.has(name)) continue;
            const container = details.querySelector(`[data-diff-media-${side}="${index}"]`);
            try {
                const preview = await scope.file({ name, ...resolveFile(name, side), index: 0 });
                if (!isCurrent() || !details.isConnected) return;
                container.replaceChildren(preview);
            } catch (failure) {
                if (!isCurrent() || !details.isConnected) return;
                container.textContent = failure.message;
            }
        }
    }
}
