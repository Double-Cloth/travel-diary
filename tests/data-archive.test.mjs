import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createZip, readZip } from '../js/zip-archive.mjs';
import { AUTH_CONFIG, installAuth } from './helpers/auth.mjs';

const require = createRequire(import.meta.url);
const { exportDataArchive, importDataArchive } = require('../js/data-archive.js');
const { writeDataBackup } = require('../scripts/build-data-backup.js');

async function fixture(t, prefix = 'travel-diary-archive-') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    t.after(async () => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');
    await installAuth(root);
    return root;
}

test('完整 ZIP 保留 data 与认证配置并可共同恢复', async t => {
    const root = await fixture(t);
    await fs.mkdir(path.join(root, 'data/travel-diary/2026'), { recursive: true });
    await fs.mkdir(path.join(root, 'data/photos/suzhou'), { recursive: true });
    const record = { date: '2026-09-11', country: '中国', country_code: 'CN', admin_area: '江苏省', locality: '苏州市', desc_md: 'data/travel-diary/2026/2026-09-11-suzhou.md', photo_folder: 'data/photos/suzhou', photos: ['lake.png'] };
    await fs.writeFile(path.join(root, 'data/travel_data.json'), JSON.stringify([record]));
    await fs.writeFile(path.join(root, record.desc_md), '# 苏州\n');
    await fs.writeFile(path.join(root, record.photo_folder, record.photos[0]), Buffer.from([1, 2, 3]));

    const archive = await exportDataArchive(root, { includeAuth: true });
    assert.deepEqual(readZip(archive).map(entry => entry.name).sort(), [
        '.secrets/auth.json',
        'data/photos/suzhou/lake.png',
        'data/travel-diary/2026/2026-09-11-suzhou.md',
        'data/travel_data.json'
    ]);
    await fs.writeFile(path.join(root, 'data/travel_data.json'), '[]');
    const result = await importDataArchive(root, archive, { requireProductionAuth: true });
    assert.deepEqual(result, { files: 4, authPreserved: false });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8')), [record]);
    assert.deepEqual(await fs.readFile(path.join(root, record.photo_folder, record.photos[0])), Buffer.from([1, 2, 3]));
    assert.equal(JSON.parse(await fs.readFile(path.join(root, '.secrets/auth.json'), 'utf8')).hash, AUTH_CONFIG.hash);
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.travel-')), false);
});

test('旧备份没有认证配置时保留当前认证，旧明文密码不会重新写入', async t => {
    const root = await fixture(t, 'travel-diary-archive-legacy-');
    const archive = createZip([
        { name: 'data/travel_data.json', data: '[]' },
        { name: 'data/password.json', data: '{"password":"123456"}' }
    ]);
    const result = await importDataArchive(root, archive, { requireProductionAuth: true });
    assert.deepEqual(result, { files: 2, authPreserved: true });
    await assert.rejects(fs.access(path.join(root, 'data/password.json')));
    assert.equal(JSON.parse(await fs.readFile(path.join(root, '.secrets/auth.json'), 'utf8')).hash, AUTH_CONFIG.hash);
});

test('导入拒绝越界路径、缺失正文及非法认证配置', async t => {
    const root = await fixture(t, 'travel-diary-archive-invalid-');
    await assert.rejects(importDataArchive(root, createZip([{ name: 'other/file.txt', data: 'x' }])), /只能包含 data/);
    const record = [{ date: '2026-09-11', country: '中国', country_code: 'CN', admin_area: '江苏省', locality: '苏州市', desc_md: 'data/travel-diary/2026/2026-09-11-missing.md', photo_folder: '', photos: [] }];
    await assert.rejects(importDataArchive(root, createZip([{ name: 'data/travel_data.json', data: JSON.stringify(record) }])), /缺少正文文件/);
    await assert.rejects(importDataArchive(root, createZip([
        { name: 'data/travel_data.json', data: '[]' },
        { name: '.secrets/auth.json', data: '{}' }
    ])), /认证配置无效/);
    await assert.rejects(importDataArchive(root, createZip([
        { name: 'data/travel_data.json', data: '[]' },
        { name: '.SECRETS/auth.json', data: JSON.stringify(AUTH_CONFIG) }
    ])), /安全文件路径/);
    assert.equal(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'), '[]');
});

test('remote 导入拒绝兼容期弱认证配置', async t => {
    const root = await fixture(t, 'travel-diary-archive-weak-auth-');
    const weak = { ...AUTH_CONFIG, policy: { minimumLength: 6, productionReady: false } };
    const archive = createZip([
        { name: 'data/travel_data.json', data: '[]' },
        { name: '.secrets/auth.json', data: JSON.stringify(weak) }
    ]);
    await assert.rejects(importDataArchive(root, archive, { requireProductionAuth: true }), /生产级口令/);
});

test('备份导入与记录保存使用相同日期校验，支持低年份与世纪闰年', async t => {
    const root = await fixture(t, 'travel-diary-archive-dates-');
    for (const date of ['0004-02-29', '0099-12-31', '2000-02-29']) {
        const record = { date, country: '中国', country_code: 'CN', admin_area: '', locality: '测试',
            desc_md: `data/travel-diary/${date.slice(0, 4)}/${date}-test.md`, photo_folder: '', photos: [] };
        const archive = createZip([
            { name: 'data/travel_data.json', data: JSON.stringify([record]) },
            { name: record.desc_md, data: '# 测试\n' }
        ]);
        await importDataArchive(root, archive);
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8')), [record]);
    }
});

test('导入在写入前拒绝无效字段、路径大小写冲突、文件目录重名及跨平台非法字符', async t => {
    const root = await fixture(t, 'travel-diary-archive-paths-');
    const invalidRecord = [{ date: '2026-02-30', country: '中国', country_code: 'cn', admin_area: '', locality: '苏州市', desc_md: 'data/travel-diary/2026/2026-02-30-suzhou.md', photo_folder: '', photos: [] }];
    await assert.rejects(importDataArchive(root, createZip([
        { name: 'data/travel_data.json', data: JSON.stringify(invalidRecord) },
        { name: 'data/travel-diary/2026/2026-02-30-suzhou.md', data: '# 苏州' }
    ])), /date 必须是有效/);

    for (const names of [
        ['data/Photos/a.png', 'data/photos/b.png'],
        ['data/file', 'data/file/child'],
        ['data/file/child', 'data/file'],
        ...['<', '>', '"', '|', '?', '*'].map(character => [`data/test${character}.txt`])
    ]) {
        const archive = createZip([
            { name: 'data/travel_data.json', data: '[]' },
            ...names.map(name => ({ name, data: 'x' }))
        ]);
        await assert.rejects(importDataArchive(root, archive), error => error.status === 400);
        assert.equal(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'), '[]');
    }
});

test('静态站点备份只发布 data，不泄露认证哈希', async t => {
    const root = await fixture(t, 'travel-diary-static-backup-');
    const outputFile = path.join(root, '_site/travel-diary-data.zip');
    const result = await writeDataBackup(root, outputFile);
    const archive = await fs.readFile(outputFile);
    assert.equal(result.bytes, archive.length);
    assert.deepEqual(readZip(archive).map(entry => entry.name), ['data/travel_data.json']);
});
