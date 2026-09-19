import { DRAFT_FORMAT, readDraft } from './record-input.mjs';
import { readUploads } from './photo-uploads.mjs';
import { pinyinSlug } from './slug.mjs';
import { createZip, readZip } from './zip-archive.mjs';

export const DRAFT_ARCHIVE_FORMAT = 'travel-diary-draft-archive-v2';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function bytesToBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

export function createDraftArchive(value) {
    const draft = readDraft(value);
    const uploads = readUploads(draft.uploads);
    const entries = [];
    const packageUploads = uploads.map((media, index) => {
        const stem = pinyinSlug(media.name.replace(/\.[^.]*$/, ''), `${media.kind}-${String(index + 1).padStart(3, '0')}`, { keepPlaceSuffix: true });
        const file = `media/${String(index + 1).padStart(3, '0')}-${stem}.${media.extension}`;
        entries.push({ name: file, data: base64ToBytes(media.data) });
        return { id: media.id, name: media.name, kind: media.kind, file };
    });
    const metadata = {
        format: DRAFT_ARCHIVE_FORMAT,
        requestId: draft.requestId,
        input: draft.input,
        uploads: packageUploads
    };
    return createZip([{ name: 'draft.json', data: JSON.stringify(metadata, null, 2) + '\n' }, ...entries]);
}

export function readDraftArchive(value) {
    const entries = readZip(value);
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
        return { id: media.id, name: media.name, data: bytesToBase64(data) };
    });
    if (files.size !== usedFiles.size) throw new Error('草稿压缩包包含未在清单中声明的文件。');
    return readDraft({ format: DRAFT_FORMAT, requestId: metadata.requestId, input: metadata.input, uploads });
}
