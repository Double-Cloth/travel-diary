import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { buildMarkdown } from '../js/record-input.mjs';

const travelData = JSON.parse(await readFile(new URL('../data/travel_data.json', import.meta.url), 'utf8'));
const countryCatalog = JSON.parse(await readFile(new URL('../assets/catalogs/countries.json', import.meta.url), 'utf8'));
const countryCodes = new Set(countryCatalog.countries.map(country => country.code));

test('Markdown 日记按年份目录存放并由元数据引用', async () => {
    assert.ok(Array.isArray(travelData));

    for (const record of travelData) {
        const year = record.date.slice(0, 4);
        const expectedPrefix = `data/travel-diary/${year}/${record.date}-`;

        assert.match(record.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.match(record.country_code, /^[A-Z]{2}$/);
        assert.equal(countryCodes.has(record.country_code), true, `${record.country_code} should exist in countries.json`);
        assert.ok(record.country);
        assert.ok(record.locality);
        assert.equal(typeof record.locality_type, 'string');
        assert.ok(record.locality_type.trim());
        if ('trip_id' in record) {
            assert.equal(typeof record.trip_id, 'string');
            assert.ok(record.trip_id.trim());
        }
        assert.equal('province' in record, false);
        assert.equal('city' in record, false);
        assert.ok(record.desc_md.startsWith(expectedPrefix), `${record.desc_md} should start with ${expectedPrefix}`);
        assert.match(record.desc_md, /\.md$/);
        await access(new URL(`../${record.desc_md}`, import.meta.url));
    }
});

test('现有 Markdown 日记与新增记录生成格式一致', async () => {
    for (const record of travelData) {
        const markdown = await readFile(new URL(`../${record.desc_md}`, import.meta.url), 'utf8');
        const normalized = markdown.replace(/\r\n?/g, '\n');
        const match = normalized.match(/^# ([^\n]*)(?:\n|$)/);
        assert.ok(match, record.desc_md);
        const title = match[1];
        const body = normalized.slice(match[0].length).replace(/^\n/, '');

        assert.equal(markdown, buildMarkdown({ title, body }), record.desc_md);
    }
});
