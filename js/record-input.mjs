import { isValidDateString } from './analytics.mjs';

export const DRAFT_FORMAT = 'travel-diary-draft-v1';
export const RECORD_FIELDS = ['date', 'country_code', 'admin_area', 'locality', 'trip_id', 'title', 'body'];

export function readDraft(value) {
    if (!value || value.format !== DRAFT_FORMAT || !value.input || typeof value.input !== 'object') {
        throw new Error('请选择从新增旅行记录窗口下载的草稿 JSON 文件。');
    }
    if (typeof value.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(value.requestId)) throw new Error('草稿标识无效。');
    const input = {};
    for (const key of RECORD_FIELDS) {
        if (typeof value.input[key] !== 'string' || value.input[key].length > (key === 'body' ? 100000 : 200)) {
            throw new Error('草稿字段缺失、格式错误或内容过长。');
        }
        input[key] = value.input[key];
    }
    return { format: DRAFT_FORMAT, requestId: value.requestId, input };
}

export function prepareRecord(value, countries) {
    const draft = readDraft(value);
    const input = Object.fromEntries(RECORD_FIELDS.map(key => [key, draft.input[key].trim()]));
    if (!isValidDateString(input.date)) throw new Error('请填写有效的旅行日期。');
    const country = countries.find(item => item.code === input.country_code);
    if (!country) throw new Error('请从目录中选择国家 / 地区。');
    if (!input.locality) throw new Error('请填写城市 / 目的地。');
    if (!input.title) throw new Error('请填写日记标题。');
    for (const key of RECORD_FIELDS.filter(key => key !== 'body')) {
        if (/[\u0000-\u001f\u007f]/.test(input[key])) throw new Error('单行字段不能包含换行或控制字符。');
    }
    if (input.body.includes('\0')) throw new Error('正文不能包含空字符。');
    const record = {
        date: input.date,
        country: country.name_zh,
        country_code: country.code,
        admin_area: input.admin_area,
        locality: input.locality,
        ...(input.trip_id ? { trip_id: input.trip_id } : {}),
        desc_md: `data/travel-diary/${input.date.slice(0, 4)}/${input.date}-${draft.requestId}.md`,
        photo_folder: '',
        photos: []
    };
    return { record, markdown: `# ${input.title}\n\n${input.body.replace(/\r\n?/g, '\n')}\n` };
}
