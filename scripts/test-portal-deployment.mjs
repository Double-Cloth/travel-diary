import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// 所有数据、镜像与网络均在本次创建的无外网 Docker Engine 内演练。
const inside = process.argv[2] === '--inside';
const archive = path.resolve(process.argv[inside ? 3 : 2] || '');
const project = `travel-portal-${process.pid}-${Date.now()}`;
const digest = async file => {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return hash.digest('hex');
};
function execute(program, args, { cwd, env = process.env, input = '', failure = false, live = false } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(program, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '', errors = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${program} 执行超时`)); }, 900_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.stdout.on('data', bytes => { output += bytes; if (live) process.stdout.write(bytes); });
        child.stderr.on('data', bytes => { errors += bytes; });
        child.on('close', code => {
            clearTimeout(timer);
            if (code && !failure) reject(new Error(`${program} ${args.join(' ')} 退出码 ${code}\n${errors}\n${output}`));
            else resolve({ code, output, errors });
        });
        child.stdin.end(input);
    });
}
const docker = (args, options) => execute('docker', args, options);
if (!inside) {
    assert.equal((await fs.readFile(`${archive}.sha256`, 'utf8')).trim(), `${await digest(archive)}  ${path.basename(archive)}`);
    try {
        await docker(['run', '-d', '--pull', 'never', '--privileged', '--network', 'none', '--name', project,
            '--mount', `type=bind,source=${path.dirname(archive)},target=/bundles,readonly`,
            '--mount', `type=bind,source=${path.resolve('scripts/test-portal-deployment.mjs')},target=/test.mjs,readonly`,
            'travel-diary:offline-test-tools']);
        for (let attempt = 0; ; attempt++) {
            if ((await docker(['exec', project, 'docker', 'info'], { failure: true })).code === 0) break;
            if (attempt === 60) throw new Error('隔离 Docker Engine 启动失败');
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        await docker(['exec', project, 'node', '/test.mjs', '--inside', `/bundles/${path.basename(archive)}`], { live: true });
    } finally {
        // 仅移除本脚本创建的独立测试 Engine 及其匿名卷。
        await docker(['rm', '-fv', project], { failure: true });
    }
    process.exit(0);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'travel portal '));
const env = { ...process.env, COMPOSE_PROJECT_NAME: project };
const shell = (args, options = {}) => execute('bash', args, { cwd: root, env, ...options });
const deploy = (args, options) => shell(['scripts/deploy.sh', ...args], options);
const dc = (args, options) => docker(['compose', '--env-file', path.join(root, '.env'),
    '-f', path.join(root, 'compose.yaml'), '-f', path.join(root, 'compose.offline.yaml'),
    '-f', path.join(root, 'compose.portal.yaml'), ...args], { env, cwd: root, ...options });
const gatewayFile = path.join(root, 'compose.gateway.yaml');
const gateway = args => docker(['compose', '-p', `${project}-gateway`, '-f', gatewayFile, ...args], { cwd: root });
const setConfig = async (key, value) => {
    const file = path.join(root, '.env');
    let text = await fs.readFile(file, 'utf8');
    const expression = new RegExp(`^${key}=.*$`, 'm');
    text = expression.test(text) ? text.replace(expression, `${key}=${value}`) : `${text}\n${key}=${value}\n`;
    await fs.writeFile(file, text, { mode: 0o600 });
};
const appCode = code => dc(['exec', '-T', 'app', 'node', '-'], { input: `
    const assert=require('node:assert/strict'),fs=require('node:fs/promises');
    (async()=>{${code}})().catch(e=>{console.error(e);process.exit(1)});
` });
let port;
const request = async (route, { method = 'GET', body, headers = {} } = {}) => {
    const payload = Buffer.isBuffer(body) ? `Buffer.from(${JSON.stringify(body.toString('base64'))},'base64')` : JSON.stringify(body);
    const requestHeaders = { Host: 'diary.test:63445', ...headers,
        ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }) };
    const result = await execute('node', ['-e', `
        const req=require('node:http').request({hostname:'127.0.0.1',port:${port},path:${JSON.stringify(route)},
            method:${JSON.stringify(method)},headers:${JSON.stringify(requestHeaders)}},res=>{
            const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>console.log(JSON.stringify({
                status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('base64')})));
        });req.on('error',e=>{console.error(e);process.exit(1)});req.end(${payload});
    `]);
    const response = JSON.parse(result.output);
    response.body = Buffer.from(response.body, 'base64');
    return response;
};
const json = response => JSON.parse(response.body);
const origin = { Origin: 'https://diary.test:63445', 'Content-Type': 'application/json' };
const login = () => request('/diary/api/travel-auth', { method: 'POST', headers: origin, body: '{"password":"483920"}' });
const assertOtherApps = async () => {
    assert.equal((await request('/')).body.toString(), 'portal homepage');
    assert.equal((await request('/blog/')).body.toString(), 'other application');
};

try {
    assert.equal((await docker(['image', 'ls', '-q'])).output.trim(), '');
    await execute('tar', ['-xzf', archive, '-C', root]);
    await shell(['-c', 'sha256sum --strict -c SHA256SUMS']);
    await docker(['load', '--input', path.join(root, 'offline/images.tar')]);
    const manifest = Object.fromEntries((await fs.readFile(path.join(root, 'offline/manifest.env'), 'utf8')).trim().split('\n').map(line => line.split('=')));
    await fs.copyFile(path.join(root, '.env.example'), path.join(root, '.env'));
    for (const [key, value] of Object.entries({
        SITE_DOMAIN: 'diary.test', TRAVEL_OFFLINE: '1', CADDY_CONFIG: './deploy/Caddyfile.internal',
        TRAVEL_IMAGE: manifest.TRAVEL_IMAGE, CADDY_IMAGE: manifest.CADDY_IMAGE,
        TRAVEL_DEPLOYMENT_MODE: 'portal', TRAVEL_BASE_PATH: '/diary',
        TRAVEL_PUBLIC_ORIGIN: 'https://diary.test:63445', TRAVEL_PORTAL_NETWORK: `${project}-shared`,
        TRAVEL_PORTAL_ALIAS: 'travel-diary', COMPOSE_PROJECT_NAME: project
    })) await setConfig(key, value);
    await docker(['network', 'create', `${project}-shared`]);

    // 使用旧的独立部署模型初始化卷，再由 Portal 复用同一个卷和密码。
    await docker(['compose', '-p', project, '--env-file', path.join(root, '.env'), '-f', path.join(root, 'compose.yaml'),
        'run', '--rm', '--no-deps', '-T', 'app', 'node', '-e', `
        (async()=>{
            const root='/var/lib/travel-diary';
            await require('/opt/travel-diary/js/server.js').ensureDataStructure(root);
            const auth=require('/opt/travel-diary/js/auth.js');
            await auth.writeAuthConfig(root,await auth.createAuthConfig('483920'));
            require('node:fs').writeFileSync(root+'/data/profile/owner-name.txt','迁移前虚拟用户');
        })().catch(e=>{console.error(e);process.exit(1)});
    `], { env });
    await deploy(['init']);
    await setConfig('TRAVEL_WRITE_MODE', 'remote');
    await deploy(['up']);
    const config = JSON.parse((await dc(['config', '--format', 'json'])).output);
    assert.equal(config.services.caddy, undefined, '默认配置不包含禁用的 Caddy');
    assert.equal(config.services.app.ports, undefined);
    assert.equal(config.networks.portal.external, true);
    const container = (await dc(['ps', '-q', 'app'])).output.trim();
    const inspected = JSON.parse((await docker(['inspect', container])).output)[0];
    const volume = inspected.Mounts.find(m => m.Destination === '/var/lib/travel-diary').Name;
    assert.equal(volume, `${project}_runtime`);
    assert.ok(inspected.NetworkSettings.Networks[`${project}-shared`]);
    assert.notEqual(inspected.Config.User, 'root');
    assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL']);
    await appCode(`assert.equal(await fs.readFile('/var/lib/travel-diary/data/profile/owner-name.txt','utf8'),'迁移前虚拟用户');`);

    await fs.mkdir(path.join(root, 'portal'));
    await fs.mkdir(path.join(root, 'blog'));
    await fs.writeFile(path.join(root, 'portal/index.html'), 'portal homepage');
    await fs.writeFile(path.join(root, 'blog/index.html'), 'other application');
    let caddyfile = await fs.readFile(path.join(root, 'deploy/Caddyfile.portal.example'), 'utf8');
    await fs.writeFile(path.join(root, 'Caddyfile.shared'), caddyfile);
    await fs.writeFile(gatewayFile, `services:
  gateway:
    image: ${manifest.CADDY_IMAGE}
    pull_policy: never
    environment:
      TRAVEL_BASE_PATH: /diary
      TRAVEL_PORTAL_ALIAS: travel-diary
    ports: ["127.0.0.1::80"]
    volumes:
      - ./Caddyfile.shared:/etc/caddy/Caddyfile:ro
      - ./portal:/srv/portal:ro
    networks: [shared]
  home:
    image: ${manifest.CADDY_IMAGE}
    pull_policy: never
    command: [caddy, file-server, --root, /srv, --listen, ':80']
    volumes: [./portal:/srv:ro]
    networks: [shared]
  blog:
    image: ${manifest.CADDY_IMAGE}
    pull_policy: never
    command: [caddy, file-server, --root, /srv, --listen, ':80']
    volumes: [./blog:/srv:ro]
    networks: [shared]
networks:
  shared:
    external: true
    name: ${project}-shared
`);
    await gateway(['run', '--rm', '--no-deps', 'gateway', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
    caddyfile = caddyfile.replace('    # 在此添加', '    handle_path /blog/* {\n        reverse_proxy blog:80\n    }\n\n    # 在此添加')
        .replace('root * /srv/portal\n        file_server', 'reverse_proxy home:80');
    await fs.writeFile(path.join(root, 'Caddyfile.shared'), caddyfile);
    await gateway(['up', '-d']);
    port = Number((await gateway(['port', 'gateway', '80'])).output.trim().split(':').at(-1));
    for (let attempt = 0; ; attempt++) {
        try { await assertOtherApps(); break; } catch (error) {
            if (attempt === 30) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    const gatewayIds = (await gateway(['ps', '-q'])).output.trim();
    console.log('旧卷迁移、非 root 安全配置、共享网络和独立四容器网关通过');

    const canonical = await request('/diary?x=a%26b');
    assert.equal(canonical.status, 308);
    assert.equal(canonical.headers.location, '/diary/?x=a%26b');
    assert.equal((await request('/diary')).headers.location, '/diary/');
    for (const route of ['/diary/', '/diary/js/app.js', '/diary/css/journal.css', '/diary/js/location.mjs',
        '/diary/assets/catalogs/countries.json', '/diary/data/travel_data.json', '/diary/.cache/fonts/diary-kai-core.css']) {
        assert.equal((await request(route)).status, 200, route);
    }
    const fontCss = (await request('/diary/.cache/fonts/diary-kai-core.css')).body.toString();
    const fontName = /url\(['"]?([^)'"\s]+)/.exec(fontCss)[1];
    assert.equal((await request(new URL(fontName, 'http://test/diary/.cache/fonts/diary-kai-core.css').pathname)).status, 200);
    for (const route of ['/diaryevil/', '/api/travel-auth', '/diary/../blog/missing', '/diary/%2e%2e/.secrets/auth.json', '/diary/.secrets/auth.json']) {
        assert.notEqual((await request(route)).status, 200, route);
    }
    const redirect = await request('/diary/data/photos?value=1');
    assert.equal(redirect.headers.location, '/diary/data/photos/?value=1');
    await appCode(`await fs.writeFile('/var/lib/travel-diary/data/videos/range.mp4','0123456789');`);
    const range = await request('/diary/data/videos/range.mp4', { headers: { Range: 'bytes=2-5' } });
    assert.equal(range.status, 206);
    assert.equal(range.body.toString(), '2345');
    const preview = await request('/diary/.cache/media-previews/profile/profile-picture.png.jpg');
    assert.equal(preview.status, 200);
    assert.equal(preview.headers['content-type'], 'image/jpeg');
    assert.ok(preview.body.length > 0);
    await dc(['exec', '-T', '-w', '/var/lib/travel-diary', 'app', 'npm', 'run', 'media:previews']);
    console.log('真实 Caddy 前缀剥离、资源、字体 WOFF2、Range、后端缩略图及 npm 运维通过');

    for (const headers of [{ ...origin, Origin: 'https://evil.test' }, { ...origin, Host: 'diary.test' },
        { ...origin, Host: 'evil.test', 'X-Forwarded-Host': 'diary.test:63445', 'X-Forwarded-Proto': 'https' }]) {
        assert.equal((await request('/diary/api/travel-auth', { method: 'POST', headers, body: '{"password":"483920"}' })).status, 403);
    }
    const authenticated = await login();
    assert.equal(authenticated.status, 200);
    assert.match(authenticated.headers['set-cookie'][0], /Path=\/diary\/api; HttpOnly; SameSite=Strict.*; Secure/);
    const headers = { ...origin, Cookie: authenticated.headers['set-cookie'][0].split(';')[0], 'X-Travel-Token': json(authenticated).token };
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5uoAAAAASUVORK5CYII=';
    const draft = { format: 'travel-diary-draft-v1', requestId: 'a'.repeat(32),
        uploads: [{ id: 'c'.repeat(32), name: 'river.png', data: png }], input: {
        date: '2026-01-01', country_code: 'CN', country: '', admin_area: '江苏省', admin_area_type: '',
        locality: '虚拟地点', locality_type: '', trip_id: '', title: '门户测试', body: '门户日记正文', desc_md: '', photo_folder: '', photos: []
    } };
    assert.equal((await request('/diary/api/travel-records', { method: 'POST', headers: origin, body: JSON.stringify(draft) })).status, 401);
    assert.equal((await request('/diary/api/travel-records', { method: 'POST', headers: { ...headers, 'X-Travel-Token': '' }, body: JSON.stringify(draft) })).status, 403);
    const created = await request('/diary/api/travel-records', { method: 'POST', headers, body: JSON.stringify(draft) });
    assert.equal(created.status, 201, created.body.toString());
    const record = json(created).record;
    assert.equal((await request(`/diary/${record.desc_md}`)).status, 200);
    const photo = await request(`/diary/${record.photo_folder}/${record.photos[0]}`);
    assert.equal(photo.status, 200);
    assert.deepEqual(photo.body, Buffer.from(png, 'base64'));
    assert.equal((await request(`/diary/.cache/media-previews/photos/${record.photo_folder.slice('data/photos/'.length)}/${record.photos[0]}.jpg`)).status, 200);
    const edited = await request('/diary/api/travel-records', { method: 'PUT', headers,
        body: JSON.stringify({ originalDescMd: record.desc_md, draft: { ...draft, uploads: [], requestId: 'b'.repeat(32),
            input: { ...draft.input, photo_folder: record.photo_folder, photos: record.photos, title: '修改后的门户日记' } } }) });
    assert.equal(edited.status, 200, edited.body.toString());
    assert.equal((await request('/diary/api/travel-profile', { method: 'PUT', headers, body: JSON.stringify({ name: '门户虚拟用户' }) })).status, 200);
    assert.equal((await request('/diary/api/travel-profile', { method: 'PUT', headers, body: JSON.stringify({ data: png }) })).status, 200);
    const deleted = await request('/diary/api/travel-records', { method: 'DELETE', headers,
        body: JSON.stringify({ desc_md: json(edited).record.desc_md }) });
    assert.equal(deleted.status, 200, deleted.body.toString());
    const recycle = json(await request('/diary/api/travel-data?mode=recycle-bin', { headers }));
    const recycledRecord = recycle.items.find(item => item.kind === 'record');
    assert.ok(recycledRecord);
    const restored = await request('/diary/api/travel-data?mode=recycle-bin', { method: 'POST', headers,
        body: JSON.stringify({ action: 'restore', id: recycledRecord.id, revision: recycle.revision }) });
    assert.equal(restored.status, 200, restored.body.toString());
    assert.equal((await request('/diary/api/travel-records', { headers })).status, 200);
    const exported = await request('/diary/api/travel-data', { headers });
    assert.equal(exported.status, 200);
    assert.match(exported.headers['content-type'], /zip/);
    assert.ok(exported.body.length > 0);
    const imported = await request('/diary/api/travel-data', { method: 'POST', body: exported.body,
        headers: { ...headers, 'Content-Type': 'application/zip', 'X-Travel-Current-Password': '483920', 'X-Travel-Backup-Password': '483920' } });
    assert.equal(imported.status, 200, imported.body.toString());
    const relogin = await login();
    headers.Cookie = relogin.headers['set-cookie'][0].split(';')[0];
    headers['X-Travel-Token'] = json(relogin).token;
    const logout = await request('/diary/api/travel-auth', { method: 'DELETE', headers });
    assert.equal(logout.status, 200);
    assert.match(logout.headers['set-cookie'][0], /Path=\/diary\/api;.*Max-Age=0/);
    assert.equal((await login()).status, 200);
    console.log('带端口认证、Cookie、图片上传与缩略图、资料头像、日记增删改、回收站恢复及 ZIP 导入导出通过');

    await deploy(['status']);
    const doctor = await deploy(['doctor'], { failure: true });
    assert.equal(doctor.code, 1);
    assert.match(doctor.output, /共享网络内应用可达/);
    assert.match(doctor.errors, /公开入口不可达.*https:\/\/diary.test:63445\/diary\/readyz/);
    await deploy(['backup']);
    const backups = await fs.readdir(path.join(root, 'backups'));
    const backupName = backups.find(name => name.startsWith('travel-diary-'));
    assert.ok(backupName);
    await deploy(['verify', backupName]);
    await appCode(`await fs.writeFile('/var/lib/travel-diary/data/profile/owner-name.txt','临时变化');`);
    await execute('script', ['-q', '-e', '-c', `bash scripts/deploy.sh restore ${backupName}`, '/dev/null'],
        { cwd: root, env, input: `${backupName}\nRESTORE\n` });
    await appCode(`assert.equal(await fs.readFile('/var/lib/travel-diary/data/profile/owner-name.txt','utf8'),'门户虚拟用户');`);
    await deploy(['--offline', 'update', '--bundle', root]);
    await deploy(['rollback']);
    await assertOtherApps();
    assert.equal((await gateway(['ps', '-q'])).output.trim(), gatewayIds);

    // 断网环境通过本地 FROM 构建覆盖在线管理分支，不连接外部镜像仓库。
    await setConfig('TRAVEL_OFFLINE', '0');
    await setConfig('TRAVEL_IMAGE', 'travel-diary:portal-update');
    await fs.writeFile(path.join(root, 'Dockerfile.update'), `FROM ${manifest.TRAVEL_IMAGE}\n`);
    const buildOverride = path.join(root, 'compose.update.yaml');
    await fs.writeFile(buildOverride, 'services:\n  app:\n    build:\n      context: .\n      dockerfile: Dockerfile.update\n');
    env.TRAVEL_BUILD = '1';
    env.COMPOSE_FILE = `${path.join(root, 'compose.yaml')}:${buildOverride}`;
    await deploy(['init']);
    await deploy(['update']);
    await deploy(['rollback']);
    await fs.writeFile(path.join(root, 'Dockerfile.update'), `FROM ${manifest.TRAVEL_IMAGE}\nENTRYPOINT ["node","-e","process.exit(42)"]\n`);
    const failedUpdate = await deploy(['update'], { failure: true });
    assert.equal(failedUpdate.code, 1);
    assert.match(failedUpdate.errors, /更新失败/);
    await assertOtherApps();
    assert.equal((await gateway(['ps', '-q'])).output.trim(), gatewayIds);
    delete env.TRAVEL_BUILD;
    delete env.COMPOSE_FILE;
    await setConfig('TRAVEL_OFFLINE', '1');
    assert.equal((await request('/diary/data/travel_data.json')).status, 200);
    await deploy(['down']);
    await assertOtherApps();
    assert.equal((await gateway(['ps', '-q'])).output.trim(), gatewayIds);
    await deploy(['up']);
    assert.equal(JSON.parse((await request('/diary/data/travel_data.json')).body).length, 1);
    const recreated = JSON.parse((await docker(['inspect', (await dc(['ps', '-q', 'app'])).output.trim()])).output)[0];
    assert.equal(recreated.Mounts.find(m => m.Destination === '/var/lib/travel-diary').Name, volume);
    await assertOtherApps();
    assert.equal((await gateway(['ps', '-q'])).output.trim(), gatewayIds);
    assert.equal((await dc(['--profile', 'standalone', 'ps', '-a', '-q', 'caddy'])).output.trim(), '');
    console.log('doctor 公开路径诊断、备份恢复、在线与离线升级回滚、失败自动回退、停启复用卷且其他应用持续可用通过');

    for (const [key, value] of [['TRAVEL_DEPLOYMENT_MODE', 'invalid'], ['TRAVEL_BASE_PATH', '/..'], ['TRAVEL_PUBLIC_ORIGIN', 'https://test/path']]) {
        const original = await fs.readFile(path.join(root, '.env'), 'utf8');
        await setConfig(key, value);
        assert.notEqual((await deploy(['up'], { failure: true })).code, 0);
        await fs.writeFile(path.join(root, '.env'), original);
    }
    await setConfig('TRAVEL_PUBLIC_ORIGIN', '');
    await deploy(['up']);
    assert.equal((await request('/diary/api/travel-auth', { method: 'POST',
        headers: { ...origin, Host: 'diary.test', Origin: 'https://diary.test' }, body: '{"password":"483920"}' })).status, 200);
    await assertOtherApps();
    console.log('错误配置拒绝启动、未设公开 Origin 时沿用 SITE_DOMAIN 通过');
} catch (error) {
    console.error((await dc(['logs', '--tail', '30'], { failure: true })).output);
    throw error;
} finally {
    // 测试 Engine 随外层容器整体移除，所有内部卷均为虚拟数据。
    await fs.rm(root, { recursive: true, force: true });
}
