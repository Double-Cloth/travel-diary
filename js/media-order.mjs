// 顺序只标识类型与文件名，目录迁移不影响排列；失效引用跳过，新文件追加。
export function orderMedia(items, order = []) {
    const remaining = new Map();
    for (const item of items) {
        const key = `${item.type}:${item.name}`;
        if (!remaining.has(key)) remaining.set(key, []);
        remaining.get(key).push(item);
    }
    const result = [];
    for (const key of Array.isArray(order) ? order : []) {
        const item = remaining.get(key)?.shift();
        if (item) result.push(item);
    }
    const pending = new Set([...remaining.values()].flat());
    return [...result, ...items.filter(item => pending.has(item))];
}
