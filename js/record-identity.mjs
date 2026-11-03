// 旧记录从原正文路径派生标识；一旦写入索引，移动正文也不再改变标识。
export function recordIdentity(record) {
    return record.record_id ?? `legacy:${record.desc_md}`;
}

export function validRecordIdentity(value) {
    return typeof value === 'string' && (/^r-[a-f0-9]{32}$/.test(value)
        || /^legacy:data\/travel-diary\/\d{4}\/[A-Za-z0-9._-]+\.md$/.test(value));
}

export function identifyRecords(records) {
    const ids = new Set();
    return records.map(record => {
        const record_id = recordIdentity(record);
        if (!validRecordIdentity(record_id) || ids.has(record_id)) throw new Error('记录固定标识无效或重复，请检查旅行索引。');
        ids.add(record_id);
        return { ...record, record_id };
    });
}

export function matchRecord(incoming, current) {
    const identity = recordIdentity(incoming);
    const sameId = current.find(record => recordIdentity(record) === identity);
    const samePath = current.find(record => record.desc_md === incoming.desc_md);
    if (sameId && samePath && sameId !== samePath) throw new Error('固定标识与正文路径分别指向不同记录，请先调整路径。');
    if (sameId) return sameId;
    if (samePath && incoming.record_id && samePath.record_id && incoming.record_id !== samePath.record_id) {
        throw new Error('正文路径已属于另一篇记录，请先调整路径。');
    }
    return samePath || null;
}
