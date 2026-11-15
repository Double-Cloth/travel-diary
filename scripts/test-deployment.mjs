import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { AUTH_CONFIG, AUTH_PASSWORD } from '../tests/helpers/auth.mjs';

// 仅创建唯一命名的测试项目和虚拟数据，清理范围限于本脚本创建的资源。
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'travel compose test-'));
const project = `travel-smoke-${process.pid}-${Date.now()}`;
const sourceImage = process.env.TRAVEL_TEST_IMAGE || 'travel-diary:verification';
const image = `travel-diary:smoke-${process.pid}-${Date.now()}`;
const rollbackTags = new Set();
const registryName = `${project}-registry`;
const override = path.join(temporary, 'compose.smoke.yaml');
const configFile = path.join(temporary, '.env');
await fs.copyFile('.env.example', configFile);
const backupDirectory = path.join(temporary, 'backups').replaceAll('\\', '/');
await fs.mkdir(path.join(temporary, 'backups'));
await fs.writeFile(override, `services:
  app:
    environment:
      TRAVEL_WRITE_MODE: remote
  caddy:
    environment:
      SITE_DOMAIN: http://diary.test
    ports: !reset []
  maintenance:
    volumes:
      - ${JSON.stringify(`${backupDirectory}:/backups`)}
`);
const compose = ['compose', '-p', project, '--env-file', configFile, '-f', 'compose.yaml', '-f', 'compose.build.yaml', '-f', override];
const environment = { ...process.env, SITE_DOMAIN: 'diary.test', TRAVEL_IMAGE: image,
    COMPOSE_PROJECT_NAME: project, COMPOSE_FILE: [path.resolve('compose.yaml'), path.resolve('compose.build.yaml'), override].join(path.delimiter),
    TRAVEL_ENV_FILE: configFile, TRAVEL_BUILD: '1' };

function execute(args, input = '', { allowFailure = false, program = 'docker' } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(program, args, { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        let errors = '';
        child.stdout.on('data', bytes => { output += bytes; });
        child.stderr.on('data', bytes => { errors += bytes; });
        child.on('error', reject);
        child.on('close', code => {
            if (code && !allowFailure) reject(new Error(`${program} 退出码 ${code}\n${errors}\n${output}`));
            else resolve({ code, output, errors });
        });
        child.stdin.end(input);
    });
}
const dc = (args, input, options) => execute([...compose, ...args], input, options);
const run = code => dc(['run', '--rm', '--no-deps', '-T', 'app', 'node', '-'], code);
const api = async code => dc(['exec', '-T', 'app', 'node', '-'], `
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    const root='/var/lib/travel-diary';
    const headers={Host:'diary.test',Origin:'https://diary.test'};
    const url='http://caddy';
    // 使用原始 HTTP 明确设置 Host，覆盖真实反代的外部主机名匹配策略。
    const fetch=(address,options={})=>new Promise((resolve,reject)=>{
        const request=require('node:http').request(address,options,response=>{
            const chunks=[];
            response.on('data',bytes=>chunks.push(bytes));
            response.on('end',()=>resolve(new Response([204,304].includes(response.statusCode)?null:Buffer.concat(chunks),
                {status:response.statusCode,headers:response.headers})));
            response.on('error',reject);
        });
        request.on('error',reject); request.end(options.body);
    });
    (async()=>{${code}})().catch(error=>{console.error(error);process.exit(1)});
`);

try {
    await execute(['tag', sourceImage, image]);
    await dc(['config', '--quiet']);
    // 镜像静态检查在入口运行前执行，检查镜像默认用户及内容隔离。
    await execute(['run', '--rm', '--entrypoint', 'node', image, '-e', `
        const fs=require('node:fs'),assert=require('node:assert/strict');
        assert.notEqual(process.getuid(),0);
        for(const name of ['data','.secrets','.cache','.env','travel-diary.config.local.json','backups','.git','tmp','tests','doc','.github','README.md']) {
            assert.equal(fs.existsSync('/opt/travel-diary/'+name),false,name);
        }
        for(const name of ['deploy.sh','test-deployment.mjs','sync-asset-versions.js','update-countries.mjs']) {
            assert.equal(fs.existsSync('/opt/travel-diary/scripts/'+name),false,name);
        }
        fs.accessSync('/opt/travel-diary/scripts/media-preview-batch.mjs');
        fs.accessSync(process.env.TRAVEL_BROWSER_PATH,fs.constants.X_OK);
        assert.deepEqual(fs.readdirSync('/var/lib/travel-diary'),[]);
    `]);
    console.log('镜像用户及私有内容隔离通过');
    const missingAuth = await dc(['run', '--rm', '--no-deps', '-T', 'app'], '', { allowFailure: true });
    assert.notEqual(missingAuth.code, 0);
    assert.match(missingAuth.errors + missingAuth.output, /auth|密码/i);
    await run(`
        (async()=>{
            await require('/opt/travel-diary/js/server.js').ensureDataStructure('/var/lib/travel-diary');
            await require('/opt/travel-diary/js/auth.js').writeAuthConfig('/var/lib/travel-diary',${JSON.stringify(AUTH_CONFIG)});
        })().catch(e=>{console.error(e);process.exit(1)});
    `);
    await dc(['up', '-d', '--no-build', '--wait', '--wait-timeout', '120']);
    const config = JSON.parse((await dc(['config', '--format', 'json'])).output);
    assert.equal(config.services.app.ports, undefined);
    assert.equal(config.services.app.environment.TRAVEL_MEDIA_PREVIEWS_ENABLED, 'true');
    assert.ok(!config.services.caddy.ports?.length);
    await api(`
        assert.equal((await fetch(url+'/readyz',{headers})).status,200);
        for(const file of ['/', '/js/app.js','/assets/catalogs/countries.json','/.cache/fonts/diary-kai-core.css']) {
            const response=await fetch(url+file,{headers}); assert.equal(response.status,200,file); await response.arrayBuffer();
        }
        const preview=await fetch(url+'/.cache/media-previews/profile/profile-picture.png.jpg',{headers});
        assert.equal(preview.status,200,'后端默认自动生成头像缩略图');
        assert.equal(preview.headers.get('content-type'),'image/jpeg');
        assert.ok((await preview.arrayBuffer()).byteLength>0);
        for(const file of ['/.secrets/auth.json','/travel-diary.config.json','/.env','/.cache/recycle-bin/item.json']) {
            assert.equal((await fetch(url+file,{headers})).status,403,file);
        }
        assert.equal((await fetch(url+'/api/travel-auth',{method:'POST',headers:{...headers,Origin:'https://evil.test','Content-Type':'application/json'},body:'{}'})).status,403);
        assert.equal((await fetch('http://app:9000/api/travel-auth',{method:'POST',headers:{Host:'evil.test',Origin:'https://diary.test','X-Forwarded-Host':'diary.test','Content-Type':'application/json'},body:'{}'})).status,403);
        const login=await fetch(url+'/api/travel-auth',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(AUTH_PASSWORD)}})});
        assert.equal(login.status,200); assert.match(login.headers.get('set-cookie'),/Secure/);
        const cookie=login.headers.get('set-cookie').split(';')[0], session=await login.json();
        const authenticated={...headers,Cookie:cookie,'X-Travel-Token':session.token,'Content-Type':'application/json'};
        const draft={format:'travel-diary-draft-v1',requestId:'a'.repeat(32),uploads:[],input:{date:'2026-09-13',country_code:'CN',country:'',admin_area:'江苏省',admin_area_type:'',locality:'虚拟地点',locality_type:'',trip_id:'',title:'部署测试',body:'容器中的虚拟测试日记',desc_md:'',photo_folder:'',photos:[]}};
        const created=await fetch(url+'/api/travel-records',{method:'POST',headers:authenticated,body:JSON.stringify(draft)});
        assert.equal(created.status,201,await created.clone().text());
        const record=(await created.json()).record;
        const edited=await fetch(url+'/api/travel-records',{method:'PUT',headers:authenticated,body:JSON.stringify({originalDescMd:record.desc_md,draft:{...draft,requestId:'b'.repeat(32),input:{...draft.input,title:'编辑后的部署测试'}}})});
        assert.equal(edited.status,200,await edited.clone().text());
        const png=await fs.readFile(root+'/data/profile/profile-picture.png');
        const profile=await fetch(url+'/api/travel-profile',{method:'PUT',headers:authenticated,body:JSON.stringify({data:png.toString('base64')})});
        assert.equal(profile.status,200,await profile.clone().text());
        for(const suffix of ['', '.json']) {
            await fs.rm(root+'/.cache/media-previews/profile/profile-picture.png.jpg'+suffix,{force:true});
        }
        await fs.mkdir(root+'/.cache/recycle-bin/synthetic',{recursive:true});
        await fs.writeFile(root+'/.cache/recycle-bin/synthetic/fixture.txt','virtual recycle data');
        console.log('代理、字体、认证、编辑和媒体上传通过');
    `);
    const previewCommand = ['exec', '-T', '-w', '/var/lib/travel-diary', 'app', 'npm', 'run', 'media:previews'];
    const generated = await dc(previewCommand);
    assert.match(generated.output, /新生成 1 项，缓存有效 0 项，失败 0 项/);
    const cached = await dc(previewCommand);
    assert.match(cached.output, /新生成 0 项，缓存有效 1 项，失败 0 项/);
    const fonts = await dc(['exec', '-T', '-w', '/var/lib/travel-diary', 'app', 'npm', 'run', 'fonts']);
    assert.match(fonts.output, /字体缓存已生成/);
    console.log('后端自动缩略图、容器 npm 批量生成及缓存复用通过');
    await dc(['restart', 'app']);
    await dc(['up', '-d', '--wait', '--wait-timeout', '120']);
    await dc(['up', '-d', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '120', 'app']);
    await api(`
        assert.equal(JSON.parse(await fs.readFile(root+'/data/travel_data.json')).length,1);
        assert.equal(await fs.readFile(root+'/.cache/recycle-bin/synthetic/fixture.txt','utf8'),'virtual recycle data');
        assert.deepEqual(JSON.parse(await fs.readFile(root+'/.secrets/auth.json')),${JSON.stringify(AUTH_CONFIG)});
        assert.equal((await fetch(url+'/.cache/media-previews/profile/profile-picture.png.jpg',{headers})).status,200);
        assert.ok((await fs.stat(root+'/.cache/fonts/LXGWWenKaiMono-Regular.woff2')).size>0);
    `);
    console.log('SIGTERM、重启和重新创建后的数据持久化通过');
    await dc(['stop', 'app']);
    const stopped = JSON.parse((await dc(['ps', '-a', '--format', 'json', 'app'])).output);
    assert.equal(stopped.ExitCode, 0);
    await dc(['--profile', 'maintenance', 'run', '--rm', '--no-deps', '-T', '--user', '0:0', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE', '--entrypoint', 'sh', 'maintenance', '-c', 'chown 1000:1000 /backups && chmod 700 /backups']);
    const ops = (...args) => dc(['--profile', 'maintenance', 'run', '--rm', '--no-deps', '-T', 'maintenance', 'node', '/opt/travel-diary/scripts/deployment-backup.js', ...args]);
    await ops('backup', '/var/lib/travel-diary', '/backups/travel-diary-original');
    await run(`require('node:fs').writeFileSync('/var/lib/travel-diary/data/profile/owner-name.txt','changed')`);
    await ops('restore', '/var/lib/travel-diary', '/backups/travel-diary-original', '/backups/travel-diary-before', '--confirm');
    await ops('verify', '/backups/travel-diary-original');
    await dc(['up', '-d', '--no-build', '--wait', '--wait-timeout', '120']);
    await api(`
        assert.equal(JSON.parse(await fs.readFile(root+'/data/travel_data.json')).length,1);
        assert.equal(await fs.readFile(root+'/.cache/recycle-bin/synthetic/fixture.txt','utf8'),'virtual recycle data');
        assert.equal((await fs.stat(root+'/.secrets/auth.json')).mode&511,384);
        await assert.rejects(fs.access(root+'/data/profile/owner-name.txt'));
        assert.equal((await fs.stat('/var/lib/travel-diary')).uid,1000);
    `);
    console.log('Linux 持久卷中的备份、恢复、回收站和权限检查通过');
    if (process.platform === 'linux') {
        await execute(['scripts/deploy.sh', 'backup'], '', { program: 'bash' });
        await execute(['scripts/deploy.sh', 'verify', 'travel-diary-original'], '', { program: 'bash' });
        await execute(['-q', '-e', '-c', 'bash scripts/deploy.sh restore travel-diary-original', '/dev/null'],
            'travel-diary-original\nRESTORE\n', { program: 'script' });
        console.log('Bash 管理入口的备份、校验和双确认恢复通过');
        const updated = await execute(['scripts/deploy.sh', 'update'], '', { program: 'bash' });
        for (const tag of updated.output.match(/travel-diary:rollback-\d{8}T\d{6}Z-\d+/g) || []) rollbackTags.add(tag);
        assert.match(await fs.readFile(configFile, 'utf8'), new RegExp(`TRAVEL_IMAGE=${image}`));
        const rolledBack = await execute(['scripts/deploy.sh', 'rollback'], '', { program: 'bash' });
        for (const tag of rolledBack.output.match(/travel-diary:rollback-\d{8}T\d{6}Z-\d+/g) || []) rollbackTags.add(tag);
        await api(`
            assert.equal(JSON.parse(await fs.readFile(root+'/data/travel_data.json')).length,1);
            assert.equal(await fs.readFile(root+'/.cache/recycle-bin/synthetic/fixture.txt','utf8'),'virtual recycle data');
            assert.deepEqual(JSON.parse(await fs.readFile(root+'/.secrets/auth.json')),${JSON.stringify(AUTH_CONFIG)});
        `);
        const originalOverride = await fs.readFile(override, 'utf8');
        const failedDockerfile = path.join(temporary, 'Dockerfile.failed');
        await fs.writeFile(failedDockerfile, `FROM ${image}\nENTRYPOINT ["node", "-e", "process.exit(42)"]\n`);
        await fs.writeFile(override, originalOverride.replace('  caddy:',
            `    build:\n      context: ${JSON.stringify(temporary)}\n      dockerfile: Dockerfile.failed\n  caddy:`));
        const failed = await execute(['scripts/deploy.sh', 'update'], '', { program: 'bash', allowFailure: true });
        const failedTags = failed.output.match(/travel-diary:rollback-\d{8}T\d{6}Z-\d+/g) || [];
        for (const tag of failedTags) rollbackTags.add(tag);
        assert.equal(failed.code, 1);
        assert.match(failed.errors, /更新失败/);
        assert.ok(failedTags.length);
        await execute(['tag', failedTags[0], image]);
        await fs.writeFile(override, originalOverride);
        await api(`assert.equal((await fetch(url+'/readyz',{headers})).status,200);`);
        console.log('Bash 更新、上一版本回滚及失败后的自动镜像回退通过');

        // 使用独立本地仓库与仅含部署文件的目录，覆盖服务器拉取路径。
        await execute(['run', '-d', '--name', registryName, '-p', '127.0.0.1::5000', 'registry:2']);
        const port = (await execute(['port', registryName, '5000/tcp'])).output.trim().split(':').at(-1);
        const publishedImage = `localhost:${port}/travel-diary:verified`;
        rollbackTags.add(publishedImage);
        await execute(['tag', image, publishedImage]);
        await execute(['push', publishedImage]);
        const serverDirectory = path.join(temporary, 'server files');
        await fs.mkdir(path.join(serverDirectory, 'scripts'), { recursive: true });
        await fs.mkdir(path.join(serverDirectory, 'deploy'));
        for (const file of ['compose.yaml', '.env.example', 'scripts/deploy.sh', 'scripts/offline-images.sh', 'deploy/Caddyfile', 'deploy/proxy.conf']) {
            await fs.copyFile(file, path.join(serverDirectory, file));
        }
        environment.COMPOSE_FILE = [path.join(serverDirectory, 'compose.yaml'), override].join(path.delimiter);
        environment.TRAVEL_BUILD = '0';
        const serverScript = path.join(serverDirectory, 'scripts/deploy.sh');
        const pulled = await execute([serverScript, 'update', publishedImage], '', { program: 'bash' });
        for (const tag of pulled.output.match(/travel-diary:rollback-\d{8}T\d{6}Z-\d+/g) || []) rollbackTags.add(tag);
        assert.ok((await fs.readFile(configFile, 'utf8')).includes(`TRAVEL_IMAGE=${publishedImage}`));
        const container = (await dc(['ps', '-q', 'app'])).output.trim();
        assert.equal((await execute(['inspect', '--format', '{{.Config.Image}}', container])).output.trim(), publishedImage);
        const missing = await execute([serverScript, 'update', `localhost:${port}/travel-diary:missing`], '', { program: 'bash', allowFailure: true });
        assert.notEqual(missing.code, 0);
        assert.equal((await dc(['ps', '-q', 'app'])).output.trim(), container);
        const previous = await execute([serverScript, 'rollback'], '', { program: 'bash' });
        for (const tag of previous.output.match(/travel-diary:rollback-\d{8}T\d{6}Z-\d+/g) || []) rollbackTags.add(tag);
        await api(`
            assert.equal(JSON.parse(await fs.readFile(root+'/data/travel_data.json')).length,1);
            assert.equal(await fs.readFile(root+'/.cache/recycle-bin/synthetic/fixture.txt','utf8'),'virtual recycle data');
            assert.deepEqual(JSON.parse(await fs.readFile(root+'/.secrets/auth.json')),${JSON.stringify(AUTH_CONFIG)});
        `);
        console.log('无源码目录的镜像拉取更新、下载失败保持服务及离线回滚通过');
    }
    console.log('容器烟雾测试完成。公网 HTTPS 证书签发需部署到实际域名后验证。');
} catch (error) {
    const logs = await dc(['logs', '--tail', '80'], '', { allowFailure: true });
    console.error(logs.output + logs.errors);
    throw error;
} finally {
    // Linux CI 的宿主机 UID 可能不同于应用 UID，交还本次测试备份的属主后再清理。
    if (process.platform === 'linux') {
        await dc(['--profile', 'maintenance', 'run', '--rm', '--no-deps', '-T', '--user', '0:0',
            '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE', '--entrypoint', 'sh',
            'maintenance', '-c', `chown -R ${process.getuid()}:${process.getgid()} /backups`], '', { allowFailure: true });
    }
    // 此处只删除本脚本创建、名称唯一的虚拟测试卷。
    await dc(['down', '--volumes', '--remove-orphans'], '', { allowFailure: true });
    await execute(['rm', '-f', registryName], '', { allowFailure: true });
    for (const tag of rollbackTags) await execute(['image', 'rm', tag], '', { allowFailure: true });
    await execute(['image', 'rm', image], '', { allowFailure: true });
    await fs.rm(temporary, { recursive: true, force: true });
}
