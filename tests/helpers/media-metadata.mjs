export function exif(date = '2026:11:03 12:30:00', { little = true, offset = '', subsecond = '', fallback = '' } = {}) {
    const tags = [[0x9003, date], [0x9011, offset], [0x9291, subsecond], [0x9004, fallback]].filter(([, value]) => value);
    const bytes = Buffer.alloc(512);
    const u16 = (position, value) => little ? bytes.writeUInt16LE(value, position) : bytes.writeUInt16BE(value, position);
    const u32 = (position, value) => little ? bytes.writeUInt32LE(value, position) : bytes.writeUInt32BE(value, position);
    bytes.write(little ? 'II' : 'MM');
    u16(2, 42); u32(4, 8);
    u16(8, 1); u16(10, 0x8769); u16(12, 4); u32(14, 1); u32(18, 26);
    u16(26, tags.length);
    let cursor = 28 + tags.length * 12 + 4;
    tags.forEach(([tag, value], index) => {
        const entry = 28 + index * 12;
        u16(entry, tag); u16(entry + 2, 2); u32(entry + 4, value.length + 1);
        if (value.length + 1 <= 4) bytes.write(value, entry + 8);
        else { u32(entry + 8, cursor); bytes.write(value, cursor); cursor += value.length + 1; }
    });
    return bytes.subarray(0, cursor);
}

export function jpeg(metadata = exif()) {
    const data = Buffer.concat([Buffer.from('Exif\0\0'), metadata]);
    const header = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
    header.writeUInt16BE(data.length + 2, 4);
    return Buffer.concat([header, data, Buffer.from([0xff, 0xd9])]);
}

export function atom(kind, ...contents) {
    const payload = Buffer.concat(contents);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(payload.length + 8); header.write(kind, 4, 'latin1');
    return Buffer.concat([header, payload]);
}

export function movie(date = '2026-11-03T12:30:00Z', version = 0) {
    const header = Buffer.alloc(24);
    header[0] = version;
    const seconds = (Date.parse(date) - Date.UTC(1904, 0, 1)) / 1000;
    if (version === 1) header.writeBigUInt64BE(BigInt(seconds), 4);
    else header.writeUInt32BE(seconds, 4);
    return Buffer.concat([atom('ftyp', Buffer.from('isom0000')), atom('moov', atom('mvhd', header))]);
}
