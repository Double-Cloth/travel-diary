import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const { moveMediaGroup } = await loadBrowserModule(new URL('../js/record-editor.js', import.meta.url), '\nexport { moveMediaGroup };');

test('单项可以拖到首位、末位和中间', () => {
    const order = ['a', 'b', 'c', 'd'];
    assert.deepEqual(moveMediaGroup(order, new Set(['d']), 'a'), ['d', 'a', 'b', 'c']);
    assert.deepEqual(moveMediaGroup(order, new Set(['a'])), ['b', 'c', 'd', 'a']);
    assert.deepEqual(moveMediaGroup(order, new Set(['d']), 'c'), ['a', 'b', 'd', 'c']);
    assert.deepEqual(order, ['a', 'b', 'c', 'd']);
});

test('不连续多选合并拖动，保留组内和未选文件的相对顺序', () => {
    assert.deepEqual(moveMediaGroup(['a', 'b', 'c', 'd', 'e'], new Set(['d', 'b']), 'a'), ['b', 'd', 'a', 'c', 'e']);
    assert.deepEqual(moveMediaGroup(['a', 'b', 'c', 'd', 'e'], new Set(['d', 'b'])), ['a', 'c', 'e', 'b', 'd']);
});

test('混合已有、新增及跨类型选择只移动当前列表中的文件', () => {
    const keys = new Set(['upload:1', 'photo:1', 'video:1']);
    assert.deepEqual(moveMediaGroup(['photo:1', 'photo:2', 'upload:1', 'photo:3'], keys, 'photo:3'), ['photo:2', 'photo:1', 'upload:1', 'photo:3']);
    assert.deepEqual(moveMediaGroup(['video:2', 'video:1'], keys, 'video:2'), ['video:1', 'video:2']);
});

test('全选、空选择及无效落点保持顺序', () => {
    const order = ['a', 'b'];
    assert.deepEqual(moveMediaGroup(order, new Set(order)), order);
    assert.deepEqual(moveMediaGroup(order, new Set(), 'a'), order);
    assert.deepEqual(moveMediaGroup(order, new Set(['a']), 'missing'), order);
});
