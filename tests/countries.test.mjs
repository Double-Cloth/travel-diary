import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const countryCatalog = JSON.parse(await readFile(new URL('../data/countries.json', import.meta.url), 'utf8'));
const countries = countryCatalog.countries;
const dataJs = await readFile(new URL('../js/data.js', import.meta.url), 'utf8');
const locationJs = await readFile(new URL('../js/location.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('国家目录覆盖 ISO 3166-1 的 249 个当前分配代码', () => {
    assert.equal(countryCatalog.standard, 'ISO 3166-1');
    assert.equal(countryCatalog.country_count, 249);
    assert.equal(countries.length, 249);

    const alpha2Codes = new Set(countries.map(country => country.code));
    const alpha3Codes = new Set(countries.map(country => country.alpha3));
    const numericCodes = new Set(countries.map(country => country.numeric));

    assert.equal(alpha2Codes.size, 249);
    assert.equal(alpha3Codes.size, 249);
    assert.equal(numericCodes.size, 249);
    assert.equal(alpha2Codes.has('CN'), true);
    assert.equal(alpha2Codes.has('US'), true);
    assert.equal(alpha2Codes.has('HK'), true);
    assert.equal(alpha2Codes.has('MO'), true);
    assert.equal(alpha2Codes.has('PS'), true);
    assert.equal(alpha2Codes.has('XK'), false);
});

test('每个国家都有多语言名称和行政区回退信息', () => {
    countries.forEach((country) => {
        assert.match(country.code, /^[A-Z]{2}$/);
        assert.match(country.alpha3, /^[A-Z]{3}$/);
        assert.match(country.numeric, /^\d{3}$/);
        assert.ok(country.name_zh, `${country.code} should have a Chinese name`);
        assert.ok(country.name_en, `${country.code} should have an English name`);
        assert.ok(country.admin_area_label, `${country.code} should have an admin area label`);
        assert.ok(country.admin_area_option, `${country.code} should have an admin area option`);
        assert.ok(Array.isArray(country.aliases));
        assert.equal(typeof country.admin_area_optional, 'boolean');
        assert.equal(typeof country.domestic, 'boolean');
    });
});

test('国家目录记录来源版本和常见国家的本地行政区称谓', () => {
    assert.equal(countryCatalog.source.localized_names, 'Unicode CLDR 48.2.1');
    assert.equal(countryCatalog.source.license, 'Unicode License V3');

    const byCode = new Map(countries.map(country => [country.code, country]));
    assert.equal(byCode.get('CN').admin_area_label, '省级行政区');
    assert.equal(byCode.get('US').admin_area_label, '州 / 特区');
    assert.equal(byCode.get('JP').admin_area_label, '都道府县');
    assert.equal(byCode.get('AE').admin_area_label, '酋长国');
    assert.equal(byCode.get('SG').admin_area_optional, true);
    assert.equal(byCode.get('AQ').admin_area_optional, true);
});

test('运行时从独立 JSON 加载国家目录而不是维护内联国家表', () => {
    assert.match(dataJs, /data\/countries\.json/);
    assert.match(dataJs, /configureCountryCatalog\(countryCatalog\)/);
    assert.doesNotMatch(locationJs, /AU:\s*\{\s*names:/);
    assert.doesNotMatch(locationJs, /US:\s*\{\s*names:/);
    assert.equal(packageJson.scripts.countries, 'node scripts/update-countries.mjs');
});
