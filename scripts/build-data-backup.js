const fs = require('fs/promises');
const { randomBytes } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('path');
const { exportDataArchive } = require('../js/data-archive.js');

async function writeDataBackup(root, outputFile) {
    root = await fs.realpath(root);
    outputFile = path.resolve(outputFile);
    if (path.extname(outputFile).toLowerCase() !== '.zip') throw new Error('备份文件必须使用 .zip 扩展名。');
    // 检查真实父目录，避免通过目录别名把备份写回个人数据或认证目录。
    let ancestor = path.dirname(outputFile);
    const missing = [];
    while (true) {
        try { ancestor = await fs.realpath(ancestor); break; }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            missing.unshift(path.basename(ancestor));
            ancestor = path.dirname(ancestor);
        }
    }
    outputFile = path.join(ancestor, ...missing, path.basename(outputFile));
    const relative = path.relative(root, outputFile);
    if (['data', '.secrets', '.cache'].includes(relative.split(path.sep)[0].toLowerCase())) {
        throw new Error('备份必须保存到 data、.secrets 和 .cache 之外，例如 dist 目录。');
    }
    const archive = await exportDataArchive(root);
    const temporary = `${outputFile}.${randomBytes(16).toString('hex')}.tmp`;
    let handle;
    try {
        await fs.mkdir(path.dirname(outputFile), { recursive: true });
        handle = await fs.open(temporary, 'wx', 0o600);
        await pipeline(Readable.from(archive.stream), handle.createWriteStream());
        await handle.close();
        await fs.rename(temporary, outputFile);
        return { bytes: archive.size, outputFile };
    } finally {
        if (handle) {
            await handle.close().catch(() => {});
            await fs.unlink(temporary).catch(() => {});
        }
        await archive.release();
    }
}

async function main() {
    const root = path.resolve(__dirname, '..');
    const outputFile = path.resolve(root, process.argv[2] || 'dist/travel-diary-data.zip');
    const result = await writeDataBackup(root, outputFile);
    process.stdout.write(`Data backup: ${result.outputFile} (${result.bytes} bytes)\n`);
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { writeDataBackup };
