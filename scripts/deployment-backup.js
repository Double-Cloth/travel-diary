const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { writeDataBackup } = require('./build-data-backup.js');
const { acquireDataLock, importDataArchive } = require('../js/data-archive.js');
const { fileSource, writeSource } = require('../js/file-stream.js');
const { ensureDataStructure } = require('../js/server.js');

const ARCHIVES = ['data.zip', 'recycle-bin.zip'];

async function checksum(file) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return hash.digest('hex');
}

async function ordinaryDirectory(directory) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`必须是普通目录：${directory}`);
}

async function recycleEntries(root, relative = '.cache/recycle-bin') {
    const directory = path.join(root, relative);
    try { await ordinaryDirectory(directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const entries = [];
    for (const name of await fs.readdir(directory)) {
        const relativeFile = `${relative}/${name}`;
        const file = path.join(root, relativeFile);
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) throw new Error('回收站备份拒绝符号链接。');
        if (stat.isDirectory()) entries.push(...await recycleEntries(root, relativeFile));
        else if (stat.isFile()) entries.push({ name: relativeFile, data: await fileSource(file) });
        else throw new Error('回收站包含不支持的文件类型。');
    }
    return entries;
}

async function outsideRuntime(root, directory) {
    // 先解析最近的现有父目录，阻止目录别名绕过边界。
    const missing = [];
    let existing = path.resolve(directory);
    while (true) {
        try { existing = await fs.realpath(existing); break; }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            missing.unshift(path.basename(existing));
            existing = path.dirname(existing);
        }
    }
    const resolved = path.join(existing, ...missing);
    const relative = path.relative(root, resolved);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('运维备份必须位于整个运行目录之外。');
    }
    return resolved;
}

async function backupBundle(root, directory) {
    root = await fs.realpath(root);
    directory = await outsideRuntime(root, directory);
    await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    await fs.mkdir(directory, { mode: 0o700 });
    // 独占创建备份目录，已有目标一律报错。失败时保留不带完整清单的产物供诊断。
    await writeDataBackup(root, path.join(directory, 'data.zip'));
    const release = await acquireDataLock(root);
    try {
        const { createZipStream } = await import('../js/zip-stream.mjs');
        try { await ordinaryDirectory(path.join(root, '.cache')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const entries = await recycleEntries(root);
        entries.unshift({ name: '.recycle-backup.json', data: Buffer.from('{"version":1}\n') });
        await pipeline(Readable.from(createZipStream(entries)),
            createWriteStream(path.join(directory, 'recycle-bin.zip'), { flags: 'wx', mode: 0o600 }));
        const files = {};
        for (const name of ARCHIVES) {
            files[name] = { bytes: (await fs.stat(path.join(directory, name))).size,
                sha256: await checksum(path.join(directory, name)) };
        }
        await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: 1, files }, null, 2),
            { flag: 'wx', mode: 0o600 });
        await verifyBundle(directory);
        return directory;
    } finally { await release(); }
}

async function verifyBundle(directory) {
    await ordinaryDirectory(directory);
    const manifestFile = path.join(directory, 'manifest.json');
    if (!(await fs.lstat(manifestFile)).isFile() || (await fs.lstat(manifestFile)).isSymbolicLink()) throw new Error('备份清单必须是普通文件。');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    if (manifest.version !== 1) throw new Error('备份版本无效。');
    const { readZipSource } = await import('../js/zip-stream.mjs');
    for (const name of ARCHIVES) {
        const file = path.join(directory, name);
        const stat = await fs.lstat(file);
        const expected = manifest.files?.[name];
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected?.bytes || await checksum(file) !== expected.sha256) {
            throw new Error(`备份完整性校验失败：${name}`);
        }
        for (const entry of await readZipSource(await fileSource(file))) {
            // 逐块核对 ZIP CRC，不把媒体整体加载到内存。
            for await (const bytes of entry.data.chunks()) { void bytes; }
        }
    }
}

async function restoreBundle(root, directory, { confirm = false, backupDirectory } = {}) {
    if (!confirm) throw new Error('恢复需要显式确认，并在停止全部服务后执行。');
    if (!backupDirectory) throw new Error('必须指定恢复前备份目录。');
    root = await fs.realpath(root);
    directory = await outsideRuntime(root, directory);
    await verifyBundle(directory);
    await backupBundle(root, backupDirectory);
    const release = await acquireDataLock(root);
    const id = randomBytes(16).toString('hex');
    const stage = path.join(root, `.travel-restore-stage-${id}`);
    const rollback = path.join(root, `.travel-restore-rollback-${id}`);
    const moved = [];
    const installed = [];
    let rollbackFailed = false;
    try {
        await fs.mkdir(stage, { mode: 0o700 });
        await ensureDataStructure(stage);
        const { readZipSource, readSourceText } = await import('../js/zip-stream.mjs');
        const archive = await fileSource(path.join(directory, 'data.zip'));
        const entries = await readZipSource(archive);
        const auth = entries.find(entry => entry.name === '.secrets/auth.json');
        if (!auth) throw new Error('运维备份缺少认证配置。');
        const config = JSON.parse(Buffer.from(await readSourceText(auth.data)).toString('utf8'));
        // 操作系统管理员已通过离线恢复确认，复用现有导入器进行格式及内容校验。
        await importDataArchive(stage, archive, { authenticatedAuthConfig: config, requireProductionAuth: true });
        await fs.rm(path.join(stage, '.cache'), { recursive: true, force: true });
        await fs.mkdir(path.join(stage, '.cache/recycle-bin'), { recursive: true, mode: 0o700 });
        for (const entry of await readZipSource(await fileSource(path.join(directory, 'recycle-bin.zip')))) {
            if (entry.name === '.recycle-backup.json') continue;
            if (!entry.name.startsWith('.cache/recycle-bin/') || /[\\:\x00-\x1f]/.test(entry.name)
                || entry.name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('回收站备份路径无效。');
            const target = path.join(stage, ...entry.name.split('/'));
            await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            await writeSource(target, entry.data);
        }
        await fs.mkdir(rollback, { mode: 0o700 });
        for (const name of ['data', '.secrets', '.cache']) {
            try {
                await ordinaryDirectory(path.join(root, name));
                await fs.rename(path.join(root, name), path.join(rollback, name));
                moved.push(name);
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            await fs.rename(path.join(stage, name), path.join(root, name));
            installed.push(name);
        }
        return { rollback, backupDirectory };
    } catch (error) {
        try {
            for (const name of installed.reverse()) await fs.rename(path.join(root, name), path.join(stage, name));
            for (const name of moved.reverse()) await fs.rename(path.join(rollback, name), path.join(root, name));
        } catch (rollbackError) {
            rollbackFailed = true;
            throw new Error(`恢复及回退失败，保持停机并保留 ${stage} 和 ${rollback}：${rollbackError.message}`, { cause: error });
        }
        throw error;
    } finally {
        if (!rollbackFailed) await fs.rm(stage, { recursive: true, force: true });
        await release();
    }
}

async function main() {
    process.umask(0o077);
    const [command, root, directory, backupDirectory, confirmation] = process.argv.slice(2);
    if (command === 'verify' && root && !directory) await verifyBundle(path.resolve(root));
    else if (command === 'backup' && root && directory && !backupDirectory) console.log(await backupBundle(root, directory));
    else if (command === 'restore' && root && directory && backupDirectory && confirmation === '--confirm') {
        console.log(JSON.stringify(await restoreBundle(root, directory, { confirm: true, backupDirectory })));
    } else throw new Error('用法 deployment-backup.js backup 运行目录 输出目录 | verify 备份目录 | restore 运行目录 备份目录 恢复前备份目录 --confirm');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { backupBundle, verifyBundle, restoreBundle };
