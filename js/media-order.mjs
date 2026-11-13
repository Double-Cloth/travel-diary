// 顺序只标识类型与文件名，目录迁移不影响排列；失效引用跳过，新文件追加。
export function orderMedia(items, order = []) {
    const remaining = new Map();
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        const key = `${item.type}:${item.name}`;
        if (!remaining.has(key)) remaining.set(key, []);
        remaining.get(key).push(index);
    }
    const result = [];
    const consumed = new Set();
    for (const key of Array.isArray(order) ? order : []) {
        const index = remaining.get(key)?.pop();
        if (index === undefined) continue;
        consumed.add(index);
        result.push(items[index]);
    }
    return [...result, ...items.filter((item, index) => !consumed.has(index))];
}
