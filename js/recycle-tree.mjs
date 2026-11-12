// 目录仅组织单个回收批次，保留原路径与大小写，恢复仍使用完整批次。
export function buildRecycleTree(files, query = '') {
    const directories = new Map();
    const root = { path: '', name: '', depth: 0, directories: [], files: [], count: 0, totalBytes: 0, matches: false };
    directories.set('', root);
    const search = query.trim().toLowerCase();
    for (const file of files) {
        const parts = file.path.split('/');
        const matches = Boolean(search && file.path.toLowerCase().includes(search));
        let parent = root;
        const ancestors = [root];
        for (const name of parts.slice(0, -1)) {
            const directoryPath = parent.path ? `${parent.path}/${name}` : name;
            let directory = directories.get(directoryPath);
            if (!directory) {
                directory = { path: directoryPath, name, depth: parent.depth + 1, directories: [], files: [], count: 0, totalBytes: 0, matches: false };
                directories.set(directoryPath, directory);
                parent.directories.push(directory);
            }
            ancestors.push(directory);
            parent = directory;
        }
        parent.files.push(file);
        for (const directory of ancestors) {
            directory.count++;
            directory.totalBytes += file.size;
            directory.matches ||= matches;
        }
    }
    const collator = new Intl.Collator('zh-CN', { numeric: true });
    const compare = (a, b) => collator.compare(a.path, b.path) || a.path.localeCompare(b.path);
    for (const directory of directories.values()) {
        directory.directories.sort(compare);
        directory.files.sort(compare);
    }
    return directories;
}
