import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { compressFont, subsetFont, readCmap, unicodeRanges } from './font-tools.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const textExtensions = new Set(['.html', '.css', '.js', '.mjs', '.json', '.md']);
const excludedDirs = new Set(['.git', '.github', '.secrets', '.cache', '.codex', '.playwright-cli', 'node_modules', '_site', 'dist', 'build', 'coverage', 'tmp', 'temp', 'output', 'test-results', 'playwright-report', 'logs', 'screenshots']);
const commonUnicodeRanges = 'U+0000-00FF,U+2000-206F,U+3000-303F';
const fontJobs = [
    { name: 'CormorantSC-Bold', family: 'Archive Seal', weight: 700 },
    { name: 'LXGWWenKaiMono-Regular', family: 'Diary Kai', weight: 400 },
    { name: 'LXGWWenKaiMono-Medium', family: 'Diary Kai', weight: 700 },
    { name: 'SourceCodePro-Regular', family: 'Archive Code', weight: 400 },
    { name: 'SourceCodePro-Bold', family: 'Archive Code', weight: 700 }
];
const implementationHash = hash(Buffer.concat([
    readFileSync(fileURLToPath(import.meta.url)),
    readFileSync(new URL('./font-tools.mjs', import.meta.url)),
    readFileSync(new URL('../assets/wasm/sources.json', import.meta.url))
]));

function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}

function collectProjectText(root, coreOnly) {
    const ignored = coreOnly ? new Set([...excludedDirs, 'assets', 'vendor', 'tests', 'doc', 'scripts']) : excludedDirs;
    const chunks = [];
    function collect(directory) {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            const fullPath = join(directory, entry.name);
            // 缓存及个人内容目录的链接均不参与文字收集。
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                if (!ignored.has(entry.name) && !entry.name.startsWith('.travel-')) collect(fullPath);
            } else if (textExtensions.has(extname(entry.name)) && !basename(entry.name).includes('.test.')) {
                chunks.push(readFileSync(fullPath, 'utf8'), relative(root, fullPath).replaceAll('\\', '/'));
            }
        }
    }
    collect(root);
    return chunks.join('\n');
}

// 和媒体缓存一样逐级检查目录，禁止链接将读写引向项目外。
async function safePath(root, path, createParents = false) {
    const parts = path.split('/');
    let current = root;
    for (const [index, part] of parts.entries()) {
        current = join(current, part);
        const parent = index < parts.length - 1;
        if (parent && createParents) await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
        let stat;
        try { stat = await lstat(current); }
        catch (error) {
            if (createParents && !parent && error.code === 'ENOENT') return current;
            throw error;
        }
        if (stat.isSymbolicLink() || (parent ? !stat.isDirectory() : !stat.isFile())) {
            throw Object.assign(new Error('字体路径必须是项目内的普通文件。'), { status: 403 });
        }
    }
    return current;
}

async function atomicWrite(path, content) {
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        await writeFile(temporary, content, { flag: 'wx' });
        await rename(temporary, path);
    } finally {
        await unlink(temporary).catch(() => {});
    }
}

function fontStyles(cores = []) {
    const styles = fontJobs.map(job => `@font-face {
    font-family: "${job.family}";
    src: url("./${job.name}.woff2") format("woff2"), url("../../assets/fonts/${job.name}.ttf") format("truetype");
    font-weight: ${job.weight};
    font-style: normal;
    font-display: block;
}`);
    for (const { job, data, ranges } of cores) {
        styles.push(`@font-face {
    font-family: "${job.family}";
    src: url("./${job.name}-core.woff2?v=${hash(data).slice(0, 12)}") format("woff2"), url("./${job.name}.woff2") format("woff2"), url("../../assets/fonts/${job.name}.ttf") format("truetype");
    font-weight: ${job.weight};
    font-style: normal;
    font-display: block;
    unicode-range: ${ranges};
}`);
    }
    return Buffer.from(`/* 自动生成的字体缓存。 */\n${styles.join('\n\n')}\n`);
}

async function buildFont({ source, text, subset, ranges, core }) {
    const input = Buffer.from(source);
    const font = subset ? await subsetFont(input, text, ranges) : input;
    return { data: await compressFont(font), ranges: core ? unicodeRanges(readCmap(font)) : undefined };
}

function buildInBackground(options) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { fontBuild: options } });
        let received = false;
        worker.once('message', result => {
            received = true;
            resolve({ ...result, data: Buffer.from(result.data) });
        });
        worker.once('error', reject);
        worker.once('exit', code => {
            if (!received) reject(new Error(`字体生成任务退出，退出码为 ${code}。`));
        });
    });
}

export function createFontCache(root, { background = false } = {}) {
    const pending = new Map();
    async function generate(name, subsetMode = false) {
        const core = name.endsWith('-core.woff2');
        const job = fontJobs.find(job => `${job.name}${core ? '-core' : ''}.woff2` === name);
        if (!job || (core && job.family !== 'Diary Kai')) {
            throw Object.assign(new Error('无效的字体缓存路径。'), { status: 404 });
        }
        const source = await readFile(await safePath(root, `assets/fonts/${job.name}.ttf`));
        const text = core || subsetMode ? collectProjectText(root, core) : '';
        const signature = hash(Buffer.concat([source, Buffer.from(`${implementationHash}:${core}:${subsetMode}:${text}`)]));
        const output = `.cache/fonts/${name}`;
        try {
            const metadata = JSON.parse(await readFile(await safePath(root, `${output}.json`), 'utf8'));
            const data = await readFile(await safePath(root, output));
            if (metadata?.signature === signature && metadata.hash === hash(data)) {
                return { job, data, ranges: metadata.ranges };
            }
        } catch (error) {
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        const options = { source, text, subset: core || subsetMode, core,
            ranges: job.family === 'Diary Kai' ? commonUnicodeRanges : 'U+0000-00FF,U+2000-206F' };
        // 服务端压缩放入内置 Worker，避免大字库阻塞页面、媒体和认证请求。
        const { data, ranges } = await (background ? buildInBackground(options) : buildFont(options));
        const destination = await safePath(root, output, true);
        const metadataPath = await safePath(root, `${output}.json`, true);
        await atomicWrite(destination, data);
        await atomicWrite(metadataPath, JSON.stringify({ signature, hash: hash(data), ranges }));
        return { job, data, ranges };
    }

    async function ensure(name, subsetMode = false) {
        // 相同文件的请求共享任务，不同构建模式等待后重新校验缓存。
        const previous = pending.get(name);
        if (previous) {
            await previous.task.catch(() => {});
            if (previous.subsetMode === subsetMode) return previous.task;
        }
        const task = generate(name, subsetMode);
        const entry = { task, subsetMode };
        pending.set(name, entry);
        try { return await task; }
        finally { if (pending.get(name) === entry) pending.delete(name); }
    }

    async function styles(strict = false) {
        const cores = [];
        for (const job of fontJobs.filter(job => job.family === 'Diary Kai')) {
            try { cores.push(await ensure(`${job.name}-core.woff2`)); }
            catch (error) { if (strict) throw error; }
        }
        const data = fontStyles(cores);
        try {
            const destination = await safePath(root, '.cache/fonts/diary-kai-core.css', true);
            // 内容相同则复用文件，避免无意义地改变缓存时间。
            const existing = await readFile(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
            if (!existing?.equals(data)) await atomicWrite(destination, data);
        } catch (error) { if (strict) throw error; }
        return data;
    }

    return {
        async get(name) {
            if (name === 'diary-kai-core.css') return styles();
            return (await ensure(name)).data;
        },
        async build({ coreOnly = false, subsetMode = false } = {}) {
            if (!coreOnly) {
                for (const job of fontJobs) await ensure(`${job.name}.woff2`, subsetMode);
            }
            await styles(true);
        }
    };
}

async function main() {
    const args = process.argv.slice(2);
    const unknown = args.filter(argument => !['--subset', '--core'].includes(argument));
    if (unknown.length) throw new Error(`未知参数：${unknown.join(', ')}。可用参数为 --subset 或 --core。`);
    if (args.includes('--subset') && args.includes('--core')) throw new Error('--subset 与 --core 不能同时使用。');
    const cache = createFontCache(await realpath(projectRoot));
    await cache.build({ coreOnly: args.includes('--core'), subsetMode: args.includes('--subset') });
    console.log('字体缓存已生成：.cache/fonts/');
}

if (!isMainThread && workerData?.fontBuild) {
    buildFont(workerData.fontBuild).then(result => parentPort.postMessage(result)).catch(error => { throw error; });
} else if (isMainThread && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
