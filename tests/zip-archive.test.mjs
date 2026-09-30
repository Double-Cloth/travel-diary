import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip, readZip } from '../js/zip-archive.mjs';

function archive() {
    const bytes = createZip([{ name: 'draft.json', data: '草稿内容' }]);
    const view = new DataView(bytes.buffer);
    const end = bytes.length - 22;
    const central = view.getUint32(end + 16, true);
    return { bytes, view, end, central };
}

test('ZIP 正常往返，并允许合法注释中的结束签名', () => {
    const { bytes, end } = archive();
    assert.equal(new TextDecoder().decode(readZip(bytes)[0].data), '草稿内容');
    const comment = new Uint8Array(30);
    new DataView(comment.buffer).setUint32(0, 0x06054b50, true);
    const commented = new Uint8Array(bytes.length + comment.length);
    commented.set(bytes);
    commented.set(comment, bytes.length);
    new DataView(commented.buffer).setUint16(end + 20, comment.length, true);
    assert.equal(readZip(commented).length, 1);
});

test('ZIP 拒绝目录边界、分卷、条目数量和本地头不一致', () => {
    const mutations = [
        ({ view, end }) => view.setUint16(end + 4, 1, true),
        ({ view, end }) => view.setUint16(end + 8, 2, true),
        ({ view, end }) => view.setUint32(end + 12, 1, true),
        ({ view, central }) => view.setUint16(central + 30, 65535, true),
        ({ view }) => view.setUint32(14, 0, true),
        ({ view }) => view.setUint32(18, 0, true),
        ({ view, central }) => view.setUint16(central + 8, 8, true),
        ({ view, central }) => view.setUint16(central + 34, 1, true)
    ];
    for (const mutate of mutations) {
        const value = archive();
        mutate(value);
        assert.throws(() => readZip(value.bytes), /ZIP/);
    }
    const { bytes } = archive();
    assert.throws(() => readZip(bytes.subarray(0, bytes.length - 1)), /ZIP/);
    const appended = new Uint8Array(bytes.length + 1);
    appended.set(bytes);
    assert.throws(() => readZip(appended), /ZIP/);
});
