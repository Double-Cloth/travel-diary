import { isValidDateString } from './analytics.mjs';
import { readUploads, storedPhotoNames } from './photo-uploads.mjs';
import { isSafeAsciiFileName, pinyinSlug } from './slug.mjs';

export const DRAFT_FORMAT = 'travel-diary-draft-v3';
export const RECORD_FIELDS = ['date', 'country_code', 'country', 'admin_area', 'admin_area_type', 'locality', 'locality_type', 'trip_id', 'title', 'body', 'desc_md', 'photo_folder', 'photos'];
const LEGACY_FIELDS = ['date', 'country_code', 'admin_area', 'locality', 'trip_id', 'title', 'body'];

export function buildMarkdown(input) {
    return `# ${input.title.trim()}\n\n${input.body.trim().replace(/\r\n?/g, '\n')}\n`;
}

export function recordSlug(locality) {
    return pinyinSlug(locality);
}

export function defaultMarkdownPath(date, locality) {
    return `data/travel-diary/${date.slice(0, 4)}/${date}-${recordSlug(locality)}.md`;
}

function isSafeFileName(name) {
    return isSafeAsciiFileName(name);
}

export function readDraft(value) {
    if (!value || ![DRAFT_FORMAT, 'travel-diary-draft-v2', 'travel-diary-draft-v1'].includes(value.format) || !value.input || typeof value.input !== 'object' || Array.isArray(value.input)) {
        throw new Error('请选择从新增旅行记录窗口下载的草稿 JSON 文件。');
    }
    if (typeof value.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(value.requestId)) throw new Error('草稿标识无效。');
    const input = {};
    for (const key of RECORD_FIELDS) {
        const field = value.input[key] ?? (value.format === 'travel-diary-draft-v1' && !LEGACY_FIELDS.includes(key) ? (key === 'photos' ? [] : '') : undefined);
        if (key === 'photos') {
            if (!Array.isArray(field) || field.length > 1000 || field.some(photo => typeof photo !== 'string' || photo.length > 200)) {
                throw new Error('照片列表必须是文件名数组，最多 1000 项，每项不超过 200 字符。');
            }
            input[key] = [...field];
            continue;
        }
        if (typeof field !== 'string' || field.length > (key === 'body' ? 100000 : 200)) {
            throw new Error('草稿字段缺失、格式错误或内容过长。');
        }
        input[key] = field;
    }
    const uploads = readUploads(value.uploads).map(({ id, name, data }) => ({ id, name, data }));
    return { format: DRAFT_FORMAT, requestId: value.requestId, input, uploads };
}

export function prepareRecord(value, countries) {
    const draft = readDraft(value);
    const input = Object.fromEntries(RECORD_FIELDS.map(key => [key, key === 'photos' ? draft.input.photos.map(photo => photo.trim()) : draft.input[key].trim()]));
    if (!isValidDateString(input.date)) throw new Error('请填写有效的旅行日期。');
    const country = countries.find(item => item.code === input.country_code);
    if (!country) throw new Error('请从目录中选择国家 / 地区。');
    if (!input.locality) throw new Error('请填写城市 / 目的地。');
    if (!input.title) throw new Error('请填写日记标题。');
    for (const key of RECORD_FIELDS.filter(key => key !== 'body' && key !== 'photos')) {
        if (/[\u0000-\u001f\u007f]/.test(input[key])) throw new Error('单行字段不能包含换行或控制字符。');
    }
    if (input.body.includes('\0')) throw new Error('正文不能包含空字符。');
    const slug = recordSlug(input.locality);
    const markdownPath = input.desc_md || defaultMarkdownPath(input.date, input.locality);
    const expectedPrefix = `data/travel-diary/${input.date.slice(0, 4)}/${input.date}-`;
    if (!markdownPath.startsWith(expectedPrefix) || !markdownPath.endsWith('.md') || !isSafeFileName(markdownPath.slice(`data/travel-diary/${input.date.slice(0, 4)}/`.length))) {
        throw new Error(`正文路径须为 ${expectedPrefix}name.md，文件名仅使用 ASCII 字母、数字、连字符、下划线或点。`);
    }
    if (input.photo_folder && (!input.photo_folder.startsWith('data/photos/') || !input.photo_folder.slice('data/photos/'.length).split('/').every(isSafeFileName))) {
        throw new Error('照片目录须位于 data/photos/ 下，各级目录名仅使用 ASCII 字母、数字、连字符、下划线或点。');
    }
    if (input.photos.length && !input.photo_folder) throw new Error('填写照片列表时必须指定照片目录。');
    if (input.photos.some(photo => !isSafeFileName(photo))) throw new Error('照片列表每行填写一个文件名，不能包含子路径、特殊字符或空行。');
    const record = {
        date: input.date,
        country: input.country || country.name_zh,
        country_code: country.code,
        admin_area: input.admin_area,
        ...(input.admin_area_type ? { admin_area_type: input.admin_area_type } : {}),
        locality: input.locality,
        ...(input.locality_type ? { locality_type: input.locality_type } : {}),
        ...(input.trip_id ? { trip_id: pinyinSlug(input.trip_id, 'trip') } : {}),
        desc_md: markdownPath,
        photo_folder: input.photo_folder,
        photos: input.photos
    };
    const uploads = readUploads(draft.uploads);
    if (uploads.length) {
        record.photo_folder = `data/photos/${slug}`;
        record.photos = storedPhotoNames(input.photos, uploads);
    }
    return { record, markdown: buildMarkdown(input), uploads, sourcePhotos: { folder: input.photo_folder, names: input.photos } };
}
