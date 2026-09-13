import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAuthConfig, validateAuthConfig, validatePassword, verifyPassword } = require('../js/auth.js');

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

test('密码策略只接受六位数字', () => {
    assert.equal(validatePassword('123456'), '123456');
    for (const password of [null, '', '12345', '1234567', 'abcdef', '１２３４５６']) {
        assert.throws(() => validatePassword(password), /密码/);
    }
});

test('仓库不再发布明文密码，后端配置可用于 remote 模式', async () => {
    await assert.rejects(access(new URL('../data/password.json', import.meta.url)));
    const config = JSON.parse(await readFile(new URL('../.secrets/auth.json', import.meta.url), 'utf8'));
    assert.equal('password' in config, false);
    assert.equal(validateAuthConfig(config, { requireProduction: true }).productionReady, true);
    assert.equal(await verifyPassword(config, '000000'), false);
});
