import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';

const options = {};
for (let index = 2; index < process.argv.length; index++) {
    const key = process.argv[index];
    if (['--offline', '--local'].includes(key)) options[key.slice(2)] = true;
    else if (['--tag', '--image', '--source', '--caddy', '--output'].includes(key) && process.argv[index + 1]) options[key.slice(2)] = process.argv[++index];
    else throw new Error(`无效参数 ${key}`);
}
if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,100}$/.test(options.tag || '')) throw new Error('请指定有效 --tag。');
if (!options.image) throw new Error('请指定 --image。');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const output = path.resolve(options.output || 'dist');
await fs.mkdir(output, { recursive: true });
const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-package-'));
const digest = async file => {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return hash.digest('hex');
};
try {
    // 发布文件采用显式白名单，不复制个人内容、环境配置、证书或缓存。
    const files = ['compose.yaml', 'compose.portal.yaml', 'compose.offline.yaml', 'install.sh', 'scripts/deploy.sh', 'scripts/offline-images.sh',
        'deploy/Caddyfile', 'deploy/Caddyfile.http', 'deploy/Caddyfile.internal', 'deploy/Caddyfile.certificate',
        'deploy/proxy.conf', 'deploy/Caddyfile.portal.example', 'deploy/certs/.gitkeep', 'doc/DEPLOYMENT.md', 'doc/PORTAL_DEPLOYMENT.md', 'doc/OFFLINE_DEPLOYMENT.md'];
    for (const file of files) {
        await fs.mkdir(path.dirname(path.join(staging, file)), { recursive: true });
        await fs.copyFile(file, path.join(staging, file));
    }
    let image = options.image;
    let caddy = options.caddy || 'caddy:2-alpine';
    let suffix = 'deploy';
    if (options.offline) {
        const platform = docker('version', '--format', '{{.Server.Os}}/{{.Server.Arch}}');
        if (!/^linux\/(amd64|arm64)$/.test(platform)) throw new Error(`不支持的 Docker 平台 ${platform}`);
        const arch = platform.split('/')[1];
        if (!options.local) {
            docker('pull', '--platform', platform, options.source || image);
            docker('pull', '--platform', platform, caddy);
        }
        const appSource = options.source || image;
        const caddySource = caddy;
        image = `travel-diary:offline-${options.tag}-${arch}`;
        caddy = `travel-diary-caddy:offline-${options.tag}-${arch}`;
        for (const [source, target] of [[appSource, image], [caddySource, caddy]]) {
            if (docker('image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', source) !== platform) throw new Error(`镜像架构不符 ${source}`);
            docker('tag', source, target);
        }
        await fs.mkdir(path.join(staging, 'offline'));
        docker('save', '--output', path.join(staging, 'offline/images.tar'), image, caddy);
        // 传统 Engine 使用配置摘要，containerd 后端也可能返回清单摘要，保存两者以兼容导入。
        const archive = path.join(staging, 'offline/images.tar');
        const manifests = JSON.parse(execFileSync('tar', ['-xOf', archive, 'manifest.json'], { encoding: 'utf8' }));
        const configId = reference => {
            const entry = manifests.find(value => value.RepoTags?.includes(reference));
            if (!entry || !/^(?:blobs\/sha256\/[a-f0-9]{64}|[a-f0-9]{64}\.json)$/.test(entry.Config)) throw new Error(`镜像归档缺少配置 ${reference}`);
            return `sha256:${createHash('sha256').update(execFileSync('tar', ['-xOf', archive, entry.Config])).digest('hex')}`;
        };
        await fs.writeFile(path.join(staging, 'offline/manifest.env'), `ARCH=${arch}\nTRAVEL_IMAGE=${image}\nCADDY_IMAGE=${caddy}\nTRAVEL_IMAGE_ID=${docker('image', 'inspect', '--format', '{{.Id}}', image)}\nCADDY_IMAGE_ID=${docker('image', 'inspect', '--format', '{{.Id}}', caddy)}\nTRAVEL_CONFIG_ID=${configId(image)}\nCADDY_CONFIG_ID=${configId(caddy)}\n`);
        files.push('offline/images.tar', 'offline/manifest.env');
        suffix = `offline-linux-${arch}`;
    }
    const example = (await fs.readFile('.env.example', 'utf8')).replace(/^TRAVEL_IMAGE=.*$/m, `TRAVEL_IMAGE=${image}`).replace(/^CADDY_IMAGE=.*$/m, `CADDY_IMAGE=${caddy}`);
    await fs.writeFile(path.join(staging, '.env.example'), example);
    await fs.writeFile(path.join(staging, 'IMAGE.txt'), `${options.source || options.image}\n`);
    files.push('.env.example', 'IMAGE.txt');
    const checksums = [];
    for (const file of files.sort()) checksums.push(`${await digest(path.join(staging, file))}  ${file}`);
    await fs.writeFile(path.join(staging, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
    const name = `travel-diary-${suffix}-${options.tag}.tar.gz`;
    execFileSync('tar', ['-czf', path.join(output, name), '-C', staging, '.'], { stdio: 'inherit' });
    await fs.writeFile(path.join(output, `${name}.sha256`), `${await digest(path.join(output, name))}  ${name}\n`);
    console.log(path.join(output, name));
} finally {
    await fs.rm(staging, { recursive: true, force: true });
}
