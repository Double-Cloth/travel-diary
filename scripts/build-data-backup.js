const fs = require('fs/promises');
const path = require('path');
const { exportDataArchive } = require('../js/data-archive.js');

async function writeDataBackup(root, outputFile) {
    const archive = await exportDataArchive(root);
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
    await fs.writeFile(outputFile, archive);
    return { bytes: archive.length, outputFile };
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
