import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createZip, readZip } from '../js/zip-archive.mjs';

const require = createRequire(import.meta.url);
const { exportDataArchive, importDataArchive } = require('../js/data-archive.js');
const { writeDataBackup } = require('../scripts/build-data-backup.js');

test('全部数据 ZIP 保留 data 目录结构并可原子恢复', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-diary-archive-'));
    t.after(async () => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'data/travel-diary/2026'), { recursive: true });
    await fs.mkdir(path.join(root, 'data/photos/suzhou'), { recursive: true });
    const record = { date: '2026-09-11', country: '中国', country_code: 'CN', admin_area: '江苏省', locality: '苏州市', desc_md: 'data/travel-diary/2026/2026-09-11-suzhou.md', photo_folder: 'data/photos/suzhou', photos: ['lake.png'] };
    await fs.writeFile(path.join(root, 'data/travel_data.json'), JSON.stringify([record]));
    await fs.writeFile(path.join(root, 'data/password.json'), JSON.stringify({ password: '123456' }));
    await fs.writeFile(path.join(root, record.desc_md), '# 苏州\n');
    await fs.writeFile(path.join(root, record.photo_folder, record.photos[0]), Buffer.from([1, 2, 3]));

    const archive = await exportDataArchive(root);
    assert.deepEqual(readZip(archive).map(entry => entry.name).sort(), [
        'data/password.json',
        'data/photos/suzhou/lake.png',
        'data/travel-diary/2026/2026-09-11-suzhou.md',
        'data/travel_data.json'
    ]);
    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');
    const result = await importDataArchive(root, archive);
    assert.equal(result.files, 4);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8')), [record]);
    assert.deepEqual(await fs.readFile(path.join(root, record.photo_folder, record.photos[0])), Buffer.from([1, 2, 3]));
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.travel-data-')), false);
});

test('全部数据导入拒绝越界目录与缺失正文的索引', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-diary-archive-invalid-'));
    t.after(async () => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');
    await assert.rejects(importDataArchive(root, createZip([{ name: 'other/file.txt', data: 'x' }])), /只能包含 data/);
    const record = [{ date: '2026-09-11', country: '中国', country_code: 'CN', admin_area: '江苏省', locality: '苏州市', desc_md: 'data/travel-diary/2026/2026-09-11-missing.md', photo_folder: '', photos: [] }];
    await assert.rejects(importDataArchive(root, createZip([{ name: 'data/travel_data.json', data: JSON.stringify(record) }])), /缺少正文文件/);
    assert.equal(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'), '[]');
});

test('全部数据导入在备份无密码时要求设置密码并写入配置', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-diary-archive-password-'));
    t.after(async () => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');
    const archive = createZip([{ name: 'data/travel_data.json', data: '[]' }]);

    await assert.rejects(
        importDataArchive(root, archive),
        error => error.status === 428 && error.code === 'IMPORT_PASSWORD_REQUIRED'
    );
    assert.equal(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'), '[]');

    const result = await importDataArchive(root, archive, { password: '654321' });
    assert.deepEqual(result, { files: 2, passwordCreated: true });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/password.json'), 'utf8')), { password: '654321' });
});

test('全部数据导入拒绝无效记录字段、密码配置与大小写冲突路径', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-diary-archive-validation-'));
    t.after(async () => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');

    const invalidRecord = [{ date: '2026-02-30', country: '中国', country_code: 'cn', admin_area: '', locality: '苏州市', desc_md: 'data/travel-diary/2026/2026-02-30-suzhou.md', photo_folder: '', photos: [] }];
    await assert.rejects(importDataArchive(root, createZip([
        { name: 'data/travel_data.json', data: JSON.stringify(invalidRecord) },
        { name: 'data/travel-diary/2026/2026-02-30-suzhou.md', data: '# 苏州' },
        { name: 'data/password.json', data: '{"password":"123456"}' }
    ])), /date 必须是有效/);

    await assert.rejects(importDataArchive(root, createZip([
        { name: 'data/travel_data.json', data: '[]' },
        { name: 'data/password.json', data: '{"password":"abc"}' }
    ])), /密码必须是 6 位数字/);

    await assert.rejects(importDataArchive(root, createZip([
        { name: 'data/travel_data.json', data: '[]' },
        { name: 'data/password.json', data: '{"password":"123456"}' },
        { name: 'data/PASSWORD.json', data: '{}' }
    ])), /仅大小写不同的重复路径/);
});

test('静态站点生成可直接通过 HTTP 下载的数据备份文件', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-diary-static-backup-'));
    t.after(async () => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');
    const outputFile = path.join(root, '_site/travel-diary-data.zip');

    const result = await writeDataBackup(root, outputFile);
    const archive = await fs.readFile(outputFile);
    assert.equal(result.bytes, archive.length);
    assert.equal(archive.length > 0, true);
    assert.deepEqual(readZip(archive).map(entry => entry.name), ['data/travel_data.json']);
});
