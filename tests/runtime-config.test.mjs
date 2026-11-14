import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG_FILENAME, LOCAL_CONFIG_FILENAME, loadRuntimeConfig } from '../js/runtime-config.js';
import { createHandler, parseArgs, listenWithRetries } from '../js/server.js';
import { checkRuntimeConfig } from '../scripts/check-runtime-config.js';
import previewBuilder from '../scripts/build-media-previews.js';
import { listenOnFetchSafePort } from './helpers/http.mjs';

async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'travel-runtime-config-'));
    t.after(async () => {
        if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('travel-runtime-config-')) {
            await rm(root, { recursive: true, force: true });
        }
    });
    return root;
}

async function saveConfig(root, config) {
    await writeFile(path.join(root, CONFIG_FILENAME), JSON.stringify(config));
}

test('配置缺失或仅提供部分字段时使用默认值，各次读取互不污染', async t => {
    const root = await fixture(t);
    const config = loadRuntimeConfig(root);
    assert.deepEqual(config, {
        server: { port: 9000, local: true, maxPortRetries: 100, writeMode: 'local', allowedOrigins: [] },
        mediaPreviews: { enabled: true, browserPath: '', progressTimeoutMs: 70000 }
    });
    config.server.allowedOrigins.push('https://diary.example');
    assert.deepEqual(loadRuntimeConfig(root).server.allowedOrigins, []);
    await saveConfig(root, { server: { port: 8080 }, mediaPreviews: { browserPath: './browser', enabled: false } });
    const partial = loadRuntimeConfig(root);
    assert.equal(partial.server.port, 8080);
    assert.equal(partial.server.local, true);
    assert.equal(partial.mediaPreviews.browserPath, path.join(root, 'browser'));
    assert.equal(partial.mediaPreviews.enabled, false);
    assert.equal(partial.mediaPreviews.progressTimeoutMs, 70000);
});

test('配置拒绝损坏 JSON、未知字段、错误类型及越界值，并支持 UTF-8 BOM', async t => {
    const root = await fixture(t);
    await writeFile(path.join(root, CONFIG_FILENAME), '{');
    assert.throws(() => loadRuntimeConfig(root), /无法读取配置文件/);
    for (const config of [
        null, [], { unknown: true }, { $schema: false }, { server: null }, { mediaPreviews: [] },
        { server: { ports: 9000 } }, { server: { port: '9000' } }, { server: { port: 65536 } },
        { server: { local: 'false' } }, { server: { maxPortRetries: 0 } },
        { server: { writeMode: 'public' } }, { server: { allowedOrigins: 'https://example.com' } },
        { server: { allowedOrigins: [123] } }, { mediaPreviews: { enabled: 0 } },
        { mediaPreviews: { browserPath: false } }, { mediaPreviews: { browserPath: '\0' } },
        { mediaPreviews: { progressTimeoutMs: 999 } }, { mediaPreviews: { progressTimeoutMs: 2147483648 } }
    ]) {
        await saveConfig(root, config);
        assert.throws(() => loadRuntimeConfig(root), Error, JSON.stringify(config));
    }
    await writeFile(path.join(root, CONFIG_FILENAME), '\uFEFF{}');
    assert.equal(loadRuntimeConfig(root).server.port, 9000);
});

test('本机配置按字段覆盖共享配置，数组整体替换且各层错误包含文件路径', async t => {
    const root = await fixture(t);
    await saveConfig(root, {
        $schema: './travel-diary.config.schema.json',
        server: { port: 8080, local: false, writeMode: 'remote', allowedOrigins: ['https://shared.example'] },
        mediaPreviews: { enabled: false, progressTimeoutMs: 30000 }
    });
    const localFile = path.join(root, LOCAL_CONFIG_FILENAME);
    await writeFile(localFile, JSON.stringify({
        $schema: './travel-diary.config.schema.json',
        server: { port: 8081, allowedOrigins: ['https://local.example'] },
        mediaPreviews: { browserPath: './browser' }
    }));
    const config = loadRuntimeConfig(root);
    assert.deepEqual(config.server, {
        port: 8081, local: false, maxPortRetries: 100, writeMode: 'remote', allowedOrigins: ['https://local.example']
    });
    assert.deepEqual(config.mediaPreviews, { enabled: false, browserPath: path.join(root, 'browser'), progressTimeoutMs: 30000 });
    assert.equal(parseArgs(['--dir', root, '--port', '8082']).port, 8082);
    for (const invalid of ['{', '{"server":null}', '{"server":{"ports":5}}', '{"server":{"port":0}}']) {
        await writeFile(localFile, invalid);
        assert.throws(() => loadRuntimeConfig(root), error => error.message.includes(localFile));
    }
    await writeFile(localFile, '{"server":{"port":8081}}');
    await saveConfig(root, { server: { port: 0 } });
    assert.throws(() => loadRuntimeConfig(root), error => error.message.includes(path.join(root, CONFIG_FILENAME)));
});

test('仅存在本机配置时可运行，空数组、false 和空路径能够覆盖共享值', async t => {
    const root = await fixture(t);
    await writeFile(path.join(root, LOCAL_CONFIG_FILENAME), '{"server":{"port":8080}}');
    assert.equal(loadRuntimeConfig(root).server.port, 8080);
    await saveConfig(root, { mediaPreviews: { browserPath: './shared-browser', enabled: true }, server: { allowedOrigins: ['https://shared.example'] } });
    await writeFile(path.join(root, LOCAL_CONFIG_FILENAME), '{"server":{"allowedOrigins":[]},"mediaPreviews":{"browserPath":"","enabled":false}}');
    const config = loadRuntimeConfig(root);
    assert.deepEqual(config.server.allowedOrigins, []);
    assert.equal(config.mediaPreviews.browserPath, '');
    assert.equal(config.mediaPreviews.enabled, false);
});

test('检查命令显示覆盖后的配置和浏览器路径，保持项目目录只读', async t => {
    const root = await fixture(t);
    await saveConfig(root, { server: { port: 8080 }, mediaPreviews: { browserPath: './browser' } });
    await mkdir(path.join(root, 'browser'));
    const browser = path.join(root, 'browser', 'chrome.exe');
    await writeFile(browser, 'browser');
    await writeFile(path.join(root, LOCAL_CONFIG_FILENAME), '{"server":{"port":8081}}');
    const before = await readdir(root);
    const previousBrowser = process.env.TRAVEL_BROWSER_PATH;
    delete process.env.TRAVEL_BROWSER_PATH;
    t.after(() => {
        if (previousBrowser === undefined) delete process.env.TRAVEL_BROWSER_PATH;
        else process.env.TRAVEL_BROWSER_PATH = previousBrowser;
    });
    const result = await checkRuntimeConfig(['--dir', root, '--port', '8082']);
    assert.equal(result.server.port, 8082);
    assert.deepEqual(result.configFiles, [path.join(root, CONFIG_FILENAME), path.join(root, LOCAL_CONFIG_FILENAME)]);
    assert.equal(result.browser.resolvedPath, browser);
    assert.equal(result.browser.source, 'mediaPreviews.browserPath');
    process.env.TRAVEL_BROWSER_PATH = process.execPath;
    assert.equal((await checkRuntimeConfig(['--dir', root])).browser.source, 'TRAVEL_BROWSER_PATH');
    assert.equal((await checkRuntimeConfig(['--dir', root])).browser.resolvedPath, process.execPath);
    process.env.TRAVEL_BROWSER_PATH = path.join(root, 'missing-browser');
    await assert.rejects(checkRuntimeConfig(['--dir', root]), /未找到 Edge 或 Chrome/);
    delete process.env.TRAVEL_BROWSER_PATH;
    await saveConfig(root, {});
    const stat = fs.stat;
    const statMock = t.mock.method(fs, 'stat', async target => {
        if (target === root) return stat(target);
        throw Object.assign(new Error('测试环境未安装浏览器'), { code: 'ENOENT' });
    });
    const missing = await checkRuntimeConfig(['--dir', root]);
    assert.equal(missing.browser.resolvedPath, '');
    assert.match(missing.browser.message, /未自动找到 Edge/);
    statMock.mock.restore();
    const script = path.resolve(import.meta.dirname, '../scripts/check-runtime-config.js');
    await saveConfig(root, { mediaPreviews: { browserPath: './browser' } });
    const { stdout } = await promisify(execFile)(process.execPath, [script, '--dir', root]);
    assert.match(stdout, /配置检查通过/);
    await saveConfig(root, { mediaPreviews: { browserPath: './missing-browser' } });
    await assert.rejects(promisify(execFile)(process.execPath, [script, '--dir', root]), error => error.code === 1 && error.stderr.includes('未找到 Edge 或 Chrome'));
    assert.deepEqual(await readdir(root), before);
});

test('配置 Schema 覆盖所有默认字段并提供中文说明', async t => {
    const root = await fixture(t);
    const schema = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../travel-diary.config.schema.json'), 'utf8'));
    assert.equal(schema.additionalProperties, false);
    for (const [section, values] of Object.entries(loadRuntimeConfig(root))) {
        const sectionSchema = schema.properties[section];
        assert.equal(sectionSchema.additionalProperties, false);
        assert.deepEqual(Object.keys(sectionSchema.properties).sort(), Object.keys(values).sort());
        for (const [key, value] of Object.entries(values)) {
            assert.deepEqual(sectionSchema.properties[key].default, value);
            assert.match(sectionSchema.properties[key].description, /[\u4e00-\u9fff]/);
        }
    }
});

test('服务读取 --dir 指向的配置，命令行覆盖配置且来源数组整体替换', async t => {
    const root = await fixture(t);
    await saveConfig(root, { server: { port: 8080, local: false } });
    assert.deepEqual(parseArgs(['--dir', root]), {
        dir: root, port: 8080, local: false, writeMode: 'local', allowedOrigins: []
    });
    assert.equal(parseArgs([`--dir=${root}`, '--port=9001', '--local']).port, 9001);
    assert.equal(parseArgs([`--dir=${root}`, '--local']).local, true);
    await saveConfig(root, { server: { writeMode: 'remote', allowedOrigins: ['https://old.example'] } });
    assert.deepEqual(parseArgs(['--dir', root]).allowedOrigins, ['https://old.example']);
    assert.deepEqual(parseArgs(['--dir', root, '--allowed-origin=https://new.example']).allowedOrigins, ['https://new.example']);
    await saveConfig(root, { server: { writeMode: 'remote', allowedOrigins: ['http://unsafe.example'] } });
    assert.throws(() => parseArgs(['--dir', root]), /HTTPS Origin/);
    await saveConfig(root, { server: { writeMode: 'remote' } });
    assert.throws(() => parseArgs(['--dir', root]), /allowed-origin/);
});

test('端口尝试次数从配置读取，占用时按配置停止', async t => {
    const root = await fixture(t);
    await saveConfig(root, { server: { maxPortRetries: 1 } });
    const occupied = await listenWithRetries(root, 0, false);
    t.after(() => new Promise(resolve => occupied.server.close(resolve)));
    await assert.rejects(listenWithRetries(root, occupied.server.address().port, false), /Unable to find a free port/);
});

test('浏览器路径支持可执行文件及安装目录，配置、环境变量和显式选项按优先级生效', async t => {
    const root = await fixture(t);
    const browserDir = path.join(root, 'browser');
    await mkdir(browserDir);
    const executable = path.join(browserDir, 'chrome.exe');
    await writeFile(executable, 'browser');
    assert.equal(await previewBuilder.findBrowser(browserDir), executable);
    assert.equal(await previewBuilder.findBrowser(executable), executable);
    await saveConfig(root, { mediaPreviews: { browserPath: './configured-browser' } });
    const previousBrowser = process.env.TRAVEL_BROWSER_PATH;
    delete process.env.TRAVEL_BROWSER_PATH;
    t.after(() => {
        if (previousBrowser === undefined) delete process.env.TRAVEL_BROWSER_PATH;
        else process.env.TRAVEL_BROWSER_PATH = previousBrowser;
    });
    const previews = ['/.cache/media-previews/photos/trip/image.png.jpg'];
    const rejectsWithPath = selected => error => error.message.includes(path.join(root, selected));
    await assert.rejects(previewBuilder.buildMediaPreviews(root, { previews }), rejectsWithPath('configured-browser'));
    process.env.TRAVEL_BROWSER_PATH = path.join(root, 'environment-browser');
    await assert.rejects(previewBuilder.buildMediaPreviews(root, { previews }), rejectsWithPath('environment-browser'));
    await assert.rejects(previewBuilder.buildMediaPreviews(root, { previews, browser: path.join(root, 'explicit-browser') }), rejectsWithPath('explicit-browser'));
    const relativeBrowser = path.relative(process.cwd(), path.join(root, 'relative-browser'));
    await assert.rejects(previewBuilder.buildMediaPreviews(root, { previews, browser: relativeBrowser }), error => error.message.includes(`（指定路径：${relativeBrowser}）`));
});

test('HTTP 按需生成传递浏览器及超时配置，关闭生成后仍返回前端回传入口并保护配置文件', async t => {
    const root = await fixture(t);
    await mkdir(path.join(root, 'data/photos/trip'), { recursive: true });
    await writeFile(path.join(root, 'data/photos/trip/image.png'), 'original');
    const previousBrowser = process.env.TRAVEL_BROWSER_PATH;
    delete process.env.TRAVEL_BROWSER_PATH;
    t.after(() => {
        if (previousBrowser === undefined) delete process.env.TRAVEL_BROWSER_PATH;
        else process.env.TRAVEL_BROWSER_PATH = previousBrowser;
    });
    const calls = [];
    t.mock.method(previewBuilder, 'buildMediaPreviews', async (selectedRoot, options) => {
        assert.equal(selectedRoot, root);
        calls.push(options);
        return { generated: 0, cached: 0, failed: 1 };
    });
    for (const enabled of [false, true]) {
        await saveConfig(root, { mediaPreviews: { enabled, browserPath: './browser', progressTimeoutMs: 5000 } });
        const server = http.createServer(createHandler(root));
        const base = await listenOnFetchSafePort(server);
        try {
            assert.equal((await fetch(base + '/.cache/media-previews/photos/trip/image.png.jpg')).status, 204);
            assert.equal(calls.length, enabled ? 1 : 0);
            for (const name of [CONFIG_FILENAME, CONFIG_FILENAME.toUpperCase(), '%74ravel-diary.config.json', LOCAL_CONFIG_FILENAME, LOCAL_CONFIG_FILENAME.toUpperCase(), '%74ravel-diary.config.local.json']) {
                assert.equal((await fetch(`${base}/${name}`)).status, 403);
            }
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    }
    assert.equal(calls[0].browser, path.join(root, 'browser'));
    assert.equal(calls[0].progressTimeoutMs, 5000);
});
