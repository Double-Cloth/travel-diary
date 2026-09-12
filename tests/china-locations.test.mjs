import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const catalog = JSON.parse(await readFile(new URL('../assets/catalogs/china-locations.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const recordEditorJs = await readFile(new URL('../js/record-editor.js', import.meta.url), 'utf8');

test('中国行政区目录记录版本、来源与完整层级数量', () => {
    assert.equal(catalog.country_code, 'CN');
    assert.equal(catalog.data_version, '2026.0.1');
    assert.equal(catalog.source.dataset, 'cn-division 2026.0.1');
    assert.equal(catalog.source.license, 'MIT');
    assert.equal(catalog.province_count, 31);
    assert.equal(catalog.city_count, 371);
    assert.equal(catalog.district_count, 2935);
    assert.equal(catalog.provinces.length, catalog.province_count);
});

test('中国行政区目录覆盖常用省市及县级目的地', () => {
    const byProvince = new Map(catalog.provinces.map(province => [province.name, province]));
    const hunan = byProvince.get('湖南省');
    const yunnan = byProvince.get('云南省');
    assert.equal(hunan.type, '省');
    assert.ok(hunan.cities.some(city => city.name === '衡阳市'));
    assert.ok(yunnan.cities.some(city => city.name === '大理白族自治州' && city.districts.includes('大理市')));
    assert.ok(yunnan.cities.some(city => city.name === '红河哈尼族彝族自治州' && city.districts.includes('建水县')));
});

test('新增记录编辑器加载独立中国行政区目录', () => {
    assert.match(recordEditorJs, /assets\/catalogs\/china-locations\.json/);
    assert.match(recordEditorJs, /Promise\.all\(\[/);
    assert.match(recordEditorJs, /getRecordAutofill\(input, countries, records, chinaLocations\)/);
    assert.match(recordEditorJs, /do \{[\s\S]*if \(clearedStaleAutofill\) values = getRecordAutofill\(getDraft\(\)\.input, countries, records, chinaLocations\);[\s\S]*\} while \(clearedStaleAutofill\);/);
    assert.equal(packageJson.scripts['china-locations'], 'node scripts/update-china-locations.mjs');
});
