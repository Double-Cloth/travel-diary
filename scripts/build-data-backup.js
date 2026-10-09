const fs = require('fs/promises');
const { createWriteStream } = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('path');
const { exportDataArchive } = require('../js/data-archive.js');

async function writeDataBackup(root, outputFile) {
    const archive = await exportDataArchive(root);
    const temporary = `${outputFile}.${process.pid}.tmp`;
    try {
        await fs.mkdir(path.dirname(outputFile), { recursive: true });
        await pipeline(Readable.from(archive.stream), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        await fs.rename(temporary, outputFile);
        return { bytes: archive.size, outputFile };
    } finally {
        await fs.unlink(temporary).catch(() => {});
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
