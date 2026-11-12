import { readSourceText, sourceOf } from './zip-stream.mjs';
import { requestWriterJson } from './writer-capability.js?v=2.1.122';

// 上传大文件前验证密码；服务端正式导入时仍会重新验证 ZIP 内的配置。
export async function verifyBackupPassword(entries, capability, currentPassword, backupPassword = currentPassword) {
    const auth = entries.find(entry => entry.name === '.secrets/auth.json');
    if (!auth) return;
    const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readSourceText(sourceOf(auth.data))));
    const { response, result } = await requestWriterJson(new URL('api/travel-data?mode=verify-backup', window.location.href), {
        method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'X-Travel-Token': capability.token,
            ...(currentPassword === undefined ? {} : { 'X-Travel-Current-Password': currentPassword }),
            ...(backupPassword === undefined ? {} : { 'X-Travel-Backup-Password': backupPassword }) },
        body: JSON.stringify({ auth: config })
    }, '备份密码验证连接中断，请检查服务及网络后重新验证。');
    if (!response.ok || result.verified !== true) throw Object.assign(new Error(response.status === 415
        ? '当前服务尚不支持导入前验证密码，请重启服务器后再试。'
        : result.error || '无法验证备份时的密码，请重试。'), { code: result.code });
}
