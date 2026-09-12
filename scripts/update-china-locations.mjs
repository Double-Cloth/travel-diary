import { writeFile } from 'node:fs/promises';

const CN_DIVISION_VERSION = '2026.0.1';
const SOURCE_URL = `https://raw.githubusercontent.com/kk-418/cn-division/v${CN_DIVISION_VERSION}/dist/no-code/pca.json`;
const OUTPUT_URL = new URL('../assets/catalogs/china-locations.json', import.meta.url);

const response = await fetch(SOURCE_URL);
if (!response.ok) {
    throw new Error(`Failed to fetch ${SOURCE_URL} (${response.status}).`);
}

const source = await response.json();
const provinces = Object.entries(source).map(([name, cities]) => ({
    name,
    type: inferAdminAreaType(name),
    cities: Object.entries(cities).map(([cityName, districts]) => ({
        name: cityName,
        districts
    }))
}));
const cityCount = provinces.reduce((total, province) => total + province.cities.length, 0);
const districtCount = provinces.reduce((total, province) => (
    total + province.cities.reduce((count, city) => count + city.districts.length, 0)
), 0);

if (provinces.length !== 31 || cityCount < 330 || districtCount < 2800) {
    throw new Error(`Unexpected China location counts: ${provinces.length} provinces, ${cityCount} cities, ${districtCount} districts.`);
}

const catalog = {
    schema_version: 1,
    country_code: 'CN',
    locale: 'zh-Hans',
    data_version: CN_DIVISION_VERSION,
    province_count: provinces.length,
    city_count: cityCount,
    district_count: districtCount,
    source: {
        dataset: `cn-division ${CN_DIVISION_VERSION}`,
        upstream: '民政部地名服务年度行政区划数据',
        license: 'MIT',
        url: SOURCE_URL
    },
    provinces
};

await writeFile(OUTPUT_URL, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log(`Generated ${provinces.length} provinces, ${cityCount} cities and ${districtCount} districts at ${OUTPUT_URL.pathname}`);

function inferAdminAreaType(name) {
    if (name.endsWith('自治区')) return '自治区';
    if (name.endsWith('省')) return '省';
    if (name.endsWith('市')) return '直辖市';
    return '';
}
