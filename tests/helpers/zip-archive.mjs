// 仅为兼容性测试生成旧版 ZIP，运行时统一使用 zip-stream.mjs。
const encoder = new TextEncoder();

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
        if (localOffset > 0xffffffff) throw new Error('ZIP 总大小超出支持范围。');
    }

    const central = concat(centralParts);
    if (localOffset + central.length > 0xffffffff) throw new Error('ZIP 总大小超出支持范围。');
    const end = header(22);
    end.view.setUint32(0, 0x06054b50, true);
    end.view.setUint16(8, entries.length, true);
    end.view.setUint16(10, entries.length, true);
    end.view.setUint32(12, central.length, true);
    end.view.setUint32(16, localOffset, true);
    return concat([...localParts, central, end.bytes]);
}
