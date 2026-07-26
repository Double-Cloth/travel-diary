import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    configureCountryCatalog,
    formatLocationText,
    getAdminAreaFilterLabel,
    getConfiguredCountryCount,
    getCountryLocationLabels,
    normalizeTravelLocation
} from '../js/location.mjs';

const countryCatalog = JSON.parse(await readFile(new URL('../data/countries.json', import.meta.url), 'utf8'));
configureCountryCatalog(countryCatalog);

test('从独立目录加载完整国家配置', () => {
    assert.equal(getConfiguredCountryCount(), 249);
});

test('将新字段规范化为国家、一级行政区和地点', () => {
    const location = normalizeTravelLocation({
        country: '美国',
        country_code: 'US',
        admin_area: 'California',
        admin_area_type: '州',
        locality: 'San Francisco'
    });

    assert.equal(location.countryCode, 'US');
    assert.equal(location.countryKey, 'US');
    assert.equal(location.adminArea, 'California');
    assert.equal(location.adminAreaType, '州');
    assert.equal(location.locality, 'San Francisco');
    assert.equal(location.adminAreaKey, 'US|California');
    assert.equal(location.locationKey, 'US|California|San Francisco');
});

test('兼容旧 province 和 city 字段', () => {
    const location = normalizeTravelLocation({
        country: '中国',
        province: '云南省',
        city: '昆明市'
    });

    assert.equal(location.countryCode, 'CN');
    assert.equal(location.adminArea, '云南省');
    assert.equal(location.adminAreaType, '省');
    assert.equal(location.locality, '昆明市');
    assert.equal(location.locationKey, 'CN|云南省|昆明市');
});

test('允许城市国家省略一级行政区', () => {
    const location = normalizeTravelLocation({
        country: '新加坡',
        country_code: 'SG',
        locality: '新加坡'
    });

    assert.equal(location.adminArea, '');
    assert.equal(location.locality, '新加坡');
    assert.equal(location.adminAreaKey, '');
    assert.equal(location.locationKey, 'SG|新加坡');
    assert.equal(formatLocationText(location), '新加坡');
});

test('按国家提供不同的一级行政区名称并支持未知国家回退', () => {
    assert.equal(getCountryLocationLabels({ country_code: 'US' }).adminArea, '州 / 特区');
    assert.equal(getCountryLocationLabels({ country_code: 'JP' }).adminArea, '都道府县');
    assert.equal(getCountryLocationLabels({ country: '加拿大' }).adminArea, '省 / 地区');
    assert.equal(getCountryLocationLabels({ country: '亚特兰蒂斯' }).adminArea, '一级行政区');
});

test('可通过中英文名称、三位代码和常用别名识别国家代码', () => {
    assert.equal(normalizeTravelLocation({ country: 'United Kingdom', locality: 'London' }).countryCode, 'GB');
    assert.equal(normalizeTravelLocation({ country: 'GBR', locality: 'London' }).countryCode, 'GB');
    assert.equal(normalizeTravelLocation({ country: 'UK', locality: 'London' }).countryCode, 'GB');
    assert.equal(normalizeTravelLocation({ country: '中国香港特别行政区', locality: '香港' }).countryCode, 'HK');
});

test('筛选标签随所选国家变化，多国视图使用通用名称', () => {
    const records = [
        normalizeTravelLocation({ country: '中国', country_code: 'CN', admin_area: '云南省', locality: '昆明市' }),
        normalizeTravelLocation({ country: '美国', country_code: 'US', admin_area: 'California', locality: 'San Francisco' })
    ];

    assert.equal(getAdminAreaFilterLabel(records, 'all'), '一级行政区');
    assert.equal(getAdminAreaFilterLabel(records, 'CN'), '省级行政区');
    assert.equal(getAdminAreaFilterLabel(records, 'US'), '州 / 特区');
});

test('不同国家的同名行政区和目的地生成不同筛选键', () => {
    const unitedStates = normalizeTravelLocation({
        country: '美国',
        country_code: 'US',
        admin_area: 'Georgia',
        locality: 'Springfield'
    });
    const anotherCountry = normalizeTravelLocation({
        country: '格鲁吉亚',
        country_code: 'GE',
        admin_area: 'Georgia',
        locality: 'Springfield'
    });

    assert.notEqual(unitedStates.adminAreaKey, anotherCountry.adminAreaKey);
    assert.notEqual(unitedStates.locationKey, anotherCountry.locationKey);
});
