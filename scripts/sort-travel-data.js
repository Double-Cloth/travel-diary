const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { acquireDataLock } = require('../js/data-archive.js');
const { sortRecords, serializeRecords } = require('../js/record-order.js');

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
        const { isValidDateString } = await import('../js/analytics.mjs');
        if (!Array.isArray(records) || records.some(record => !isValidDateString(record?.date))) {
            throw new Error('日记索引必须是数组，且每篇日记须包含有效的 YYYY-MM-DD 日期。');
        }
        const sorted = sortRecords(records);
        const changed = sorted.some((record, index) => record !== records[index]);
        if (changed && !check) {
            await fs.writeFile(temporary, serializeRecords(sorted), { flag: 'wx' });
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

async function main() {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some(arg => arg !== '--check')) {
        throw new Error('用法：npm run data:sort -- [--check]');
    }
    const check = args.includes('--check');
    const { changed, count } = await sortTravelData(path.resolve(__dirname, '..'), { check });
    if (changed && check) {
        console.error('日记索引未按日期升序排列，请运行 npm run data:sort 自动排序。');
        process.exitCode = 1;
    } else {
        console.log(`${changed ? '已自动排序' : '已检查'} ${count} 篇日记，索引按日期从早到晚排列。`);
    }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { sortTravelData };
