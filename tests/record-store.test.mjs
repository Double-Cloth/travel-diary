import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createHandler } from '../js/server.js';
import { DRAFT_FORMAT, prepareRecord, readDraft, recordMetadataSnapshot } from '../js/record-input.mjs';
import { createDraftBlob } from '../js/draft-archive.mjs';
import { sameMediaContent } from '../js/photo-uploads.mjs';
import { ByteSource, readZipSource, readSourceText, sourceOf, ZIP_CHUNK_BYTES } from '../js/zip-stream.mjs';
import { createZip } from './helpers/zip-archive.mjs';
import { MAXIMUM_ARCHIVE_BYTES, MAXIMUM_RECORD_ARCHIVE_BYTES } from '../js/file-limits.mjs';
import { installAuth, login } from './helpers/auth.mjs';
import { listenOnFetchSafePort } from './helpers/http.mjs';

let root;
let server;
let base;
let token;
let cookie;
const countries = [{ code: 'CN', name_zh: '中国' }, { code: 'SG', name_zh: '新加坡' }];
const original = { date: '2024-01-01', custom: '保留已有未知字段', desc_md: 'original.md' };
const draft = (id = 'a', input = {}) => ({
    format: DRAFT_FORMAT,
    requestId: id.repeat(32),
    uploads: [],
    input: { date: '2026-09-10', country_code: 'CN', country: '', admin_area: '江苏省', admin_area_type: '', locality: `苏州市-${id}`, locality_type: '', trip_id: '', title: '沿河散步', body: '## 雨后\n\n石板路与茶馆。', desc_md: '', photo_folder: '', photos: [], video_folder: '', videos: [], ...input }
});

test('旧版草稿补齐可选字段，完整字段草稿保留照片顺序和类型信息', () => {
    const legacy = draft();
    legacy.format = 'travel-diary-draft-v1';
    for (const key of ['country', 'admin_area_type', 'locality_type', 'desc_md', 'photo_folder', 'photos', 'video_folder', 'videos']) delete legacy.input[key];
    assert.deepEqual(readDraft(legacy), draft());
    const value = draft('f', { country: '中华人民共和国', admin_area_type: '省', locality_type: '城市', trip_id: 'jiangsu', desc_md: 'data/travel-diary/2026/2026-09-10-suzhou.md', photo_folder: 'data/photos/suzhou', photos: ['river.jpg', 'garden.png', 'river.jpg'], video_folder: 'data/videos/suzhou', videos: ['walk.mp4'] });
    const { record } = prepareRecord(value, countries);
    for (const key of ['country', 'admin_area_type', 'locality_type', 'trip_id', 'desc_md', 'photo_folder', 'photos', 'video_folder', 'videos']) assert.deepEqual(record[key], value.input[key]);
    for (const input of [
        { desc_md: 'data/travel-diary/2026/2026-09-10-../../escape.md' },
        { desc_md: 'data/travel-diary/2025/2026-09-10-suzhou.md' },
        { desc_md: 'data/travel-diary/2026/2026-09-11-suzhou.md' },
        { photo_folder: 'data/photos/../profile', photos: ['a.png'] },
        { photo_folder: 'data/photos/CON', photos: ['a.png'] },
        { photo_folder: 'data/photos/suzhou', photos: ['../a.png'] },
        { photo_folder: 'data/photos/suzhou', photos: ['a.png:secret'] },
        { photos: ['a.png'] }, { photos: 'a.png' },
        { video_folder: 'data/videos/../profile', videos: ['a.mp4'] },
        { video_folder: 'data/videos/suzhou', videos: ['../a.mp4'] },
        { videos: ['a.mp4'] }, { videos: 'a.mp4' }
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
    await installAuth(root);
    server = http.createServer(createHandler(root));
    base = await listenOnFetchSafePort(server);
    ({ token, cookie } = await login(base));
});

after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    if (root && path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('travel-diary-write-')) {
        await fs.rm(root, { recursive: true, force: true });
    }
});

async function sendRecord(url, options) {
    const response = await fetch(url, options);
    const result = await response.clone().json();
    if (result.code !== 'MEDIA_DUPLICATE_WARNING') return response;
    return fetch(url, { ...options, headers: { ...options.headers, 'X-Travel-Media-Confirmation': result.confirmation } });
}

const readIndex = async () => JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'));
const post = (value, headers = {}) => sendRecord(`${base}/api/travel-records`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Travel-Token': token, Cookie: cookie, Origin: base, ...headers }, body: JSON.stringify(value)
});
const put = (originalDescMd, value, headers = {}, expected, options = {}) => sendRecord(`${base}/api/travel-records`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Travel-Token': token, Cookie: cookie, Origin: base, ...headers },
    body: JSON.stringify({ originalDescMd, draft: value, ...(expected ? { expected } : {}), ...options })
});
const remove = (descMd, headers = {}) => sendRecord(`${base}/api/travel-records`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Travel-Token': token, Cookie: cookie, Origin: base, ...headers },
    body: JSON.stringify({ desc_md: descMd })
});

test('媒体数量限制合并已有引用与新上传，图片和视频分别计算', async () => {
    const image = { id: 'c'.repeat(32), name: 'new.png', data: 'iVBORw0KGgo=' };
    const video = { id: 'd'.repeat(32), name: 'new.webm', data: 'GkXfow==' };
    const photos = Array.from({ length: 1000 }, (_, index) => `photo-${index}.png`);
    const videos = Array.from({ length: 1000 }, (_, index) => `video-${index}.webm`);
    const value = draft('e', { photo_folder: 'data/photos/test', photos, video_folder: 'data/videos/test', videos });
    assert.equal(readDraft(value).input.photos.length, 1000);
    assert.throws(() => readDraft({ ...value, uploads: [image] }), /图片已有引用与待上传文件合计不能超过 1000 项/);
    assert.throws(() => readDraft({ ...value, uploads: [video] }), /视频已有引用与待上传文件合计不能超过 1000 项/);
    const accepted = readDraft({
        ...value,
        input: { ...value.input, photos: photos.slice(1), videos: videos.slice(1) },
        uploads: [image, video]
    });
    assert.equal(accepted.uploads.length, 2);
    assert.throws(() => readDraft({
        ...value,
        input: { ...value.input, photos: photos.slice(1) },
        uploads: [image],
        mediaOrder: { photos: [] }
    }), /媒体顺序必须完整/);

    const previous = await readIndex();
    const response = await post({ ...value, uploads: [image] });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /合计不能超过 1000 项/);
    assert.deepEqual(await readIndex(), previous);
});
test('媒体内容按分块比较，改名仍判重，同名同大小但内容不同可以添加', async () => {
    const bytes = new Uint8Array(ZIP_CHUNK_BYTES + 7).fill(42);
    const changed = bytes.slice();
    changed[changed.length - 1] = 43;
    let maximumRead = 0;
    const source = new ByteSource(bytes.length, async (offset, length) => {
        maximumRead = Math.max(maximumRead, length);
        return bytes.subarray(offset, offset + length);
    });
    assert.equal(await sameMediaContent(source, sourceOf(bytes)), true);
    assert.equal(await sameMediaContent(source, changed), false);
    assert.equal(await sameMediaContent(source, bytes.subarray(1)), false);
    assert.equal(maximumRead, ZIP_CHUNK_BYTES);
    assert.equal(await sameMediaContent('YWJj', new Uint8Array([97, 98, 99])), true);
    await assert.rejects(sameMediaContent(source, bytes, () => { throw new Error('取消比较'); }), /取消比较/);
});

test('同篇拒绝改名或大小写变化的重复图片视频，跨日记必须确认且支持 ZIP', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=';
    const mp4 = Buffer.from('\0\0\0\x18ftypisom\0\0\0\0isommp42', 'binary').toString('base64');
    for (const [index, [name, data, list, folder]] of [['IMAGE.PNG', png, 'photos', 'photo_folder'], ['VIDEO.MP4', mp4, 'videos', 'video_folder']].entries()) {
        const value = draft('a', { date: `2040-01-0${index + 1}`, locality: `重复上传-${index}` });
        value.uploads = [{ id: 'a'.repeat(32), name, data }];
        const created = (await (await post(value)).json()).record;
        assert.deepEqual(created[list], [name]);
        assert.equal((await post(value)).status, 200);
        const previous = await readIndex();
        const duplicate = { ...value, input: { ...value.input, date: `2040-02-0${index + 1}` },
            uploads: [{ id: 'b'.repeat(32), name: `renamed-${name.toLowerCase()}`, data }] };
        const headers = { 'Content-Type': 'application/json', 'X-Travel-Token': token, Cookie: cookie, Origin: base };
        const response = await fetch(`${base}/api/travel-records`, { method: 'POST', headers, body: JSON.stringify(duplicate) });
        assert.equal(response.status, 409);
        const result = await response.json();
        assert.equal(result.code, 'MEDIA_DUPLICATE_WARNING');
        assert.ok(result.duplicates.some(item => item.records.some(owner => owner.desc_md === created.desc_md)));
        assert.deepEqual(await readIndex(), previous);
        const edited = { ...duplicate, input: { ...value.input, ...created, [list]: [] } };
        const denied = await put(created.desc_md, edited, { 'X-Travel-Media-Confirmation': result.confirmation }, undefined, { syncMediaFiles: false });
        assert.equal((await denied.json()).code, 'DUPLICATE_MEDIA');
        const zip = await createDraftBlob(duplicate);
        const zipHeaders = { ...headers, 'Content-Type': 'application/zip' };
        const zipResponse = await fetch(`${base}/api/travel-records`, { method: 'POST', headers: zipHeaders, body: zip });
        assert.equal((await zipResponse.json()).code, 'MEDIA_DUPLICATE_WARNING');
        const confirmed = await fetch(`${base}/api/travel-records`, { method: 'POST', headers: {
            ...zipHeaders, 'X-Travel-Media-Confirmation': result.confirmation
        }, body: zip });
        assert.equal(confirmed.status, 201);
        assert.equal((await post(duplicate)).status, 200);
        assert.ok((await fs.readdir(path.join(root, created[folder]))).includes(name));
        const differentPlace = { ...duplicate, input: { ...duplicate.input, locality: `其他目的地-${index}` } };
        const changed = await fetch(`${base}/api/travel-records`, { method: 'POST', headers: {
            ...headers, 'X-Travel-Media-Confirmation': result.confirmation
        }, body: JSON.stringify(differentPlace) });
        assert.equal((await changed.json()).code, 'MEDIA_DUPLICATE_WARNING');
        assert.equal((await post(differentPlace)).status, 201);
    }
});

test('跨日记确认后可共用同名同内容媒体，提交失败保留共享文件，同名不同内容不覆盖', async () => {
    const bytes = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=', 'base64'), Buffer.from('shared-name-test')]);
    const first = draft('c', { date: '2041-01-01', locality: '共享文件测试' });
    first.uploads = [{ id: 'c'.repeat(32), name: 'SHARED.PNG', data: bytes.toString('base64') }];
    const created = (await (await post(first)).json()).record;
    const second = { ...first, requestId: 'd'.repeat(32), input: { ...first.input, date: '2041-01-02' } };
    const rename = fs.rename;
    fs.rename = async (source, target) => {
        if (target === path.join(root, 'data/travel_data.json')) throw new Error('模拟共享文件提交失败');
        return rename(source, target);
    };
    try { assert.equal((await post(second)).status, 500); }
    finally { fs.rename = rename; }
    assert.deepEqual(await fs.readFile(path.join(root, created.photo_folder, 'SHARED.PNG')), bytes);
    assert.equal((await post(second)).status, 201);
    const third = { ...second, requestId: 'e'.repeat(32), input: { ...second.input, date: '2041-01-03' },
        uploads: [{ ...first.uploads[0], data: Buffer.concat([bytes, Buffer.from('changed')]).toString('base64') }] };
    assert.equal((await post(third)).status, 409);
    assert.deepEqual(await fs.readFile(path.join(root, created.photo_folder, 'SHARED.PNG')), bytes);
});

test('同批重复文件与搬入附件的相同内容被拒绝，失败不留下新文件', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=';
    const value = draft('b', { date: '2040-03-03', locality: '同批重复上传' });
    value.uploads = [{ id: 'a'.repeat(32), name: 'one.png', data: png }, { id: 'b'.repeat(32), name: 'two.png', data: png }];
    const previous = await readIndex();
    const response = await post(value);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /已上传过一样的文件/);
    assert.deepEqual(await readIndex(), previous);
    const prepared = prepareRecord(value, countries).record;
    await assert.rejects(fs.stat(path.join(root, prepared.photo_folder)), { code: 'ENOENT' });
    await fs.mkdir(path.join(root, 'data/photos/duplicate-source'), { recursive: true });
    await fs.writeFile(path.join(root, 'data/photos/duplicate-source/old.png'), Buffer.from(png, 'base64'));
    value.uploads.pop();
    value.input.photo_folder = 'data/photos/duplicate-source';
    value.input.photos = ['old.png'];
    assert.equal((await post(value)).status, 409);
    assert.deepEqual(await readIndex(), previous);
    await assert.rejects(fs.stat(path.join(root, prepared.photo_folder)), { code: 'ENOENT' });
});

test('ZIP 二进制媒体可新增、无损重试与修改，原快照冲突时不覆盖数据', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=', 'base64');
    const mp4 = Buffer.from('\0\0\0\x18ftypisom\0\0\0\0isommp42', 'binary');
    const value = draft('7', { locality: 'ZIP 原始媒体', desc_md: 'data/travel-diary/2026/2026-09-10-zip-media.md' });
    value.uploads = [{ id: '1'.repeat(32), name: 'river.png', data: png }, { id: '2'.repeat(32), name: 'walk.mp4', data: mp4 }];
    const sendZip = (method, body, overrides = {}) => sendRecord(`${base}/api/travel-records`, {
        method,
        headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': token, Cookie: cookie, Origin: base, ...overrides },
        body
    });
    const archive = new Uint8Array(await (await createDraftBlob(value)).arrayBuffer());
    assert.equal((await sendZip('POST', archive, { 'X-Travel-Token': 'invalid' })).status, 403);
    const response = await sendZip('POST', archive);
    assert.equal(response.status, 201);
    const { record } = await response.json();
    assert.deepEqual(await fs.readFile(path.join(root, record.photo_folder, record.photos[0])), png);
    assert.deepEqual(await fs.readFile(path.join(root, record.video_folder, record.videos[0])), mp4);
    assert.equal((await sendZip('POST', archive)).status, 200);
    const legacyArchive = createZip(await Promise.all((await readZipSource(archive)).map(async entry => ({
        name: entry.name,
        data: await readSourceText(entry.data)
    }))));
    assert.equal((await sendZip('POST', legacyArchive)).status, 200);
    const expected = { record, markdown: await fs.readFile(path.join(root, record.desc_md), 'utf8') };
    const edited = { ...value, uploads: [], input: { ...value.input, ...record, body: '更新后的 ZIP 正文' } };
    const updatedArchive = await createDraftBlob(edited, { originalDescMd: record.desc_md, expected });
    assert.equal((await sendZip('PUT', updatedArchive)).status, 200);
    assert.match(await fs.readFile(path.join(root, record.desc_md), 'utf8'), /更新后的 ZIP 正文/);
    assert.equal((await sendZip('PUT', await createDraftBlob(value, { originalDescMd: record.desc_md, expected }))).status, 409);
    const index = await readIndex();
    const broken = archive.slice();
    broken[0] ^= 1;
    assert.equal((await sendZip('POST', broken)).status, 400);
    assert.equal((await sendZip('DELETE', archive)).status, 415);
    assert.deepEqual(await readIndex(), index);
});

test('ZIP 请求在读取媒体前按新上限拒绝超量声明', async () => {
    async function declaredRequest(endpoint, length) {
        return new Promise((resolve, reject) => {
            const request = http.request(`${base}${endpoint}`, {
                method: 'POST',
                agent: false,
                headers: { 'Content-Type': 'application/zip', 'Content-Length': length, 'X-Travel-Token': token, Cookie: cookie, Origin: base }
            }, response => {
                response.resume();
                response.on('end', () => { resolve(response.statusCode); request.destroy(); });
            });
            request.on('error', reject);
            request.end('x');
        });
    }
    assert.equal(await declaredRequest('/api/travel-records', MAXIMUM_RECORD_ARCHIVE_BYTES + 1), 413);
    assert.equal(await declaredRequest('/api/travel-data', MAXIMUM_ARCHIVE_BYTES + 1), 413);
});

test('ZIP64 媒体 CRC 损坏会回滚文件；上传期间注销会话则拒绝写入并清理临时文件', async () => {
    const previous = await readIndex();
    const value = draft('8', { locality: '流式回滚', desc_md: 'data/travel-diary/2026/2026-09-10-stream-rollback.md' });
    value.uploads = [{ id: '3'.repeat(32), name: 'river.png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=', 'base64') }];
    const archive = Buffer.from(await (await createDraftBlob(value)).arrayBuffer());
    const damaged = Buffer.from(archive);
    const localOffset = damaged.indexOf(Buffer.from([0x50, 0x4b, 3, 4]), 4);
    const view = new DataView(damaged.buffer, damaged.byteOffset, damaged.length);
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    damaged[dataStart + value.uploads[0].data.length - 1] ^= 255;
    const rejected = await sendRecord(`${base}/api/travel-records`, {
        method: 'POST', headers: { 'Content-Type': 'application/zip', Cookie: cookie, 'X-Travel-Token': token, Origin: base }, body: damaged
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /校验失败/);
    const authorization = await login(base);
    const request = http.request(`${base}/api/travel-records`, {
        method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/zip', 'Content-Length': archive.length, Cookie: authorization.cookie, 'X-Travel-Token': authorization.token, Origin: base }
    });
    const response = new Promise((resolve, reject) => {
        request.on('response', result => { result.resume(); result.on('end', () => resolve(result.statusCode)); });
        request.on('error', reject);
    });
    request.write(archive.subarray(0, 8));
    assert.equal((await fetch(`${base}/api/travel-auth`, { method: 'DELETE', headers: { Cookie: authorization.cookie, Origin: base } })).status, 200);
    request.end(archive.subarray(8));
    assert.equal(await response, 401);
    assert.deepEqual(await readIndex(), previous);
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.travel-upload-')), false);
    await assert.rejects(fs.stat(path.join(root, value.input.desc_md)), { code: 'ENOENT' });
});

test('写入服务声明支持新增、修改与删除方法', async () => {
    const response = await sendRecord(`${base}/api/travel-records`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const capability = await response.json();
    assert.deepEqual(capability.methods, ['POST', 'PUT', 'DELETE']);
    assert.equal(capability.syncMediaFiles, true);
    assert.equal(capability.mediaOrder, true);
});

test('旧窗口修改不会覆盖最新元数据和正文，同内容重试仍幂等', async () => {
    const value = draft('e', { date: '2030-01-01', locality: '并发编辑检查' });
    const created = (await (await post(value)).json()).record;
    const markdownFile = path.join(root, created.desc_md);
    const expected = { record: created, markdown: await fs.readFile(markdownFile, 'utf8') };
    const firstEdit = { ...value, input: { ...value.input, body: '窗口甲已保存', admin_area_type: '省' } };
    const first = await put(created.desc_md, firstEdit, {}, expected);
    assert.equal(first.status, 200);
    const updated = (await first.json()).record;
    const repeated = await put(created.desc_md, firstEdit, {}, expected);
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).alreadySaved, true);
    const staleEdit = { ...value, input: { ...value.input, body: '窗口乙旧内容' } };
    const stale = await put(created.desc_md, staleEdit, {}, expected);
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /其他窗口或文件中修改/);
    assert.match(await fs.readFile(markdownFile, 'utf8'), /窗口甲已保存/);
    const latest = { record: updated, markdown: await fs.readFile(markdownFile, 'utf8') };
    await fs.writeFile(markdownFile, '# 外部修改\n');
    assert.equal((await put(created.desc_md, staleEdit, {}, latest)).status, 409);
    assert.equal(await fs.readFile(markdownFile, 'utf8'), '# 外部修改\n');
});

test('修改记录引用多级媒体目录时按完整路径搬移文件', async () => {
    const sourceFolder = 'data/photos/nested-source';
    await fs.mkdir(path.join(root, sourceFolder), { recursive: true });
    await fs.writeFile(path.join(root, sourceFolder, 'photo.png'), '原始媒体字节');
    const value = draft('f', { date: '2031-01-01', locality: '多级目录检查', photo_folder: sourceFolder, photos: ['photo.png'] });
    const created = (await (await post(value)).json()).record;
    const destination = 'data/photos/trips/day-one';
    const edited = { ...value, input: { ...value.input, photo_folder: destination } };
    assert.equal((await put(created.desc_md, edited)).status, 200);
    assert.equal(await fs.readFile(path.join(root, destination, 'photo.png'), 'utf8'), '原始媒体字节');
    assert.equal((await readIndex()).find(record => record.desc_md === created.desc_md).photo_folder, destination);
    await assert.rejects(fs.stat(path.join(root, 'data/photos/day-one')), { code: 'ENOENT' });
});

test('字段校验支持闰年、空行政区和草稿往返，拒绝无效日期、国家与超长正文', () => {
    const value = draft('a', { date: '2024-02-29', country_code: 'SG', admin_area: '', body: '' });
    assert.deepEqual(readDraft(JSON.parse(JSON.stringify(value))), value);
    assert.equal(prepareRecord(value, countries).record.admin_area, '');
    assert.equal(prepareRecord(draft('a', { trip_id: '2026-09-江苏省' }), countries).record.trip_id, '2026-09-jiangsu');
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
    assert.equal((await readIndex()).length, previousCount + 1);
});

test('修改记录会替换索引与 Markdown，支持移动正文路径且不会重复新增', async () => {
    const createdResponse = await post(draft('9'));
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()).record;
    const previousCount = (await readIndex()).length;
    const editedDraft = draft('7', {
        date: '2026-09-12',
        locality: '无锡市',
        title: '修改后的标题',
        body: '新的旅行正文。'
    });
    const response = await put(created.desc_md, editedDraft);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.updated, true);
    assert.equal(result.record.desc_md, 'data/travel-diary/2026/2026-09-12-wuxi.md');
    assert.equal((await readIndex()).length, previousCount);
    assert.equal((await readIndex()).some(record => record.desc_md === created.desc_md), false);
    assert.equal(await fs.readFile(path.join(root, result.record.desc_md), 'utf8'), '# 修改后的标题\n\n新的旅行正文。\n');
    await assert.rejects(fs.stat(path.join(root, created.desc_md)), { code: 'ENOENT' });
});

test('删除记录会同步移除索引与 Markdown，并拒绝重复删除', async () => {
    const created = (await (await post(draft('8'))).json()).record;
    const previousCount = (await readIndex()).length;
    const response = await remove(created.desc_md);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).deleted, true);
    assert.equal((await readIndex()).length, previousCount - 1);
    assert.equal((await readIndex()).some(record => record.desc_md === created.desc_md), false);
    await assert.rejects(fs.stat(path.join(root, created.desc_md)), { code: 'ENOENT' });
    assert.equal((await remove(created.desc_md)).status, 409);
});

test('修改正文各阶段失败均保留原正文和索引，并允许重试', async () => {
    const value = draft('a', { locality: '回滚测试', date: '2028-01-02' });
    const created = (await (await post(value)).json()).record;
    const diaryFile = path.join(root, created.desc_md);
    const indexFile = path.join(root, 'data/travel_data.json');
    const previous = await fs.readFile(indexFile, 'utf8');
    const markdown = await fs.readFile(diaryFile, 'utf8');
    const edited = { ...value, input: { ...value.input, body: '修改的正文' } };
    const rename = fs.rename;
    for (const stage of ['backup', 'replace', 'index']) {
        fs.rename = async (from, to) => {
            if ((stage === 'backup' && from === diaryFile)
                || (stage === 'replace' && from.endsWith('.tmp') && to === diaryFile)
                || (stage === 'index' && to === indexFile)) throw new Error(`模拟 ${stage} 失败`);
            return rename(from, to);
        };
        try { assert.equal((await put(created.desc_md, edited)).status, 500); }
        finally { fs.rename = rename; }
        assert.equal(await fs.readFile(diaryFile, 'utf8'), markdown);
        assert.equal(await fs.readFile(indexFile, 'utf8'), previous);
        assert.deepEqual(await fs.readdir(path.dirname(diaryFile)), [path.basename(diaryFile)]);
    }
    assert.equal((await put(created.desc_md, edited)).status, 200);
});

test('修改到新路径时同步失败会清理半成品正文', async () => {
    const value = draft('b', { locality: '写入失败测试', date: '2028-02-02' });
    const created = (await (await post(value)).json()).record;
    const edited = { ...value, input: { ...value.input, date: '2028-02-03' } };
    const target = path.join(root, prepareRecord(edited, countries).record.desc_md);
    const previous = await readIndex();
    const open = fs.open;
    fs.open = async (file, ...args) => {
        const handle = await open(file, ...args);
        if (file === target) handle.sync = async () => { throw new Error('模拟磁盘同步失败'); };
        return handle;
    };
    try { assert.equal((await put(created.desc_md, edited)).status, 500); }
    finally { fs.open = open; }
    assert.deepEqual(await readIndex(), previous);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    assert.ok(await fs.readFile(path.join(root, created.desc_md), 'utf8'));
    assert.equal((await put(created.desc_md, edited)).status, 200);
});

test('正文年份目录缺失时仍可删除索引记录', async () => {
    const created = (await (await post(draft('c', { date: '2029-01-01' }))).json()).record;
    await fs.unlink(path.join(root, created.desc_md));
    await fs.rmdir(path.dirname(path.join(root, created.desc_md)));
    assert.equal((await remove(created.desc_md)).status, 200);
    assert.equal((await readIndex()).some(record => record.desc_md === created.desc_md), false);
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
    assert.equal((await put('missing.md', draft('b'), { 'X-Travel-Token': '' })).status, 403);
    assert.equal((await remove('missing.md', { 'X-Travel-Token': '' })).status, 403);
    assert.equal((await post(draft('b'), { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await sendRecord(`${base}/api/travel-records`, { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await post(draft('b', { date: '2026-02-30' }))).status, 400);
    assert.equal((await post(draft('b', { body: '字'.repeat(180000) }))).status, 400);
    assert.deepEqual(await readIndex(), before);
});

test('上传照片自动建目录并写入原始字节，草稿重试校验照片内容', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=';
    const value = { ...draft('1'), uploads: [{ id: '2'.repeat(32), name: '湖边.png', data: png }] };
    const response = await post(value);
    assert.equal(response.status, 201);
    const record = (await response.json()).record;
    assert.equal(record.photo_folder, 'data/photos/suzhoushi-1');
    assert.deepEqual(record.photos, ['hubian.png']);
    const bytes = await fs.readFile(path.join(root, record.photo_folder, record.photos[0]));
    assert.deepEqual(bytes, Buffer.from(png, 'base64'));
    assert.equal((await post(value)).status, 200);
    assert.equal((await post({ ...value, uploads: [{ ...value.uploads[0], data: Buffer.concat([bytes, Buffer.from('改动')]).toString('base64') }] })).status, 409);
    const invalid = { ...draft('3'), uploads: [{ id: '4'.repeat(32), name: '伪装.png', data: Buffer.from('<svg onload="evil"/>').toString('base64') }] };
    assert.equal((await post(invalid)).status, 400);
});

test('上传视频自动建目录、保留原始字节并写入视频元数据', async () => {
    const mp4Bytes = Buffer.from('\0\0\0\x18ftypisom\0\0\0\0isommp42', 'binary');
    const value = {
        ...draft('0', { date: '2026-09-14', locality: '厦门市' }),
        uploads: [{ id: 'a'.repeat(32), name: '夜游.MOV', data: mp4Bytes.toString('base64') }]
    };
    const response = await post(value);
    assert.equal(response.status, 201);
    const record = (await response.json()).record;
    assert.equal(record.video_folder, 'data/videos/xiamen');
    assert.deepEqual(record.videos, ['yeyou.mp4']);
    assert.deepEqual(await fs.readFile(path.join(root, record.video_folder, record.videos[0])), mp4Bytes);
    assert.equal((await post(value)).status, 200);
});

test('上传与已有照片可以合并，索引提交失败会清理新照片和目录', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=';
    await fs.mkdir(path.join(root, 'data/photos/legacy'), { recursive: true });
    await fs.writeFile(path.join(root, 'data/photos/legacy/old.png'), Buffer.from(png, 'base64'));
    const newPng = Buffer.concat([Buffer.from(png, 'base64'), Buffer.from('new')]).toString('base64');
    const value = { ...draft('5', { photo_folder: 'data/photos/legacy', photos: ['old.png'] }), uploads: [{ id: '6'.repeat(32), name: 'new.png', data: newPng }] };
    const previous = await readIndex();
    const rename = fs.rename;
    fs.rename = async () => { throw new Error('模拟提交失败'); };
    try { assert.equal((await post(value)).status, 500); }
    finally { fs.rename = rename; }
    assert.deepEqual(await readIndex(), previous);
    const record = prepareRecord(value, countries).record;
    await assert.rejects(fs.stat(path.join(root, record.photo_folder)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(root, record.desc_md)), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(path.join(root, 'data/photos/legacy/old.png')), Buffer.from(png, 'base64'));
    assert.equal((await post(value)).status, 201);
    assert.deepEqual(record.photos, ['old.png', 'new.png']);
    for (const name of record.photos) assert.deepEqual(await fs.readFile(path.join(root, record.photo_folder, name)), Buffer.from(name === 'new.png' ? newPng : png, 'base64'));
    const sameDestination = { ...draft('7', { date: '2026-09-11', locality: value.input.locality }), uploads: [{ id: '8'.repeat(32), name: 'another.png', data: png }] };
    const sameDestinationResponse = await post(sameDestination);
    assert.equal(sameDestinationResponse.status, 201);
    assert.deepEqual(await fs.readFile(path.join(root, record.photo_folder, 'another.png')), Buffer.from(png, 'base64'));
});

test('并发保存发生冲突时可重试，最终不丢失任何一条记录', async () => {
    const values = [draft('b'), draft('c')];
    const results = await Promise.all(values.map(value => post(value)));
    for (let index = 0; index < results.length; index += 1) {
        assert.ok([201, 409].includes(results[index].status));
        if (results[index].status === 409) assert.equal((await post(values[index])).status, 201);
    }
    const records = await readIndex();
    for (const value of values) assert.equal(records.filter(record => record.desc_md === prepareRecord(value, countries).record.desc_md).length, 1);
});

test('同日同音地名分别保存正文与同名媒体，ZIP 重试沿用实际路径和固定标识', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=', 'base64');
    const video = Buffer.from('\0\0\0\x18ftypisom\0\0\0\0isommp42', 'binary');
    const first = { ...draft('a', { date: '2042-01-01', locality: '苏州市' }), uploads: [
        { id: 'a'.repeat(32), name: 'same.png', data: png.toString('base64') },
        { id: 'b'.repeat(32), name: 'same.mp4', data: video.toString('base64') }
    ] };
    const second = { ...draft('b', { date: first.input.date, admin_area: '安徽省', locality: '宿州市' }), uploads: first.uploads.map(upload => ({
        ...upload, data: Buffer.concat([Buffer.from(upload.data, 'base64'), Buffer.from('second')]).toString('base64')
    })), mediaOrder: { sequence: ['video', 'photo'] } };
    const originalRecord = (await (await post(first)).json()).record;
    const sendZip = value => sendRecord(`${base}/api/travel-records`, {
        method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': token, Cookie: cookie, Origin: base },
        body: value
    });
    const response = await sendZip(await createDraftBlob(second));
    assert.equal(response.status, 201);
    const saved = (await response.json()).record;
    assert.match(saved.desc_md, /2042-01-01-suzhou-[a-f0-9]{12}\.md$/);
    assert.notEqual(saved.record_id, originalRecord.record_id);
    for (const field of ['photo_folder', 'video_folder']) assert.notEqual(saved[field], originalRecord[field]);
    assert.deepEqual(saved.media_order, ['video:same.mp4', 'photo:same.png']);
    const count = (await readIndex()).length;
    const retry = await sendZip(await createDraftBlob(second));
    assert.equal(retry.status, 200);
    assert.deepEqual((await retry.json()).record, saved);
    assert.equal((await readIndex()).length, count);
    assert.equal((await post({ ...second, input: { ...second.input, body: '已修改' } })).status, 409);
    for (const [value, record] of [[first, originalRecord], [second, saved]]) {
        for (const [index, field] of ['photo_folder', 'video_folder'].entries()) {
            assert.deepEqual(await fs.readFile(path.join(root, record[field], value.uploads[index].name)), Buffer.from(value.uploads[index].data, 'base64'));
        }
    }
    const next = { ...second, requestId: 'c'.repeat(32), input: { ...second.input, date: '2042-01-02' } };
    const nextResponse = await post(next);
    assert.equal(nextResponse.status, 201);
    const nextRecord = (await nextResponse.json()).record;
    assert.equal(nextRecord.photo_folder, saved.photo_folder);
    assert.equal(nextRecord.video_folder, saved.video_folder);
});

test('同名目的地按国家和行政区区分，旧版省市字段也参与路径冲突检查', async () => {
    const first = draft('d', { date: '2042-02-01', locality: '朝阳区', admin_area: '北京市' });
    const originalRecord = (await (await post(first)).json()).record;
    const records = await readIndex();
    const legacy = records.find(item => item.desc_md === originalRecord.desc_md);
    legacy.province = legacy.admin_area;
    legacy.city = legacy.locality;
    delete legacy.admin_area;
    delete legacy.locality;
    await fs.writeFile(path.join(root, 'data/travel_data.json'), JSON.stringify(records));
    for (const [id, input] of [['e', { admin_area: '辽宁省' }], ['f', { country_code: 'SG' }]]) {
        const response = await post(draft(id, { ...first.input, ...input }));
        assert.equal(response.status, 201);
        assert.notEqual((await response.json()).record.desc_md, originalRecord.desc_md);
    }
    const manual = draft('f', { ...first.input, locality: '宿州市', desc_md: originalRecord.desc_md });
    assert.equal((await post(manual)).status, 409);
});

test('同音地名避开已占用的后缀路径，序号达到两位时重试仍幂等', async () => {
    const date = '2042-03-01';
    assert.equal((await post(draft('a', { date, locality: '苏州市' }))).status, 201);
    const value = draft('b', { date, locality: '宿州市', admin_area: '安徽省' });
    const suffix = createHash('sha256').update('cn|安徽省|宿州市').digest('hex').slice(0, 12);
    const stem = `data/travel-diary/2042/${date}-suzhou-${suffix}`;
    const occupied = Array.from({ length: 9 }, (_, index) => `${stem}${index ? `-${index + 1}` : ''}.md`);
    for (const file of occupied) await fs.writeFile(path.join(root, file), '# 已有文件\n');
    const response = await post(value);
    assert.equal(response.status, 201);
    const record = (await response.json()).record;
    assert.equal(record.desc_md, `${stem}-10.md`);
    const retry = await post(value);
    assert.equal(retry.status, 200);
    assert.deepEqual((await retry.json()).record, record);
    for (const file of occupied) assert.equal(await fs.readFile(path.join(root, file), 'utf8'), '# 已有文件\n');
});

test('修改为同音目的地会分配独立路径，索引提交失败回滚后可重试', async () => {
    const date = '2042-04-01';
    assert.equal((await post(draft('a', { date, locality: '苏州市' }))).status, 201);
    const value = draft('b', { date, locality: '无锡市' });
    const existing = (await (await post(value)).json()).record;
    const edited = { ...value, input: { ...value.input, locality: '宿州市', admin_area: '安徽省' } };
    const previous = await readIndex();
    const rename = fs.rename;
    fs.rename = async (from, to) => {
        if (to === path.join(root, 'data/travel_data.json')) throw new Error('模拟索引提交失败');
        return rename(from, to);
    };
    try { assert.equal((await put(existing.desc_md, edited)).status, 500); }
    finally { fs.rename = rename; }
    assert.deepEqual(await readIndex(), previous);
    const response = await put(existing.desc_md, edited);
    assert.equal(response.status, 200);
    const updated = (await response.json()).record;
    assert.match(updated.desc_md, /suzhou-[a-f0-9]{12}\.md$/);
    assert.equal(updated.record_id, existing.record_id);
    await assert.rejects(fs.stat(path.join(root, existing.desc_md)), { code: 'ENOENT' });
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

test('修改目的地会同步搬迁正文与媒体目录并清理旧目录', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=';
    const created = (await (await post({
        ...draft('4', { date: '2030-05-05', locality: '苏州市-4' }),
        uploads: [{ id: '4'.repeat(32), name: '湖边.png', data: png }]
    })).json()).record;
    const oldFolder = created.photo_folder;
    assert.equal(oldFolder, 'data/photos/suzhoushi-4');
    assert.deepEqual(await fs.readFile(path.join(root, oldFolder, created.photos[0])), Buffer.from(png, 'base64'));

    const edited = draft('4', {
        date: '2030-05-05',
        locality: '无锡市',
        desc_md: 'data/travel-diary/2030/2030-05-05-wuxi.md',
        photo_folder: 'data/photos/wuxi',
        photos: [...created.photos]
    });
    const response = await put(created.desc_md, edited);
    assert.equal(response.status, 200);
    const updated = (await response.json()).record;
    assert.equal(updated.desc_md, 'data/travel-diary/2030/2030-05-05-wuxi.md');
    assert.equal(updated.photo_folder, 'data/photos/wuxi');
    assert.deepEqual(updated.photos, created.photos);
    assert.deepEqual(await fs.readFile(path.join(root, 'data/photos/wuxi', created.photos[0])), Buffer.from(png, 'base64'));
    await assert.rejects(fs.stat(path.join(root, created.desc_md)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(root, oldFolder)), { code: 'ENOENT' });
});

test('目的地变更时仍被其他记录引用的媒体不会被删除', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=';
    const created = (await (await post({
        ...draft('3', { date: '2030-06-06', locality: '苏州市-3' }),
        uploads: [{ id: '3'.repeat(32), name: '分享.png', data: png }]
    })).json()).record;
    const sharedFolder = created.photo_folder;
    const sharedName = created.photos[0];

    const referencing = draft('e', {
        date: '2030-06-07',
        locality: '苏州市-e',
        photo_folder: sharedFolder,
        photos: [sharedName]
    });
    assert.equal((await post(referencing)).status, 201);

    const edited = draft('3', {
        date: '2030-06-06',
        locality: '无锡市-3',
        desc_md: 'data/travel-diary/2030/2030-06-06-wuxi.md',
        photo_folder: 'data/photos/wuxi',
        photos: [sharedName]
    });
    assert.equal((await put(created.desc_md, edited)).status, 200);
    assert.deepEqual(await fs.readFile(path.join(root, 'data/photos/wuxi', sharedName)), Buffer.from(png, 'base64'));
    assert.deepEqual(await fs.readFile(path.join(root, sharedFolder, sharedName)), Buffer.from(png, 'base64'));
});

test('默认同步删除照片与视频，保留其他日记引用的文件和未列入记录的文件', async () => {
    const input = {
        date: '2032-01-01', locality: '媒体删除',
        photo_folder: 'data/photos/sync-delete', photos: ['removed.png', 'shared.png'],
        video_folder: 'data/videos/sync-delete', videos: ['removed.mp4', 'shared.mp4']
    };
    for (const [folder, names] of [[input.photo_folder, [...input.photos, 'unlisted.png']], [input.video_folder, [...input.videos, 'unlisted.mp4']]]) {
        await fs.mkdir(path.join(root, folder), { recursive: true });
        for (const name of names) await fs.writeFile(path.join(root, folder, name), name);
    }
    const value = draft('a', input);
    const created = (await (await post(value)).json()).record;
    assert.equal((await post(draft('b', { ...input, date: '2032-01-02', photos: ['shared.png'], videos: ['shared.mp4'] }))).status, 201);
    const edited = { ...value, input: { ...value.input, photos: [], videos: [] } };
    assert.equal((await put(created.desc_md, edited)).status, 200);
    for (const folder of [input.photo_folder, input.video_folder]) {
        const extension = folder.startsWith('data/photos/') ? 'png' : 'mp4';
        await assert.rejects(fs.stat(path.join(root, folder, `removed.${extension}`)), { code: 'ENOENT' });
        for (const name of [`shared.${extension}`, `unlisted.${extension}`]) {
            assert.equal(await fs.readFile(path.join(root, folder, name), 'utf8'), name);
        }
        assert.equal((await fs.readdir(path.join(root, folder))).some(name => name.endsWith('.bak')), false);
    }
});

test('ZIP 保存可关闭真实文件同步，只更新删除与目录引用且仍写入新媒体', async () => {
    const input = {
        date: '2032-02-01', locality: '媒体引用',
        photo_folder: 'data/photos/references-only', photos: ['keep.png', 'removed.png'],
        video_folder: 'data/videos/references-only', videos: ['keep.mp4', 'removed.mp4']
    };
    for (const [folder, names] of [[input.photo_folder, input.photos], [input.video_folder, input.videos]]) {
        await fs.mkdir(path.join(root, folder), { recursive: true });
        for (const name of names) await fs.writeFile(path.join(root, folder, name), name);
    }
    const value = draft('a', input);
    const created = (await (await post(value)).json()).record;
    const edited = { ...value, input: { ...value.input, photo_folder: 'data/photos/references-target', photos: ['keep.png'], video_folder: 'data/videos/references-target', videos: ['keep.mp4'] } };
    const response = await sendRecord(`${base}/api/travel-records`, {
        method: 'PUT', headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': token, Cookie: cookie, Origin: base },
        body: await createDraftBlob(edited, { originalDescMd: created.desc_md, syncMediaFiles: false })
    });
    assert.equal(response.status, 200);
    const updated = (await response.json()).record;
    assert.equal(updated.photo_folder, edited.input.photo_folder);
    assert.deepEqual(updated.photos, ['keep.png']);
    assert.equal(updated.video_folder, edited.input.video_folder);
    assert.deepEqual(updated.videos, ['keep.mp4']);
    for (const [folder, names] of [[input.photo_folder, input.photos], [input.video_folder, input.videos]]) {
        for (const name of names) assert.equal(await fs.readFile(path.join(root, folder, name), 'utf8'), name);
    }
    for (const folder of [updated.photo_folder, updated.video_folder]) await assert.rejects(fs.stat(path.join(root, folder)), { code: 'ENOENT' });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=', 'base64');
    const uploaded = { ...edited, uploads: [{ id: 'b'.repeat(32), name: 'new.png', data: png.toString('base64') }] };
    const uploadResponse = await put(created.desc_md, uploaded, {}, undefined, { syncMediaFiles: false });
    assert.equal(uploadResponse.status, 200);
    const withUpload = (await uploadResponse.json()).record;
    assert.deepEqual(await fs.readFile(path.join(root, withUpload.photo_folder, withUpload.photos.at(-1))), png);
    assert.equal(await fs.readFile(path.join(root, input.photo_folder, 'keep.png'), 'utf8'), 'keep.png');
});

test('ZIP 默认删除最后一张照片和视频，并清理空目录及空父目录', async () => {
    const input = {
        date: '2032-04-01', locality: '清空媒体目录',
        photo_folder: 'data/photos/empty-parent/leaf', photos: ['last.png', 'last.png'],
        video_folder: 'data/videos/empty-parent/leaf', videos: ['last.mp4']
    };
    for (const [folder, name] of [[input.photo_folder, 'last.png'], [input.video_folder, 'last.mp4']]) {
        await fs.mkdir(path.join(root, folder), { recursive: true });
        await fs.writeFile(path.join(root, folder, name), name);
    }
    const value = draft('a', input);
    const created = (await (await post(value)).json()).record;
    const response = await sendRecord(`${base}/api/travel-records`, {
        method: 'PUT', headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': token, Cookie: cookie, Origin: base },
        body: await createDraftBlob({ ...value, input: { ...value.input, photos: [], videos: [] } }, { originalDescMd: created.desc_md })
    });
    assert.equal(response.status, 200);
    for (const type of ['photos', 'videos']) {
        await assert.rejects(fs.stat(path.join(root, 'data', type, 'empty-parent')), { code: 'ENOENT' });
        assert.equal((await fs.stat(path.join(root, 'data', type))).isDirectory(), true);
    }
});

test('同步保存清理已无媒体的空目录，关闭同步保留目录，有其他文件的父目录保留', async () => {
    const input = {
        date: '2032-04-02', locality: '已有空目录',
        photo_folder: 'data/photos/empty-existing/leaf', photos: [],
        video_folder: 'data/videos/empty-existing/leaf', videos: []
    };
    for (const folder of [input.photo_folder, input.video_folder]) await fs.mkdir(path.join(root, folder), { recursive: true });
    const sibling = path.join(root, 'data/photos/empty-existing/keep.txt');
    await fs.writeFile(sibling, '保留其他文件');
    const value = draft('a', input);
    const created = (await (await post(value)).json()).record;
    assert.equal((await put(created.desc_md, value, {}, undefined, { syncMediaFiles: false })).status, 200);
    for (const folder of [input.photo_folder, input.video_folder]) assert.equal((await fs.stat(path.join(root, folder))).isDirectory(), true);
    assert.equal((await put(created.desc_md, value)).status, 200);
    for (const folder of [input.photo_folder, input.video_folder]) await assert.rejects(fs.stat(path.join(root, folder)), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(root, 'data/videos/empty-existing')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(sibling, 'utf8'), '保留其他文件');
});

test('同步移动照片与视频并移除列表中的文件，后续写入失败时恢复全部原文件', async () => {
    const input = {
        date: '2032-03-01', locality: '媒体回滚',
        photo_folder: 'data/photos/sync-rollback', photos: ['keep.png', 'removed.png'],
        video_folder: 'data/videos/sync-rollback', videos: ['keep.mp4', 'removed.mp4']
    };
    for (const [folder, names] of [[input.photo_folder, input.photos], [input.video_folder, input.videos]]) {
        await fs.mkdir(path.join(root, folder), { recursive: true });
        for (const name of names) await fs.writeFile(path.join(root, folder, name), name);
    }
    const value = draft('a', input);
    const created = (await (await post(value)).json()).record;
    const targetMarkdown = 'data/travel-diary/2032/2032-03-01-occupied.md';
    await fs.writeFile(path.join(root, targetMarkdown), '# 已有文件\n');
    const edited = { ...value, input: { ...value.input, desc_md: targetMarkdown, photo_folder: 'data/photos/sync-moved', photos: ['keep.png'], video_folder: 'data/videos/sync-moved', videos: ['keep.mp4'] } };
    const previous = await readIndex();
    assert.equal((await put(created.desc_md, edited)).status, 409);
    assert.deepEqual(await readIndex(), previous);
    for (const [folder, names] of [[input.photo_folder, input.photos], [input.video_folder, input.videos]]) {
        assert.deepEqual((await fs.readdir(path.join(root, folder))).sort(), [...names].sort());
        for (const name of names) assert.equal(await fs.readFile(path.join(root, folder, name), 'utf8'), name);
    }
    for (const folder of [edited.input.photo_folder, edited.input.video_folder]) await assert.rejects(fs.stat(path.join(root, folder)), { code: 'ENOENT' });
    edited.input.desc_md = created.desc_md;
    const rename = fs.rename;
    for (const stage of ['media', 'index']) {
        fs.rename = async (from, to) => {
            if ((stage === 'media' && from === path.join(root, input.video_folder, 'keep.mp4'))
                || (stage === 'index' && to === path.join(root, 'data/travel_data.json'))) throw new Error(`模拟 ${stage} 提交失败`);
            return rename(from, to);
        };
        try { assert.equal((await put(created.desc_md, edited)).status, 500); }
        finally { fs.rename = rename; }
        assert.deepEqual(await readIndex(), previous);
        for (const [folder, names] of [[input.photo_folder, input.photos], [input.video_folder, input.videos]]) {
            assert.deepEqual((await fs.readdir(path.join(root, folder))).sort(), [...names].sort());
            for (const name of names) assert.equal(await fs.readFile(path.join(root, folder, name), 'utf8'), name);
        }
        for (const folder of [edited.input.photo_folder, edited.input.video_folder]) await assert.rejects(fs.stat(path.join(root, folder)), { code: 'ENOENT' });
        await assert.rejects(fs.stat(path.join(root, '.travel-data.lock')), { code: 'ENOENT' });
    }
    assert.equal((await put(created.desc_md, edited, {}, undefined, { syncMediaFiles: 'false' })).status, 400);
    assert.equal((await put(created.desc_md, edited, {}, undefined, { syncMediaFiles: true })).status, 200);
    for (const [folder, name] of [[edited.input.photo_folder, 'keep.png'], [edited.input.video_folder, 'keep.mp4']]) {
        assert.equal(await fs.readFile(path.join(root, folder, name), 'utf8'), name);
    }
    for (const folder of [input.photo_folder, input.video_folder]) await assert.rejects(fs.stat(path.join(root, folder)), { code: 'ENOENT' });
});


test('媒体混合顺序拒绝缺项、重复和越界，并兼容未指定顺序的旧草稿', () => {
    const value = draft('d', { photo_folder: 'data/photos/order', photos: ['a.png', 'b.png'] });
    for (const order of [[0], [0, 0], [0, 2], [-1, 0], [0, 0.5], [0,,], '0,1']) {
        assert.throws(() => readDraft({ ...value, mediaOrder: { photos: order } }), /媒体顺序/);
    }
    for (const mediaOrder of [null, [], 'bad']) assert.throws(() => readDraft({ ...value, mediaOrder }), /媒体顺序/);
    assert.deepEqual(readDraft(value), value);
    assert.deepEqual(prepareRecord({ ...value, mediaOrder: { photos: [1, 0] } }, countries).record.photos, ['b.png', 'a.png']);
});

test('混合排序草稿 ZIP 往返保持图片、视频顺序及原始媒体', async () => {
    const value = { ...draft('d', { photo_folder: 'data/photos/order', photos: ['a.png', 'b.png'], video_folder: 'data/videos/order', videos: ['old.webm'] }),
        uploads: [
            { id: 'a'.repeat(32), name: 'new.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=' },
            { id: 'b'.repeat(32), name: 'new.webm', data: Buffer.from('\x1aE\xdf\xa3video', 'latin1').toString('base64') }
        ], mediaOrder: { photos: [0, 2, 1], videos: [1, 0], sequence: ['photo', 'video', 'photo', 'video', 'photo'] } };
    const { draft: restored } = await (await import('../js/draft-archive.mjs')).readRecordSource(await createDraftBlob(value));
    assert.deepEqual(restored.mediaOrder, value.mediaOrder);
    const { record } = prepareRecord(restored, countries);
    assert.deepEqual(record.photos, ['a.png', 'new.png', 'b.png']);
    assert.deepEqual(record.videos, ['new.webm', 'old.webm']);
    assert.deepEqual(record.media_order, ['photo:a.png', 'video:new.webm', 'photo:new.png', 'video:old.webm', 'photo:b.png']);
});

test('跨类型顺序拒绝缺项与错误类型，元数据快照识别仅统一顺序的变化', () => {
    const value = draft('d', { photo_folder: 'data/photos/order', photos: ['a.png'], video_folder: 'data/videos/order', videos: ['a.mp4'] });
    for (const sequence of [null, 'photo,video', [], ['photo'], ['photo', 'photo'], ['video', 'unknown'], ['photo', 'video', 'video']]) {
        assert.throws(() => readDraft({ ...value, mediaOrder: { sequence } }), /媒体顺序/);
    }
    const { record } = prepareRecord({ ...value, mediaOrder: { sequence: ['video', 'photo'] } }, countries);
    assert.deepEqual(record.media_order, ['video:a.mp4', 'photo:a.png']);
    assert.notEqual(recordMetadataSnapshot(record), recordMetadataSnapshot({ ...record, media_order: [...record.media_order].reverse() }));
});

test('图片视频交错顺序真实落盘、重试及重新编辑保持顺序与原文件', async () => {
    const folder = 'data/photos/cross-type';
    const videoFolder = 'data/videos/cross-type';
    await fs.mkdir(path.join(root, folder), { recursive: true });
    await fs.mkdir(path.join(root, videoFolder), { recursive: true });
    await fs.writeFile(path.join(root, folder, 'first.png'), 'first');
    await fs.writeFile(path.join(root, folder, 'last.png'), 'last');
    await fs.writeFile(path.join(root, videoFolder, 'middle.mp4'), 'middle');
    const value = { ...draft('f', { date: '2038-03-03', locality: '跨类型顺序', photo_folder: folder, photos: ['first.png', 'last.png'], video_folder: videoFolder, videos: ['middle.mp4'] }),
        mediaOrder: { photos: [0, 1], videos: [0], sequence: ['photo', 'video', 'photo'] } };
    const response = await post(value);
    assert.equal(response.status, 201);
    const created = (await response.json()).record;
    assert.deepEqual(created.media_order, ['photo:first.png', 'video:middle.mp4', 'photo:last.png']);
    assert.deepEqual((await readIndex()).find(record => record.desc_md === created.desc_md).media_order, created.media_order);
    assert.equal((await post(value)).status, 200);
    const edited = { ...value, input: { ...value.input, desc_md: created.desc_md },
        mediaOrder: { photos: [1, 0], videos: [0], sequence: ['video', 'photo', 'photo'] } };
    const updatedResponse = await put(created.desc_md, edited);
    assert.equal(updatedResponse.status, 200);
    const updated = (await updatedResponse.json()).record;
    assert.deepEqual(updated.media_order, ['video:middle.mp4', 'photo:last.png', 'photo:first.png']);
    const unchanged = await readIndex();
    assert.equal((await put(created.desc_md, { ...edited, mediaOrder: { sequence: ['photo'] } })).status, 400);
    assert.deepEqual(await readIndex(), unchanged);
    for (const [name, content] of [['first.png', 'first'], ['last.png', 'last']]) assert.equal(await fs.readFile(path.join(root, folder, name), 'utf8'), content);
    assert.equal(await fs.readFile(path.join(root, videoFolder, 'middle.mp4'), 'utf8'), 'middle');
});

test('新旧图片交错排序真实落盘、重试与修改后文件内容保持对应', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=', 'base64');
    const first = Buffer.concat([png, Buffer.from('first')]);
    const second = Buffer.concat([png, Buffer.from('second')]);
    const source = 'data/photos/mixed-order-source';
    await fs.mkdir(path.join(root, source), { recursive: true });
    await fs.writeFile(path.join(root, source, 'first.png'), first);
    await fs.writeFile(path.join(root, source, 'second.png'), second);
    const value = { ...draft('d', { date: '2038-01-01', locality: '混排测试', photo_folder: source, photos: ['first.png', 'second.png'] }),
        uploads: [{ id: 'a'.repeat(32), name: 'new.png', data: png.toString('base64') }], mediaOrder: { photos: [0, 2, 1] } };
    const response = await post(value);
    assert.equal(response.status, 201);
    const created = (await response.json()).record;
    assert.deepEqual(created.photos, ['first.png', 'new.png', 'second.png']);
    for (const [name, bytes] of [['first.png', first], ['second.png', second], ['new.png', png]]) {
        assert.deepEqual(await fs.readFile(path.join(root, created.photo_folder, name)), bytes);
    }
    assert.equal((await post(value)).status, 200);
    assert.equal((await post({ ...value, uploads: [{ ...value.uploads[0], data: first.toString('base64') }] })).status, 409);

    const third = Buffer.concat([png, Buffer.from('third!')]);
    const edited = { ...draft('d', { date: '2038-01-01', locality: '混排测试', photo_folder: created.photo_folder, photos: created.photos }),
        uploads: [{ id: 'b'.repeat(32), name: 'another.png', data: third.toString('base64') }], mediaOrder: { photos: [3, 0, 2, 1] } };
    const updatedResponse = await put(created.desc_md, edited);
    assert.equal(updatedResponse.status, 200);
    const updated = (await updatedResponse.json()).record;
    assert.deepEqual(updated.photos, ['another.png', 'first.png', 'second.png', 'new.png']);
    assert.deepEqual(await fs.readFile(path.join(root, updated.photo_folder, 'another.png')), third);
    assert.deepEqual(await fs.readFile(path.join(root, updated.photo_folder, 'new.png')), png);
    assert.deepEqual(await fs.readFile(path.join(root, updated.photo_folder, 'first.png')), first);

    const unchanged = await readIndex();
    assert.equal((await put(created.desc_md, { ...edited, mediaOrder: { photos: [0, 0, 1, 2] } })).status, 400);
    assert.deepEqual(await readIndex(), unchanged);
});

test('关闭真实文件同步仍按混合顺序写入新增图片并保留已有文件', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=';
    const value = { ...draft('e', { date: '2038-02-02', locality: '关闭同步混排' }), uploads: [{ id: 'c'.repeat(32), name: 'old.png', data: png }] };
    const created = (await (await post(value)).json()).record;
    const newPng = Buffer.concat([Buffer.from(png, 'base64'), Buffer.from('new')]).toString('base64');
    const edited = { ...draft('e', { date: '2038-02-02', locality: '关闭同步混排', photo_folder: created.photo_folder, photos: created.photos }),
        uploads: [{ id: 'd'.repeat(32), name: 'new.png', data: newPng }], mediaOrder: { photos: [1, 0] } };
    const response = await put(created.desc_md, edited, {}, undefined, { syncMediaFiles: false });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).record.photos, ['new.png', 'old.png']);
    for (const name of ['old.png', 'new.png']) assert.deepEqual(await fs.readFile(path.join(root, created.photo_folder, name)), Buffer.from(name === 'new.png' ? newPng : png, 'base64'));
});
