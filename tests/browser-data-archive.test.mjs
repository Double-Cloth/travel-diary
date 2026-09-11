import assert from 'node:assert/strict';
import test from 'node:test';
import { collectReferencedDataFiles, createBrowserDataArchive } from '../js/browser-data-archive.mjs';
import { readZip } from '../js/zip-archive.mjs';

test('静态页面根据旅行索引收集正文、照片、头像和索引', () => {
    const paths = collectReferencedDataFiles([{
        desc_md: 'data/travel-diary/2026/2026-09-11-suzhou.md',
        photo_folder: 'data/photos/suzhou',
        photos: ['bridge.jpg', 'bridge.jpg']
    }]);
    assert.deepEqual(paths, [
        'data/photos/suzhou/bridge.jpg',
        'data/profile/profile-picture.png',
        'data/travel_data.json',
        'data/travel-diary/2026/2026-09-11-suzhou.md'
    ]);
});

test('静态页面可生成包含独立二进制照片的全部数据 ZIP', async () => {
    const records = [{
        desc_md: 'data/travel-diary/2026/2026-09-11-suzhou.md',
        photo_folder: 'data/photos/suzhou',
        photos: ['bridge.jpg']
    }];
    const files = new Map([
        ['data/travel_data.json', new TextEncoder().encode(JSON.stringify(records))],
        ['data/profile/profile-picture.png', Uint8Array.of(137, 80, 78, 71)],
        ['data/travel-diary/2026/2026-09-11-suzhou.md', new TextEncoder().encode('# Suzhou')],
        ['data/photos/suzhou/bridge.jpg', Uint8Array.of(255, 216, 255, 217)]
    ]);
    const fetchImpl = async url => {
        const path = new URL(url).pathname.slice(1);
        const data = files.get(path);
        return {
            ok: Boolean(data),
            status: data ? 200 : 404,
            arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        };
    };

    const archive = await createBrowserDataArchive('https://example.test/', fetchImpl);
    const entries = readZip(archive);
    assert.deepEqual(entries.map(entry => entry.name), [...files.keys()].sort((a, b) => a.localeCompare(b, 'en')));
    assert.deepEqual(entries.find(entry => entry.name.endsWith('bridge.jpg')).data, Uint8Array.of(255, 216, 255, 217));
});

test('静态导出拒绝越界数据路径', () => {
    assert.throws(() => collectReferencedDataFiles([{ desc_md: '../secret.md' }]), /无效数据路径/);
});
