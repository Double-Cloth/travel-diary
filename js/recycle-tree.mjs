import { recordFilePaths } from './record-backup.mjs?v=2.1.87';

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

// 逻辑目录只负责展示归属，文件保留原始对象供预览和恢复使用。
export function buildRecycleTree(files, query = '', { records = [], mediaReferences = [], mediaKind = () => '' } = {}) {
    const directories = new Map();
    const root = { path: '', name: '', depth: 0, directories: [], files: [], count: 0, totalBytes: 0, matches: false };
    directories.set('', root);
    const diaries = new Map();
    const owners = new Map();
    for (const record of [...records, ...mediaReferences]) {
        if (!record?.desc_md) continue;
        if (!diaries.has(record.desc_md)) diaries.set(record.desc_md, record);
        for (const name of recordFilePaths([record])) {
            if (!owners.has(name)) owners.set(name, new Set());
            owners.get(name).add(record.desc_md);
        }
    }
    const search = query.trim().toLowerCase();
    const categories = ['正文', '图片', '视频', '个人资料', '日记索引', '其他文件'];
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
        } else if (references?.size && diaries.size > 1) {
            const name = references.values().next().value;
            parent = directory(root, `record:${name}`, recycleRecordLabel(diaries.get(name)), 0);
        }
        if (parent !== root) ancestors.push(parent);
        const category = diaries.has(file.path) ? '正文' : recycleFileType(file.path, mediaKind);
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
