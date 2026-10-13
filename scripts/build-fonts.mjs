import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const subsetMode = process.argv.slice(2).includes('--subset');
const coreOnlyMode = process.argv.slice(2).includes('--core');
const unknownArguments = process.argv.slice(2).filter(argument => !['--subset', '--core'].includes(argument));
const textExtensions = new Set(['.html', '.css', '.js', '.mjs', '.json', '.md']);
const excludedDirs = new Set(['.git', '.github', '.secrets', '.codex', '.playwright-cli', 'node_modules', '_site', 'dist', 'build', 'coverage', 'tmp', 'temp']);
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
        buildSubsets();
    } else {
        for (const job of fontJobs) buildFullFont(job);
    }
}
buildCoreFonts();

function buildCoreFonts() {
    const tempDir = mkdtempSync(join(tmpdir(), 'travel-diary-font-core-'));
    const textFile = join(tempDir, 'core-text.txt');
    const styles = [];
    try {
        // 首屏字集只收集界面与个人内容；拼音字典和全国目录按需使用完整字库。
        writeFileSync(textFile, collectProjectText(projectRoot, new Set([...excludedDirs, 'assets', 'vendor', 'tests', 'doc', 'scripts'])), 'utf8');
        for (const job of fontJobs.filter(job => basename(job.source).startsWith('LXGWWenKaiMono-'))) {
            const output = job.output.replace('.woff2', '-core.woff2');
            buildSubset({ ...job, output }, textFile);
            const cmapFile = join(tempDir, 'cmap.ttx');
            runFontTool('fonttools', ['ttx', '-q', '-t', 'cmap', '-o', cmapFile, join(projectRoot, output)], '字集映射');
            // 使用实际生成的 cmap，避免为字体不含的字符声明 unicode-range。
            const codepoints = [...new Set([...readFileSync(cmapFile, 'utf8').matchAll(/code="0x([0-9a-f]+)"/gi)]
                .map(match => Number.parseInt(match[1], 16)))].sort((a, b) => a - b);
            const ranges = [];
            for (let index = 0; index < codepoints.length; index += 1) {
                const start = codepoints[index];
                let end = start;
                while (codepoints[index + 1] === end + 1) end = codepoints[++index];
                ranges.push(`U+${start.toString(16).toUpperCase()}${end === start ? '' : `-${end.toString(16).toUpperCase()}`}`);
            }
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
    unicode-range: ${ranges.join(',')};
}`);
        }
        writeFileSync(join(projectRoot, 'assets/fonts/diary-kai-core.css'), `/* 由 npm run fonts 生成。未覆盖字符继续使用完整本地字库。 */\n${styles.join('\n\n')}\n`, 'utf8');
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

function buildSubsets() {
    const tempDir = mkdtempSync(join(tmpdir(), 'travel-diary-fonts-'));
    const textFile = join(tempDir, 'subset-text.txt');

    try {
        writeFileSync(textFile, collectProjectText(projectRoot), 'utf8');
        for (const job of fontJobs) buildSubset(job, textFile);
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
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

function buildFullFont({ source, output }) {
    runFontTool('fonttools', [
        'ttLib.woff2',
        'compress',
        join(projectRoot, source),
        '-o',
        join(projectRoot, output),
        '--no-glyf-transform'
    ], '完整字体');
}

function buildSubset({ source, output, unicodeRanges }, textFile) {
    runFontTool('pyftsubset', [
        join(projectRoot, source),
        `--output-file=${join(projectRoot, output)}`,
        '--flavor=woff2',
        '--layout-features=*',
        '--drop-tables+=meta',
        // 日期会在运行时更新，子集模式下仍须保留完整数字。
        '--text=0123456789',
        `--text-file=${textFile}`,
        `--unicodes=${unicodeRanges}`
    ], '字体子集');
}

function runFontTool(command, arguments_, label) {
    const result = spawnSync(command, arguments_, {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: 'pipe'
    });

    if (result.error || result.status !== 0) {
        const detail = result.error?.message || result.stderr || result.stdout || `exit code ${result.status}`;
        throw new Error(`${label}生成失败，请先安装 fonttools[woff] 后重试：${detail.trim()}`);
    }

    if (result.stderr.trim()) process.stderr.write(result.stderr);
}
