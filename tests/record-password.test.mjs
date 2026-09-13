import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAuthConfig, validateAuthConfig, validatePassword, verifyPassword } = require('../js/auth.js');

test('生产认证使用带随机盐的 scrypt 哈希且不保存明文口令', async () => {
    const password = 'correct horse battery staple';
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

test('生产口令策略拒绝短口令和低多样性口令', () => {
    for (const password of [null, '', '123456', 'a'.repeat(16), 'abcabcabcabcabca']) {
        assert.throws(() => validatePassword(password), /口令/);
    }
});

test('仓库不再发布明文密码，兼容配置禁止 remote 生产启动', async () => {
    await assert.rejects(access(new URL('../data/password.json', import.meta.url)));
    const config = JSON.parse(await readFile(new URL('../.secrets/auth.json', import.meta.url), 'utf8'));
    assert.equal('password' in config, false);
    assert.throws(() => validateAuthConfig(config, { requireProduction: true }), /npm run auth:set/);
    assert.equal(await verifyPassword(config, '240918'), true);
});
