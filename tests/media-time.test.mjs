import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteSource } from '../js/zip-stream.mjs';
import { readMediaTime, fetchMediaTime, sortMediaByTime } from '../js/media-time.mjs';
import { atom, exif, jpeg, movie } from './helpers/media-metadata.mjs';

test('JPEG 的大小端 EXIF 原始时间优先于数字化时间，并处理时区与毫秒', async () => {
    for (const little of [true, false]) {
        assert.equal(await readMediaTime(jpeg(exif('2026:11:03 12:30:00', { little, offset: '+08:00', subsecond: '123', fallback: '2020:01:01 00:00:00' }))), Date.parse('2026-11-03T04:30:00.123Z'));
    }
    assert.equal(await readMediaTime(jpeg(exif('2026:11:03 12:30:00'))), new Date(2026, 10, 3, 12, 30).getTime());
});

test('空时间、损坏日期不会被误认为拍摄时间，有效备用创建时间可用', async () => {
    for (const date of ['0000:00:00 00:00:00', '2026:02:30 12:00:00', '2026:01:01 24:00:00', 'invalid']) {
        assert.equal(await readMediaTime(jpeg(exif(date))), null);
    }
    assert.equal(await readMediaTime(jpeg(exif('invalid', { fallback: '2025:01:02 03:04:05' }))), new Date(2025, 0, 2, 3, 4, 5).getTime());
    assert.equal(await readMediaTime(Buffer.from('GIF89a000000')), null);
    assert.equal(await readMediaTime(new Blob(['nothing'])), null);
});

test('PNG 与 WebP 中的 EXIF 及 JPEG 的 XMP 均能提取时间', async () => {
    const metadata = exif();
    const chunk = Buffer.alloc(8); chunk.writeUInt32BE(metadata.length); chunk.write('eXIf', 4);
    assert.equal(await readMediaTime(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk, metadata, Buffer.alloc(4)])), new Date(2026, 10, 3, 12, 30).getTime());
    const webp = Buffer.alloc(20); webp.write('RIFF'); webp.write('WEBPEXIF', 8); webp.writeUInt32LE(metadata.length, 16);
    assert.equal(await readMediaTime(Buffer.concat([webp, metadata])), new Date(2026, 10, 3, 12, 30).getTime());
    const xmp = Buffer.from('<rdf xmp:CreateDate="2026-11-02T12:30:00Z"/>');
    const header = Buffer.from([255, 216, 255, 225, 0, 0]); header.writeUInt16BE(xmp.length + 2, 4);
    assert.equal(await readMediaTime(Buffer.concat([header, xmp])), Date.parse('2026-11-02T12:30:00Z'));
});

test('MP4 / MOV 的 32 位和 64 位时间使用 1904 纪元，空创建时间返回无时间', async () => {
    for (const version of [0, 1]) assert.equal(await readMediaTime(movie('2026-11-03T12:30:00Z', version)), Date.parse('2026-11-03T12:30:00Z'));
    assert.equal(await readMediaTime(movie('1904-01-01T00:00:00Z')), null);
});

test('QuickTime 拍摄日期优先于容器创建时间', async () => {
    const key = atom('mdta', Buffer.from('com.apple.quicktime.creationdate'));
    const keys = atom('keys', Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), key);
    const item = atom('\0\0\0\x01', atom('data', Buffer.alloc(8), Buffer.from('2020-01-02T03:04:05+08:00')));
    const meta = atom('meta', Buffer.alloc(4), keys, atom('ilst', item));
    const bytes = Buffer.concat([movie(), atom('moov', meta)]);
    assert.equal(await readMediaTime(bytes), Date.parse('2020-01-02T03:04:05+08:00'));
});

test('大型视频跳过 mdat 内容，支持扩展长度和位于尾部的 moov', async () => {
    const prefix = movie().subarray(0, 16);
    const end = movie().subarray(16);
    const mdatSize = 10 * 1024 * 1024 * 1024;
    const mdat = Buffer.alloc(16); mdat.writeUInt32BE(1); mdat.write('mdat', 4); mdat.writeBigUInt64BE(BigInt(mdatSize), 8);
    let read = 0;
    const source = new ByteSource(prefix.length + mdatSize + end.length, async (offset, length) => {
        read += length;
        if (offset < prefix.length) return prefix.subarray(offset, offset + length);
        if (offset === prefix.length) return mdat.subarray(0, length);
        assert.ok(offset >= prefix.length + mdatSize, '不能读取视频内容');
        return end.subarray(offset - prefix.length - mdatSize, offset + length - prefix.length - mdatSize);
    });
    assert.equal(await readMediaTime(source), Date.parse('2026-11-03T12:30:00Z'));
    assert.ok(read < 200);
});

test('WebM DateUTC 支持 2001 纪元之前的有符号日期与未知 Segment 长度', async () => {
    const date = Buffer.alloc(8); date.writeBigInt64BE(-1000000000n);
    const info = Buffer.concat([Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x8b, 0x44, 0x61, 0x88]), date]);
    const bytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0xff]), info]);
    assert.equal(await readMediaTime(bytes), Date.UTC(2001, 0, 1) - 1000);
});

test('按时间升序，同时间按文件名，无时间置后并按自然文件名排序，保持原数组', () => {
    const items = ['10.jpg', '2.jpg', 'late.jpg', 'early.jpg', 'same.jpg'].map(name => ({ key: name, name }));
    const times = new Map([['late.jpg', 20], ['early.jpg', 10], ['same.jpg', 10], ['10.jpg', null]]);
    assert.deepEqual(sortMediaByTime(items, times).map(item => item.name), ['early.jpg', 'same.jpg', 'late.jpg', '2.jpg', '10.jpg']);
    assert.equal(items[0].name, '10.jpg');
});

test('已有媒体使用 HEAD 和 Range，支持小文件静态服务忽略 Range', async t => {
    const bytes = movie();
    for (const range of [true, false]) {
        const calls = [];
        t.mock.method(globalThis, 'fetch', async (_url, options) => {
            calls.push(options);
            if (options.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': bytes.length } });
            return new Response(bytes, { status: range ? 206 : 200, headers: range ? { 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` } : {} });
        });
        assert.equal(await fetchMediaTime('/video.mp4'), Date.parse('2026-11-03T12:30:00Z'));
        assert.equal(calls.length, 2);
        assert.equal(calls[1].headers.Range, `bytes=0-${bytes.length - 1}`);
        t.mock.restoreAll();
    }
});

test('无法分段读取大文件时取消下载，缺失文件与取消不会产生时间', async t => {
    let cancelled = false;
    t.mock.method(globalThis, 'fetch', async (_url, options) => options.method === 'HEAD'
        ? new Response(null, { headers: { 'Content-Length': 10 * 1024 * 1024 } })
        : new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await assert.rejects(fetchMediaTime('/large.mp4'), /无法分段读取/);
    assert.equal(cancelled, true);
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
    await assert.rejects(fetchMediaTime('/missing.jpg'), /无法读取/);
    t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('cancelled', 'AbortError'); });
    await assert.rejects(fetchMediaTime('/cancel.jpg', AbortSignal.abort()), { name: 'AbortError' });
});

test('损坏的循环块和越界 EXIF 有界退出，不读取整段媒体', async () => {
    const invalid = jpeg(exif()); invalid.writeUInt32LE(0xffffffff, 20);
    assert.equal(await readMediaTime(invalid), null);
    const bytes = atom('ftyp', Buffer.from('isom0000'));
    const repeat = atom('free');
    const source = new ByteSource(1024 * 1024 * 1024, async (offset, length) => {
        if (!offset) return bytes.subarray(0, length);
        const block = Buffer.alloc(length);
        for (let index = 0; index < length; index++) block[index] = repeat[index % repeat.length];
        return block;
    });
    await assert.rejects(readMediaTime(source), /元数据过大或已损坏/);
});
