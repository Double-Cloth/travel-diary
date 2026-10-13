import { DRAFT_FORMAT, readDraft } from './record-input.mjs?v=20261013-cleanup-v1';
import { mediaBytes, readUploads } from './photo-uploads.mjs?v=20261013-cleanup-v1';
import { pinyinSlug } from './slug.mjs';
import { MAXIMUM_RECORD_ARCHIVE_BYTES } from './file-limits.mjs?v=20261009-stream-files-v2';

import { ByteSource, createZipBlob, readZipSource, readSourceText } from './zip-stream.mjs';

export const DRAFT_ARCHIVE_FORMAT = 'travel-diary-draft-archive-v2';
const decoder = new TextDecoder('utf-8', { fatal: true });

function draftEntries(value, editContext = {}) {
    const draft = readDraft(value);
    const uploads = readUploads(draft.uploads);
    const entries = [];
    const packageUploads = uploads.map((media, index) => {
        const stem = pinyinSlug(media.name.replace(/\.[^.]*$/, ''), `${media.kind}-${String(index + 1).padStart(3, '0')}`, { keepPlaceSuffix: true });
        const file = `media/${String(index + 1).padStart(3, '0')}-${stem}.${media.extension}`;
        entries.push({ name: file, data: media.data instanceof ByteSource ? media.data : mediaBytes(media.data) });
        return { id: media.id, name: media.name, kind: media.kind, file };
    });
    const metadata = {
        format: DRAFT_ARCHIVE_FORMAT,
        requestId: draft.requestId,
        input: draft.input,
        uploads: packageUploads,
        ...(editContext.originalDescMd ? { originalDescMd: editContext.originalDescMd, expected: editContext.expected } : {})
    };
    return [{ name: 'draft.json', data: JSON.stringify(metadata, null, 2) + '\n' }, ...entries];
}

export function createDraftBlob(value, editContext = {}, onProgress) {
    return createZipBlob(draftEntries(value, editContext), onProgress);
}

export async function readRecordSource(value, { verifyMedia = false, onProgress = () => {} } = {}) {
    if ((value.size ?? value.byteLength) > MAXIMUM_RECORD_ARCHIVE_BYTES) throw new Error('草稿 ZIP 超过大小上限。');
    const entries = await readZipSource(value);
    for (const entry of entries) {
        if (entry.name === 'draft.json') entry.data = await readSourceText(entry.data);
        else entry.data.head = await entry.data.read(0, Math.min(16386, entry.data.size));
    }
    const result = recordFromEntries(entries);
    if (verifyMedia) {
        let processed = 0;
        const total = result.draft.uploads.reduce((sum, media) => sum + media.data.size, 0);
        for (const media of result.draft.uploads) {
            for await (const chunk of media.data.chunks()) {
                processed += chunk.length;
                onProgress(processed, total);
            }
            media.data.cachedCrc = media.data.checksum;
        }
    }
    return result;
}

function recordFromEntries(entries) {
    const files = new Map(entries.map(entry => [entry.name, entry.data]));
    const metadataBytes = files.get('draft.json');
    if (!metadataBytes) throw new Error('草稿压缩包缺少 draft.json。');
    let metadata;
    try { metadata = JSON.parse(decoder.decode(metadataBytes)); }
    catch { throw new Error('draft.json 不是有效的 JSON 文件。'); }
    if (!metadata || ![DRAFT_ARCHIVE_FORMAT, 'travel-diary-draft-archive-v1'].includes(metadata.format) || !Array.isArray(metadata.uploads)) {
        throw new Error('请选择由本应用导出的 ZIP 草稿。');
    }
    const usedFiles = new Set(['draft.json']);
    const uploads = metadata.uploads.map(media => {
        if (!media || typeof media.id !== 'string' || typeof media.name !== 'string' || typeof media.file !== 'string'
            || !/^(?:photos|media)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(media.file) || usedFiles.has(media.file)) {
            throw new Error('草稿中的媒体清单无效。');
        }
        const data = files.get(media.file);
        if (!data) throw new Error(`草稿缺少媒体文件：${media.file}`);
        usedFiles.add(media.file);
        return { id: media.id, name: media.name, data };
    });
    if (files.size !== usedFiles.size) throw new Error('草稿压缩包包含未在清单中声明的文件。');
    return {
        draft: readDraft({ format: DRAFT_FORMAT, requestId: metadata.requestId, input: metadata.input, uploads }),
        originalDescMd: metadata.originalDescMd,
        expected: metadata.expected
    };
}
