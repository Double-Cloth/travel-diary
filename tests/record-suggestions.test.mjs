import test from 'node:test';
import assert from 'node:assert/strict';
import { getRecordAutofill, getRecordOptions, suggestedTripId } from '../js/record-suggestions.mjs';

const countries = [
    { code: 'CN', name_zh: '中国', aliases: ['中华人民共和国'] },
    { code: 'JP', name_zh: '日本', aliases: [] }
];
const records = [
    { date: '2026-07-11', country_code: 'CN', country: '中国', admin_area: '江苏省', admin_area_type: '省', locality: '苏州市', locality_type: '城市', trip_id: '2026-07-jiangsu' },
    { date: '2024-11-03', countryCode: 'CN', country: '中华人民共和国', adminArea: '江苏省', adminAreaType: '省', locality: '苏州市', localityType: '城市', tripId: '2024-11-jiangsu' },
    { date: '2026-03-01', country_code: 'CN', country: '中国', admin_area: '云南省', locality: '昆明市' }
];

test('已知目的地自动补全国家、行政区和类型，并兼容运行时字段名', () => {
    assert.deepEqual(getRecordAutofill({ country_code: 'CN', locality: '苏州市' }, countries, records), {
        country: '中国',
        admin_area: '江苏省',
        admin_area_type: '省',
        locality_type: '城市'
    });
});

test('新地点根据名称后缀补全可靠类型，不猜测行政区', () => {
    assert.deepEqual(getRecordAutofill({ country_code: 'CN', admin_area: '广西壮族自治区', locality: '涠洲岛' }, countries, records), {
        country: '中国',
        admin_area_type: '自治区',
        locality_type: '岛屿'
    });
});

test('同一国家内的同名目的地跨行政区时不自动选择最近一项', () => {
    const ambiguousRecords = [
        ...records,
        { date: '2026-08-01', country_code: 'CN', admin_area: '另一省', locality: '苏州市', locality_type: '景区' }
    ];
    assert.deepEqual(getRecordAutofill({ country_code: 'CN', locality: '苏州市' }, countries, ambiguousRecords), {
        country: '中国',
        locality_type: '城市'
    });
});

test('地点候选按当前国家和行政区过滤', () => {
    const options = getRecordOptions({ country_code: 'CN', admin_area: '江苏省' }, countries, records);
    assert.deepEqual(options.locality, ['苏州市']);
    assert.deepEqual(options.trip_id, ['2026-07-jiangsu', '2024-11-jiangsu']);
    assert.ok(options.country.includes('中华人民共和国'));
});

test('旅行标识建议使用完整日期和目的地', () => {
    assert.equal(suggestedTripId({ date: '2026-09-11', admin_area: '江苏省', locality: '苏州市' }), '2026-09-11-suzhou');
    assert.equal(suggestedTripId({ date: '2026-09-11', locality: '涠洲岛' }), '2026-09-11-weizhoudao');
    assert.equal(suggestedTripId({ date: '2026-09-11', admin_area: '江苏省' }), '2026-09-11-jiangsu');
    assert.equal(suggestedTripId({ date: '', locality: '苏州市' }), '');
});

test('旅行标识随日期和可靠地点自动补全', () => {
    assert.equal(getRecordAutofill({ date: '2026-09-11', country_code: 'CN', admin_area: '江苏省' }, countries, records).trip_id, '2026-09-11-jiangsu');
    assert.equal(getRecordAutofill({ date: '2026-09-11', country_code: 'CN', locality: '苏州市' }, countries, records).trip_id, '2026-09-11-suzhou');
    assert.equal(getRecordAutofill({ date: '2026-09-11', country_code: 'CN' }, countries, records).trip_id, undefined);
});

test('旅行标识候选列出最近五个不重复的已有行程', () => {
    const recentRecords = [
        { date: '2026-09-10', country_code: 'CN', admin_area: '湖南省', trip_id: 'trip-a' },
        { date: '2026-09-09', country_code: 'JP', admin_area: '东京都', trip_id: 'trip-b' },
        { date: '2026-09-08', country_code: 'CN', admin_area: '湖南省', trip_id: 'trip-a' },
        { date: '2026-09-07', country_code: 'CN', admin_area: '云南省', trip_id: 'trip-c' },
        { date: '2026-09-06', country_code: 'CN', admin_area: '山东省', trip_id: 'trip-d' },
        { date: '2026-09-05', country_code: 'CN', admin_area: '陕西省', trip_id: 'trip-e' },
        { date: '2026-09-04', country_code: 'CN', admin_area: '浙江省', trip_id: 'trip-f' }
    ];
    const options = getRecordOptions({ country_code: 'CN', admin_area: '江苏省' }, countries, [...records, ...recentRecords]);
    assert.deepEqual(options.trip_id, ['trip-a', 'trip-b', 'trip-c', 'trip-d', 'trip-e']);
});
