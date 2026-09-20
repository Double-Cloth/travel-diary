import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAuthConfig, replaceAuthConfig, validateAuthConfig, validatePassword, verifyPassword } = require('../js/auth.js');
const { writeAuthConfig } = require('../scripts/set-auth-password.js');

test('六位数字密码使用带随机盐的 scrypt 哈希且不保存明文', async () => {
    const password = '483920';
    const first = await createAuthConfig(password);
    const second = await createAuthConfig(password);
    assert.equal(first.algorithm, 'scrypt');
    assert.notEqual(first.salt, second.salt);
    assert.notEqual(first.hash, second.hash);
    assert.equal(JSON.stringify(first).includes(password), false);
    assert.equal(await verifyPassword(first, password), true);
    assert.equal(await verifyPassword(first, `${password}!`), false);
    assert.equal(validateAuthConfig(first, { requireProduction: true }).productionReady, true);
});

test('换密工具可以原子替换已有配置', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'travel-diary-password-tool-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const first = await createAuthConfig('483920');
    const second = await createAuthConfig('590247');
    await writeAuthConfig(root, first);
    await writeAuthConfig(root, second);
    const saved = JSON.parse(await readFile(path.join(root, '.secrets/auth.json'), 'utf8'));
    assert.equal(saved.hash, second.hash);
    assert.deepEqual(await readdir(path.join(root, '.secrets')), ['auth.json']);
});

test('应用内换密会生成新的盐和哈希并清理临时文件', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'travel-diary-password-change-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const original = await createAuthConfig('483920');
    await writeAuthConfig(root, original);
    const replacement = await replaceAuthConfig(root, '590247');
    const saved = JSON.parse(await readFile(path.join(root, '.secrets/auth.json'), 'utf8'));
    assert.notEqual(saved.salt, original.salt);
    assert.notEqual(saved.hash, original.hash);
    assert.equal(saved.hash, replacement.hash);
    assert.equal(await verifyPassword(saved, '590247'), true);
    assert.equal(await verifyPassword(saved, '483920'), false);
    assert.deepEqual(await readdir(path.join(root, '.secrets')), ['auth.json']);
});

test('密码策略只接受非弱组合的六位数字', () => {
    assert.equal(validatePassword('483920'), '483920');
    for (const password of [null, '', '12345', '1234567', 'abcdef', '１２３４５６']) {
        assert.throws(() => validatePassword(password), /密码/);
    }
    for (const password of ['000000', '123456', '654321', '121212', '123123', '131452']) {
        assert.throws(() => validatePassword(password), { code: 'PASSWORD_TOO_WEAK' });
    }
});

test('仓库不发布明文密码，跟踪的哈希配置可用于 remote 模式', async () => {
    await assert.rejects(access(new URL('../data/password.json', import.meta.url)));
    const config = JSON.parse(await readFile(new URL('../.secrets/auth.json', import.meta.url), 'utf8'));
    assert.equal('password' in config, false);
    assert.equal(validateAuthConfig(config, { requireProduction: true }).productionReady, true);
    const legacy = await createAuthConfig('483920');
    delete legacy.policy.commonPatternsRejected;
    assert.throws(() => validateAuthConfig(legacy, { requireProduction: true }), { code: 'AUTH_NOT_PRODUCTION_READY' });
});
