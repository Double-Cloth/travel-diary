// 使用固定大小分块与随机读取，避免将大型媒体或整个 ZIP 放入内存。
export const ZIP_CHUNK_BYTES = 1024 * 1024;
export const MAXIMUM_ZIP_TEXT_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const table = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});

export function updateCrc(crc, bytes) {
    for (let index = 0; index < bytes.length; index += 1) crc = table[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
    return crc >>> 0;
}

export class ByteSource {
    constructor(size, read, blob = null) {
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('文件大小无效。');
        this.size = size;
        this.read = async (offset, length) => {
            if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
                throw new Error('ZIP 文件内容不完整或范围无效。');
            }
            const bytes = await read(offset, length);
            if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error('文件读取不完整。');
            return bytes;
        };
        this.blob = blob;
    }

    slice(offset, size) {
        if (offset < 0 || size < 0 || offset + size > this.size) throw new Error('ZIP 条目范围无效。');
        return new ByteSource(size, (start, length) => this.read(offset + start, length), this.blob?.slice(offset, offset + size));
    }

    async *chunks() {
        let crc = 0xffffffff;
        for (let offset = 0; offset < this.size; offset += ZIP_CHUNK_BYTES) {
            const bytes = await this.read(offset, Math.min(ZIP_CHUNK_BYTES, this.size - offset));
            if (this.checksum !== undefined) crc = updateCrc(crc, bytes);
            yield bytes;
        }
        if (this.checksum !== undefined && ((crc ^ 0xffffffff) >>> 0) !== this.checksum) {
            throw new Error('ZIP 文件校验失败。');
        }
    }
}

export function sourceOf(value) {
    if (value instanceof ByteSource) return value;
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
        return new ByteSource(value.size, async (offset, length) => new Uint8Array(await value.slice(offset, offset + length).arrayBuffer()), value);
    }
    const bytes = typeof value === 'string' ? encoder.encode(value)
        : value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    if (!(bytes instanceof Uint8Array)) throw new Error('文件内容无效。');
    return new ByteSource(bytes.length, async (offset, length) => bytes.subarray(offset, offset + length));
}

export async function readSourceText(source) {
    if (source.size > MAXIMUM_ZIP_TEXT_BYTES) throw new Error('ZIP 文本或清单不能超过 16 MiB。');
    const bytes = await source.read(0, source.size);
    if (source.checksum !== undefined && ((updateCrc(0xffffffff, bytes) ^ 0xffffffff) >>> 0) !== source.checksum) {
        throw new Error('ZIP 文件校验失败。');
    }
    return bytes;
}

function header(size, signature) {
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, signature, true);
    return { bytes, view };
}

function safeName(name, seen) {
    if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\') || name.includes('\0')
        || name.split('/').some(part => !part || part === '.' || part === '..') || seen.has(name)) {
        throw new Error('ZIP 条目路径无效或重复。');
    }
    seen.add(name);
    const bytes = encoder.encode(name);
    if (bytes.length > 65535) throw new Error('ZIP 文件名过长。');
    return bytes;
}

function extra64(values) {
    const bytes = new Uint8Array(4 + values.length * 8);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 1, true);
    view.setUint16(2, bytes.length - 4, true);
    values.forEach((value, index) => view.setBigUint64(4 + index * 8, BigInt(value), true));
    return bytes;
}

function localHeader(name, size, crc, descriptor) {
    const extra = extra64([size, size]);
    const { bytes, view } = header(30, 0x04034b50);
    view.setUint16(4, 45, true);
    view.setUint16(6, descriptor ? 0x0808 : 0x0800, true);
    view.setUint16(12, 33, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, 0xffffffff, true);
    view.setUint32(22, 0xffffffff, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, extra.length, true);
    return [bytes, name, extra];
}

function centralHeader(name, size, crc, offset, descriptor) {
    const extra = extra64([size, size, offset]);
    const { bytes, view } = header(46, 0x02014b50);
    view.setUint16(4, 45, true);
    view.setUint16(6, 45, true);
    view.setUint16(8, descriptor ? 0x0808 : 0x0800, true);
    view.setUint16(14, 33, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, 0xffffffff, true);
    view.setUint32(24, 0xffffffff, true);
    view.setUint16(28, name.length, true);
    view.setUint16(30, extra.length, true);
    view.setUint32(42, 0xffffffff, true);
    return [bytes, name, extra];
}

function endHeaders(count, start, size) {
    const end64 = header(56, 0x06064b50);
    end64.view.setBigUint64(4, 44n, true);
    end64.view.setUint16(12, 45, true);
    end64.view.setUint16(14, 45, true);
    for (const offset of [24, 32]) end64.view.setBigUint64(offset, BigInt(count), true);
    end64.view.setBigUint64(40, BigInt(size), true);
    end64.view.setBigUint64(48, BigInt(start), true);
    const locator = header(20, 0x07064b50);
    locator.view.setBigUint64(8, BigInt(start + size), true);
    locator.view.setUint32(16, 1, true);
    const end = header(22, 0x06054b50);
    for (const offset of [8, 10]) end.view.setUint16(offset, 65535, true);
    for (const offset of [12, 16]) end.view.setUint32(offset, 0xffffffff, true);
    return [end64.bytes, locator.bytes, end.bytes];
}

function checkEntries(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 50000) throw new Error('ZIP 文件数量必须为 1 至 50000。');
}

export function zipStreamSize(entries) {
    checkEntries(entries);
    return entries.reduce((size, entry) => size + sourceOf(entry.data).size + 30 + 20 + 24 + 46 + 28 + encoder.encode(entry.name).length * 2, 98);
}

// 数据描述符使导出只需顺序读取一次，pipeline 会将网络背压传到文件读取。
export async function* createZipStream(entries) {
    checkEntries(entries);
    const central = [];
    const seen = new Set();
    let offset = 0;
    for (const entry of entries) {
        const name = safeName(entry.name, seen);
        const source = sourceOf(entry.data);
        const local = localHeader(name, source.size, 0, true);
        for (const part of local) yield part;
        let crc = 0xffffffff;
        for await (const bytes of source.chunks()) {
            crc = updateCrc(crc, bytes);
            yield bytes;
        }
        crc = (crc ^ 0xffffffff) >>> 0;
        const descriptor = header(24, 0x08074b50);
        descriptor.view.setUint32(4, crc, true);
        descriptor.view.setBigUint64(8, BigInt(source.size), true);
        descriptor.view.setBigUint64(16, BigInt(source.size), true);
        yield descriptor.bytes;
        central.push(...centralHeader(name, source.size, crc, offset, true));
        offset += 30 + name.length + 20 + source.size + 24;
    }
    const size = central.reduce((sum, part) => sum + part.length, 0);
    yield* central;
    yield* endHeaders(entries.length, offset, size);
}

// 浏览器保留原 File/Blob，仅扫描 CRC 并组合小头部，避免拷贝媒体到大数组。
export async function createZipBlob(entries, onProgress = () => {}) {
    checkEntries(entries);
    const parts = [];
    const central = [];
    const seen = new Set();
    let offset = 0;
    let processed = 0;
    const total = entries.reduce((sum, entry) => sum + sourceOf(entry.data).size, 0);
    for (const entry of entries) {
        const name = safeName(entry.name, seen);
        const source = sourceOf(entry.data);
        let crc = source.cachedCrc;
        if (crc === undefined) {
            crc = 0xffffffff;
            for await (const chunk of source.chunks()) {
                crc = updateCrc(crc, chunk);
                processed += chunk.length;
                onProgress(processed, total);
            }
            crc = (crc ^ 0xffffffff) >>> 0;
            if (source.blob) source.cachedCrc = crc;
        } else {
            processed += source.size;
            onProgress(processed, total);
        }
        const blob = source.blob || new Blob([entry.data instanceof ByteSource ? await readSourceText(source) : entry.data]);
        parts.push(...localHeader(name, source.size, crc, false), blob);
        central.push(...centralHeader(name, source.size, crc, offset, false));
        offset += 30 + name.length + 20 + source.size;
    }
    const size = central.reduce((sum, part) => sum + part.length, 0);
    return new Blob([...parts, ...central, ...endHeaders(entries.length, offset, size)], { type: 'application/zip' });
}

function number64(view, offset) {
    const value = Number(view.getBigUint64(offset, true));
    if (!Number.isSafeInteger(value)) throw new Error('ZIP64 数值超出安全范围。');
    return value;
}

function sizes64(extra, values) {
    const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
    let offset = 0;
    let found = false;
    const needs64 = values.includes(0xffffffff);
    while (offset < extra.length) {
        if (offset + 4 > extra.length) throw new Error('ZIP 扩展字段损坏。');
        const id = view.getUint16(offset, true);
        const length = view.getUint16(offset + 2, true);
        const end = offset + 4 + length;
        if (end > extra.length) throw new Error('ZIP 扩展字段损坏。');
        if (id === 1) {
            if (found) throw new Error('ZIP64 扩展字段重复。');
            found = true;
            let position = offset + 4;
            values = values.map(value => {
                if (value !== 0xffffffff) return value;
                if (position + 8 > end) throw new Error('ZIP64 扩展字段不完整。');
                const result = number64(view, position);
                position += 8;
                return result;
            });
        }
        offset = end;
    }
    if (needs64 && !found) throw new Error('ZIP64 扩展字段缺失。');
    return values;
}

export async function readZipSource(value) {
    const source = sourceOf(value);
    if (source.size < 22) throw new Error('文件不是有效的 ZIP 压缩包。');
    const tailStart = Math.max(0, source.size - 65557);
    const tail = await source.read(tailStart, source.size - tailStart);
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let end = tail.length - 22;
    while (end >= 0 && !(view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === tail.length)) end -= 1;
    if (end < 0) throw new Error('文件不是有效的 ZIP 压缩包。');
    let count = view.getUint16(end + 10, true);
    let centralSize = view.getUint32(end + 12, true);
    let start = view.getUint32(end + 16, true);
    let centralEnd = tailStart + end;
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count) throw new Error('ZIP 分卷信息无效。');
    if (count === 65535 || centralSize === 0xffffffff || start === 0xffffffff) {
        const locatorBytes = await source.read(centralEnd - 20, 20);
        const locator = new DataView(locatorBytes.buffer, locatorBytes.byteOffset, 20);
        if (locator.getUint32(0, true) !== 0x07064b50 || locator.getUint32(4, true) || locator.getUint32(16, true) !== 1) throw new Error('ZIP64 定位或分卷信息无效。');
        const position = number64(locator, 8);
        const bytes = await source.read(position, 56);
        const zip64 = new DataView(bytes.buffer, bytes.byteOffset, 56);
        if (zip64.getUint32(0, true) !== 0x06064b50 || position + 12 + number64(zip64, 4) !== centralEnd - 20
            || zip64.getUint32(16, true) || zip64.getUint32(20, true) || number64(zip64, 24) !== number64(zip64, 32)) throw new Error('ZIP64 目录无效。');
        count = number64(zip64, 32);
        centralSize = number64(zip64, 40);
        start = number64(zip64, 48);
        centralEnd = position;
    }
    if (!count || count > 50000 || start + centralSize !== centralEnd || centralSize > MAXIMUM_ZIP_TEXT_BYTES) throw new Error('ZIP 目录大小或数量无效。');
    const bytes = await source.read(start, centralSize);
    const directory = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const seen = new Set();
    const entries = [];
    const ranges = [];
    let offset = 0;
    for (let index = 0; index < count; index += 1) {
        if (offset + 46 > bytes.length || directory.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 目录已损坏。');
        const flags = directory.getUint16(offset + 8, true);
        const method = directory.getUint16(offset + 10, true);
        const crc = directory.getUint32(offset + 16, true);
        const nameLength = directory.getUint16(offset + 28, true);
        const extraLength = directory.getUint16(offset + 30, true);
        const commentLength = directory.getUint16(offset + 32, true);
        const next = offset + 46 + nameLength + extraLength + commentLength;
        if (next > bytes.length || flags & ~0x0808 || method !== 0 || directory.getUint16(offset + 34, true)) throw new Error('仅支持未加密、未压缩、非分卷 ZIP。');
        const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
        safeName(name, seen);
        const rawSize = directory.getUint32(offset + 24, true);
        const rawCompressed = directory.getUint32(offset + 20, true);
        const [size, compressed, localOffset] = sizes64(bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength),
            [rawSize, rawCompressed, directory.getUint32(offset + 42, true)]);
        if (size !== compressed || localOffset + 30 > start) throw new Error('ZIP 条目大小无效。');
        const localBytes = await source.read(localOffset, 30);
        const local = new DataView(localBytes.buffer, localBytes.byteOffset, 30);
        const localNameLength = local.getUint16(26, true);
        const localExtraLength = local.getUint16(28, true);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        if (dataStart + size > start) throw new Error('ZIP 文件内容不完整。');
        const fields = await source.read(localOffset + 30, localNameLength + localExtraLength);
        if (local.getUint32(0, true) !== 0x04034b50 || local.getUint16(6, true) !== flags || local.getUint16(8, true) !== method
            || decoder.decode(fields.subarray(0, localNameLength)) !== name) throw new Error('ZIP 本地头信息不一致。');
        let dataEnd = dataStart + size;
        if (flags & 8) {
            const localSizes = sizes64(fields.subarray(localNameLength), [local.getUint32(22, true), local.getUint32(18, true)]);
            if (![0, crc].includes(local.getUint32(14, true)) || localSizes.some(value => value !== 0 && value !== size)) throw new Error('ZIP 条目信息不一致。');
            const wide = rawSize === 0xffffffff || rawCompressed === 0xffffffff
                || local.getUint32(18, true) === 0xffffffff || local.getUint32(22, true) === 0xffffffff;
            const descriptorBytes = await source.read(dataEnd, wide ? 24 : 16);
            const descriptor = new DataView(descriptorBytes.buffer, descriptorBytes.byteOffset, descriptorBytes.length);
            if (descriptor.getUint32(0, true) !== 0x08074b50 || descriptor.getUint32(4, true) !== crc
                || (wide ? number64(descriptor, 8) : descriptor.getUint32(8, true)) !== size
                || (wide ? number64(descriptor, 16) : descriptor.getUint32(12, true)) !== size) throw new Error('ZIP 数据描述符无效。');
            dataEnd += descriptorBytes.length;
            if (dataEnd > start) throw new Error('ZIP 数据描述符越界。');
        } else {
            const localSizes = sizes64(fields.subarray(localNameLength), [local.getUint32(22, true), local.getUint32(18, true)]);
            if (local.getUint32(14, true) !== crc || localSizes.some(value => value !== size)) throw new Error('ZIP 条目信息不一致。');
        }
        const data = source.slice(dataStart, size);
        data.checksum = crc;
        ranges.push({ start: localOffset, end: dataEnd });
        entries.push({ name, data });
        offset = next;
    }
    if (offset !== bytes.length) throw new Error('ZIP 目录大小无效。');
    ranges.sort((a, b) => a.start - b.start);
    if (ranges.some((range, index) => index && range.start < ranges[index - 1].end)) throw new Error('ZIP 文件条目重叠。');
    return entries;
}
