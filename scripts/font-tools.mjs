import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let harfbuzzPromise;
const woff2Promises = new Map();

function loadWoff2(kind) {
    if (!woff2Promises.has(kind)) {
        woff2Promises.set(kind, new Promise((resolve, reject) => {
            const module = require(`../assets/wasm/woff2-${kind}.cjs`);
            module.onAbort = reason => reject(new Error(`WOFF2 WASM 初始化失败：${reason}`));
            module.onRuntimeInitialized = () => resolve(module);
            if (module.calledRun) resolve(module);
        }).catch(error => {
            woff2Promises.delete(kind);
            delete require.cache[require.resolve(`../assets/wasm/woff2-${kind}.cjs`)];
            throw error;
        }));
    }
    return woff2Promises.get(kind);
}

async function convertWoff2(kind, source) {
    const module = await loadWoff2(kind);
    const result = module[kind](source);
    if (result === false) throw new Error(`WOFF2 ${kind} 失败，字体数据无效。`);
    // 上游返回 WASM 堆内视图；下一次调用前必须复制为独立数据。
    return Buffer.from(result);
}

export const compressFont = source => convertWoff2('compress', source);
export const decompressFont = source => convertWoff2('decompress', source);

async function loadHarfbuzz() {
    harfbuzzPromise ??= WebAssembly.instantiate(readFileSync(new URL('../assets/wasm/harfbuzz-subset.wasm', import.meta.url)))
        .then(({ instance }) => {
            instance.exports._initialize();
            return instance.exports;
        }).catch(error => { harfbuzzPromise = undefined; throw error; });
    return harfbuzzPromise;
}

function fontTag(value) {
    return [...value].reduce((tag, character) => (tag << 8) | character.charCodeAt(0), 0) >>> 0;
}

export async function subsetFont(source, text, unicodeRanges) {
    const hb = await loadHarfbuzz();
    let pointer = 0;
    let blob = 0;
    let face = 0;
    let input = 0;
    let subset = 0;
    let resultBlob = 0;
    try {
        pointer = hb.malloc(source.length);
        if (!pointer) throw new Error('无法分配字体内存。');
        new Uint8Array(hb.memory.buffer).set(source, pointer);
        blob = hb.hb_blob_create(pointer, source.length, 2, 0, 0);
        face = hb.hb_face_create(blob, 0);
        input = hb.hb_subset_input_create_or_fail();
        if (!input) throw new Error('无法创建字体子集参数。');
        const unicodes = hb.hb_subset_input_unicode_set(input);
        for (const character of `${text}0123456789`) hb.hb_set_add(unicodes, character.codePointAt(0));
        for (const range of unicodeRanges.split(',')) {
            const [start, end = start] = range.replace(/^U\+/i, '').split('-').map(value => Number.parseInt(value, 16));
            for (let codepoint = start; codepoint <= end; codepoint += 1) hb.hb_set_add(unicodes, codepoint);
        }
        // 保留全部 OpenType 特性及默认字形闭包、hinting，与原构建选项一致。
        const features = hb.hb_subset_input_set(input, 6);
        hb.hb_set_clear(features);
        hb.hb_set_invert(features);
        hb.hb_set_add(hb.hb_subset_input_set(input, 3), fontTag('meta'));
        subset = hb.hb_subset_or_fail(face, input);
        if (!subset) throw new Error('HarfBuzz 无法生成字体子集。');
        resultBlob = hb.hb_face_reference_blob(subset);
        const length = hb.hb_blob_get_length(resultBlob);
        const data = hb.hb_blob_get_data(resultBlob, 0);
        if (!length || !data) throw new Error('字体子集为空。');
        // HarfBuzz 操作可能扩展 memory；此时重新获取视图。
        return Buffer.from(new Uint8Array(hb.memory.buffer, data, length));
    } finally {
        if (resultBlob) hb.hb_blob_destroy(resultBlob);
        if (subset) hb.hb_face_destroy(subset);
        if (input) hb.hb_subset_input_destroy(input);
        if (face) hb.hb_face_destroy(face);
        if (blob) hb.hb_blob_destroy(blob);
        if (pointer) hb.free(pointer);
    }
}

export function readCmap(source) {
    const font = Buffer.from(source);
    const tableCount = font.readUInt16BE(4);
    let cmap;
    for (let index = 0; index < tableCount; index += 1) {
        const entry = 12 + index * 16;
        if (font.toString('ascii', entry, entry + 4) === 'cmap') {
            const offset = font.readUInt32BE(entry + 8);
            const length = font.readUInt32BE(entry + 12);
            if (offset + length > font.length) throw new Error('cmap 表超出字体边界。');
            cmap = font.subarray(offset, offset + length);
            break;
        }
    }
    if (!cmap) throw new Error('字体缺少 cmap 表。');
    const codepoints = new Set();
    const visited = new Set();
    const add = (codepoint, glyph) => {
        if (glyph && codepoint <= 0x10ffff && (codepoint < 0xd800 || codepoint > 0xdfff)) codepoints.add(codepoint);
    };
    for (let index = 0; index < cmap.readUInt16BE(2); index += 1) {
        const entry = 4 + index * 8;
        const platform = cmap.readUInt16BE(entry);
        const encoding = cmap.readUInt16BE(entry + 2);
        if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
        const offset = cmap.readUInt32BE(entry + 4);
        if (visited.has(offset)) continue;
        visited.add(offset);
        const format = cmap.readUInt16BE(offset);
        if (format === 14) continue; // 变体选择符不声明为独立字符。
        const length = format >= 10 ? cmap.readUInt32BE(offset + 4) : cmap.readUInt16BE(offset + 2);
        if (offset + length > cmap.length) throw new Error('cmap 子表超出字体边界。');
        const table = cmap.subarray(offset, offset + length);
        if (format === 4) {
            const count = table.readUInt16BE(6) / 2;
            for (let segment = 0; segment < count; segment += 1) {
                const end = table.readUInt16BE(14 + segment * 2);
                const start = table.readUInt16BE(16 + count * 2 + segment * 2);
                const delta = table.readInt16BE(16 + count * 4 + segment * 2);
                const rangePosition = 16 + count * 6 + segment * 2;
                const rangeOffset = table.readUInt16BE(rangePosition);
                for (let codepoint = start; codepoint <= end && codepoint !== 0xffff; codepoint += 1) {
                    let glyph = rangeOffset ? table.readUInt16BE(rangePosition + rangeOffset + (codepoint - start) * 2) : codepoint;
                    if (!rangeOffset || glyph) glyph = (glyph + delta) & 0xffff;
                    add(codepoint, glyph);
                }
            }
        } else if (format === 12 || format === 13) {
            for (let group = 0; group < table.readUInt32BE(12); group += 1) {
                const position = 16 + group * 12;
                const start = table.readUInt32BE(position);
                const end = table.readUInt32BE(position + 4);
                const glyph = table.readUInt32BE(position + 8);
                if (end > 0x10ffff || end < start) throw new Error('cmap Unicode 范围无效。');
                for (let codepoint = start; codepoint <= end; codepoint += 1) add(codepoint, glyph + (format === 12 ? codepoint - start : 0));
            }
        } else if (format === 0) {
            for (let codepoint = 0; codepoint < 256; codepoint += 1) add(codepoint, table.readUInt8(6 + codepoint));
        } else if (format === 6 || format === 10) {
            const start = format === 6 ? table.readUInt16BE(6) : table.readUInt32BE(12);
            const count = format === 6 ? table.readUInt16BE(8) : table.readUInt32BE(16);
            for (let item = 0; item < count; item += 1) add(start + item, table.readUInt16BE((format === 6 ? 10 : 20) + item * 2));
        } else {
            throw new Error(`不支持的 Unicode cmap 格式：${format}`);
        }
    }
    return [...codepoints].sort((a, b) => a - b);
}

export function unicodeRanges(codepoints) {
    const sorted = [...new Set(codepoints)].sort((a, b) => a - b);
    const ranges = [];
    for (let index = 0; index < sorted.length; index += 1) {
        const start = sorted[index];
        let end = start;
        while (sorted[index + 1] === end + 1) end = sorted[++index];
        ranges.push(`U+${start.toString(16).toUpperCase()}${end === start ? '' : `-${end.toString(16).toUpperCase()}`}`);
    }
    return ranges.join(',');
}
