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
        countryCode: 'CN',
        adminArea: '云南省',
        locality: '昆明市',
        adminAreaKey: 'CN|云南省',
        locationKey: 'CN|云南省|昆明市',
        isRepeated: false
    },
    {
        date: '2024-01-11',
        country: '中国',
        countryCode: 'CN',
        adminArea: '云南省',
        locality: '昆明市',
        adminAreaKey: 'CN|云南省',
        locationKey: 'CN|云南省|昆明市',
        isRepeated: true
    },
    {
        date: '2025-03-12',
        country: '中国',
        countryCode: 'CN',
        adminArea: '江苏省',
        locality: '苏州市',
        adminAreaKey: 'CN|江苏省',
        locationKey: 'CN|江苏省|苏州市',
        isRepeated: false
    },
    {
        date: '2025-01-20',
        country: '中国',
        countryCode: 'CN',
        adminArea: '浙江省',
        locality: '杭州市',
        adminAreaKey: 'CN|浙江省',
        locationKey: 'CN|浙江省|杭州市',
        isRepeated: false
    }
];

test('统计筛选后的记录集合', () => {
    assert.deepEqual(buildRecordSetSnapshot(records), {
        count: 4,
        localityCount: 3,
        adminAreaCount: 3,
        firstDate: '2024-01-01',
        latestDate: '2025-03-12'
    });
});

test('统计复访地点、活跃周期和最长记录间隔', () => {
    assert.deepEqual(deriveOverviewAnalytics(records), {
        repeatCount: 1,
        repeatLocationCount: 1,
        activeYearCount: 2,
        activeMonthCount: 3,
        activeMonthCapacity: 15,
        longestGap: {
            days: 375,
            from: '2024-01-11',
            to: '2025-01-20'
        }
    });
});

test('活跃月份分母按首条记录日期到统计截止日期计算', () => {
    assert.deepEqual(deriveOverviewAnalytics([
        {
            date: '2024-07-08',
            country: '中国',
            countryCode: 'CN',
            adminArea: '云南省',
            locality: '玉溪市',
            locationKey: 'CN|云南省|玉溪市',
            isRepeated: false
        },
        {
            date: '2026-07-02',
            country: '中国',
            countryCode: 'CN',
            adminArea: '山东省',
            locality: '济南市',
            locationKey: 'CN|山东省|济南市',
            isRepeated: false
        }
    ], '2026-07-11'), {
        repeatCount: 0,
        repeatLocationCount: 0,
        activeYearCount: 2,
        activeMonthCount: 2,
        activeMonthCapacity: 25,
        longestGap: {
            days: 724,
            from: '2024-07-08',
            to: '2026-07-02'
        }
    });
});

test('空数据和无效日期不会产生错误统计', () => {
    assert.deepEqual(buildRecordSetSnapshot([]), {
        count: 0,
        localityCount: 0,
        adminAreaCount: 0,
        firstDate: '',
        latestDate: ''
    });
    assert.deepEqual(deriveOverviewAnalytics([{ date: '', isRepeated: false }]), {
        repeatCount: 0,
        repeatLocationCount: 0,
        activeYearCount: 0,
        activeMonthCount: 0,
        activeMonthCapacity: 0,
        longestGap: null
    });
    assert.deepEqual(deriveOverviewAnalytics([{ date: '2024-13-99', isRepeated: false }]), {
        repeatCount: 0,
        repeatLocationCount: 0,
        activeYearCount: 0,
        activeMonthCount: 0,
        activeMonthCapacity: 0,
        longestGap: null
    });
});
