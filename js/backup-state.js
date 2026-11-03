import { confirmFeedback } from './feedback-dialog.js?v=20261102-native-preview-v1';

export async function confirmBackupSaved(download, capability) {
    if (download.cancelled || !download.backupReceipt) return false;
    const confirmed = await confirmFeedback('请先确认这次导出的 ZIP 文件已保存。点击“已保存”，会把本次导出的记录标记为已备份。下次选择待备份记录时，它们只有修改后才会再次被选中；未导出的记录不受影响。', {
        title: '确认备份已保存', confirmLabel: '已保存', cancelLabel: '还未确认'
    });
    if (!confirmed) return false;
    const response = await fetch(new URL('api/travel-data?mode=backup-complete', window.location.href), {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Travel-Token': capability.token },
        body: JSON.stringify({ receipt: download.backupReceipt })
    });
    const result = await response.json();
    if (!response.ok || !result.remembered) throw new Error(result.error || '文件已下载，但更新备份状态失败，请稍后重新导出。');
    return true;
}
