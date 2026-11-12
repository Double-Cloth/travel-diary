import { recordFilePaths } from './record-backup.mjs?v=2.1.92';
import { recordIdentity } from './record-identity.mjs?v=2.1.92';

export function recycleRecordLabel(record) {
    return [record.date, record.country, record.admin_area, record.locality].filter(Boolean).join(' · ') || '日记';
}

export function recycleFileType(path, mediaKind = () => '') {
    const kind = mediaKind(path);
    if (path.startsWith('data/profile/')) return '个人资料';
    if (path === 'data/travel_data.json') return '日记索引';
    if (kind === 'image' || path.startsWith('data/photos/')) return '图片';
    if (kind === 'video' || path.startsWith('data/videos/')) return '视频';
    if (/\.md$/i.test(path)) return '正文';
    return '其他文件';
}

function recordIdentityResolver(candidates) {
    const identitiesByPath = new Map();
    for (const record of candidates) {
        if (!identitiesByPath.has(record.desc_md)) identitiesByPath.set(record.desc_md, new Set());
        if (record.record_id && !record.record_id.startsWith('legacy:')) identitiesByPath.get(record.desc_md).add(record.record_id);
    }
    return record => {
        const identities = identitiesByPath.get(record.desc_md);
        if (recordIdentity(record).startsWith('legacy:') && identities?.size === 1) return identities.values().next().value;
        return recordIdentity(record);
    };
}

// 展示关联与恢复关联独立保存，旧文件的归属提示不会改变恢复目标与写入内容。
export function groupRecycleItems(items, currentRecords = []) {
    const candidates = [...currentRecords, ...items.flatMap(item => [...(item.records || []), ...(item.mediaReferences || []), ...(item.displayRecords || [])])]
        .filter(record => record?.desc_md);
    const identity = recordIdentityResolver(candidates);
    const diaries = new Map();
    const owners = new Map();
    const folders = new Map();
    const addOwner = (index, name, key) => {
        if (!index.has(name)) index.set(name, new Set());
        index.get(name).add(key);
    };
    for (const record of candidates) {
        const key = identity(record);
        if (!diaries.has(key)) diaries.set(key, record);
        for (const name of recordFilePaths([record])) addOwner(owners, name, key);
        for (const [folder, prefix] of [[record.photo_folder, 'data/photos/'], [record.video_folder, 'data/videos/']]) {
            if (folder?.startsWith(prefix) && !folder.endsWith('/')) addOwner(folders, folder, key);
        }
    }
    const groups = new Map();
    const recordsByItem = new Map();
    for (const item of items) {
        const explicit = [...(item.records || []), ...(item.mediaReferences || []), ...(item.displayRecords || [])].filter(record => record?.desc_md);
        const related = new Map();
        for (const record of explicit) if (!related.has(identity(record))) related.set(identity(record), record);
        let unassigned = false;
        if (!related.size) {
            for (const file of item.files) {
                const matches = owners.get(file.path) || folders.get(file.path.slice(0, file.path.lastIndexOf('/')));
                if (!matches?.size) unassigned = true;
                for (const key of matches || []) related.set(key, diaries.get(key));
            }
        }
        const records = [...related.values()];
        recordsByItem.set(item.id, records);
        // 整站、多篇日记和混合文件保留完整批次，避免产生重复恢复入口。
        const single = item.kind !== 'snapshot' && related.size === 1 && !unassigned;
        const key = single ? `diary:${related.keys().next().value}` : `batch:${item.id}`;
        if (!groups.has(key)) groups.set(key, { key, record: single ? diaries.get(related.keys().next().value) : null, items: [] });
        groups.get(key).items.push(item);
    }
    return { groups: [...groups.values()], recordsByItem };
}

// 同篇日记的完整记录或旧版本需要单独恢复，互不覆盖的附件批次仍可合并恢复。
export function recycleRestoreConflicts(items, currentRecords, selections) {
    if (selections.length < 2) return [];
    const selected = new Map(selections.map(selection => [selection.id, selection]));
    const candidates = items.map(item => {
        const target = selected.get(item.id)?.targetDescMd;
        return target ? { ...item, mediaReferences: currentRecords.filter(record => record.desc_md === target), displayRecords: [] } : item;
    });
    const { recordsByItem } = groupRecycleItems(candidates, currentRecords);
    const records = [...currentRecords, ...[...recordsByItem.values()].flat()];
    const identity = recordIdentityResolver(records);
    const conflicts = new Map();
    for (const item of candidates.filter(item => selected.has(item.id) && item.kind !== 'snapshot')) {
        for (const record of recordsByItem.get(item.id)) {
            const key = identity(record);
            if (!conflicts.has(key)) conflicts.set(key, { record: currentRecords.find(current => identity(current) === key) || record, items: [] });
            conflicts.get(key).items.push(item);
        }
    }
    return [...conflicts.values()].filter(group => group.items.length > 1 && group.items.some(item => item.kind === 'version' || item.kind === 'record'));
}

// 逻辑目录只负责展示归属，文件保留原始对象供预览和恢复使用。
export function buildRecycleTree(files, query = '', {
    records = [], mediaReferences = [], displayRecords = [], mediaKind = () => '', groupSingleRecord = false,
    categories = ['正文', '图片', '视频', '个人资料', '日记索引', '其他文件']
} = {}) {
    const directories = new Map();
    const root = { path: '', name: '', depth: 0, directories: [], files: [], count: 0, totalBytes: 0, matches: false };
    directories.set('', root);
    const diaries = new Map();
    const owners = new Map();
    for (const record of [...records, ...mediaReferences, ...displayRecords]) {
        if (!record?.desc_md) continue;
        if (!diaries.has(record.desc_md)) diaries.set(record.desc_md, record);
        for (const name of recordFilePaths([record])) {
            if (!owners.has(name)) owners.set(name, new Set());
            owners.get(name).add(record.desc_md);
        }
    }
    const search = query.trim().toLowerCase();
    const directory = (parent, key, name, order) => {
        const path = parent.path ? `${parent.path}/${key}` : key;
        if (!directories.has(path)) {
            const node = { path, name, order, depth: parent.depth + 1, directories: [], files: [], count: 0, totalBytes: 0, matches: false };
            directories.set(path, node);
            parent.directories.push(node);
        }
        return directories.get(path);
    };
    for (const file of files) {
        const references = owners.get(file.path);
        let parent = root;
        const ancestors = [root];
        if (references?.size > 1) {
            parent = directory(root, 'shared', '共用内容', 1);
        } else if (references?.size && (groupSingleRecord || diaries.size > 1)) {
            const name = references.values().next().value;
            parent = directory(root, `record:${name}`, recycleRecordLabel(diaries.get(name)), 0);
        }
        if (parent !== root) ancestors.push(parent);
        const category = file.category || (diaries.has(file.path) ? '正文' : recycleFileType(file.path, mediaKind));
        const index = categories.indexOf(category);
        const node = directory(parent, `type:${index}`, category, index + 2);
        node.files.push(file);
        ancestors.push(node);
        const matches = Boolean(search && [file.path, ...ancestors.map(ancestor => ancestor.name)].some(value => value.toLowerCase().includes(search)));
        for (const ancestor of ancestors) {
            ancestor.count++;
            ancestor.totalBytes += file.size;
            ancestor.matches ||= matches;
        }
    }
    const collator = new Intl.Collator('zh-CN', { numeric: true });
    const compare = (a, b) => collator.compare(a.path, b.path) || a.path.localeCompare(b.path);
    for (const node of directories.values()) {
        node.directories.sort((a, b) => a.order - b.order || collator.compare(a.name, b.name) || compare(a, b));
        node.files.sort((a, b) => collator.compare(a.path.split('/').pop(), b.path.split('/').pop()) || compare(a, b));
    }
    return directories;
}

// 差异拆成信息、正文与单个附件，复用回收目录的日记归属及共用文件逻辑。
export function buildRestorePreviewTree(changes, mediaKind = () => '', { groupSingleRecord = true } = {}) {
    const files = [];
    const records = [];
    const media = new Set();
    for (const { record, comparison } of changes) {
        const diary = record.date ? record : comparison.previous?.date ? comparison.previous : null;
        if (diary) {
            records.push(diary);
            if (comparison.previous?.date) records.push({ ...comparison.previous, desc_md: diary.desc_md });
        }
        const empty = { ...comparison, fields: [], media: [], markdownChanged: false };
        if (comparison.fields.length) files.push({ path: record.desc_md, size: 0, category: '日记信息', label: '记录信息', record, comparison: { ...empty, fields: comparison.fields } });
        if (comparison.markdownChanged) files.push({ path: record.desc_md, size: 0, record, comparison: { ...empty, markdownChanged: true } });
        for (const name of comparison.media) {
            if (media.has(name)) continue;
            media.add(name);
            files.push({ path: name, size: 0, record, comparison: { ...empty, media: [name] } });
        }
    }
    return buildRecycleTree(files, '', { records, mediaKind, groupSingleRecord, categories: ['日记信息', '正文', '图片', '视频', '个人资料', '日记索引', '其他文件'] });
}
