import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, stat, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFontCache } from '../scripts/build-fonts.mjs';
import { createHandler } from '../js/server.js';
import { clearCache } from '../scripts/clear-cache.js';
import { listenOnFetchSafePort } from './helpers/http.mjs';
import { compressFont, decompressFont, subsetFont, readCmap, unicodeRanges } from '../scripts/font-tools.mjs';

const root = new URL('../', import.meta.url);
const names = ['CormorantSC-Bold', 'LXGWWenKaiMono-Regular', 'LXGWWenKaiMono-Medium', 'SourceCodePro-Regular', 'SourceCodePro-Bold'];

function tables(font) {
    const result = new Map();
    for (let index = 0; index < font.readUInt16BE(4); index += 1) {
        const entry = 12 + index * 16;
        const offset = font.readUInt32BE(entry + 8);
        result.set(font.toString('ascii', entry, entry + 4), font.subarray(offset, offset + font.readUInt32BE(entry + 12)));
    }
    return result;
}

// 解码轮廓为点坐标，忽略 WOFF2 无损变换造成的字节编码和填充差异。
function glyphs(font) {
    const map = tables(font);
    const long = map.get('head').readInt16BE(50) === 1;
    const loca = map.get('loca');
    const offset = index => long ? loca.readUInt32BE(index * 4) : loca.readUInt16BE(index * 2) * 2;
    return Array.from({ length: map.get('maxp').readUInt16BE(4) }, (_, index) => {
        const data = map.get('glyf').subarray(offset(index), offset(index + 1));
        if (!data.length) return null;
        const count = data.readInt16BE(0);
        const bbox = [2, 4, 6, 8].map(position => data.readInt16BE(position));
        let position = 10;
        if (count < 0) {
            let flags;
            do {
                flags = data.readUInt16BE(position);
                position += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 64 ? 4 : flags & 128 ? 8 : 0);
            } while (flags & 32);
            if (flags & 256) position += 2 + data.readUInt16BE(position);
            return { bbox, components: data.subarray(10, position) };
        }
        const ends = Array.from({ length: count }, () => { const end = data.readUInt16BE(position); position += 2; return end; });
        const instructionLength = data.readUInt16BE(position);
        position += 2;
        const instructions = data.subarray(position, position + instructionLength);
        position += instructionLength;
        const flags = [];
        const pointCount = count ? ends.at(-1) + 1 : 0;
        while (flags.length < pointCount) {
            const flag = data.readUInt8(position++);
            const repeat = flag & 8 ? data.readUInt8(position++) : 0;
            for (let item = 0; item <= repeat; item += 1) flags.push(flag);
        }
        const coordinates = [];
        for (const [short, same] of [[2, 16], [4, 32]]) {
            let coordinate = 0;
            coordinates.push(flags.map(flag => {
                let delta = 0;
                if (flag & short) delta = data.readUInt8(position++) * (flag & same ? 1 : -1);
                else if (!(flag & same)) { delta = data.readInt16BE(position); position += 2; }
                coordinate += delta;
                return coordinate;
            }));
        }
        return { bbox, ends, instructions, coordinates, onCurve: flags.map(flag => flag & 1) };
    });
}

function syntheticCmap(subtables) {
    const headerSize = 4 + subtables.length * 8;
    const cmap = Buffer.alloc(headerSize + subtables.reduce((sum, table) => sum + table.length, 0));
    cmap.writeUInt16BE(subtables.length, 2);
    let offset = headerSize;
    subtables.forEach((table, index) => {
        cmap.writeUInt16BE(0, 4 + index * 8);
        cmap.writeUInt16BE(index, 6 + index * 8);
        cmap.writeUInt32BE(offset, 8 + index * 8);
        table.copy(cmap, offset);
        offset += table.length;
    });
    const sfnt = Buffer.alloc(28);
    sfnt.writeUInt16BE(1, 4);
    sfnt.write('cmap', 12);
    sfnt.writeUInt32BE(28, 20);
    sfnt.writeUInt32BE(cmap.length, 24);
    return Buffer.concat([sfnt, cmap]);
}

test('cmap 解析覆盖 format 4 的 glyphIdArray、delta、缺字以及 format 12 的非 BMP 字符', () => {
    const format4 = Buffer.alloc(38);
    format4.writeUInt16BE(4);
    format4.writeUInt16BE(format4.length, 2);
    format4.writeUInt16BE(4, 6);
    [0x43, 0xffff, 0, 0x41, 0xffff, 1, 1, 4, 0, 2, 0, 0xffff].forEach((value, index) => format4.writeUInt16BE(value, 14 + index * 2));
    const format12 = Buffer.alloc(40);
    format12.writeUInt16BE(12);
    format12.writeUInt32BE(40, 4);
    format12.writeUInt32BE(2, 12);
    [0x20000, 0x20001, 10, 0x20003, 0x20003, 0].forEach((value, index) => format12.writeUInt32BE(value, 16 + index * 4));
    assert.deepEqual(readCmap(syntheticCmap([format4, format12])), [0x41, 0x20000, 0x20001]);
    assert.equal(unicodeRanges([0x20001, 0x41, 0x20000, 0x41, 0x43]), 'U+41,U+43,U+20000-20001');
    assert.equal(unicodeRanges([]), '');
    assert.throws(() => readCmap(Buffer.alloc(12)), /cmap/);
    const broken = syntheticCmap([format12]);
    broken.writeUInt32BE(1000, 24);
    assert.throws(() => readCmap(broken), /边界/);
});

test('仓库内 WASM 和加载器符合固定来源的 SHA-256', async () => {
    const manifest = JSON.parse(await readFile(new URL('assets/wasm/sources.json', root), 'utf8'));
    for (const [name, hash] of Object.entries(manifest.sha256)) {
        assert.equal(createHash('sha256').update(await readFile(new URL(`assets/wasm/${name}`, root))).digest('hex'), hash, name);
    }
});

test('生成的首屏缓存与 CSS 字符范围及缓存哈希一致', async () => {
    await createFontCache(fileURLToPath(root)).build();
    const css = await readFile(new URL('.cache/fonts/diary-kai-core.css', root), 'utf8');
    const ranges = [...css.matchAll(/unicode-range: ([^;]+);/g)].map(match => match[1]);
    for (const [index, name] of names.filter(name => name.startsWith('LXGW')).entries()) {
        const font = await readFile(new URL(`.cache/fonts/${name}-core.woff2`, root));
        const codepoints = readCmap(await decompressFont(font));
        assert.equal(ranges[index], unicodeRanges(codepoints));
        const hash = createHash('sha256').update(font).digest('hex').slice(0, 12);
        assert.ok(css.includes(`./${name}-core.woff2?v=${hash}`));
        const full = new Set(readCmap(await decompressFont(await readFile(new URL(`.cache/fonts/${name}.woff2`, root)))));
        assert.ok(codepoints.every(codepoint => full.has(codepoint)));
        assert.ok(full.size > codepoints.length, '保留完整字体供未覆盖字符回退');
    }
});

test('所有完整 WOFF2 保留 TTF 的字符、排版、度量、hinting 和全部字形轮廓', async () => {
    for (const name of names) {
        const original = await readFile(new URL(`assets/fonts/${name}.ttf`, root));
        const decoded = await decompressFont(await readFile(new URL(`.cache/fonts/${name}.woff2`, root)));
        assert.deepEqual(readCmap(decoded), readCmap(original), name);
        const before = tables(original);
        const after = tables(decoded);
        for (const [tag, value] of before) {
            // WOFF2 重建轮廓和位置、更新校验和，并移除失效的数字签名。
            if (['glyf', 'loca', 'head', 'DSIG'].includes(tag)) continue;
            assert.deepEqual(after.get(tag), value, `${name}: ${tag}`);
        }
        const head = Buffer.from(after.get('head'));
        before.get('head').copy(head, 8, 8, 12);
        // WOFF2 编码器按规范设置 head.flags 的 bit 11，记录无损压缩变换。
        head.writeUInt16BE(head.readUInt16BE(16) & ~0x0800, 16);
        assert.deepEqual(head, before.get('head'), `${name}: head`);
        assert.deepEqual(glyphs(decoded), glyphs(original), `${name}: glyf`);
    }
});

test('子集保留数字、指定范围、非 BMP、排版特性和 hinting，丢弃 meta', async () => {
    const source = await readFile(new URL('assets/fonts/LXGWWenKaiMono-Regular.ttf', root));
    const text = '旅行日记\u{20003}';
    const subset = await subsetFont(source, text, 'U+0041-005A,U+3000-303F');
    const roundtrip = await decompressFont(await compressFont(subset));
    const requested = new Set([...(text + '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ')].map(c => c.codePointAt(0)));
    for (let codepoint = 0x3000; codepoint <= 0x303f; codepoint += 1) requested.add(codepoint);
    assert.deepEqual(readCmap(roundtrip), readCmap(source).filter(c => requested.has(c)));
    assert.ok(roundtrip.length < source.length / 10);
    assert.equal(tables(roundtrip).has('meta'), false);
    assert.ok(tables(roundtrip).has('GSUB'));
    const hinted = await readFile(new URL('assets/fonts/SourceCodePro-Regular.ttf', root));
    const hintedSubset = tables(await subsetFont(hinted, 'ABCfié', 'U+0030-0039'));
    for (const tag of ['cvt ', 'fpgm', 'prep']) assert.deepEqual(hintedSubset.get(tag), tables(hinted).get(tag), tag);
});

test('三个构建模式在无 PATH、无 node_modules、禁止联网和外部命令的隔离项目中可运行', { timeout: 120000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'travel-diary-font-wasm-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    for (const path of ['scripts', 'assets/fonts', 'assets/wasm', 'assets/catalogs', 'data', 'tests', '.cache', 'node_modules']) {
        if (path !== 'node_modules') await mkdir(join(directory, path), { recursive: true });
    }
    await cp(new URL('assets/wasm/', root), join(directory, 'assets/wasm'), { recursive: true });
    for (const name of ['build-fonts.mjs', 'font-tools.mjs']) await cp(new URL(`scripts/${name}`, root), join(directory, 'scripts', name));
    // 小型真实字体保留中文、非 BMP、复合字形与完整回退字符，避免重复压缩整套大字库。
    const source = await readFile(new URL('assets/fonts/LXGWWenKaiMono-Regular.ttf', root));
    const fixture = await subsetFont(source, '旅行日记龘\u{20003}魑魅魍魉', 'U+0000-00FF,U+2000-206F,U+3000-303F');
    for (const name of names) await writeFile(join(directory, 'assets/fonts', `${name}.ttf`), fixture);
    await writeFile(join(directory, 'index.html'), '<h1>旅行日记\u{20003}\u{10ffff}</h1>');
    await writeFile(join(directory, 'data', 'entry.md'), '旅行');
    for (const path of ['tests/ignored.md', '.cache/ignored.md', 'assets/catalogs/ignored.json']) await writeFile(join(directory, path), '龘');
    await writeFile(join(directory, 'offline.cjs'), `
const { syncBuiltinESMExports } = require('node:module');
const deny = () => { throw new Error('禁止联网或启动外部命令'); };
globalThis.fetch = deny;
for (const [name, methods] of Object.entries({
    'node:child_process': ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
    'node:http': ['request', 'get'], 'node:https': ['request', 'get'],
    'node:net': ['connect', 'createConnection'], 'node:tls': ['connect'], 'node:dgram': ['createSocket']
})) for (const method of methods) require(name)[method] = deny;
require('node:net').Socket.prototype.connect = deny;
syncBuiltinESMExports();
`);
    const run = (...args) => {
        const result = spawnSync(process.execPath, ['--require', join(directory, 'offline.cjs'), join(directory, 'scripts/build-fonts.mjs'), ...args], {
            cwd: tmpdir(), encoding: 'utf8', timeout: 90000,
            env: { ...process.env, PATH: '', Path: '', NODE_PATH: '', NODE_OPTIONS: '' }
        });
        assert.equal(result.error, undefined);
        return result;
    };
    const full = run();
    assert.equal(full.status, 0, full.stderr);
    const fullFonts = await Promise.all(names.map(name => readFile(join(directory, '.cache/fonts', `${name}.woff2`))));
    assert.deepEqual(readCmap(await decompressFont(fullFonts[1])), readCmap(fixture));
    const corePath = join(directory, '.cache/fonts/LXGWWenKaiMono-Regular-core.woff2');
    const firstCore = await readFile(corePath);
    const firstMap = readCmap(await decompressFont(firstCore));
    assert.ok(firstMap.includes(0x20003));
    assert.ok(!firstMap.includes('龘'.codePointAt(0)));
    assert.ok(!firstMap.includes('魑'.codePointAt(0)));
    const css = await readFile(join(directory, '.cache/fonts/diary-kai-core.css'), 'utf8');
    const ranges = [...css.matchAll(/unicode-range: ([^;]+);/g)].map(match => match[1]);
    assert.deepEqual(ranges, [unicodeRanges(firstMap), unicodeRanges(firstMap)]);
    for (const [index, weight] of [[0, 400], [1, 700]]) {
        const name = names[index + 1];
        const hash = createHash('sha256').update(await readFile(join(directory, '.cache/fonts', `${name}-core.woff2`))).digest('hex').slice(0, 12);
        assert.ok(css.indexOf(`./${name}.woff2`) < css.indexOf(`./${name}-core.woff2?v=${hash}`));
        assert.match(css, new RegExp(`font-weight: ${weight}`));
    }
    assert.equal((css.match(/font-display: block/g) || []).length, 7);
    await writeFile(join(directory, 'data/entry.md'), '旅行龘');
    assert.equal(run('--core').status, 0);
    const core = await readFile(corePath);
    assert.notDeepEqual(core, firstCore);
    assert.ok(readCmap(await decompressFont(core)).includes('龘'.codePointAt(0)));
    assert.equal(run('--core').status, 0);
    assert.deepEqual(await readFile(corePath), core, '相同输入应生成相同字体');
    for (const [index, name] of names.entries()) assert.deepEqual(await readFile(join(directory, '.cache/fonts', `${name}.woff2`)), fullFonts[index]);
    const subset = run('--subset');
    assert.equal(subset.status, 0, subset.stderr);
    const subsetMap = readCmap(await decompressFont(await readFile(join(directory, '.cache/fonts/LXGWWenKaiMono-Regular.woff2'))));
    assert.ok(!subsetMap.includes('魑'.codePointAt(0)));
    assert.ok(subsetMap.includes('龘'.codePointAt(0)), '完整子集模式收集目录文字');
    for (const digit of '0123456789') assert.ok(subsetMap.includes(digit.codePointAt(0)));
    const restored = await createFontCache(directory).get('LXGWWenKaiMono-Regular.woff2');
    assert.deepEqual(readCmap(await decompressFont(restored)), readCmap(fixture), '运行请求恢复完整字库以覆盖子集外字符');
    for (const args of [['--unknown'], ['--core', '--subset']]) {
        const result = run(...args);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /未知参数|不能同时/);
    }
    await assert.rejects(stat(join(directory, 'node_modules')), { code: 'ENOENT' });
    await writeFile(join(directory, 'retry.mjs'), `
import assert from 'node:assert/strict';
import { readFile, rename } from 'node:fs/promises';
import { compressFont, subsetFont } from './scripts/font-tools.mjs';
const source = await readFile(new URL('./assets/fonts/LXGWWenKaiMono-Regular.ttf', import.meta.url));
for (const [file, run] of [
    ['woff2-compress.wasm', () => compressFont(source)],
    ['harfbuzz-subset.wasm', () => subsetFont(source, '旅行', 'U+0030-0039')]
]) {
    const original = new URL('./assets/wasm/' + file, import.meta.url);
    const moved = new URL('./assets/wasm/' + file + '.missing', import.meta.url);
    await rename(original, moved);
    await assert.rejects(run());
    await rename(moved, original);
    assert.ok((await run()).length > 0);
}
`);
    const retry = spawnSync(process.execPath, [join(directory, 'retry.mjs')], { encoding: 'utf8', timeout: 30000 });
    assert.equal(retry.status, 0, retry.stderr);
});

test('HTTP 字体缓存冷启动、并发、失效、清理、跨实例复用及生成失败回退', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'travel-diary-font-http-'));
    const servers = [];
    t.after(async () => {
        for (const server of servers) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        await rm(directory, { recursive: true, force: true });
    });
    await mkdir(join(directory, 'assets/fonts'), { recursive: true });
    await mkdir(join(directory, 'data'));
    const source = await readFile(new URL('assets/fonts/LXGWWenKaiMono-Regular.ttf', root));
    const fixture = await subsetFont(source, '旅行龘魑', 'U+0000-00FF');
    for (const name of names) await writeFile(join(directory, 'assets/fonts', `${name}.ttf`), fixture);
    await writeFile(join(directory, 'index.html'), '旅行');
    const start = async () => {
        const server = createServer(createHandler(directory));
        servers.push(server);
        return listenOnFetchSafePort(server);
    };
    const url = await start();
    const fontPath = '/.cache/fonts/LXGWWenKaiMono-Regular.woff2';
    const cssPath = '/.cache/fonts/diary-kai-core.css';
    const fonts = await Promise.all(Array.from({ length: 6 }, () => fetch(url + fontPath)));
    const full = Buffer.from(await fonts[0].arrayBuffer());
    assert.equal(fonts[0].headers.get('content-type'), 'font/woff2');
    for (const response of fonts.slice(1)) assert.deepEqual(Buffer.from(await response.arrayBuffer()), full);
    assert.deepEqual(readCmap(await decompressFont(full)), readCmap(fixture));
    const etag = fonts[0].headers.get('etag');
    assert.equal((await fetch(url + fontPath, { headers: { 'If-None-Match': etag } })).status, 304);
    const head = await fetch(url + fontPath, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(full.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const fontFile = join(directory, fontPath);
    const modified = (await stat(fontFile)).mtimeMs;
    const secondUrl = await start();
    assert.equal((await fetch(secondUrl + fontPath)).status, 200);
    assert.equal((await stat(fontFile)).mtimeMs, modified, '服务重启复用有效磁盘缓存');
    const cssResponse = await fetch(url + cssPath);
    const css = await cssResponse.text();
    assert.match(css, /unicode-range:/);
    assert.match(css, /format\("woff2"\), url\("\.\.\/\.\.\/assets\/fonts\/LXGWWenKaiMono-Regular.ttf"\) format\("truetype"\)/);
    assert.equal(await readFile(join(directory, cssPath), 'utf8'), css);
    const coreFile = join(directory, '.cache/fonts/LXGWWenKaiMono-Regular-core.woff2');
    assert.ok(!readCmap(await decompressFont(await readFile(coreFile))).includes('龘'.codePointAt(0)));
    await writeFile(join(directory, 'data/entry.md'), '旅行龘');
    const updatedCss = await (await fetch(url + cssPath)).text();
    assert.notEqual(updatedCss, css);
    assert.ok(readCmap(await decompressFont(await readFile(coreFile))).includes('龘'.codePointAt(0)));
    for (const metadata of ['{', 'null', '[]']) {
        await writeFile(`${fontFile}.json`, metadata);
        await writeFile(fontFile, 'broken');
        assert.deepEqual(Buffer.from(await (await fetch(url + fontPath)).arrayBuffer()), full);
    }
    await writeFile(fontFile, Buffer.alloc(full.length));
    assert.deepEqual(Buffer.from(await (await fetch(url + fontPath)).arrayBuffer()), full);
    // 源文件改变后旧完整字体立即失效。
    const changedSource = await subsetFont(source, '旅行龘', 'U+0000-00FF');
    await writeFile(join(directory, 'assets/fonts/LXGWWenKaiMono-Regular.ttf'), changedSource);
    const changed = await fetch(url + fontPath);
    assert.notEqual(changed.headers.get('etag'), etag);
    assert.deepEqual(readCmap(await decompressFont(Buffer.from(await changed.arrayBuffer()))), readCmap(changedSource));
    for (const path of [`${fontPath}.json`, '/.cache/fonts/unknown.woff2', '/.cache/fonts/nested/file.woff2']) {
        assert.equal((await fetch(url + path)).status, 404);
    }
    assert.equal((await fetch(url + '/.cache/secret.txt')).status, 403);
    assert.equal((await fetch(url + fontPath, { method: 'PUT' })).status, 405);
    await clearCache(directory);
    assert.equal((await fetch(url + fontPath)).status, 200, '清理后请求重新补齐字体');
    await rm(join(directory, 'assets/fonts/LXGWWenKaiMono-Regular.ttf'));
    const unavailable = await fetch(url + fontPath);
    assert.equal(unavailable.status, 503, '先尝试生成，源文件缺失时返回失败以启用 CSS 回退');
    assert.equal(unavailable.headers.get('cache-control'), 'no-store');
    const fallbackCss = await (await fetch(url + cssPath)).text();
    assert.match(fallbackCss, /LXGWWenKaiMono-Regular.ttf/);
    assert.equal((fallbackCss.match(/unicode-range:/g) || []).length, 1, '失败字重保留完整字库及 TTF 回退');
    await writeFile(join(directory, 'assets/fonts/LXGWWenKaiMono-Regular.ttf'), fixture);
    assert.equal((await fetch(url + fontPath)).status, 200, '恢复源文件后允许再次生成');
    await clearCache(directory);
    await mkdir(join(directory, '.cache'));
    await symlink(join(directory, 'data'), join(directory, '.cache/fonts'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await fetch(url + fontPath)).status, 403);
    const memoryCss = await fetch(url + cssPath);
    assert.equal(memoryCss.status, 200, '缓存目录不可写时仍返回完整字体回退样式');
    assert.match(await memoryCss.text(), /format\("truetype"\)/);
    assert.equal((await fetch(url + '/assets/fonts/SourceCodePro-Regular.ttf')).headers.get('content-type'), 'font/ttf');
});
