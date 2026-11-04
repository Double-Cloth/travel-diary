import { createZipBlob, zipStreamSize } from './zip-stream.mjs';
import { readBackupRecords, selectBackupRecords, recordFilePaths, recordBackupEntries } from './record-backup.mjs?v=2.1.25';
import { identifyRecords } from './record-identity.mjs?v=2.1.25';
import { MAXIMUM_ARCHIVE_BYTES } from './file-limits.mjs?v=2.1.25';
import { saveBlobDownload } from './operation-progress.js?v=2.1.25';

function validateDataPath(name) {
    if (typeof name !== 'string' || !/^data\/(?:travel-diary|photos|videos)\//.test(name)
        || name.split('/').some(part => !part || part.startsWith('.') || /[\\%?#:\u0000-\u001f\u007f<>"|*]/.test(part) || /[. ]$/.test(part))) {
        throw new Error(`旅行索引中的文件路径无效：${name}`);
    }
}

// 静态托管没有目录枚举接口，只备份索引可达的公开内容，不请求认证配置。
export async function createStaticBackup(paths, progress) {
    const signal = AbortSignal.any([progress.signal, AbortSignal.timeout(8 * 60 * 60 * 1000)]);
    let bytes = 0;
    async function readFile(name, optional = false) {
        signal.throwIfAborted();
        const url = new URL(name.split('/').map(encodeURIComponent).join('/'), new URL('.', window.location.href));
        const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal });
        if (response.status === 404 && optional) { await response.body?.cancel(); return null; }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`无法读取 ${name}（HTTP ${response.status}）。`); }
        if (bytes + Number(response.headers.get('Content-Length')) > MAXIMUM_ARCHIVE_BYTES) {
            await response.body?.cancel();
            throw new Error('静态备份不能超过 100 GiB，请减少所选记录。');
        }
        const data = await response.blob();
        signal.throwIfAborted();
        bytes += data.size;
        if (bytes > MAXIMUM_ARCHIVE_BYTES) throw new Error('静态备份不能超过 100 GiB，请减少所选记录。');
        return { name, data };
    }

    progress.phase('正在读取已发布的旅行索引…');
    const index = await readFile('data/travel_data.json');
    const allRecords = identifyRecords(await readBackupRecords([index]));
    const records = paths === null ? allRecords : selectBackupRecords(allRecords, paths);
    // 先检查全部所选路径，再发出正文与附件请求。
    for (const record of records) {
        validateDataPath(record.desc_md);
        if (!/^data\/travel-diary\/\d{4}\/[^/]+\.md$/.test(record.desc_md)
            || ['photos', 'videos'].some(field => record[field] != null && (!Array.isArray(record[field])
                || record[field].some(name => typeof name !== 'string' || name.includes('/'))))) {
            throw new Error('旅行索引中的正文或附件列表无效。');
        }
    }
    const names = [...recordFilePaths(records)];
    names.forEach(validateDataPath);
    const markdown = new Set(records.map(record => record.desc_md));
    const entries = [];
    let missingMediaFiles = 0;
    for (const [position, name] of names.entries()) {
        progress.update(position, names.length, '正在读取正文和附件…', 'files');
        const entry = await readFile(name, !markdown.has(name));
        if (entry) entries.push(entry);
        else missingMediaFiles += 1;
    }
    let archiveEntries;
    if (paths === null) {
        for (const name of ['data/profile/profile-picture.png', 'data/profile/owner-name.txt']) {
            const entry = await readFile(name, true);
            if (entry) entries.push(entry);
        }
        archiveEntries = [{ name: index.name, data: JSON.stringify(records, null, 2) + '\n' }, ...entries];
    } else archiveEntries = recordBackupEntries(entries, records);
    if (zipStreamSize(archiveEntries) > MAXIMUM_ARCHIVE_BYTES) throw new Error('静态备份不能超过 100 GiB，请减少所选记录。');
    const blob = await createZipBlob(archiveEntries, (loaded, total) => {
        signal.throwIfAborted();
        progress.update(loaded, total, '正在打包已发布的内容…');
    });
    signal.throwIfAborted();
    return { blob, missingMediaFiles };
}

export async function downloadStaticBackup(name, progress, paths = null) {
    try {
        const { blob, missingMediaFiles } = await createStaticBackup(paths, progress);
        progress.setCancelable(false, '备份正在交给浏览器保存。');
        saveBlobDownload(blob, name);
        progress.complete(`静态备份已交给浏览器保存，不含密码配置。${missingMediaFiles ? `有 ${missingMediaFiles} 个附件缺失，未打包；日记及引用已保留。` : ''}`);
        return { static: true, missingMediaFiles };
    } catch (error) {
        if (progress.signal.aborted) { progress.remove(); return { cancelled: true }; }
        throw error;
    }
}
