import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getRouteMapCountRange,
    getRouteMapRandomCount
} from '../js/route-map.mjs';

test('随机路线图按屏幕宽度提供不同抽取区间', () => {
    assert.deepEqual(getRouteMapCountRange(360, 6), { min: 2, max: 3 });
    assert.deepEqual(getRouteMapCountRange(640, 6), { min: 3, max: 6 });
    assert.deepEqual(getRouteMapCountRange(900, 6), { min: 4, max: 7 });
    assert.deepEqual(getRouteMapCountRange(1280, 6), { min: 5, max: 8 });
});

test('随机路线图抽取数量不会超过可用城市和槽位', () => {
    assert.equal(getRouteMapRandomCount(360, 1, 6, () => 0.99), 1);
    assert.equal(getRouteMapRandomCount(1280, 4, 6, () => 0.99), 4);
    assert.equal(getRouteMapRandomCount(1280, 12, 6, () => 0.99), 6);
});

test('随机路线图在同一屏幕区间内随机选择合理数量', () => {
    assert.equal(getRouteMapRandomCount(640, 8, 6, () => 0), 3);
    assert.equal(getRouteMapRandomCount(640, 8, 6, () => 0.99), 4);
    assert.equal(getRouteMapRandomCount(1280, 8, 6, () => 0), 5);
    assert.equal(getRouteMapRandomCount(1280, 8, 6, () => 0.99), 6);
});
