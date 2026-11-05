import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressFont, subsetFont, readCmap, unicodeRanges } from './font-tools.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const subsetMode = process.argv.slice(2).includes('--subset');
const coreOnlyMode = process.argv.slice(2).includes('--core');
const unknownArguments = process.argv.slice(2).filter(argument => !['--subset', '--core'].includes(argument));
const textExtensions = new Set(['.html', '.css', '.js', '.mjs', '.json', '.md']);
const excludedDirs = new Set(['.git', '.github', '.secrets', '.cache', '.codex', '.playwright-cli', 'node_modules', '_site', 'dist', 'build', 'coverage', 'tmp', 'temp', 'output', 'test-results', 'playwright-report', 'logs', 'screenshots']);
const commonUnicodeRanges = 'U+0000-00FF,U+2000-206F,U+3000-303F';

const fontJobs = [
    {
        source: 'assets/fonts/CormorantSC-Bold.ttf',
        output: 'assets/fonts/CormorantSC-Bold.woff2',
        unicodeRanges: 'U+0000-00FF,U+2000-206F'
    },
    {
        source: 'assets/fonts/LXGWWenKaiMono-Regular.ttf',
        output: 'assets/fonts/LXGWWenKaiMono-Regular.woff2',
        unicodeRanges: commonUnicodeRanges
    },
    {
        source: 'assets/fonts/LXGWWenKaiMono-Medium.ttf',
        output: 'assets/fonts/LXGWWenKaiMono-Medium.woff2',
        unicodeRanges: commonUnicodeRanges
    },
    {
        source: 'assets/fonts/SourceCodePro-Regular.ttf',
        output: 'assets/fonts/SourceCodePro-Regular.woff2',
        unicodeRanges: 'U+0000-00FF,U+2000-206F'
    },
    {
        source: 'assets/fonts/SourceCodePro-Bold.ttf',
        output: 'assets/fonts/SourceCodePro-Bold.woff2',
        unicodeRanges: 'U+0000-00FF,U+2000-206F'
    }
];

if (unknownArguments.length) {
    throw new Error(`未知参数：${unknownArguments.join(', ')}。可用参数为 --subset 或 --core。`);
}

if (subsetMode && coreOnlyMode) throw new Error('--subset 与 --core 不能同时使用。');

if (!coreOnlyMode) {
    if (subsetMode) {
        await buildSubsets();
    } else {
        for (const job of fontJobs) await buildFullFont(job);
    }
}
await buildCoreFonts();

async function buildCoreFonts() {
    const styles = [];
    // 首屏字集只收集界面与个人内容；拼音字典和全国目录按需使用完整字库。
    const text = collectProjectText(projectRoot, new Set([...excludedDirs, 'assets', 'vendor', 'tests', 'doc', 'scripts']));
    for (const job of fontJobs.filter(job => basename(job.source).startsWith('LXGWWenKaiMono-'))) {
        const output = job.output.replace('.woff2', '-core.woff2');
        const subset = await buildSubset({ ...job, output }, text);
        // 从实际子集的 cmap 生成范围，避免声明字体不含的字符。
        const ranges = unicodeRanges(readCmap(subset));
        const weight = job.source.includes('Medium') ? 700 : 400;
        styles.push(`@font-face {
    font-family: "Diary Kai";
    src: url("./${basename(job.output)}") format("woff2");
    font-weight: ${weight};
    font-style: normal;
    font-display: block;
}

@font-face {
    font-family: "Diary Kai";
    src: url("./${basename(output)}?v=${createHash('sha256').update(readFileSync(join(projectRoot, output))).digest('hex').slice(0, 12)}") format("woff2");
    font-weight: ${weight};
    font-style: normal;
    font-display: block;
    unicode-range: ${ranges};
}`);
    }
    writeFileSync(join(projectRoot, 'assets/fonts/diary-kai-core.css'), `/* 由 npm run fonts 生成。未覆盖字符继续使用完整本地字库。 */\n${styles.join('\n\n')}\n`, 'utf8');
}

async function buildSubsets() {
    const text = collectProjectText(projectRoot);
    for (const job of fontJobs) await buildSubset(job, text);
}

function collectProjectText(directory, ignoredDirectories = excludedDirs) {
    const chunks = [];
    collectTextFiles(directory, chunks, ignoredDirectories);
    return chunks.join('\n');
}

function collectTextFiles(directory, chunks, ignoredDirectories) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = join(directory, entry.name);
        const relativePath = relative(projectRoot, fullPath).replaceAll('\\', '/');

        if (entry.isDirectory()) {
            if (!ignoredDirectories.has(entry.name) && !entry.name.startsWith('.travel-')) collectTextFiles(fullPath, chunks, ignoredDirectories);
            continue;
        }

        if (!textExtensions.has(extname(entry.name)) || basename(entry.name).includes('.test.')) continue;
        chunks.push(readFileSync(fullPath, 'utf8'));
        chunks.push(relativePath);
    }
}

async function buildFullFont({ source, output }) {
    await writeFont(output, readFileSync(join(projectRoot, source)));
}

async function buildSubset({ source, output, unicodeRanges: ranges }, text) {
    const subset = await subsetFont(readFileSync(join(projectRoot, source)), text, ranges);
    await writeFont(output, subset);
    return subset;
}

async function writeFont(output, source) {
    const compressed = await compressFont(source);
    writeFileSync(join(projectRoot, output), compressed);
    console.log(`${output}：${compressed.length.toLocaleString('en-US')} bytes`);
}
