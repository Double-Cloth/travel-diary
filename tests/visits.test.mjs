import test from 'node:test';
import assert from 'node:assert/strict';

import {
    countDistinctVisits,
    getScopedVisitKey,
    getVisitKey
} from '../js/visits.mjs';

test('同一次旅行的多座城市共享同一个到访标识', () => {
    const nanjing = {
        trip_id: '2024-11-jiangsu',
        desc_md: 'data/travel-diary/2024/2024-11-02-nanjing.md'
    };
    const suzhou = {
        trip_id: '2024-11-jiangsu',
        desc_md: 'data/travel-diary/2024/2024-11-03-suzhou.md'
    };

    assert.equal(getVisitKey(nanjing), getVisitKey(suzhou));
    assert.equal(countDistinctVisits([nanjing, suzhou]), 1);
});

test('未填写 trip_id 的旧记录仍分别计算到访', () => {
    const records = [
        { desc_md: 'data/travel-diary/2024/2024-11-02-nanjing.md' },
        { desc_md: 'data/travel-diary/2024/2024-11-03-suzhou.md' }
    ];

    assert.equal(countDistinctVisits(records), 2);
    assert.notEqual(getVisitKey(records[0]), getVisitKey(records[1]));
});

test('同一旅行在不同地点范围内分别形成一次到访', () => {
    const record = { trip_id: '2026-07-malaysia' };

    assert.notEqual(
        getScopedVisitKey(record, 'MY|吉隆坡联邦直辖区'),
        getScopedVisitKey(record, 'MY|马六甲州')
    );
});
