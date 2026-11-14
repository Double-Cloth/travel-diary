import { createMediaPreview } from './preview.mjs';

async function run() {
    async function generate(item) {
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

    const active = new Set();
    let finished = false;
    let failure;
    // 完成一项立即领取空出的并发槽，慢媒体不会挡住另一条生成链路。
    while (!finished || active.size) {
        if (!finished && active.size < 2) {
            const response = await fetch(`./manifest?limit=${2 - active.size}`);
            if (!response.ok) throw new Error('无法领取生成任务。');
            const manifest = await response.json();
            finished = !manifest.length;
            for (const item of manifest) {
                const task = generate(item).catch(error => { failure = error; }).finally(() => active.delete(task));
                active.add(task);
            }
        }
        if (active.size === 2 || (finished && active.size)) await Promise.race(active);
        if (failure) throw failure;
    }
    const response = await fetch('./complete', { method: 'POST' });
    if (!response.ok) throw new Error('无法完成生成任务。');
}

run().catch(error => fetch('./error', { method: 'POST', body: String(error.message) }));
