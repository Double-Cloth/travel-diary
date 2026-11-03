import { readSourceText, sourceOf } from './zip-stream.mjs';

export const RECORD_BACKUP_PATH = 'data/record-backup.json';
export const RECORD_BACKUP_FORMAT = 'travel-diary-records-v1';

export function recordFilePaths(records) {
    return new Set(records.flatMap(record => [record.desc_md,
        ...(record.photos || []).map(name => `${record.photo_folder}/${name}`),
        ...(record.videos || []).map(name => `${record.video_folder}/${name}`)]));
}

export function selectBackupRecords(records, paths) {
    if (!Array.isArray(records) || !Array.isArray(paths) || !paths.length || paths.length > 10000
        || paths.some(path => typeof path !== 'string' || !path || path.length > 200) || new Set(paths).size !== paths.length) {
        throw new Error('请选择有效且不重复的旅行记录。');
    }
    const selected = new Set(paths);
    const result = records.filter(record => selected.has(record.desc_md));
    if (result.length !== paths.length) throw new Error('所选记录已变化或不存在，请重新选择。');
    return result;
}

export async function readBackupRecords(entries) {
    const index = entries.find(entry => entry.name === 'data/travel_data.json');
    if (!index) throw new Error('备份缺少 data/travel_data.json。');
    const records = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readSourceText(sourceOf(index.data))));
    if (!Array.isArray(records) || records.length > 10000 || records.some(record => !record || typeof record.desc_md !== 'string')
        || new Set(records.map(record => record.desc_md)).size !== records.length) throw new Error('备份中的旅行索引无效。');
    return records;
}

export function recordBackupEntries(entries, records, { includeAuth = false } = {}) {
    const paths = recordFilePaths(records);
    const files = entries.filter(entry => paths.has(entry.name) || (includeAuth && entry.name === '.secrets/auth.json'));
    const available = new Set(files.map(entry => entry.name));
    if (records.some(record => !available.has(record.desc_md))) throw new Error('所选记录缺少正文文件。');
    const encoder = new TextEncoder();
    return [
        { name: 'data/travel_data.json', data: encoder.encode(JSON.stringify(records, null, 2) + '\n') },
        { name: RECORD_BACKUP_PATH, data: encoder.encode(JSON.stringify({ format: RECORD_BACKUP_FORMAT })) },
        ...files
    ];
}
