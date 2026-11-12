const fs = require('node:fs/promises');
const path = require('node:path');

async function clearCache(root) {
    const projectRoot = await fs.realpath(path.resolve(root));
    const cachePath = path.join(projectRoot, '.cache');
    let stat;
    try { stat = await fs.lstat(cachePath); }
    catch (error) {
        if (error.code === 'ENOENT') return { cachePath, removed: false };
        throw error;
    }
    // 删除前核对实际路径，拒绝将项目外目录作为缓存清理。
    if (stat.isSymbolicLink() || !stat.isDirectory()
        || path.relative(projectRoot, await fs.realpath(cachePath)) !== '.cache') {
        throw new Error('.cache 必须是项目内的普通目录，不能是符号链接或 junction。');
    }
    for (const name of await fs.readdir(cachePath)) {
        if (name.toLowerCase() === 'recycle-bin') continue;
        const target = path.resolve(cachePath, name);
        if (path.dirname(target) !== cachePath) throw new Error('缓存路径无效。');
        await fs.rm(target, { recursive: true, force: true });
    }
    if (!(await fs.readdir(cachePath)).length) await fs.rmdir(cachePath);
    return { cachePath, removed: true };
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
        console.log('用法：npm run cache:clear -- [--dir 项目目录]\n清除目标项目的缓存，保留 .cache/recycle-bin 回收站；原始媒体、日记和浏览器缓存不受影响。');
        return;
    }
    let root = path.resolve(__dirname, '..');
    if (args.length) {
        if (args.length !== 2 || args[0] !== '--dir' || !args[1].trim() || args[1].startsWith('--')) {
            throw new Error('参数无效。用法：npm run cache:clear -- [--dir 项目目录]');
        }
        root = path.resolve(args[1]);
    }
    const result = await clearCache(root);
    console.log(result.removed ? `已清除缓存：${result.cachePath}` : `无需清理，缓存目录不存在：${result.cachePath}`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { clearCache };
