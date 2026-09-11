import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const { readRecordPassword } = await loadBrowserModule(new URL('../js/record-password.js', import.meta.url));

test('新增记录密码配置读取 6 位数字密码', async () => {
    const config = JSON.parse(await readFile(new URL('../data/password.json', import.meta.url), 'utf8'));
    assert.equal(readRecordPassword(config), '240918');
});

test('新增记录密码拒绝非 6 位数字配置', () => {
    for (const password of [null, 240918, '', '12345', '1234567', '12a456']) {
        assert.throws(() => readRecordPassword({ password }), /6 位数字/);
    }
});
