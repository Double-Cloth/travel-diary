import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHandler } from '../js/server.js';
import { DRAFT_FORMAT, prepareRecord, readDraft } from '../js/record-input.mjs';

let root;
let server;
let base;
let token;
const countries = [{ code: 'CN', name_zh: '中国' }, { code: 'SG', name_zh: '新加坡' }];
const original = { date: '2024-01-01', custom: '保留已有未知字段', desc_md: 'original.md' };
const draft = (id = 'a', input = {}) => ({
    format: DRAFT_FORMAT,
    requestId: id.repeat(32),
    input: { date: '2026-09-10', country_code: 'CN', country: '', admin_area: '江苏省', admin_area_type: '', locality: '苏州市', locality_type: '', trip_id: '', title: '沿河散步', body: '## 雨后\n\n石板路与茶馆。', desc_md: '', photo_folder: '', photos: [], ...input }
});

test('旧版草稿补齐可选字段，完整字段草稿保留照片顺序和类型信息', () => {
    const legacy = draft();
    legacy.format = 'travel-diary-draft-v1';
    for (const key of ['country', 'admin_area_type', 'locality_type', 'desc_md', 'photo_folder', 'photos']) delete legacy.input[key];
    assert.deepEqual(readDraft(legacy), draft());
    const value = draft('f', { country: '中华人民共和国', admin_area_type: '省', locality_type: '城市', trip_id: 'jiangsu', desc_md: 'data/travel-diary/2026/2026-09-10-suzhou.md', photo_folder: 'data/photos/suzhou', photos: ['river.jpg', 'garden.png', 'river.jpg'] });
    const { record } = prepareRecord(value, countries);
    for (const key of ['country', 'admin_area_type', 'locality_type', 'trip_id', 'desc_md', 'photo_folder', 'photos']) assert.deepEqual(record[key], value.input[key]);
    for (const input of [
        { desc_md: 'data/travel-diary/2026/2026-09-10-../../escape.md' },
        { desc_md: 'data/travel-diary/2025/2026-09-10-suzhou.md' },
        { desc_md: 'data/travel-diary/2026/2026-09-11-suzhou.md' },
        { photo_folder: 'data/photos/../profile', photos: ['a.png'] },
        { photo_folder: 'data/photos/CON', photos: ['a.png'] },
        { photo_folder: 'data/photos/suzhou', photos: ['../a.png'] },
        { photo_folder: 'data/photos/suzhou', photos: ['a.png:secret'] },
        { photos: ['a.png'] }, { photos: 'a.png' }
    ]) assert.throws(() => prepareRecord(draft('f', input), countries));
});

test('自定义正文路径和完整元数据真实落盘，缺失照片时不写索引', async () => {
    const input = { country: '中华人民共和国', admin_area_type: '省', locality_type: '城市', trip_id: 'jiangsu', desc_md: 'data/travel-diary/2026/2026-09-10-complete.md', photo_folder: 'data/photos/suzhou', photos: ['river.jpg'] };
    const previous = await readIndex();
    assert.equal((await post(draft('f', input))).status, 400);
    assert.deepEqual(await readIndex(), previous);
    await fs.mkdir(path.join(root, 'data/photos/suzhou'), { recursive: true });
    await fs.writeFile(path.join(root, 'data/photos/suzhou/river.jpg'), '测试图片内容');
    const response = await post(draft('f', input));
    assert.equal(response.status, 201);
    const record = (await response.json()).record;
    for (const [key, value] of Object.entries(input)) assert.deepEqual(record[key], value);
    assert.equal((await post(draft('f', input))).status, 200);
    assert.equal((await post(draft('f', { ...input, title: '其他标题' }))).status, 409);
    assert.ok((await fs.readFile(path.join(root, record.desc_md), 'utf8')).startsWith('# 沿河散步'));
});

before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-diary-write-'));
    await fs.mkdir(path.join(root, 'data'));
    await fs.mkdir(path.join(root, 'assets/catalogs'), { recursive: true });
    await fs.writeFile(path.join(root, 'assets/catalogs/countries.json'), JSON.stringify({ countries }));
    await fs.writeFile(path.join(root, 'data/travel_data.json'), JSON.stringify([original]));
    server = http.createServer(createHandler(root));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    token = (await (await fetch(`${base}/api/travel-records`)).json()).token;
});

after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    if (root && path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('travel-diary-write-')) {
        await fs.rm(root, { recursive: true, force: true });
    }
});

const readIndex = async () => JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'));
const post = (value, headers = {}) => fetch(`${base}/api/travel-records`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Travel-Token': token, Origin: base, ...headers }, body: JSON.stringify(value)
});

test('字段校验支持闰年、空行政区和草稿往返，拒绝无效日期、国家与超长正文', () => {
    const value = draft('a', { date: '2024-02-29', country_code: 'SG', admin_area: '', body: '' });
    assert.deepEqual(readDraft(JSON.parse(JSON.stringify(value))), value);
    assert.equal(prepareRecord(value, countries).record.admin_area, '');
    for (const input of [{ date: '2025-02-29' }, { country_code: 'ZZ' }, { title: ' ' }, { locality: '' }, { title: '标题\n注入' }, { body: '文'.repeat(100001) }]) {
        assert.throws(() => prepareRecord(draft('a', input), countries));
    }
    assert.throws(() => prepareRecord({ ...draft(), requestId: '../escape' }, countries));
    assert.throws(() => readDraft({ ...draft(), format: 'unknown' }));
});

test('保存真正写入 JSON 与 Markdown，保留旧数据，重试不重复新增', async () => {
    const previousCount = (await readIndex()).length;
    const response = await post(draft());
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.saved, true);
    const records = await readIndex();
    assert.deepEqual(records[0], original);
    assert.equal(records.length, previousCount + 1);
    assert.equal(await fs.readFile(path.join(root, result.record.desc_md), 'utf8'), '# 沿河散步\n\n## 雨后\n\n石板路与茶馆。\n');
    assert.equal((await fetch(`${base}/${result.record.desc_md}`)).status, 200);
    assert.equal((await post(draft())).status, 200);
    assert.equal((await readIndex()).length, previousCount + 1);
    assert.equal((await post(draft('a', { title: '修改后的标题' }))).status, 409);
    assert.equal((await post(draft('a', { date: '2027-01-01' }))).status, 409);
    assert.equal((await readIndex()).length, previousCount + 1);
});

test('写入端点拒绝跨源请求、伪造 Host、缺失令牌及不合法数据', async () => {
    const before = await readIndex();
    assert.equal((await post(draft('b'), { Origin: 'https://example.com' })).status, 403);
    const forgedHostStatus = await new Promise((resolve, reject) => {
        const request = http.get(`${base}/api/travel-records`, { headers: { Host: 'example.com' } }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject);
    });
    assert.equal(forgedHostStatus, 403);
    assert.equal((await post(draft('b'), { 'X-Travel-Token': '' })).status, 403);
    assert.equal((await post(draft('b'), { 'Content-Type': 'text/plain' })).status, 403);
    assert.equal((await fetch(`${base}/api/travel-records`, { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await post(draft('b', { date: '2026-02-30' }))).status, 400);
    assert.equal((await post(draft('b', { body: '字'.repeat(180000) }))).status, 413);
    assert.deepEqual(await readIndex(), before);
});

test('并发保存发生冲突时可重试，最终不丢失任何一条记录', async () => {
    const values = [draft('b'), draft('c')];
    const results = await Promise.all(values.map(value => post(value)));
    for (let index = 0; index < results.length; index += 1) {
        assert.ok([201, 409].includes(results[index].status));
        if (results[index].status === 409) assert.equal((await post(values[index])).status, 201);
    }
    const records = await readIndex();
    for (const value of values) assert.equal(records.filter(record => record.desc_md.includes(value.requestId)).length, 1);
});

test('索引替换失败会回滚新日记、释放锁并保留索引原文', async () => {
    const indexFile = path.join(root, 'data/travel_data.json');
    const previous = await fs.readFile(indexFile, 'utf8');
    const rename = fs.rename;
    fs.rename = async (from, to) => {
        if (to === indexFile) throw Object.assign(new Error('模拟磁盘写入失败'), { code: 'EACCES' });
        return rename(from, to);
    };
    try { assert.equal((await post(draft('d'))).status, 500); }
    finally { fs.rename = rename; }
    assert.equal(await fs.readFile(indexFile, 'utf8'), previous);
    await assert.rejects(fs.stat(path.join(root, prepareRecord(draft('d'), countries).record.desc_md)), { code: 'ENOENT' });
    assert.equal((await fs.readdir(path.join(root, 'data'))).some(name => name.startsWith('.travel-write')), false);
    assert.equal((await post(draft('d'))).status, 201);
});

test('拒绝覆盖已有 Markdown、异常索引和带链接的数据目录', async () => {
    const value = draft('e');
    const diaryFile = path.join(root, prepareRecord(value, countries).record.desc_md);
    await fs.writeFile(diaryFile, '已有正文');
    assert.equal((await post(value)).status, 409);
    assert.equal(await fs.readFile(diaryFile, 'utf8'), '已有正文');
    const indexFile = path.join(root, 'data/travel_data.json');
    const previous = await fs.readFile(indexFile, 'utf8');
    await fs.writeFile(indexFile, '{broken');
    assert.equal((await post(draft('f'))).status, 500);
    assert.equal(await fs.readFile(indexFile, 'utf8'), '{broken');
    await fs.writeFile(indexFile, previous);
    const linkedDir = path.join(root, 'data/travel-diary/2027');
    await fs.symlink(path.join(root, 'assets'), linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await post(draft('f', { date: '2027-01-01' }))).status, 403);
    assert.equal(await fs.readFile(indexFile, 'utf8'), previous);
});
