const path = require('node:path');
const { sortTravelData } = require('../js/sort-travel-data.js');

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
