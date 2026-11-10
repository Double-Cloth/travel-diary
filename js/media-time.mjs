import { ByteSource, sourceOf } from './zip-stream.mjs';

const MAXIMUM_METADATA_BYTES = 8 * 1024 * 1024;
const decoder = new TextDecoder();
const text = bytes => decoder.decode(bytes).replace(/\0+$/, '');
const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const filenameOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'variant' });

// 缺少时区的相机时间按浏览器本地时间解释，不使用文件系统的修改时间。
function dateTime(value, offset = '') {
    const match = String(value).trim().match(/^(\d{4})[:-](\d{2})[:-](\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
    if (!match) return null;
    const [, year, month, day, hour, minute, second, fraction = '', zone = offset] = match;
    const calendar = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
    if (+year < 1900 || calendar.getUTCFullYear() !== +year || calendar.getUTCMonth() !== +month - 1
        || calendar.getUTCDate() !== +day || +hour > 23 || +minute > 59 || +second > 59) return null;
    if (zone && !/^(Z|[+-](?:0\d|1\d|2[0-3]):?[0-5]\d)$/.test(zone)) return null;
    const result = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}${zone}`);
    return Number.isFinite(result) ? result : null;
}

function exifTime(bytes) {
    if (text(bytes.subarray(0, 6)) === 'Exif') bytes = bytes.subarray(6);
    if (bytes.length < 8) return null;
    const little = text(bytes.subarray(0, 2)) === 'II';
    if (!little && text(bytes.subarray(0, 2)) !== 'MM') return null;
    const view = viewOf(bytes);
    if (view.getUint16(2, little) !== 42) return null;
    const tags = new Map();
    const visited = new Set();
    function directory(offset) {
        if (visited.has(offset) || visited.size > 4 || offset + 2 > bytes.length) return;
        visited.add(offset);
        const count = view.getUint16(offset, little);
        if (offset + 2 + count * 12 > bytes.length) return;
        for (let index = 0; index < count; index++) {
            const entry = offset + 2 + index * 12;
            const tag = view.getUint16(entry, little);
            const type = view.getUint16(entry + 2, little);
            const size = view.getUint32(entry + 4, little);
            if (tag === 0x8769 && type === 4 && size === 1) directory(view.getUint32(entry + 8, little));
            if (type !== 2 || size > 128) continue;
            const start = size <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
            if (start + size <= bytes.length) tags.set(tag, text(bytes.subarray(start, start + size)).trim());
        }
    }
    directory(view.getUint32(4, little));
    for (const [tag, zone, subsecond] of [[0x9003, 0x9011, 0x9291], [0x9004, 0x9012, 0x9292], [0x132, 0x9010, 0x9290]]) {
        const fraction = tags.get(subsecond);
        const result = dateTime(`${tags.get(tag) || ''}${/^\d+$/.test(fraction || '') ? `.${fraction}` : ''}`, tags.get(zone) || '');
        if (result !== null) return result;
    }
    return null;
}

function xmpTime(bytes) {
    const content = text(bytes);
    for (const tag of ['exif:DateTimeOriginal', 'photoshop:DateCreated', 'xmp:CreateDate']) {
        const match = content.match(new RegExp(`${tag}\\s*=\\s*["']([^"']+)["']|<${tag}>([^<]+)</${tag}>`));
        const result = match ? dateTime(match[1] || match[2]) : null;
        if (result !== null) return result;
    }
    return null;
}

async function imageTime(source, head) {
    let fallback = null;
    if (head[0] === 0xff && head[1] === 0xd8) {
        let offset = 2;
        while (offset + 4 <= source.size) {
            const marker = await source.read(offset, 4);
            if (marker[0] !== 0xff || marker[1] === 0xda || marker[1] === 0xd9) break;
            if (marker[1] === 0xff) { offset++; continue; }
            const size = viewOf(marker).getUint16(2);
            if (size < 2 || offset + size + 2 > source.size) break;
            if (marker[1] === 0xe1) {
                const bytes = await source.read(offset + 4, size - 2);
                const result = exifTime(bytes);
                if (result !== null) return result;
                fallback ??= xmpTime(bytes);
            }
            offset += size + 2;
        }
    } else if (head[0] === 0x89 && text(head.subarray(1, 4)) === 'PNG') {
        for (let offset = 8; offset + 12 <= source.size;) {
            const header = await source.read(offset, 8);
            const size = viewOf(header).getUint32(0);
            const kind = text(header.subarray(4));
            if (offset + size + 12 > source.size || kind === 'IEND') break;
            if (kind === 'eXIf' && size <= MAXIMUM_METADATA_BYTES) {
                const result = exifTime(await source.read(offset + 8, size));
                if (result !== null) return result;
            }
            if (['iTXt', 'tEXt'].includes(kind) && size <= MAXIMUM_METADATA_BYTES) fallback ??= xmpTime(await source.read(offset + 8, size));
            offset += size + 12;
        }
    } else if (text(head.subarray(0, 4)) === 'RIFF' && text(head.subarray(8, 12)) === 'WEBP') {
        for (let offset = 12; offset + 8 <= source.size;) {
            const header = await source.read(offset, 8);
            const size = viewOf(header).getUint32(4, true);
            const kind = text(header.subarray(0, 4));
            if (offset + size + 8 > source.size) break;
            if (['EXIF', 'XMP '].includes(kind) && size <= MAXIMUM_METADATA_BYTES) {
                const bytes = await source.read(offset + 8, size);
                if (kind === 'EXIF') {
                    const result = exifTime(bytes);
                    if (result !== null) return result;
                } else fallback ??= xmpTime(bytes);
            }
            offset += size + 8 + size % 2;
        }
    }
    return fallback;
}

async function movieTime(source) {
    let fallback = null;
    let original = null;
    async function atoms(start, end, depth = 0) {
        if (depth > 6) return;
        let keys = [];
        for (let offset = start; offset + 8 <= end;) {
            const header = await source.read(offset, Math.min(16, end - offset));
            const view = viewOf(header);
            const kind = text(header.subarray(4, 8));
            let size = view.getUint32(0);
            let headerSize = 8;
            if (size === 1) { size = Number(view.getBigUint64(8)); headerSize = 16; }
            if (size === 0) size = end - offset;
            if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) break;
            const payload = offset + headerSize;
            const length = size - headerSize;
            if (kind === 'mvhd' && length >= 12) {
                const bytes = await source.read(payload, Math.min(length, 20));
                const data = viewOf(bytes);
                const seconds = bytes[0] === 1 && length >= 20 ? Number(data.getBigUint64(4))
                    : bytes[0] === 0 ? data.getUint32(4) : 0;
                let time = seconds * 1000 + Date.UTC(1904, 0, 1);
                // 部分剪辑软件误用 Unix 纪元，落在 1970 年之前的容器时间按 Unix 秒数兼容。
                if (time < 0) time = seconds * 1000;
                if (seconds > 0 && Number.isFinite(new Date(time).getTime())) fallback ??= time;
            } else if (['moov', 'udta'].includes(kind)) await atoms(payload, offset + size, depth + 1);
            else if (kind === 'meta' && length >= 4) await atoms(payload + 4, offset + size, depth + 1);
            else if (kind === 'keys' && length <= MAXIMUM_METADATA_BYTES && length >= 8) {
                const bytes = await source.read(payload, length);
                const data = viewOf(bytes);
                keys = [];
                for (let cursor = 8; cursor + 8 <= length;) {
                    const keySize = data.getUint32(cursor);
                    if (keySize < 8 || cursor + keySize > length) break;
                    keys.push(text(bytes.subarray(cursor + 8, cursor + keySize)));
                    cursor += keySize;
                }
            } else if (kind === 'ilst' && length <= MAXIMUM_METADATA_BYTES) {
                const bytes = await source.read(payload, length);
                const data = viewOf(bytes);
                for (let cursor = 0; cursor + 8 <= length;) {
                    const itemSize = data.getUint32(cursor);
                    if (itemSize < 8 || cursor + itemSize > length) break;
                    if (keys[data.getUint32(cursor + 4) - 1] === 'com.apple.quicktime.creationdate') {
                        for (let child = cursor + 8; child + 16 <= cursor + itemSize;) {
                            const childSize = data.getUint32(child);
                            if (childSize < 16 || child + childSize > cursor + itemSize) break;
                            if (text(bytes.subarray(child + 4, child + 8)) === 'data') original ??= dateTime(text(bytes.subarray(child + 16, child + childSize)));
                            child += childSize;
                        }
                    }
                    cursor += itemSize;
                }
            }
            offset += size;
        }
    }
    await atoms(0, source.size);
    return original ?? fallback;
}

async function webmTime(source) {
    async function elements(start, end, depth = 0) {
        if (depth > 3) return null;
        for (let offset = start; offset + 2 <= end;) {
            const bytes = await source.read(offset, Math.min(16, end - offset));
            function integer(position, keepMarker) {
                let width = 1;
                while (width <= 8 && !(bytes[position] & (128 >> (width - 1)))) width++;
                if (width > 8 || position + width > bytes.length) throw new Error('视频元数据无效。');
                let value = BigInt(keepMarker ? bytes[position] : bytes[position] & (255 >> width));
                for (let index = 1; index < width; index++) value = value * 256n + BigInt(bytes[position + index]);
                return { width, value };
            }
            const id = integer(0, true);
            const size = integer(id.width, false);
            const payload = offset + id.width + size.width;
            const unknown = size.value === (1n << BigInt(size.width * 7)) - 1n;
            const next = unknown ? end : payload + Number(size.value);
            if (!Number.isSafeInteger(next) || next > end || next < payload) break;
            if (id.value === 0x4461n && next - payload === 8) {
                const date = viewOf(await source.read(payload, 8)).getBigInt64(0);
                return Date.UTC(2001, 0, 1) + Number(date / 1000000n);
            }
            if ([0x18538067n, 0x1549a966n].includes(id.value)) {
                const result = await elements(payload, next, depth + 1);
                if (result !== null) return result;
            }
            offset = next;
        }
        return null;
    }
    return elements(0, source.size);
}

export async function readMediaTime(value) {
    const input = sourceOf(value);
    let total = 0;
    let reads = 0;
    const source = new ByteSource(input.size, (offset, length) => {
        total += length;
        if (total > MAXIMUM_METADATA_BYTES || ++reads > 2048) throw new Error('媒体元数据过大或已损坏。');
        return input.read(offset, length);
    });
    const head = await source.read(0, Math.min(source.size, 16));
    if (head.length < 8) return null;
    if (viewOf(head).getUint32(0) === 0x1a45dfa3) return webmTime(source);
    if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(text(head.subarray(4, 8)))) return movieTime(source);
    return imageTime(source, head);
}

// 按区块读取已有文件；跳过视频内容块，moov 位于文件尾部也不会整段下载。
export async function fetchMediaTime(url, signal) {
    const response = await fetch(url, { method: 'HEAD', signal, cache: 'no-store' });
    const size = Number(response.headers.get('Content-Length'));
    if (!response.ok || !Number.isSafeInteger(size) || size <= 0) throw new Error('无法读取媒体文件。');
    const blocks = new Map();
    let fetched = 0;
    let complete;
    const chunkSize = 64 * 1024;
    const source = new ByteSource(size, async (offset, length) => {
        const result = new Uint8Array(length);
        for (let copied = 0; copied < length;) {
            signal?.throwIfAborted();
            const start = Math.floor((offset + copied) / chunkSize) * chunkSize;
            if (!complete && !blocks.has(start)) {
                const end = Math.min(start + chunkSize, size) - 1;
                fetched += end - start + 1;
                if (fetched > MAXIMUM_METADATA_BYTES) throw new Error('媒体元数据过大或已损坏。');
                const part = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
                if (part.status === 206 && part.headers.get('Content-Range') === `bytes ${start}-${end}/${size}`) {
                    blocks.set(start, new Uint8Array(await part.arrayBuffer()));
                } else if (part.status === 200 && size <= MAXIMUM_METADATA_BYTES) {
                    complete = new Uint8Array(await part.arrayBuffer());
                    if (complete.length !== size) throw new Error('媒体文件已变化，请重新打开日记。');
                } else {
                    await part.body?.cancel();
                    throw new Error('当前服务无法分段读取此媒体文件。');
                }
            }
            const position = offset + copied;
            const bytes = complete ? complete.subarray(position, Math.min(offset + length, start + chunkSize))
                : blocks.get(start).subarray(position - start, Math.min(offset + length - start, chunkSize));
            if (!bytes.length) throw new Error('媒体文件读取不完整。');
            result.set(bytes, copied);
            copied += bytes.length;
        }
        return result;
    });
    return readMediaTime(source);
}

export function sortMediaByTime(items, times) {
    return [...items].sort((left, right) => {
        const a = times.get(left.key);
        const b = times.get(right.key);
        const hasA = Number.isFinite(a);
        const hasB = Number.isFinite(b);
        if (hasA !== hasB) return hasA ? -1 : 1;
        if (hasA && a !== b) return a - b;
        return filenameOrder.compare(left.name, right.name);
    });
}
