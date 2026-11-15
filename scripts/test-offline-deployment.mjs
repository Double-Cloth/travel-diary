import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const inside = process.argv[2] === '--inside';
const archive = path.resolve(process.argv[inside ? 3 : 2] || '');
const testName = `travel-offline-${process.pid}-${Date.now()}`;
const hashFile = async file => {
    const result = createHash('sha256');
    for await (const bytes of createReadStream(file)) result.update(bytes);
    return result.digest('hex');
};
function execute(program, args, { cwd, input = '', failure = false, env = process.env, secret = false, live = false } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(program, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '', errors = '', sent = 0;
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${program} 执行超时`)); }, live ? 900_000 : 300_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.stdout.on('data', bytes => {
            output += bytes;
            if (live) process.stdout.write(bytes);
            // 通过真实伪终端响应密码提示，不把口令放入参数或环境变量。
            if (secret && sent === 0 && output.includes('新访问密码：')) { child.stdin.write('483920\n'); sent++; }
            if (secret && sent === 1 && output.includes('再次输入：')) { child.stdin.write('483920\n'); sent++; child.stdin.end(); }
        });
        child.stderr.on('data', bytes => { errors += bytes; });
        child.on('close', code => {
            clearTimeout(timer);
            if (code && !failure) reject(new Error(`${program} ${args.join(' ')} 退出码 ${code}\n${errors}\n${output}`));
            else resolve({ code, output, errors });
        });
        if (!secret) child.stdin.end(input);
    });
}
const docker = (args, options) => execute('docker', args, options);
if (!inside) {
    await fs.access(archive);
    assert.equal((await fs.readFile(`${archive}.sha256`, 'utf8')).trim(), `${await hashFile(archive)}  ${path.basename(archive)}`);
    const script = path.resolve('scripts/test-offline-deployment.mjs');
    try {
        await docker(['run', '-d', '--pull', 'never', '--privileged', '--network', 'none', '--name', testName,
            '--mount', `type=bind,source=${path.dirname(archive)},target=/bundles,readonly`,
            '--mount', `type=bind,source=${script},target=/test.mjs,readonly`, 'travel-diary:offline-test-tools']);
        for (let attempt = 0; ; attempt++) {
            if ((await docker(['exec', testName, 'docker', 'info'], { failure: true })).code === 0) break;
            if (attempt === 60) throw new Error('隔离 Docker Engine 未能启动。');
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        await docker(['exec', testName, 'node', '/test.mjs', '--inside', `/bundles/${path.basename(archive)}`], { live: true });
    } catch (error) {
        console.error((await docker(['logs', '--tail', '15', testName], { failure: true })).errors);
        throw error;
    } finally {
        // 只删除本脚本创建的独立测试 Engine 及其匿名数据卷。
        await docker(['rm', '-fv', testName], { failure: true });
    }
    process.exit(0);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel offline '));
const env = { ...process.env, COMPOSE_PROJECT_NAME: testName };
const shell = (args, options = {}) => execute('bash', args, { cwd: root, env, ...options });
const deploy = (args, options) => shell(['scripts/deploy.sh', ...args], options);
const dc = (args, options) => docker(['compose', '-p', testName, '-f', path.join(root, 'compose.yaml'), '-f', path.join(root, 'compose.offline.yaml'), '--env-file', path.join(root, '.env'), ...args], { cwd: root, env, ...options });
const checksums = async directory => {
    const lines = (await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    await fs.writeFile(path.join(directory, 'SHA256SUMS'), (await Promise.all(lines.map(async line => {
        const file = line.slice(66);
        return `${await hashFile(path.join(directory, file))}  ${file}`;
    }))).join('\n') + '\n');
};
const setConfig = async (key, value) => {
    const file = path.join(root, '.env');
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`), { mode: 0o600 });
};
const record = { format: 'travel-diary-draft-v1', requestId: 'a'.repeat(32), uploads: [], input: {
    date: '2026-01-01', country_code: 'CN', country: '', admin_area: '江苏省', admin_area_type: '',
    locality: '虚拟地点', locality_type: '', trip_id: '', title: '断网测试', body: '离线日记正文', desc_md: '', photo_folder: '', photos: []
} };
async function request(route, { method = 'GET', body, headers = {}, https = true } = {}) {
    // 入口通过宿主机发布端口访问；HTTPS 始终校验证书及域名。
    const program = `
        const fs=require('node:fs');
        const request=require('node:${https ? 'https' : 'http'}').request({hostname:'127.0.0.1',port:${https ? 443 : 80},servername:'diary.test',path:${JSON.stringify(route)},method:${JSON.stringify(method)},
            ${https ? "ca:fs.readFileSync('/tmp/travel-test-ca.crt')," : ''}
            headers:${JSON.stringify({ Host: 'diary.test', ...headers })}},response=>{
                let body='';response.on('data',b=>body+=b);response.on('end',()=>console.log(JSON.stringify({status:response.statusCode,headers:response.headers,body})));
            });request.on('error',e=>{console.error(e);process.exit(1)});request.end(${JSON.stringify(body ? JSON.stringify(body) : '')});
    `;
    for (let attempt = 0; ; attempt++) {
        try { return JSON.parse((await execute('node', ['-e', program])).output); }
        catch (error) {
            if (method !== 'GET' || attempt === 20) throw error;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
}
async function checkData() {
    const response = await request('/data/travel_data.json');
    assert.equal(response.status, 200);
    const records = JSON.parse(response.body);
    assert.equal(records.length, 1);
    const markdown = await request(`/${records[0].desc_md}`);
    assert.equal(markdown.status, 200);
    assert.match(markdown.body, /^# 离线编辑成功\n/);
    const login = await request('/api/travel-auth', { method: 'POST', headers: { Origin: 'https://diary.test', 'Content-Type': 'application/json' }, body: { password: '483920' } });
    assert.equal(login.status, 200, '升级、回滚和恢复后密码仍可登录');
}
try {
    assert.equal((await docker(['image', 'ls', '-q'])).output.trim(), '', '隔离 Engine 初始镜像库必须为空');
    const routes = await fs.readFile('/proc/net/route', 'utf8');
    assert.ok(routes.trim().split('\n').slice(1).every(line => line.trim().split(/\s+/)[1] !== '00000000'), '隔离 Engine 所在网络空间没有默认外部路由');
    assert.ok(Object.keys(os.networkInterfaces()).every(name => ['lo', 'docker0'].includes(name)), '隔离 Engine 只有回环和本地 Docker 网桥');
    await execute('tar', ['-xzf', archive, '-C', root]);
    await shell(['-c', 'sha256sum --strict -c SHA256SUMS']);
    const manifest = Object.fromEntries((await fs.readFile(path.join(root, 'offline/manifest.env'), 'utf8')).trim().split('\n').map(line => line.split('=')));
    // 先破坏载荷，确认在 docker load 和初始化配置前拒绝。
    const checksumFile = path.join(root, 'SHA256SUMS');
    const originalChecksums = await fs.readFile(checksumFile, 'utf8');
    await fs.writeFile(checksumFile, originalChecksums.replace(/^[a-f0-9]/, char => char === '0' ? '1' : '0'));
    assert.notEqual((await shell(['install.sh', 'diary.test', 'http'], { failure: true })).code, 0);
    assert.equal((await docker(['image', 'ls', '-q'])).output.trim(), '');
    await fs.writeFile(checksumFile, originalChecksums);
    await execute('script', ['-q', '-e', '-c', 'bash install.sh diary.test http', '/dev/null'], { cwd: root, env, secret: true });
    assert.equal((await request('/readyz', { https: false })).status, 200);
    assert.equal((await request('/', { https: false })).status, 200);
    await setConfig('TRAVEL_WRITE_MODE', 'remote');
    assert.notEqual((await deploy(['up'], { failure: true })).code, 0, 'HTTP 不得开启远程编辑');
    await setConfig('TRAVEL_WRITE_MODE', 'local');
    const config = JSON.parse((await dc(['config', '--format', 'json'])).output);
    assert.equal(config.networks.default.internal, true);
    for (const service of Object.values(config.services)) assert.equal(service.pull_policy, 'never');
    const missing = await deploy(['update', 'travel-diary:missing-offline-image'], { failure: true });
    assert.notEqual(missing.code, 0);
    assert.equal((await request('/readyz', { https: false })).status, 200);
    console.log('空镜像库安装、校验失败拒绝、HTTP 浏览及缺失镜像保持服务通过');

    await setConfig('SITE_SCHEME', 'https');
    await setConfig('CADDY_CONFIG', './deploy/Caddyfile.internal');
    await setConfig('TRAVEL_WRITE_MODE', 'remote');
    await deploy(['up']);
    // 等待本地 CA 首次签发，通过受信任根证书访问真实 HTTPS 入口。
    for (let attempt = 0; ; attempt++) {
        const copied = await dc(['cp', 'caddy:/data/caddy/pki/authorities/local/root.crt', '/tmp/travel-test-ca.crt'], { failure: true });
        if (!copied.code) { try { if ((await request('/readyz')).status === 200) break; } catch {} }
        if (attempt === 30) throw new Error('内部 CA 未就绪。');
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    for (const file of ['/', '/js/app.js', '/assets/catalogs/countries.json', '/.cache/fonts/diary-kai-core.css']) assert.equal((await request(file)).status, 200, file);
    const login = await request('/api/travel-auth', { method: 'POST', headers: { Origin: 'https://diary.test', 'Content-Type': 'application/json' }, body: { password: '483920' } });
    assert.equal(login.status, 200, login.body);
    const headers = { Origin: 'https://diary.test', 'Content-Type': 'application/json', Cookie: login.headers['set-cookie'][0].split(';')[0], 'X-Travel-Token': JSON.parse(login.body).token };
    const created = await request('/api/travel-records', { method: 'POST', headers, body: record });
    assert.equal(created.status, 201, created.body);
    const edited = await request('/api/travel-records', { method: 'PUT', headers, body: { originalDescMd: JSON.parse(created.body).record.desc_md, draft: { ...record, requestId: 'b'.repeat(32), input: { ...record.input, title: '离线编辑成功' } } } });
    assert.equal(edited.status, 200, edited.body);
    await checkData();
    await deploy(['doctor']);
    await deploy(['backup']);
    const backupName = (await fs.readdir(path.join(root, 'backups')))[0];
    await deploy(['verify', backupName]);
    console.log('内部 CA 的真实 HTTPS、认证、编辑、字体与备份通过');

    // 使用隔离 Engine 内的工具签发已有证书，完全断网切换入口模式。
    const certs = path.join(root, 'deploy/certs');
    await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certs, 'site.key'), '-out', path.join(certs, 'site.crt'), '-days', '2', '-subj', '/CN=diary.test', '-addext', 'subjectAltName=DNS:diary.test']);
    await fs.copyFile(path.join(certs, 'site.crt'), '/tmp/travel-test-ca.crt');
    await setConfig('CADDY_CONFIG', './deploy/Caddyfile.certificate');
    await deploy(['up']);
    await checkData();
    console.log('已有证书的 HTTPS 与证书校验通过');

    // 新版本以本地镜像产生不同 ID，打包后通过正式 --bundle 入口导入升级。
    const next = path.join(root, 'next bundle');
    await fs.mkdir(next);
    await execute('tar', ['-xzf', archive, '-C', next]);
    const newImage = 'travel-diary:offline-upgrade-test';
    const buildDirectory = path.join(root, 'test build');
    await fs.mkdir(buildDirectory);
    await fs.writeFile(path.join(buildDirectory, 'Dockerfile'), `FROM ${manifest.TRAVEL_IMAGE}\nLABEL travel.offline.test=upgrade\n`);
    await docker(['build', '--network', 'none', '--pull=false', '-t', newImage, buildDirectory]);
    const newId = (await docker(['image', 'inspect', '--format', '{{.Id}}', newImage])).output.trim();
    await docker(['save', '-o', path.join(next, 'offline/images.tar'), newImage, manifest.CADDY_IMAGE]);
    await fs.writeFile(path.join(next, 'offline/manifest.env'), Object.entries({ ...manifest, TRAVEL_IMAGE: newImage, TRAVEL_IMAGE_ID: newId, TRAVEL_CONFIG_ID: newId }).map(([key, value]) => `${key}=${value}\n`).join(''));
    await checksums(next);
    await docker(['image', 'rm', newImage]);
    const manifestFile = path.join(next, 'offline/manifest.env');
    const validManifest = await fs.readFile(manifestFile, 'utf8');
    await fs.writeFile(manifestFile, validManifest.replace(/^ARCH=.*$/m, `ARCH=${manifest.ARCH === 'amd64' ? 'arm64' : 'amd64'}`));
    await checksums(next);
    assert.notEqual((await deploy(['update', '--bundle', next], { failure: true })).code, 0);
    await checkData();
    await fs.writeFile(manifestFile, validManifest);
    await checksums(next);
    await deploy(['update', '--bundle', next]);
    assert.match(await fs.readFile(path.join(root, '.env'), 'utf8'), /TRAVEL_IMAGE=travel-diary:offline-upgrade-test/);
    await checkData();
    await deploy(['rollback']);
    await checkData();
    await fs.writeFile(path.join(buildDirectory, 'Dockerfile'), `FROM ${manifest.TRAVEL_IMAGE}\nENTRYPOINT ["node", "-e", "process.exit(42)"]\n`);
    await docker(['build', '--network', 'none', '--pull=false', '-t', 'travel-diary:offline-broken-test', buildDirectory]);
    const failed = await deploy(['update', 'travel-diary:offline-broken-test'], { failure: true });
    assert.notEqual(failed.code, 0);
    assert.match(failed.errors, /更新失败/);
    await checkData();
    await execute('script', ['-q', '-e', '-c', `bash scripts/deploy.sh restore ${backupName}`, '/dev/null'], { cwd: root, env, input: `${backupName}\nRESTORE\n` });
    await checkData();
    assert.ok((await fs.readdir(path.join(root, 'backups'))).length >= 4);
    console.log('断网架构校验、导入新版本、自动备份、升级、回滚、失败自动回退及双确认恢复通过');
} catch (error) {
    console.error((await dc(['logs', '--tail', '60'], { failure: true })).output);
    throw error;
} finally {
    await dc(['down', '--volumes', '--remove-orphans'], { failure: true });
    await fs.rm(root, { recursive: true, force: true });
}
