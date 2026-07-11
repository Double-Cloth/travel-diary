import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const tempDir = mkdtempSync(join(tmpdir(), 'travel-diary-fonts-'));
const textFile = join(tempDir, 'subset-text.txt');
const textExtensions = new Set(['.html', '.css', '.js', '.mjs', '.json', '.md']);
const excludedDirs = new Set(['.git', '.github', 'node_modules', '_site']);
const commonUnicodeRanges = 'U+0000-00FF,U+2000-206F,U+3000-303F';

const fontJobs = [
    {
        source: 'assets/fonts/LXGWWenKaiMono-Regular.ttf',
        output: 'assets/fonts/LXGWWenKaiMono-Regular-subset.woff2',
        unicodeRanges: commonUnicodeRanges
    },
    {
        source: 'assets/fonts/LXGWWenKaiMono-Medium.ttf',
        output: 'assets/fonts/LXGWWenKaiMono-Medium-subset.woff2',
        unicodeRanges: commonUnicodeRanges
    },
    {
        source: 'assets/fonts/SourceCodePro-Regular.ttf',
        output: 'assets/fonts/SourceCodePro-Regular-subset.woff2',
        unicodeRanges: 'U+0000-00FF,U+2000-206F'
    },
    {
        source: 'assets/fonts/SourceCodePro-Bold.ttf',
        output: 'assets/fonts/SourceCodePro-Bold-subset.woff2',
        unicodeRanges: 'U+0000-00FF,U+2000-206F'
    }
];

try {
    writeFileSync(textFile, collectProjectText(projectRoot), 'utf8');

    for (const job of fontJobs) {
        runPyftsubset(job);
    }
} finally {
    rmSync(tempDir, { recursive: true, force: true });
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
            if (!excludedDirs.has(entry.name)) {
                collectTextFiles(fullPath, chunks);
            }
            continue;
        }

        if (!textExtensions.has(extname(entry.name)) || basename(entry.name).includes('.test.')) {
            continue;
        }

        chunks.push(readFileSync(fullPath, 'utf8'));
        chunks.push(relativePath);
    }
}

function runPyftsubset({ source, output, unicodeRanges }) {
    const result = spawnSync('pyftsubset', [
        join(projectRoot, source),
        `--output-file=${join(projectRoot, output)}`,
        '--flavor=woff2',
        '--layout-features=*',
        '--drop-tables+=meta',
        `--text-file=${textFile}`,
        `--unicodes=${unicodeRanges}`
    ], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: 'pipe'
    });

    if (result.error || result.status !== 0) {
        const detail = result.error?.message || result.stderr || result.stdout || `exit code ${result.status}`;
        throw new Error(`字体子集生成失败，请先安装 fonttools/pyftsubset 后重试：${detail.trim()}`);
    }

    if (result.stderr.trim()) {
        process.stderr.write(result.stderr);
    }
}
