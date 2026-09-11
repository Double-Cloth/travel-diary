import { createZip } from './zip-archive.mjs';

const REQUIRED_DATA_FILES = ['data/travel_data.json', 'data/profile/profile-picture.png'];

function isSafeDataPath(value) {
    const path = String(value || '').replace(/\\/g, '/');
    return path.startsWith('data/')
        && !path.includes('\0')
        && !/[\u0000-\u001f\u007f:]/.test(path)
        && !path.split('/').some(part => !part || part === '.' || part === '..');
}

export function collectReferencedDataFiles(records) {
    if (!Array.isArray(records)) throw new Error('旅行索引必须是数组。');
    const files = new Set(REQUIRED_DATA_FILES);

    for (const record of records) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('旅行索引包含无效记录。');
        if (record.desc_md) files.add(record.desc_md);
        if (record.photo_folder && Array.isArray(record.photos)) {
            for (const photo of record.photos) files.add(`${record.photo_folder}/${photo}`);
        }
    }

    const paths = [...files].map(path => String(path).replace(/\\/g, '/'));
    const invalid = paths.find(path => !isSafeDataPath(path));
    if (invalid) throw new Error(`旅行索引引用了无效数据路径：${invalid}`);
    return paths.sort((left, right) => left.localeCompare(right, 'en'));
}

async function fetchFile(path, baseUrl, fetchImpl) {
    const response = await fetchImpl(new URL(path, baseUrl), { cache: 'no-store' });
    if (!response.ok) throw new Error(`无法读取数据文件 ${path}（HTTP ${response.status}）。`);
    return new Uint8Array(await response.arrayBuffer());
}

export async function createBrowserDataArchive(baseUrl, fetchImpl = fetch) {
    const indexPath = 'data/travel_data.json';
    const indexBytes = await fetchFile(indexPath, baseUrl, fetchImpl);
    let records;
    try {
        records = JSON.parse(new TextDecoder().decode(indexBytes));
    } catch {
        throw new Error('data/travel_data.json 不是有效 JSON。');
    }

    const paths = collectReferencedDataFiles(records);
    const entries = await Promise.all(paths.map(async path => ({
        name: path,
        data: path === indexPath ? indexBytes : await fetchFile(path, baseUrl, fetchImpl)
    })));
    return createZip(entries);
}
