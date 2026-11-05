import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('随仓库分发的首屏字体与 CSS 字符范围及缓存哈希一致', async () => {
    const css = await readFile(new URL('assets/fonts/diary-kai-core.css', root), 'utf8');
    const ranges = [...css.matchAll(/unicode-range: ([^;]+);/g)].map(match => match[1]);
    for (const [index, name] of names.filter(name => name.startsWith('LXGW')).entries()) {
        const font = await readFile(new URL(`assets/fonts/${name}-core.woff2`, root));
        const codepoints = readCmap(await decompressFont(font));
        assert.equal(ranges[index], unicodeRanges(codepoints));
        const hash = createHash('sha256').update(font).digest('hex').slice(0, 12);
        assert.ok(css.includes(`./${name}-core.woff2?v=${hash}`));
        const full = new Set(readCmap(await decompressFont(await readFile(new URL(`assets/fonts/${name}.woff2`, root)))));
        assert.ok(codepoints.every(codepoint => full.has(codepoint)));
        assert.ok(full.size > codepoints.length, '保留完整字体供未覆盖字符回退');
    }
});

test('所有完整 WOFF2 保留 TTF 的字符、排版、度量、hinting 和全部字形轮廓', async () => {
    for (const name of names) {
        const original = await readFile(new URL(`assets/fonts/${name}.ttf`, root));
        const decoded = await decompressFont(await readFile(new URL(`assets/fonts/${name}.woff2`, root)));
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
    const fullFonts = await Promise.all(names.map(name => readFile(join(directory, 'assets/fonts', `${name}.woff2`))));
    assert.deepEqual(readCmap(await decompressFont(fullFonts[1])), readCmap(fixture));
    const corePath = join(directory, 'assets/fonts/LXGWWenKaiMono-Regular-core.woff2');
    const firstCore = await readFile(corePath);
    const firstMap = readCmap(await decompressFont(firstCore));
    assert.ok(firstMap.includes(0x20003));
    assert.ok(!firstMap.includes('龘'.codePointAt(0)));
    assert.ok(!firstMap.includes('魑'.codePointAt(0)));
    const css = await readFile(join(directory, 'assets/fonts/diary-kai-core.css'), 'utf8');
    const ranges = [...css.matchAll(/unicode-range: ([^;]+);/g)].map(match => match[1]);
    assert.deepEqual(ranges, [unicodeRanges(firstMap), unicodeRanges(firstMap)]);
    for (const [index, weight] of [[0, 400], [1, 700]]) {
        const name = names[index + 1];
        const hash = createHash('sha256').update(await readFile(join(directory, 'assets/fonts', `${name}-core.woff2`))).digest('hex').slice(0, 12);
        assert.ok(css.indexOf(`./${name}.woff2`) < css.indexOf(`./${name}-core.woff2?v=${hash}`));
        assert.match(css, new RegExp(`font-weight: ${weight}`));
    }
    assert.equal((css.match(/font-display: block/g) || []).length, 4);
    await writeFile(join(directory, 'data/entry.md'), '旅行龘');
    assert.equal(run('--core').status, 0);
    const core = await readFile(corePath);
    assert.notDeepEqual(core, firstCore);
    assert.ok(readCmap(await decompressFont(core)).includes('龘'.codePointAt(0)));
    assert.equal(run('--core').status, 0);
    assert.deepEqual(await readFile(corePath), core, '相同输入应生成相同字体');
    for (const [index, name] of names.entries()) assert.deepEqual(await readFile(join(directory, 'assets/fonts', `${name}.woff2`)), fullFonts[index]);
    const subset = run('--subset');
    assert.equal(subset.status, 0, subset.stderr);
    const subsetMap = readCmap(await decompressFont(await readFile(join(directory, 'assets/fonts/LXGWWenKaiMono-Regular.woff2'))));
    assert.ok(!subsetMap.includes('魑'.codePointAt(0)));
    assert.ok(subsetMap.includes('龘'.codePointAt(0)), '完整子集模式收集目录文字');
    for (const digit of '0123456789') assert.ok(subsetMap.includes(digit.codePointAt(0)));
    for (const args of [['--unknown'], ['--core', '--subset']]) {
        const result = run(...args);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /未知参数|不能同时/);
    }
    await assert.rejects(stat(join(directory, 'node_modules')), { code: 'ENOENT' });
});
