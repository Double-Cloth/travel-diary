const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    return current >>> 0;
});

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function bytesOf(value) {
    if (typeof value === 'string') return encoder.encode(value);
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError('ZIP 条目内容必须是字符串或字节数组。');
}

function concat(parts) {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output;
}

function dosDateTime(date = new Date()) {
    const year = Math.max(1980, Math.min(2107, date.getFullYear()));
    return {
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
    };
}

function header(length) {
    const bytes = new Uint8Array(length);
    return { bytes, view: new DataView(bytes.buffer) };
}

export function createZip(entries, date = new Date()) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('ZIP 压缩包至少需要一个文件。');
    if (entries.length > 50000) throw new Error('ZIP 压缩包文件数量过多。');
    const seen = new Set();
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    const stamp = dosDateTime(date);

    for (const entry of entries) {
        const name = String(entry?.name || '').replace(/\\/g, '/');
        if (!name || name.startsWith('/') || name.includes('\0') || name.split('/').some(part => !part || part === '.' || part === '..') || seen.has(name)) {
            throw new Error(`ZIP 条目路径无效或重复：${name || '(empty)'}`);
        }
        seen.add(name);
        const nameBytes = encoder.encode(name);
        const data = bytesOf(entry.data);
        if (nameBytes.length > 65535 || data.length > 0xffffffff) throw new Error(`ZIP 条目过大：${name}`);
        const checksum = crc32(data);
        const local = header(30);
        local.view.setUint32(0, 0x04034b50, true);
        local.view.setUint16(4, 20, true);
        local.view.setUint16(6, 0x0800, true);
        local.view.setUint16(8, 0, true);
        local.view.setUint16(10, stamp.time, true);
        local.view.setUint16(12, stamp.date, true);
        local.view.setUint32(14, checksum, true);
        local.view.setUint32(18, data.length, true);
        local.view.setUint32(22, data.length, true);
        local.view.setUint16(26, nameBytes.length, true);
        localParts.push(local.bytes, nameBytes, data);

        const central = header(46);
        central.view.setUint32(0, 0x02014b50, true);
        central.view.setUint16(4, 20, true);
        central.view.setUint16(6, 20, true);
        central.view.setUint16(8, 0x0800, true);
        central.view.setUint16(10, 0, true);
        central.view.setUint16(12, stamp.time, true);
        central.view.setUint16(14, stamp.date, true);
        central.view.setUint32(16, checksum, true);
        central.view.setUint32(20, data.length, true);
        central.view.setUint32(24, data.length, true);
        central.view.setUint16(28, nameBytes.length, true);
        central.view.setUint32(42, localOffset, true);
        centralParts.push(central.bytes, nameBytes);
        localOffset += local.bytes.length + nameBytes.length + data.length;
    }

    const central = concat(centralParts);
    const end = header(22);
    end.view.setUint32(0, 0x06054b50, true);
    end.view.setUint16(8, entries.length, true);
    end.view.setUint16(10, entries.length, true);
    end.view.setUint32(12, central.length, true);
    end.view.setUint32(16, localOffset, true);
    return concat([...localParts, central, end.bytes]);
}

function findEnd(view) {
    const minimum = Math.max(0, view.byteLength - 65557);
    for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
        if (view.getUint32(offset, true) === 0x06054b50) return offset;
    }
    throw new Error('文件不是有效的 ZIP 压缩包。');
}

export function readZip(value) {
    const bytes = bytesOf(value);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const endOffset = findEnd(view);
    const count = view.getUint16(endOffset + 10, true);
    const centralSize = view.getUint32(endOffset + 12, true);
    let offset = view.getUint32(endOffset + 16, true);
    if (count > 50000 || offset + centralSize > endOffset) throw new Error('ZIP 目录大小无效。');
    const entries = [];
    const seen = new Set();

    for (let index = 0; index < count; index += 1) {
        if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 目录已损坏。');
        const flags = view.getUint16(offset + 8, true);
        const method = view.getUint16(offset + 10, true);
        const checksum = view.getUint32(offset + 16, true);
        const compressedSize = view.getUint32(offset + 20, true);
        const size = view.getUint32(offset + 24, true);
        const nameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const localOffset = view.getUint32(offset + 42, true);
        const nameStart = offset + 46;
        const nameEnd = nameStart + nameLength;
        if ((flags & 1) || method !== 0 || compressedSize !== size || nameEnd > bytes.length) {
            throw new Error('仅支持本应用导出的未加密 ZIP 压缩包。');
        }
        const name = decoder.decode(bytes.subarray(nameStart, nameEnd)).replace(/\\/g, '/');
        if (!name || name.startsWith('/') || name.includes('\0') || name.split('/').some(part => !part || part === '.' || part === '..') || seen.has(name)) {
            throw new Error(`ZIP 条目路径无效或重复：${name || '(empty)'}`);
        }
        seen.add(name);
        if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('ZIP 文件条目已损坏。');
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const localFlags = view.getUint16(localOffset + 6, true);
        const localMethod = view.getUint16(localOffset + 8, true);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const dataEnd = dataStart + size;
        const localName = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)).replace(/\\/g, '/');
        if (dataEnd > bytes.length || localFlags !== flags || localMethod !== method || localName !== name) throw new Error('ZIP 文件内容不完整。');
        const data = bytes.slice(dataStart, dataEnd);
        if (crc32(data) !== checksum) throw new Error(`ZIP 文件校验失败：${name}`);
        entries.push({ name, data });
        offset = nameEnd + extraLength + commentLength;
    }
    return entries;
}
