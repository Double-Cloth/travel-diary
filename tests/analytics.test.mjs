import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildRecordSetSnapshot,
    deriveOverviewAnalytics
} from '../js/analytics.mjs';

const records = [
    {
        date: '2024-01-01',
        country: '中国',
        province: '云南省',
        city: '昆明市',
        locationKey: '中国|云南省|昆明市',
        isRepeated: false
    },
    {
        date: '2024-01-11',
        country: '中国',
        province: '云南省',
        city: '昆明市',
        locationKey: '中国|云南省|昆明市',
        isRepeated: true
    },
    {
        date: '2025-03-12',
        country: '中国',
        province: '江苏省',
        city: '苏州市',
        locationKey: '中国|江苏省|苏州市',
        isRepeated: false
    }
];

test('统计筛选后的记录集合', () => {
    assert.deepEqual(buildRecordSetSnapshot(records), {
        count: 3,
        cityCount: 2,
        provinceCount: 2,
        firstDate: '2024-01-01',
        latestDate: '2025-03-12'
    });
});

test('统计复访、活跃周期和最长记录间隔', () => {
    assert.deepEqual(deriveOverviewAnalytics(records), {
        repeatCount: 1,
        repeatRate: 33,
        activeYearCount: 2,
        activeMonthCount: 2,
        longestGap: {
            days: 426,
            from: '2024-01-11',
            to: '2025-03-12'
        }
    });
});

test('空数据和无效日期不会产生错误统计', () => {
    assert.deepEqual(buildRecordSetSnapshot([]), {
        count: 0,
        cityCount: 0,
        provinceCount: 0,
        firstDate: '',
        latestDate: ''
    });
    assert.deepEqual(deriveOverviewAnalytics([{ date: '', isRepeated: false }]), {
        repeatCount: 0,
        repeatRate: 0,
        activeYearCount: 0,
        activeMonthCount: 0,
        longestGap: null
    });
});
