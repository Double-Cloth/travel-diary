import { readSourceText, sourceOf } from './zip-stream.mjs';

// 上传大文件前验证密码；服务端正式导入时仍会重新验证 ZIP 内的配置。
export async function verifyBackupPassword(entries, capability, currentPassword, backupPassword = currentPassword) {
    const auth = entries.find(entry => entry.name === '.secrets/auth.json');
    if (!auth) return;
    const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readSourceText(sourceOf(auth.data))));
    const response = await fetch(new URL('api/travel-data?mode=verify-backup', window.location.href), {
        method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'X-Travel-Token': capability.token,
            'X-Travel-Current-Password': currentPassword, 'X-Travel-Backup-Password': backupPassword },
        body: JSON.stringify({ auth: config })
    });
    const result = await response.json();
    if (!response.ok || !result.verified) throw Object.assign(new Error(response.status === 415
        ? '当前服务尚不支持备份密码预校验，请重启服务器后再试。'
        : result.error || '备份密码验证失败。'), { code: result.code });
}
