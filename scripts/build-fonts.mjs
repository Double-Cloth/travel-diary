import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const subsetMode = process.argv.slice(2).includes('--subset');
const unknownArguments = process.argv.slice(2).filter(argument => argument !== '--subset');
const textExtensions = new Set(['.html', '.css', '.js', '.mjs', '.json', '.md']);
const excludedDirs = new Set(['.git', '.github', 'node_modules', '_site']);
const commonUnicodeRanges = 'U+0000-00FF,U+2000-206F,U+3000-303F';

const fontJobs = [
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
    throw new Error(`未知参数：${unknownArguments.join(', ')}。可用参数为 --subset。`);
}

if (subsetMode) {
    buildSubsets();
} else {
    for (const job of fontJobs) buildFullFont(job);
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

function collectProjectText(directory) {
    const chunks = [];
    collectTextFiles(directory, chunks);
    return chunks.join('\n');
}

function collectTextFiles(directory, chunks) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = join(directory, entry.name);
        const relativePath = relative(projectRoot, fullPath).replaceAll('\\', '/');

        if (entry.isDirectory()) {
            if (!excludedDirs.has(entry.name)) collectTextFiles(fullPath, chunks);
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
