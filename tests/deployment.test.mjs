import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createZip } from './helpers/zip-archive.mjs';
import { backupBundle, restoreBundle, verifyBundle } from '../scripts/deployment-backup.js';
import { loadRuntimeConfig } from '../js/runtime-config.js';
import { ensureDataStructure, listenWithRetries, stopServer, parseArgs } from '../js/server.js';
import { installAuth, AUTH_CONFIG } from './helpers/auth.mjs';

async function fixture(t) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-deployment-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const root = path.join(base, 'runtime');
    await fs.mkdir(root);
    await ensureDataStructure(root);
    await installAuth(root);
    return { root, base };
}

test('环境变量覆盖 JSON，CLI 覆盖环境，配置检查与启动使用相同结果', async t => {
    const { root } = await fixture(t);
    await fs.writeFile(path.join(root, 'travel-diary.config.local.json'), '{"server":{"port":9010,"local":true}}');
    const environment = { TRAVEL_PORT: '9020', TRAVEL_LOCAL: 'false', TRAVEL_MAX_PORT_RETRIES: '1',
        TRAVEL_WRITE_MODE: 'remote', TRAVEL_ALLOWED_ORIGINS: '["https://diary.example"]', TRAVEL_MEDIA_PREVIEWS_ENABLED: 'false' };
    const config = loadRuntimeConfig(root, environment);
    assert.deepEqual(config.server, { port: 9020, local: false, maxPortRetries: 1,
        writeMode: 'remote', allowedOrigins: ['https://diary.example'] });
    assert.equal(config.mediaPreviews.enabled, false);
    const previous = { ...process.env };
    Object.assign(process.env, environment);
    t.after(() => { for (const name of Object.keys(environment)) {
        if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    } });
    const args = parseArgs(['--dir', root, '--port', '9030', '--local', '--allowed-origin', 'https://override.example']);
    assert.equal(args.port, 9030);
    assert.equal(args.local, true);
    assert.deepEqual(args.allowedOrigins, ['https://override.example']);
    const { checkRuntimeConfig } = await import('../scripts/check-runtime-config.js');
    assert.deepEqual((await checkRuntimeConfig(['--dir', root])).server, config.server);
});

test('环境变量错误值明确报告变量名', async t => {
    const { root } = await fixture(t);
    for (const [name, value] of [
        ['TRAVEL_PORT', ''], ['TRAVEL_PORT', '1e3'], ['TRAVEL_PORT', '65536'], ['TRAVEL_LOCAL', '0'],
        ['TRAVEL_WRITE_MODE', 'public'], ['TRAVEL_MAX_PORT_RETRIES', '0'],
        ['TRAVEL_MEDIA_PREVIEWS_ENABLED', 'FALSE'], ['TRAVEL_ALLOWED_ORIGINS', 'https://diary.example'],
        ['TRAVEL_ALLOWED_ORIGINS', '["http://diary.example"]'], ['TRAVEL_ALLOWED_ORIGINS', '["https://diary.example/path"]']
    ]) assert.throws(() => loadRuntimeConfig(root, { [name]: value }), error => error.message.includes(name));
});

test('健康接口不缓存、不泄漏内容，缺少数据返回未就绪，停止可重复调用', async t => {
    const { root } = await fixture(t);
    const { server } = await listenWithRetries(root, 0, false, { generateMediaPreviews: false });
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const route of ['healthz', 'readyz']) {
        const response = await fetch(`${base}/${route}`);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'ok\n');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.equal((await fetch(`${base}/healthz`, { method: 'POST' })).status, 405);
    await fs.unlink(path.join(root, 'data/travel_data.json'));
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const stopping = stopServer(server, 1000);
    assert.equal(stopServer(server, 1000), stopping);
    await stopping;
});

test('停止等待连接关闭后尚未完成的提交，超时明确报错', async t => {
    const { root } = await fixture(t);
    const { server } = await listenWithRetries(root, 0, false);
    let complete;
    server.lifecycle.pending.add(new Promise(resolve => { complete = resolve; }));
    let stopped = false;
    const task = stopServer(server, 1000).then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(stopped, false);
    complete();
    await task;
    const second = await listenWithRetries(root, 0, false);
    second.server.lifecycle.pending.add(new Promise(() => {}));
    await assert.rejects(stopServer(second.server, 20), /活动写入可能尚未完成/);
});

test('运维备份恢复包含媒体、密码、回收站，保留恢复前备份和回退目录', async t => {
    const { root, base } = await fixture(t);
    await fs.mkdir(path.join(root, '.cache/recycle-bin/example'), { recursive: true });
    await fs.writeFile(path.join(root, '.cache/recycle-bin/example/item.json'), '{"test":true}');
    await fs.writeFile(path.join(root, 'data/profile/owner-name.txt'), '虚拟测试用户');
    const directory = path.join(base, 'backup');
    await backupBundle(root, directory);
    await verifyBundle(directory);
    if (process.platform !== 'win32') {
        assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
        assert.equal((await fs.stat(path.join(directory, 'data.zip'))).mode & 0o777, 0o600);
    }
    await assert.rejects(backupBundle(root, directory), { code: 'EEXIST' });
    await assert.rejects(backupBundle(root, path.join(root, 'data/backup')), /运行目录之外/);
    await assert.rejects(restoreBundle(root, directory), /显式确认/);
    await fs.writeFile(path.join(root, 'data/profile/owner-name.txt'), '恢复前用户');
    await fs.rm(path.join(root, '.cache/recycle-bin'), { recursive: true });
    const result = await restoreBundle(root, directory, { confirm: true, backupDirectory: path.join(base, 'before-restore') });
    assert.equal(await fs.readFile(path.join(root, 'data/profile/owner-name.txt'), 'utf8'), '虚拟测试用户');
    assert.equal(await fs.readFile(path.join(root, '.cache/recycle-bin/example/item.json'), 'utf8'), '{"test":true}');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, '.secrets/auth.json'))), AUTH_CONFIG);
    assert.equal(await fs.readFile(path.join(result.rollback, 'data/profile/owner-name.txt'), 'utf8'), '恢复前用户');
    await verifyBundle(path.join(base, 'before-restore'));
});

test('损坏备份、链接和路径穿越在恢复当前数据前拒绝', async t => {
    const { root, base } = await fixture(t);
    const directory = path.join(base, 'backup');
    await backupBundle(root, directory);
    await fs.appendFile(path.join(directory, 'data.zip'), '损坏');
    await assert.rejects(restoreBundle(root, directory, { confirm: true, backupDirectory: path.join(base, 'before') }), /完整性校验失败/);
    assert.equal(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'), '[]\n');
    await fs.symlink(path.join(root, 'data'), path.join(base, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(backupBundle(root, path.join(base, 'alias/backup')), /运行目录之外/);
    const malicious = path.join(base, 'malicious');
    await backupBundle(root, malicious);
    const zip = Buffer.from(createZip([{ name: '.cache/recycle-bin/xx/xx/outside.txt', data: '越界数据' }]));
    for (let offset = zip.indexOf('/xx/xx/'); offset !== -1; offset = zip.indexOf('/xx/xx/', offset + 7)) {
        zip.write('/../../', offset);
    }
    await fs.writeFile(path.join(malicious, 'recycle-bin.zip'), zip);
    const manifest = JSON.parse(await fs.readFile(path.join(malicious, 'manifest.json')));
    manifest.files['recycle-bin.zip'] = { bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex') };
    await fs.writeFile(path.join(malicious, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(restoreBundle(root, malicious, { confirm: true, backupDirectory: path.join(base, 'before-malicious') }), /路径/);
    assert.equal(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'), '[]\n');
});

test('恢复安装中途失败时回退已经替换的数据目录', async t => {
    const { root, base } = await fixture(t);
    await fs.writeFile(path.join(root, 'data/profile/owner-name.txt'), '旧归档');
    const directory = path.join(base, 'backup');
    await backupBundle(root, directory);
    await fs.writeFile(path.join(root, 'data/profile/owner-name.txt'), '当前数据');
    const rename = fs.rename;
    fs.rename = async (source, destination) => {
        if (source.includes('.travel-restore-stage-') && destination === path.join(root, '.secrets')) {
            throw Object.assign(new Error('模拟认证目录安装失败'), { code: 'EACCES' });
        }
        return rename(source, destination);
    };
    try {
        await assert.rejects(restoreBundle(root, directory, { confirm: true, backupDirectory: path.join(base, 'before-failure') }), /模拟认证目录安装失败/);
    } finally { fs.rename = rename; }
    assert.equal(await fs.readFile(path.join(root, 'data/profile/owner-name.txt'), 'utf8'), '当前数据');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, '.secrets/auth.json'))), AUTH_CONFIG);
    assert.equal((await fs.readdir(root)).includes('.travel-data.lock'), false);
});
