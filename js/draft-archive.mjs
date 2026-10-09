import { DRAFT_FORMAT, readDraft } from './record-input.mjs?v=20261009-large-files-v1';
import { mediaBytes, readUploads } from './photo-uploads.mjs?v=20261009-large-files-v1';
import { pinyinSlug } from './slug.mjs';
import { createZip, readZip } from './zip-archive.mjs?v=20261009-large-files-v1';
import { MAXIMUM_RECORD_ARCHIVE_BYTES } from './file-limits.mjs';

export const DRAFT_ARCHIVE_FORMAT = 'travel-diary-draft-archive-v2';
const decoder = new TextDecoder('utf-8', { fatal: true });

export function createDraftArchive(value, editContext = {}) {
    const draft = readDraft(value);
    const uploads = readUploads(draft.uploads);
    const entries = [];
    const packageUploads = uploads.map((media, index) => {
        const stem = pinyinSlug(media.name.replace(/\.[^.]*$/, ''), `${media.kind}-${String(index + 1).padStart(3, '0')}`, { keepPlaceSuffix: true });
        const file = `media/${String(index + 1).padStart(3, '0')}-${stem}.${media.extension}`;
        entries.push({ name: file, data: mediaBytes(media.data) });
        return { id: media.id, name: media.name, kind: media.kind, file };
    });
    const metadata = {
        format: DRAFT_ARCHIVE_FORMAT,
        requestId: draft.requestId,
        input: draft.input,
        uploads: packageUploads,
        ...(editContext.originalDescMd ? { originalDescMd: editContext.originalDescMd, expected: editContext.expected } : {})
    };
    return createZip([{ name: 'draft.json', data: JSON.stringify(metadata, null, 2) + '\n' }, ...entries]);
}

export function readDraftArchive(value) {
    return readRecordArchive(value).draft;
}

export function readRecordArchive(value) {
    if ((value.byteLength ?? value.length) > MAXIMUM_RECORD_ARCHIVE_BYTES) {
        throw new Error(`草稿 ZIP 不能超过 ${MAXIMUM_RECORD_ARCHIVE_BYTES / 1024 / 1024} MiB。`);
    }
    const entries = readZip(value, { copy: false });
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
