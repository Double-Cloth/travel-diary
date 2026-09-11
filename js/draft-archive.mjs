import { DRAFT_FORMAT, readDraft } from './record-input.mjs';
import { readUploads } from './photo-uploads.mjs';
import { pinyinSlug } from './slug.mjs';
import { createZip, readZip } from './zip-archive.mjs';

export const DRAFT_ARCHIVE_FORMAT = 'travel-diary-draft-archive-v1';
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
    const packageUploads = uploads.map((photo, index) => {
        const stem = pinyinSlug(photo.name.replace(/\.[^.]*$/, ''), `photo-${String(index + 1).padStart(3, '0')}`, { keepPlaceSuffix: true });
        const file = `photos/${String(index + 1).padStart(3, '0')}-${stem}.${photo.extension}`;
        entries.push({ name: file, data: base64ToBytes(photo.data) });
        return { id: photo.id, name: photo.name, file };
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
    if (!metadata || metadata.format !== DRAFT_ARCHIVE_FORMAT || !Array.isArray(metadata.uploads)) {
        throw new Error('请选择从新增旅行记录窗口导出的 ZIP 草稿。');
    }
    const usedFiles = new Set(['draft.json']);
    const uploads = metadata.uploads.map(photo => {
        if (!photo || typeof photo.id !== 'string' || typeof photo.name !== 'string' || typeof photo.file !== 'string'
            || !/^photos\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(photo.file) || usedFiles.has(photo.file)) {
            throw new Error('草稿中的照片清单无效。');
        }
        const data = files.get(photo.file);
        if (!data) throw new Error(`草稿缺少照片文件：${photo.file}`);
        usedFiles.add(photo.file);
        return { id: photo.id, name: photo.name, data: bytesToBase64(data) };
    });
    if (files.size !== usedFiles.size) throw new Error('草稿压缩包包含未在清单中声明的文件。');
    return readDraft({ format: DRAFT_FORMAT, requestId: metadata.requestId, input: metadata.input, uploads });
}

