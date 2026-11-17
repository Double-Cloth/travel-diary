import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('源码构建支持可选的完整提交 SHA，并以 unknown 保持旧构建兼容', async () => {
    const dockerfile = await fs.readFile('Dockerfile', 'utf8');
    const composeBuild = await fs.readFile('compose.build.yaml', 'utf8');
    assert.match(dockerfile, /^ARG VCS_REF=unknown$/m);
    assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{VCS_REF\}"/);
    assert.match(composeBuild, /^\s+VCS_REF: \$\{VCS_REF:-unknown\}$/m);
});

test('部署归档校验覆盖全部发布文件，固定镜像且不携带运行数据和证书', async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-package-test-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    execFileSync(process.execPath, ['scripts/package-deployment.mjs', '--tag', 'package-test', '--image', 'example/diary:package-test', '--output', temporary]);
    const name = 'travel-diary-deploy-package-test.tar.gz';
    const bytes = await fs.readFile(path.join(temporary, name));
    assert.equal(await fs.readFile(path.join(temporary, `${name}.sha256`), 'utf8'), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
    const extracted = path.join(temporary, 'extracted');
    await fs.mkdir(extracted);
    execFileSync('tar', ['-xzf', path.join(temporary, name), '-C', extracted]);
    const checksums = (await fs.readFile(path.join(extracted, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    const names = new Set();
    for (const line of checksums) {
        const [, expected, file] = /^([a-f0-9]{64})  (.+)$/.exec(line);
        names.add(file);
        assert.equal(createHash('sha256').update(await fs.readFile(path.join(extracted, file))).digest('hex'), expected, file);
    }
    const walk = async (directory, prefix = '') => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const relative = `${prefix}${entry.name}`;
            if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${relative}/`);
            else {
                assert.ok(entry.isFile(), relative);
                assert.ok(relative === 'SHA256SUMS' || names.has(relative), relative);
                assert.doesNotMatch(relative, /^(?:data|\.secrets|\.cache|backups|\.git)\/|^\.env$|\.(?:key|crt|pem)$/);
            }
        }
    };
    await walk(extracted);
    assert.match(await fs.readFile(path.join(extracted, '.env.example'), 'utf8'), /^TRAVEL_IMAGE=example\/diary:package-test$/m);
    for (const name of ['scripts/offline-images.sh', 'scripts/deploy.sh', 'install.sh', 'compose.offline.yaml', 'compose.portal.yaml', 'deploy/Caddyfile.portal.example', 'doc/PORTAL_DEPLOYMENT.md', 'doc/OFFLINE_DEPLOYMENT.md']) assert.ok(names.has(name));
});
