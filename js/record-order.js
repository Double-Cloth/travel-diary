// ISO 日期可直接比较；稳定排序保留同一天日记的原有顺序。
function sortRecords(records) {
    return [...records].sort((a, b) => a.date.localeCompare(b.date));
}

function serializeRecords(records) {
    return JSON.stringify(sortRecords(records), null, 2) + '\n';
}

module.exports = { sortRecords, serializeRecords };
