import { isValidDateString } from './analytics.mjs?v=2.1.71';
import { readUploads, storedMediaNames } from './photo-uploads.mjs?v=2.1.71';
import { isSafeAsciiFileName, pinyinSlug } from './slug.mjs?v=2.1.71';

export const DRAFT_FORMAT = 'travel-diary-draft-v4';
export const RECORD_FIELDS = ['date', 'country_code', 'country', 'admin_area', 'admin_area_type', 'locality', 'locality_type', 'trip_id', 'title', 'body', 'desc_md', 'photo_folder', 'photos', 'video_folder', 'videos'];
const LEGACY_FIELDS = ['date', 'country_code', 'admin_area', 'locality', 'trip_id', 'title', 'body'];
const MEDIA_LIST_FIELDS = new Set(['photos', 'videos']);

export function recordMetadataSnapshot(record) {
    return JSON.stringify({ ...Object.fromEntries(RECORD_FIELDS
        .filter(key => !['title', 'body'].includes(key))
        .map(key => [key, record[key] ?? (MEDIA_LIST_FIELDS.has(key) ? [] : '')])), media_order: record.media_order || [] });
}

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
    if (!value || ![DRAFT_FORMAT, 'travel-diary-draft-v3', 'travel-diary-draft-v2', 'travel-diary-draft-v1'].includes(value.format) || !value.input || typeof value.input !== 'object' || Array.isArray(value.input)) {
        throw new Error('请选择由本应用导出的草稿 JSON 文件。');
    }
    if (typeof value.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(value.requestId)) throw new Error('草稿标识无效。');
    const input = {};
    for (const key of RECORD_FIELDS) {
        const isOptionalVideoField = key === 'video_folder' || key === 'videos';
        const isLegacyOptionalField = value.format !== DRAFT_FORMAT && (!LEGACY_FIELDS.includes(key) || key === 'photos');
        const field = value.input[key] ?? (isOptionalVideoField || isLegacyOptionalField ? (MEDIA_LIST_FIELDS.has(key) ? [] : '') : undefined);
        if (MEDIA_LIST_FIELDS.has(key)) {
            if (!Array.isArray(field) || field.length > 1000 || field.some(name => typeof name !== 'string' || name.length > 200)) {
                throw new Error('媒体列表必须是文件名数组，最多 1000 项，每项不超过 200 字符。');
            }
            input[key] = [...field];
            continue;
        }
        if (typeof field !== 'string' || field.length > (key === 'body' ? 100000 : 200)) {
            throw new Error('草稿字段缺失、格式错误或内容过长。');
        }
        input[key] = field;
    }
    const media = readUploads(value.uploads);
    const uploads = media.map(({ id, name, data }) => ({ id, name, data }));
    if (value.mediaOrder !== undefined && (!value.mediaOrder || typeof value.mediaOrder !== 'object' || Array.isArray(value.mediaOrder))) {
        throw new Error('媒体顺序格式无效。');
    }
    const mediaOrder = {};
    for (const [key, kind] of [['photos', 'image'], ['videos', 'video']]) {
        const order = value.mediaOrder?.[key];
        if (order === undefined) continue;
        const count = input[key].length + media.filter(upload => upload.kind === kind).length;
        if (!Array.isArray(order) || order.length !== count || new Set(order).size !== count
            || Array.from(order).some(index => !Number.isInteger(index) || index < 0 || index >= count)) {
            throw new Error('媒体顺序必须完整且不重复，请重新调整文件列表。');
        }
        mediaOrder[key] = [...order];
    }
    if (value.mediaOrder?.sequence !== undefined) {
        const sequence = value.mediaOrder.sequence;
        const photos = input.photos.length + media.filter(upload => upload.kind === 'image').length;
        const videos = input.videos.length + media.filter(upload => upload.kind === 'video').length;
        if (!Array.isArray(sequence) || sequence.length !== photos + videos
            || sequence.filter(type => type === 'photo').length !== photos
            || sequence.filter(type => type === 'video').length !== videos) {
            throw new Error('媒体顺序必须完整且类型正确，请重新调整文件列表。');
        }
        mediaOrder.sequence = [...sequence];
    }
    return { format: DRAFT_FORMAT, requestId: value.requestId, input, uploads,
        ...(Object.keys(mediaOrder).length ? { mediaOrder } : {}) };
}

export function prepareRecord(value, countries) {
    const draft = readDraft(value);
    const input = Object.fromEntries(RECORD_FIELDS.map(key => [key, MEDIA_LIST_FIELDS.has(key) ? draft.input[key].map(name => name.trim()) : draft.input[key].trim()]));
    if (!isValidDateString(input.date)) throw new Error('请填写有效的旅行日期。');
    const country = countries.find(item => item.code === input.country_code);
    if (!country) throw new Error('请从目录中选择国家 / 地区。');
    if (!input.locality) throw new Error('请填写城市 / 目的地。');
    if (!input.title) throw new Error('请填写日记标题。');
    for (const key of RECORD_FIELDS.filter(key => key !== 'body' && !MEDIA_LIST_FIELDS.has(key))) {
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
    if (input.video_folder && (!input.video_folder.startsWith('data/videos/') || !input.video_folder.slice('data/videos/'.length).split('/').every(isSafeFileName))) {
        throw new Error('视频目录须位于 data/videos/ 下，各级目录名仅使用 ASCII 字母、数字、连字符、下划线或点。');
    }
    if (input.videos.length && !input.video_folder) throw new Error('填写视频列表时必须指定视频目录。');
    if (input.videos.some(video => !isSafeFileName(video))) throw new Error('视频列表每行填写一个文件名，不能包含子路径、特殊字符或空行。');
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
        photos: input.photos,
        ...(input.video_folder ? { video_folder: input.video_folder } : {}),
        ...(input.videos.length ? { videos: input.videos } : {})
    };
    const uploads = readUploads(draft.uploads);
    const photoUploads = uploads.filter(upload => upload.kind === 'image');
    const videoUploads = uploads.filter(upload => upload.kind === 'video');
    if (photoUploads.length) {
        record.photo_folder = `data/photos/${slug}`;
        record.photos = storedMediaNames(input.photos, photoUploads, 'photo');
    }
    if (videoUploads.length) {
        record.video_folder = `data/videos/${slug}`;
        record.videos = storedMediaNames(input.videos, videoUploads, 'video');
    }
    // 文件分配保持来源顺序，展示顺序单独应用，避免将上传字节写入其他文件名。
    const photoNames = [...record.photos];
    const videoNames = [...(record.videos || [])];
    if (draft.mediaOrder?.photos) record.photos = draft.mediaOrder.photos.map(index => photoNames[index]);
    if (draft.mediaOrder?.videos && videoNames.length) record.videos = draft.mediaOrder.videos.map(index => videoNames[index]);
    if (draft.mediaOrder?.sequence) {
        const indexes = { photo: 0, video: 0 };
        record.media_order = draft.mediaOrder.sequence.map(type => `${type}:${record[`${type}s`][indexes[type]++]}`);
    }
    return {
        record,
        markdown: buildMarkdown(input),
        uploads,
        sourcePhotos: { folder: input.photo_folder, names: input.photos, targetNames: photoNames, order: draft.mediaOrder?.photos },
        sourceVideos: { folder: input.video_folder, names: input.videos, targetNames: videoNames, order: draft.mediaOrder?.videos }
    };
}
