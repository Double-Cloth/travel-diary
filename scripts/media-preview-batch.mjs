import { createMediaPreview } from './preview.mjs';

async function run() {
    while (true) {
        const manifest = await fetch('./manifest').then(response => response.json());
        if (!manifest.length) return;
        for (const item of manifest) {
            let status = 'cached';
            let message = '';
            try {
                const response = await fetch(item.preview, { signal: AbortSignal.timeout(20000) });
                if (response.status === 204) {
                    const blob = await createMediaPreview(item.source, item.kind);
                    const saved = await fetch(item.preview, {
                        method: 'PUT', headers: { 'Content-Type': 'image/jpeg', 'If-Match': response.headers.get('etag') },
                        body: blob, signal: AbortSignal.timeout(20000)
                    });
                    if (!saved.ok) throw new Error(`保存失败（HTTP ${saved.status}）。`);
                    status = 'generated';
                } else if (response.status !== 200) {
                    throw new Error(`读取失败（HTTP ${response.status}）。`);
                }
                await response.body?.cancel();
            } catch (error) {
                status = 'failed';
                message = error.message;
            }
            const report = await fetch('./progress', { method: 'POST', body: JSON.stringify({ index: item.index, status, message }) });
            if (!report.ok) throw new Error('无法报告生成进度。');
        }
    }
}

run().catch(error => fetch('./error', { method: 'POST', body: String(error.message) }));
