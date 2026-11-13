const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { acquireDataLock } = require('./data-archive.js');
const { sortRecords, serializeRecords } = require('./record-order.js');

async function sortTravelData(root, { check = false } = {}) {
    const file = path.join(root, 'data/travel_data.json');
    const temporary = path.join(root, 'data', `.travel-order-${randomBytes(16).toString('hex')}.tmp`);
    const release = await acquireDataLock(root);
    try {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink() || !stat.isFile()
            || await fs.realpath(file) !== path.join(await fs.realpath(root), 'data/travel_data.json')) {
            throw new Error('日记索引必须是项目内的普通文件。');
        }
        const previous = await fs.readFile(file, 'utf8');
        const records = JSON.parse(previous);
        const { isValidDateString } = await import('./analytics.mjs');
        if (!Array.isArray(records) || records.some(record => !isValidDateString(record?.date))) {
            throw new Error('日记索引必须是数组，且每篇日记须包含有效的 YYYY-MM-DD 日期。');
        }
        const sorted = sortRecords(records);
        const changed = sorted.some((record, index) => record !== records[index]);
        if (changed && !check) {
            await fs.writeFile(temporary, serializeRecords(records), { flag: 'wx' });
            // 手工编辑不受数据锁约束，替换前再次核对，避免覆盖期间的新修改。
            if (await fs.readFile(file, 'utf8') !== previous) throw new Error('日记索引在排序期间被修改，请重试。');
            await fs.rename(temporary, file);
        }
        return { changed, count: records.length };
    } finally {
        await fs.unlink(temporary).catch(() => {});
        await release();
    }
}

module.exports = { sortTravelData };
