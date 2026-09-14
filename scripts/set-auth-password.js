const fs = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { createAuthConfig, PASSWORD_LENGTH } = require('../js/auth.js');

function readSecret(prompt) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('此命令需要交互式终端，以避免口令出现在命令行参数、Shell 历史或进程列表中。');
    }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(prompt);
    return new Promise((resolve, reject) => {
        let value = '';
        const finish = (error) => {
            process.stdin.off('keypress', onKeypress);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.write('\n');
            if (error) reject(error);
            else resolve(value);
        };
        const onKeypress = (character, key = {}) => {
            if (key.ctrl && key.name === 'c') return finish(new Error('已取消设置访问口令。'));
            if (key.name === 'return' || key.name === 'enter') return finish();
            if (key.name === 'backspace') {
                if (value) {
                    value = Array.from(value).slice(0, -1).join('');
                    process.stdout.write('\b \b');
                }
                return;
            }
            if (!key.ctrl && !key.meta && /^\d$/.test(character) && value.length < PASSWORD_LENGTH) {
                value += character;
                process.stdout.write('*');
            }
        };
        process.stdin.on('keypress', onKeypress);
    });
}

async function writeAuthConfig(root, config) {
    const secretsDir = path.join(root, '.secrets');
    await fs.mkdir(secretsDir, { recursive: true });
    const directoryStat = await fs.lstat(secretsDir);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('.secrets 必须是项目内的普通目录。');
    await fs.chmod(secretsDir, 0o700).catch(() => {});
    const target = path.join(secretsDir, 'auth.json');
    const suffix = `${process.pid}-${Date.now()}`;
    const temporary = path.join(secretsDir, `.auth-${suffix}.tmp`);
    const backup = path.join(secretsDir, `.auth-${suffix}.bak`);
    let movedExisting = false;
    let installed = false;
    try {
        try {
            const targetStat = await fs.lstat(target);
            if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
                throw new Error('.secrets/auth.json 必须是普通文件，不能是链接。');
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        try {
            await fs.rename(target, backup);
            movedExisting = true;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        await fs.rename(temporary, target);
        installed = true;
        await fs.chmod(target, 0o600).catch(() => {});
        if (movedExisting) {
            await fs.unlink(backup).catch(() => {});
            movedExisting = false;
        }
    } catch (error) {
        if (movedExisting && !installed) {
            try { await fs.rename(backup, target); }
            catch (restoreError) {
                throw new AggregateError([error, restoreError], '认证配置更新失败，且旧配置自动恢复失败。');
            }
            movedExisting = false;
        }
        throw error;
    } finally {
        await fs.unlink(temporary).catch(() => {});
    }
}

async function main() {
    const root = path.resolve(__dirname, '..');
    process.stdout.write(`请设置 ${PASSWORD_LENGTH} 位数字访问密码。输入过程不会回显数字。\n`);
    const password = await readSecret('新访问密码：');
    const confirmation = await readSecret('再次输入：');
    if (password !== confirmation) throw new Error('两次输入的访问密码不一致。');
    const config = await createAuthConfig(password);
    await writeAuthConfig(root, config);
    process.stdout.write('已安全更新 .secrets/auth.json，旧会话将自动失效。\n');
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { readSecret, writeAuthConfig };
