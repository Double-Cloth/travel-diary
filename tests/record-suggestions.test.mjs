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

test('候选项按当前国家和行政区过滤，旅行标识保持为用户选择', () => {
    const options = getRecordOptions({ country_code: 'CN', admin_area: '江苏省' }, countries, records);
    assert.deepEqual(options.locality, ['苏州市']);
    assert.deepEqual(options.trip_id, ['2026-07-jiangsu', '2024-11-jiangsu']);
    assert.ok(options.country.includes('中华人民共和国'));
    assert.equal(getRecordAutofill({ country_code: 'CN', admin_area: '江苏省' }, countries, records).trip_id, undefined);
});

test('旅行标识建议使用年月和已填地点', () => {
    assert.equal(suggestedTripId({ date: '2026-09-11', admin_area: '江苏省', locality: '苏州市' }), '2026-09-江苏省');
    assert.equal(suggestedTripId({ date: '2026-09-11', locality: '涠洲岛' }), '2026-09-涠洲岛');
    assert.equal(suggestedTripId({ date: '', locality: '苏州市' }), '');
});
