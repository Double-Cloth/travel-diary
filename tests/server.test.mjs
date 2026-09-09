import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHandler, parseArgs, safeJoin, listenWithRetries } from '../js/server.js';

let fixture;
let root;
let server;

before(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), 'travel-diary-server-'));
    root = path.join(fixture, 'site');
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await mkdir(path.join(fixture, 'site-other'));
    await writeFile(path.join(root, 'index.html'), '首页');
    await writeFile(path.join(root, 'nested', 'index.html'), '子目录');
    await writeFile(path.join(root, '100%.txt'), '百分号');
    await writeFile(path.join(root, '%2e.txt'), '编码名称');
    await writeFile(path.join(root, 'module.mjs'), 'export {};');
    await writeFile(path.join(fixture, 'site-other', 'secret.txt'), '目录外内容');
    await symlink(path.join(fixture, 'site-other'), path.join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    server = http.createServer(createHandler(root));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
});

after(async () => {
    if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    if (fixture && path.dirname(fixture) === path.resolve(tmpdir()) && path.basename(fixture).startsWith('travel-diary-server-')) {
        await rm(fixture, { recursive: true, force: true });
    }
});

function request(url, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

test('畸形 URL 返回错误且后续请求仍正常', async () => {
    for (const url of ['/%', '/%E0%A4%A', 'http://[invalid']) {
        assert.equal((await request(url)).status, 400);
    }
    assert.equal((await request('/')).body, '首页');
});

test('路径只解码一次，含百分号的合法文件仍可访问', async () => {
    assert.equal((await request('/100%25.txt')).body, '百分号');
    assert.equal((await request('/%252e.txt')).body, '编码名称');
});

test('拒绝同名前缀目录、编码穿越、空字符与链接越界', async () => {
    assert.equal(safeJoin(root, '../site-other/secret.txt'), null);
    assert.equal(safeJoin(root, '..\\site-other\\secret.txt'), null);
    for (const url of ['/..%2fsite-other/secret.txt', '/..%5csite-other/secret.txt', '/outside/secret.txt', '/bad%00name', '/index.html:stream']) {
        assert.equal((await request(url)).status, 403, url);
    }
});

test('目录跳转保留查询参数，HEAD 与 GET 的资源元数据一致', async () => {
    const redirect = await request('/nested?q=1');
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, '/nested/?q=1');
    assert.equal((await request('/nested/')).body, '子目录');
    const head = await request('/module.mjs', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], String(Buffer.byteLength('export {};')));
    assert.match(head.headers['content-type'], /text\/javascript/);
    assert.equal((await request('/missing')).status, 404);
    assert.equal((await request('/', 'POST')).status, 405);
    assert.equal((await request('/', 'OPTIONS')).headers['access-control-allow-methods'], 'GET, HEAD, OPTIONS');
});

test('端口参数不能越界且被占用时自动尝试后续端口', async () => {
    for (const port of ['0', '-1', '65536', '1.5', 'NaN', 'Infinity']) {
        assert.throws(() => parseArgs([`--port=${port}`]), /端口/);
    }
    assert.equal(parseArgs(['--port', '65535']).port, 65535);
    for (const args of [['--port'], ['--dir'], ['--dir='], ['--dir', '--network'], ['--unknown']]) {
        assert.throws(() => parseArgs(args));
    }
    const result = await listenWithRetries(root, server.address().port, false);
    assert.ok(result.port > server.address().port);
    await new Promise(resolve => result.server.close(resolve));
});
