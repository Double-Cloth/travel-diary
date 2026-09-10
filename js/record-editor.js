import { escapeHtml } from './utils.js';
import { DRAFT_FORMAT, RECORD_FIELDS, prepareRecord, readDraft } from './record-input.mjs';

export function createRecordEditor(onSaved) {
    const dialog = document.createElement('dialog');
    dialog.className = 'record-editor entry-sheet';
    dialog.setAttribute('aria-labelledby', 'recordEditorTitle');
    document.body.append(dialog);
    let countries = [];
    let token = '';
    let requestId = '';
    let busy = false;
    let dirty = false;
    let saved = false;
    let initialized = false;
    let opening = false;
    let trigger;

    const status = message => { dialog.querySelector('[data-editor-status]').textContent = message; };
    const getDraft = () => ({
        format: DRAFT_FORMAT,
        requestId,
        input: Object.fromEntries(RECORD_FIELDS.map(key => [key, dialog.querySelector(`[name="${key}"]`).value]))
    });

    async function detectWriter() {
        token = '';
        dialog.querySelector('[data-editor-save]').disabled = true;
        const hint = dialog.querySelector('[data-editor-mode]');
        hint.textContent = '正在检查文件写入服务…';
        try {
            if (!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) throw new Error();
            const response = await fetch(new URL('api/travel-records', window.location.href), {
                cache: 'no-store', signal: AbortSignal.timeout(4000)
            });
            const result = await response.json();
            if (!response.ok || result.service !== 'travel-diary-writer-v1' || !result.token) throw new Error();
            token = result.token;
            hint.textContent = '本地模式 · 保存会写入旅行索引和 Markdown 日记文件，断网也可使用。';
            dialog.querySelector('[data-editor-save]').disabled = saved;
        } catch {
            hint.textContent = '当前为只读页面（例如 GitHub Pages），无法写回仓库文件。你可以填写并下载草稿，再在本机运行 npm start，打开 localhost 页面导入草稿并保存。下载草稿不会发布或新增站点记录。';
        }
    }

    function render() {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        requestId = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        const today = new Date();
        const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        dialog.innerHTML = `
            <div class="record-editor-heading">
                <div><p class="journal-label">写下新的旅途</p><h2 id="recordEditorTitle">新增旅行记录</h2></div>
                <button class="paper-button" type="button" data-editor-close aria-label="关闭新增窗口，保留本页草稿">关闭</button>
            </div>
            <p class="record-editor-mode" data-editor-mode></p>
            <form>
                <fieldset class="record-editor-fields">
                    <div class="record-editor-grid">
                        <label>旅行日期 <span>必填</span><input name="date" type="date" value="${date}" required></label>
                        <label>国家 / 地区 <span>必填</span><select name="country_code" required>
                            ${countries.map(country => `<option value="${escapeHtml(country.code)}" ${country.code === 'CN' ? 'selected' : ''}>${escapeHtml(country.name_zh)}</option>`).join('')}
                        </select></label>
                        <label><span data-editor-area>一级行政区（选填）</span><input name="admin_area" maxlength="200" placeholder="例如：江苏省"></label>
                        <label>城市 / 目的地 <span>必填</span><input name="locality" maxlength="200" required placeholder="例如：苏州市、平江路"></label>
                    </div>
                    <label>日记标题 <span>必填</span><input name="title" maxlength="200" required placeholder="为这段旅途起个名字"></label>
                    <label>旅途正文 <span>选填 · 支持 Markdown</span><textarea name="body" maxlength="100000" rows="7" placeholder="沿途的风景、遇见的人，还有想记住的小事…"></textarea></label>
                    <label>旅行标识 <span>选填</span><input name="trip_id" maxlength="200" placeholder="同一次旅行填写相同标识，例如 2026-09-jiangsu"></label>
                    <p class="record-editor-note">同一次旅行的多篇记录可共用旅行标识。照片可在保存后按内容维护指南添加。</p>
                </fieldset>
                <p class="record-editor-status" data-editor-status role="status" aria-live="polite"></p>
                <div class="record-editor-actions">
                    <button class="brass-button" type="submit" data-editor-save disabled>保存到项目文件</button>
                    <button class="paper-button" type="button" data-editor-download>下载草稿</button>
                    <button class="paper-button" type="button" data-editor-import>导入草稿</button>
                    <input type="file" accept=".json,application/json" data-editor-file hidden aria-label="选择草稿文件">
                </div>
                <p class="record-editor-note">关闭窗口会保留本页草稿；离开或刷新页面前请下载。只有保存成功的记录才会进入旅行档案。</p>
            </form>`;
        saved = false;
        dirty = false;
        updateAreaLabel();
    }

    function updateAreaLabel() {
        const country = countries.find(item => item.code === dialog.querySelector('[name="country_code"]').value);
        dialog.querySelector('[data-editor-area]').textContent = `${country?.admin_area_label || '一级行政区'}（选填）`;
    }

    function close() {
        if (busy) return;
        dialog.close();
        if (trigger?.isConnected) trigger.focus();
        else document.querySelector('[data-action="add-record"]')?.focus();
    }

    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    // 原有日记弹层也监听键盘事件，编辑时仅由原生 dialog 处理焦点和 Escape。
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('input', event => {
        if (!saved && RECORD_FIELDS.includes(event.target.name)) dirty = true;
    });
    dialog.addEventListener('click', event => {
        if (event.target.closest('[data-editor-close]')) close();
        if (busy) return;
        if (event.target.closest('[data-editor-download]')) {
            const url = URL.createObjectURL(new Blob([JSON.stringify(getDraft(), null, 2) + '\n'], { type: 'application/json' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = `travel-diary-draft-${requestId}.json`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            status('已发起草稿下载，请确认文件已下载完成。草稿下载不会写入旅行索引。');
        }
        if (event.target.closest('[data-editor-import]')) dialog.querySelector('[data-editor-file]').click();
    });
    dialog.addEventListener('change', async event => {
        if (event.target.name === 'country_code') updateAreaLabel();
        if (!event.target.matches('[data-editor-file]')) return;
        const file = event.target.files[0];
        if (!file) return;
        try {
            if (file.size > 512 * 1024) throw new Error('草稿文件不能超过 512 KB。');
            const draft = readDraft(JSON.parse(await file.text()));
            if (dirty) throw new Error('当前窗口已有未保存内容。请先保存，或下载草稿后刷新页面，再导入另一份草稿。');
            for (const key of RECORD_FIELDS) dialog.querySelector(`[name="${key}"]`).value = draft.input[key];
            requestId = draft.requestId;
            dirty = true;
            updateAreaLabel();
            status('草稿已导入，尚未写入项目文件。请检查内容后保存。');
        } catch (error) {
            status(error instanceof SyntaxError ? '文件不是有效的 JSON 草稿。' : error.message);
        } finally {
            event.target.value = '';
        }
    });
    dialog.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || saved || !token) return;
        const draft = getDraft();
        try { prepareRecord(draft, countries); }
        catch (error) { status(error.message); return; }
        busy = true;
        dialog.querySelector('fieldset').disabled = true;
        dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
        status('正在写入项目文件…');
        try {
            const response = await fetch(new URL('api/travel-records', window.location.href), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Travel-Token': token },
                body: JSON.stringify(draft), signal: AbortSignal.timeout(15000)
            });
            const result = await response.json();
            if (!response.ok || !result.saved) throw new Error(result.error || '服务器未确认保存成功。');
            saved = true;
            dirty = false;
            status(`已保存到项目文件：data/travel_data.json 和 ${result.record.desc_md}。发布到站点仍需提交并推送这些文件。`);
            try { await onSaved(result.record); }
            catch { status(`文件已保存：${result.record.desc_md}，但页面刷新失败，请刷新浏览器查看。`); }
        } catch (error) {
            status(`未能确认保存成功：${error.message} 内容仍保留，请下载草稿或重试；重试同一草稿不会重复新增。`);
        } finally {
            busy = false;
            dialog.querySelector('fieldset').disabled = saved;
            dialog.querySelectorAll('button').forEach(button => { button.disabled = false; });
            dialog.querySelector('[data-editor-save]').disabled = saved || !token;
            dialog.querySelector('[data-editor-import]').disabled = saved;
        }
    });
    window.addEventListener('beforeunload', event => {
        if (!dirty && !busy) return;
        event.preventDefault();
        event.returnValue = '';
    });

    return async () => {
        if (dialog.open || opening) return;
        opening = true;
        try {
            trigger = document.activeElement;
            if (!initialized || saved) {
                if (!countries.length) {
                    const response = await fetch(new URL('assets/catalogs/countries.json', window.location.href));
                    if (!response.ok) throw new Error('国家目录加载失败，请刷新后重试。');
                    countries = (await response.json()).countries;
                }
                render();
                initialized = true;
            }
            dialog.showModal();
            await detectWriter();
        } finally {
            opening = false;
        }
    };
}
