import { recordFilePaths } from './record-backup.mjs?v=2.1.138';
import { recordIdentity, matchRecord } from './record-identity.mjs?v=2.1.138';

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

// 信息与文件分别选择，共用文件只出现一次，索引由所选日记合并生成。
export function recyclePartGroups(item) {
    const full = item.kind === 'snapshot' || item.files.some(file => file.path === 'data/travel_data.json');
    const records = new Map([...(item.records || []), ...(item.mediaReferences || []), ...(item.displayRecords || [])]
        .filter(record => record?.desc_md).map(record => [record.desc_md, record]));
    const metadata = new Set((full ? item.displayRecords || [] : item.records || []).map(record => record.desc_md));
    const groups = new Map();
    const ownersByPath = new Map();
    for (const record of records.values()) {
        const parts = metadata.has(record.desc_md) ? [{ key: `record:${record.desc_md}`, label: '日记信息', record }] : [];
        groups.set(record.desc_md, { key: record.desc_md, label: recycleRecordLabel(record), record, parts });
        for (const name of recordFilePaths([record])) {
            if (!ownersByPath.has(name)) ownersByPath.set(name, []);
            ownersByPath.get(name).push(record);
        }
    }
    for (const file of item.files) {
        if (file.path === 'data/travel_data.json') continue;
        const owners = ownersByPath.get(file.path) || [];
        const key = owners.length === 1 ? owners[0].desc_md : owners.length > 1 ? 'shared' : recycleFileType(file.path);
        if (!groups.has(key)) groups.set(key, { key, label: owners.length > 1 ? '共用内容' : key, parts: [] });
        groups.get(key).parts.push({ key: `file:${file.path}`, label: file.path.split('/').pop(), file });
    }
    return [...groups.values()].filter(group => group.parts.length);
}

// 界面按整篇日记选择，共用附件随引用它的日记一并恢复。
export function recycleDiaryGroups(item) {
    const groups = new Map(recyclePartGroups(item).filter(group => group.record).map(group => [group.key, group]));
    const records = new Map([...(item.records || []), ...(item.mediaReferences || []), ...(item.displayRecords || [])]
        .filter(record => record?.desc_md).map(record => [record.desc_md, record]));
    const files = new Map(item.files.map(file => [file.path, file]));
    return [...records.values()].map(record => {
        const group = groups.get(record.desc_md) || { key: record.desc_md, label: recycleRecordLabel(record), record, parts: [] };
        const parts = new Map(group.parts.map(part => [part.key, part]));
        for (const path of recordFilePaths([group.record])) {
            if (files.has(path)) parts.set(`file:${path}`, { key: `file:${path}`, file: files.get(path) });
        }
        return { ...group, parts: [...parts.values()] };
    }).filter(group => group.parts.length);
}

export function recycleSelectionGroups(item) {
    const groups = recycleDiaryGroups(item).map(group => ({ ...group, key: `diary:${group.key}` }));
    const parts = item.files.filter(file => file.path.startsWith('data/profile/'))
        .map(file => ({ key: `file:${file.path}`, file }));
    if (parts.length || item.kind === 'snapshot') groups.push({ key: 'profile', label: '个人资料', parts });
    const index = item.files.find(file => file.path === 'data/travel_data.json');
    if (index) groups.push({ key: 'index', label: '日记索引', parts: [{ key: `file:${index.path}`, file: index }] });
    return groups;
}

export function selectRecycleParts(item, parts, currentRecords = []) {
    if (parts === undefined) return item;
    const groupSelection = Array.isArray(parts) && parts.some(key => key === 'profile' || key === 'index' || typeof key === 'string' && key.startsWith('diary:'));
    let selectedDiaries;
    if (groupSelection) {
        const choices = new Map(recycleSelectionGroups(item).map(group => [group.key, group]));
        if (new Set(parts).size !== parts.length || parts.some(key => !choices.has(key))) throw new Error('请选择有效且不重复的恢复内容。');
        selectedDiaries = new Set(parts.flatMap(key => choices.get(key).record ? [choices.get(key).record.desc_md] : []));
        parts = [...new Set(parts.flatMap(key => choices.get(key).parts.map(part => part.key)))];
        // 整份索引已包含全部元数据，同时勾选日记时只补回其归档文件。
        if (parts.includes('file:data/travel_data.json')) {
            const keys = new Set(parts);
            return { ...item, kind: 'version', records: [], mediaReferences: [], displayRecords: [],
                files: item.files.filter(file => keys.has(`file:${file.path}`)) };
        }
    }
    const groups = recyclePartGroups(item);
    const available = new Map(groups.flatMap(group => group.parts).map(part => [part.key, part]));
    if (!Array.isArray(parts) || (!parts.length && !groupSelection) || new Set(parts).size !== parts.length || parts.some(key => !available.has(key))) {
        throw new Error('请选择有效且不重复的恢复内容。');
    }
    const keys = new Set(parts);
    const files = item.files.filter(file => keys.has(`file:${file.path}`));
    const paths = new Set(files.map(file => file.path));
    const records = [];
    const references = [];
    const displayRecords = [];
    const bodyTargets = new Map();
    const candidates = new Map([...(item.records || []), ...(item.mediaReferences || []), ...(item.displayRecords || [])]
        .filter(record => record?.desc_md).map(record => [record.desc_md, record]));
    const full = item.kind === 'snapshot' || item.files.some(file => file.path === 'data/travel_data.json');
    for (const saved of candidates.values()) {
        if (selectedDiaries && !selectedDiaries.has(saved.desc_md)) continue;
        const group = groups.find(group => group.record?.desc_md === saved.desc_md);
        const current = matchRecord(saved, currentRecords);
        const metadata = keys.has(`record:${saved.desc_md}`);
        const related = [...recordFilePaths([saved])].some(name => paths.has(name));
        if (!metadata && !related) continue;
        const ownFiles = group?.parts.some(part => part.file && keys.has(part.key));
        // 整站共用文件本身不代表选中了全部历史使用者。
        if (full && !metadata && !ownFiles) continue;
        displayRecords.push(saved);
        if (current && !metadata && paths.has(saved.desc_md)) bodyTargets.set(saved.desc_md, current.desc_md);
        const complete = available.has(`record:${saved.desc_md}`);
        // 新日记需要信息与正文才能正常阅读，附件仍严格按勾选范围恢复。
        if (metadata || (!current && complete && ownFiles)) {
            const restored = { ...saved };
            if (current && !paths.has(saved.desc_md)) restored.desc_md = current.desc_md;
            for (const [folder, list] of [['photo_folder', 'photos'], ['video_folder', 'videos']]) {
                restored[folder] = current?.[folder] || saved[folder] || '';
                const chosen = (saved[list] || []).filter(name => paths.has(`${saved[folder]}/${name}`));
                restored[list] = [...new Set([...(current?.[list] || []), ...chosen])];
            }
            if (current) restored.media_order = current.media_order || [];
            records.push(restored);
            if (!current && !paths.has(saved.desc_md)) {
                const body = item.files.find(file => file.path === saved.desc_md);
                if (body) { files.push(body); paths.add(body.path); }
            }
        }
        if (related && (current || item.mediaReferences?.some(record => record.desc_md === saved.desc_md))) references.push(saved);
    }
    const attachments = files.length > 0 && files.every(file => /^data\/(photos|videos)\//.test(file.path));
    let kind = references.length ? 'record' : 'version';
    if (attachments || item.kind === 'files') kind = 'files';
    if (records.length) kind = 'record';
    return { ...item, kind,
        records, mediaReferences: references, displayRecords,
        files: files.map(file => bodyTargets.has(file.path) ? { ...file, path: bodyTargets.get(file.path), sourcePath: file.path } : file) };
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
    const candidates = items.map(original => {
        const selection = selected.get(original.id);
        const item = selection?.parts ? selectRecycleParts(original, selection.parts, currentRecords) : original;
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
    includeEmptyRecords = false, includeEmptyProfile = false, preserveProfileGroup = false,
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
    if (includeEmptyRecords && (groupSingleRecord || diaries.size > 1)) {
        for (const record of diaries.values()) {
            directory(root, `record:${record.desc_md}`, recycleRecordLabel(record), 0).record = record;
        }
    }
    if (includeEmptyProfile) {
        const index = categories.indexOf('个人资料');
        directory(root, `type:${index}`, '个人资料', index + 2);
    }
    for (const file of files) {
        const references = owners.get(file.path);
        let parent = root;
        const ancestors = [root];
        if (references?.size > 1) {
            parent = directory(root, 'shared', '共用内容', 1);
        } else if (references?.size && (groupSingleRecord || diaries.size > 1)) {
            const name = references.values().next().value;
            parent = directory(root, `record:${name}`, recycleRecordLabel(diaries.get(name)), 0);
            parent.record = diaries.get(name);
        }
        if (parent !== root) ancestors.push(parent);
        const category = file.category || (diaries.has(file.path) ? '正文' : recycleFileType(file.path, mediaKind));
        const index = categories.indexOf(category);
        const node = ['日记索引', '日记信息'].includes(category) ? parent : directory(parent, `type:${index}`, category, index + 2);
        node.files.push(file);
        if (node !== parent) ancestors.push(node);
        const matches = Boolean(search && [file.path, category, ...ancestors.map(ancestor => ancestor.name)].some(value => value.toLowerCase().includes(search)));
        for (const ancestor of ancestors) {
            ancestor.count++;
            ancestor.totalBytes += file.size;
            ancestor.matches ||= matches;
        }
    }
    const collator = new Intl.Collator('zh-CN', { numeric: true });
    const compare = (a, b) => collator.compare(a.path, b.path) || a.path.localeCompare(b.path);
    // 从内向外移除单一分类层，日记选择与共用归属仍有独立入口。
    for (const node of [...directories.values()].reverse()) {
        if (node.directories.length !== 1) continue;
        const child = node.directories[0];
        if (child.record || child.path === 'shared' || preserveProfileGroup && child.name === '个人资料') continue;
        node.directories = child.directories;
        node.files = node.files.concat(child.files);
        directories.delete(child.path);
    }
    // 单个正文直接作为展开入口，避免正文分类与文件重复折叠。
    for (const node of [...directories.values()]) {
        const body = node.directories.find(child => child.name === '正文' && child.files.length === 1 && !child.directories.length);
        if (!body) continue;
        node.files = node.files.concat(body.files);
        node.directories = node.directories.filter(child => child !== body);
        directories.delete(body.path);
    }
    for (const node of directories.values()) {
        for (const child of node.directories) child.depth = node.depth + 1;
        node.directories.sort((a, b) => a.order - b.order || collator.compare(a.name, b.name) || compare(a, b));
        node.files.sort((a, b) => Number(b.category === '日记信息') - Number(a.category === '日记信息')
            || collator.compare(a.path.split('/').pop(), b.path.split('/').pop()) || compare(a, b));
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
        if (comparison.fields.length) files.push({ path: record.desc_md, size: 0, category: '日记信息', label: '日记信息', record, comparison: { ...empty, fields: comparison.fields } });
        if (comparison.markdownChanged) files.push({ path: record.desc_md, size: 0, record, comparison: { ...empty, markdownChanged: true } });
        for (const name of comparison.media) {
            if (media.has(name)) continue;
            media.add(name);
            files.push({ path: name, size: 0, record, comparison: { ...empty, media: [name] } });
        }
    }
    return buildRecycleTree(files, '', { records, mediaKind, groupSingleRecord, categories: ['日记信息', '正文', '图片', '视频', '个人资料', '日记索引', '其他文件'] });
}
