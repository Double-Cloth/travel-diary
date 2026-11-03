import { confirmFeedback } from './feedback-dialog.js?v=20261102-native-preview-v1';

export async function confirmBackupSaved(download, capability) {
    if (download.cancelled || !download.backupReceipt) return false;
    const confirmed = await confirmFeedback('请确认 ZIP 文件已经保存且可以找到。确认后，这次导出的内容会作为“待备份变更”的比较基准；未导出的记录不受影响。', {
        title: '备份文件已保存？', confirmLabel: '已保存，更新备份状态', cancelLabel: '暂不更新'
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
