import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const travelData = JSON.parse(await readFile(new URL('../data/travel_data.json', import.meta.url), 'utf8'));

test('Markdown 日记按年份目录存放并由元数据引用', async () => {
    assert.ok(Array.isArray(travelData));

    for (const record of travelData) {
        const year = record.date.slice(0, 4);
        const expectedPrefix = `data/travel-diary/${year}/${record.date}-`;

        assert.match(record.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(record.desc_md.startsWith(expectedPrefix), `${record.desc_md} should start with ${expectedPrefix}`);
        assert.match(record.desc_md, /\.md$/);
        await access(new URL(`../${record.desc_md}`, import.meta.url));
    }
});
