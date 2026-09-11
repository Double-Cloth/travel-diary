import { escapeHtml } from './utils.js';
import { highlightMarkdown, splitMarkdown, previewHtml, previewToMarkdown } from './markdown-editor.js';
import { readUploads } from './photo-uploads.mjs';
import { DRAFT_FORMAT, RECORD_FIELDS, buildMarkdown, defaultMarkdownPath, prepareRecord, readDraft, recordSlug } from './record-input.mjs';
import { getRecordAutofill, getRecordOptions, suggestedTripId } from './record-suggestions.mjs';
import { createDraftArchive, readDraftArchive } from './draft-archive.mjs';
import { enhanceCustomSelects } from './custom-select.js';

export function createRecordEditor(onSaved, getRecords = () => []) {
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
    let bodyView = 'source';
    let uploads = [];
    let readingPhotos = false;
    let trigger;
    const userEditedAutofillFields = new Set();
    const autoFilledValues = new Map();

    const field = name => dialog.querySelector(`[name="${name}"]`);
    const status = message => { dialog.querySelector('[data-editor-status]').textContent = message; };
    const getDraft = () => ({
        format: DRAFT_FORMAT,
        requestId,
        uploads: uploads.map(({ id, name, data }) => ({ id, name, data })),
        input: Object.fromEntries(RECORD_FIELDS.map(key => [key, key === 'photos'
            ? field(key).value.split(/\r?\n/).map(photo => photo.trim()).filter(Boolean)
            : field(key).value]))
    });

    async function detectWriter() {
        token = '';
        dialog.querySelector('[data-editor-save]').disabled = true;
        const hint = dialog.querySelector('[data-editor-mode]');
        hint.textContent = '正在检查保存服务…';
        try {
            if (!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) throw new Error();
            const response = await fetch(new URL('api/travel-records', window.location.href), {
                cache: 'no-store', signal: AbortSignal.timeout(4000)
            });
            const result = await response.json();
            if (!response.ok || result.service !== 'travel-diary-writer-v1' || !result.token) throw new Error();
            token = result.token;
            hint.textContent = '本地模式 · 可直接保存到项目。';
            dialog.querySelector('[data-editor-save]').disabled = saved;
        } catch {
            hint.textContent = '只读模式 · 请导出草稿后在本机重新导入。';
        }
    }

    function render() {
        requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
        const today = new Date();
        const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        dialog.innerHTML = `
            <header class="record-editor-heading">
                <div><p class="journal-label">旅行日记</p><h2 id="recordEditorTitle">新增旅行记录</h2></div>
                <button class="paper-button" type="button" data-editor-close aria-label="关闭新增窗口，保留本页草稿">关闭</button>
            </header>
            <form>
                <div class="record-editor-scroll">
                    <p class="record-editor-mode" data-editor-mode></p>
                    <div class="record-editor-layout">
                        <section class="record-editor-section" aria-labelledby="recordLocationTitle">
                            <h3 id="recordLocationTitle"><span>01</span> 行程与地点</h3>
                            <div class="record-editor-fields">
                                <div class="record-editor-grid">
                                    <label>旅行日期 <span>必填</span><input name="date" type="date" value="${date}" required></label>
                                    <label>旅行标识 <span>选填</span><span class="record-editor-autocomplete"><input name="trip_id" maxlength="200" data-editor-autocomplete="trip_id" placeholder="同次旅行共用" aria-describedby="recordTripHelp" aria-autocomplete="list" aria-controls="recordTripOptions" aria-expanded="false" autocomplete="off"><span class="record-editor-autocomplete-chevron" aria-hidden="true"></span><span class="record-editor-autocomplete-menu" id="recordTripOptions" role="listbox" data-editor-autocomplete-menu hidden></span></span></label>
                                </div>
                                <p class="record-editor-note" id="recordTripHelp">同次旅行填写同一标识。</p>
                                <div class="record-editor-grid">
                                    <label>国家 / 地区 <span>必填</span><span class="custom-select"><select name="country_code" data-custom-select aria-label="国家 / 地区" required>
                                        ${countries.map(country => `<option value="${escapeHtml(country.code)}" ${country.code === 'CN' ? 'selected' : ''}>${escapeHtml(country.code)} · ${escapeHtml(country.name_zh)}</option>`).join('')}
                                    </select></span></label>
                                    <label>国家显示名称 <span>选填</span><span class="record-editor-autocomplete"><input name="country" maxlength="200" data-editor-autocomplete="country" placeholder="默认使用目录名称" aria-autocomplete="list" aria-controls="recordCountryOptions" aria-expanded="false" autocomplete="off"><span class="record-editor-autocomplete-chevron" aria-hidden="true"></span><span class="record-editor-autocomplete-menu" id="recordCountryOptions" role="listbox" data-editor-autocomplete-menu hidden></span></span></label>
                                    <label><span class="record-editor-field-name" data-editor-area>一级行政区</span> <span>选填</span><span class="record-editor-autocomplete"><input name="admin_area" maxlength="200" data-editor-autocomplete="admin_area" placeholder="例如：江苏省" aria-autocomplete="list" aria-controls="recordAdminAreaOptions" aria-expanded="false" autocomplete="off"><span class="record-editor-autocomplete-chevron" aria-hidden="true"></span><span class="record-editor-autocomplete-menu" id="recordAdminAreaOptions" role="listbox" data-editor-autocomplete-menu hidden></span></span></label>
                                    <label>行政区类型 <span>选填</span><span class="record-editor-autocomplete"><input name="admin_area_type" maxlength="200" data-editor-autocomplete="admin_area_type" placeholder="例如：省、州" aria-autocomplete="list" aria-controls="recordAdminAreaTypeOptions" aria-expanded="false" autocomplete="off"><span class="record-editor-autocomplete-chevron" aria-hidden="true"></span><span class="record-editor-autocomplete-menu" id="recordAdminAreaTypeOptions" role="listbox" data-editor-autocomplete-menu hidden></span></span></label>
                                    <label>城市 / 目的地 <span>必填</span><span class="record-editor-autocomplete"><input name="locality" maxlength="200" data-editor-autocomplete="locality" required placeholder="例如：苏州市" aria-autocomplete="list" aria-controls="recordLocalityOptions" aria-expanded="false" autocomplete="off"><span class="record-editor-autocomplete-chevron" aria-hidden="true"></span><span class="record-editor-autocomplete-menu" id="recordLocalityOptions" role="listbox" data-editor-autocomplete-menu hidden></span></span></label>
                                    <label>目的地类型 <span>选填</span><span class="record-editor-autocomplete"><input name="locality_type" maxlength="200" data-editor-autocomplete="locality_type" placeholder="例如：城市、岛屿" aria-autocomplete="list" aria-controls="recordLocalityTypeOptions" aria-expanded="false" autocomplete="off"><span class="record-editor-autocomplete-chevron" aria-hidden="true"></span><span class="record-editor-autocomplete-menu" id="recordLocalityTypeOptions" role="listbox" data-editor-autocomplete-menu hidden></span></span></label>
                                </div>
                                <p class="record-editor-note record-editor-autofill" data-editor-autofill>填写国家、行政区或目的地后，将自动补全可可靠推断的空白项；也可从历史候选中选择。</p>
                                <div data-editor-option-lists hidden></div>
                            </div>
                        </section>
                        <section class="record-editor-section" aria-labelledby="recordBodyTitle">
                            <h3 id="recordBodyTitle"><span>02</span> 旅行正文</h3>
                            <label>日记标题 <span>必填</span><input name="title" maxlength="200" required placeholder="为这段旅途起个名字"></label>
                            <div class="record-editor-workbench">
                                <div class="record-editor-tabs" role="tablist" aria-label="正文视图">
                                    <button type="button" role="tab" id="recordTabSource" aria-controls="recordPanelSource" aria-selected="true" data-editor-view="source">源码</button>
                                    <button type="button" role="tab" id="recordTabPreview" aria-controls="recordPanelPreview" aria-selected="false" tabindex="-1" data-editor-view="preview">预览</button>
                                    <span class="record-editor-format">Markdown</span>
                                </div>
                                <div id="recordPanelSource" role="tabpanel" aria-labelledby="recordTabSource" data-editor-panel="source">
                                    <div class="record-editor-source-layer">
                                        <pre data-editor-highlight aria-hidden="true"><code></code></pre>
                                        <textarea data-editor-source maxlength="100210" rows="10" aria-label="Markdown 源码" aria-describedby="recordBodyHelp" spellcheck="false"></textarea>
                                    </div>
                                </div>
                                <div id="recordPanelPreview" role="tabpanel" aria-labelledby="recordTabPreview" data-editor-panel="preview" hidden>
                                    <div class="record-editor-formatting" role="toolbar" aria-label="预览格式">
                                        <button type="button" data-format="bold" aria-label="加粗"><b>粗体</b></button>
                                        <button type="button" data-format="italic" aria-label="斜体"><i>斜体</i></button>
                                        <button type="button" data-format="formatBlock" data-format-value="h2">标题</button>
                                        <button type="button" data-format="formatBlock" data-format-value="p">段落</button>
                                        <button type="button" data-format="insertUnorderedList">列表</button>
                                    </div>
                                    <div class="record-editor-preview markdown-content" data-editor-rich contenteditable="true" role="textbox" aria-label="预览正文，可直接编辑" aria-multiline="true" aria-describedby="recordBodyHelp"></div>
                                </div>
                                <textarea name="body" hidden></textarea>
                            </div>
                        </section>
                    </div>
                    <section class="record-editor-photos" aria-labelledby="recordPhotosTitle">
                        <h3 id="recordPhotosTitle"><span>03</span> 旅行照片</h3>
                        <div class="record-editor-upload-zone" data-editor-drop>
                            <button class="paper-button" type="button" data-editor-upload>＋ 上传照片</button>
                            <p>选择或拖入图片。</p>
                            <small>支持 JPEG / PNG / GIF / WebP</small>
                            <input type="file" data-editor-photos accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden aria-label="选择旅行照片">
                        </div>
                        <div class="record-editor-photo-list" data-editor-photo-list aria-label="待保存照片"></div>
                    </section>
                    <details class="record-editor-files">
                        <summary><span>文件设置</span><span>正文路径与已有照片引用</span></summary>
                        <div class="record-editor-fields">
                            <label>正文文件路径 <span>选填 · 留空自动生成</span><input name="desc_md" maxlength="200"></label>
                            <div class="record-editor-grid">
                                <label>照片目录 <span>选填</span><input name="photo_folder" maxlength="200" placeholder="data/photos/suzhou" aria-describedby="recordPhotoHelp"></label>
                                <label>照片文件列表 <span>选填 · 每行一个文件名</span><textarea name="photos" rows="3" maxlength="201000" placeholder="canal.jpg&#10;garden.jpg" aria-describedby="recordPhotoHelp"></textarea></label>
                            </div>
                            <p class="record-editor-note" id="recordPhotoHelp">仅填写项目内已有照片；上传照片无需设置。新上传照片会使用拼音文件名并保存到：<output data-editor-photo-path-preview></output></p>
                        </div>
                    </details>
                </div>
                <footer class="record-editor-footer">
                    <p class="record-editor-status" data-editor-status role="status" aria-live="polite"></p>
                    <div class="record-editor-actions">
                        <div class="record-editor-exports">
                            <button class="paper-button" type="button" data-editor-import>导入草稿</button>
                            <button class="paper-button" type="button" data-editor-download>导出草稿</button>
                        </div>
                        <button class="brass-button" type="submit" data-editor-save disabled>保存旅行记录</button>
                        <input type="file" accept=".zip,.json,application/zip,application/json" data-editor-file hidden aria-label="选择草稿 ZIP 或旧版 JSON 文件">
                    </div>
                    <p class="record-editor-note">离开页面前请保存或导出草稿。</p>
                </footer>
            </form>`;
        saved = false;
        dirty = false;
        uploads = [];
        bodyView = 'source';
        userEditedAutofillFields.clear();
        autoFilledValues.clear();
        enhanceCustomSelects(dialog);
        updateCountry(true);
        updatePathHint();
        updateAutofill();
        updateBodyView(bodyView);
    }

    function updateCountry(fillName = false) {
        const country = countries.find(item => item.code === field('country_code').value);
        dialog.querySelector('[data-editor-area]').textContent = country?.admin_area_label || '一级行政区';
        field('country').placeholder = country?.name_zh || '默认使用目录名称';
        if (fillName) field('country').value = country?.name_zh || '';
    }

    function updatePathHint() {
        const locality = field('locality').value || '目的地';
        const markdownPath = defaultMarkdownPath(field('date').value || 'YYYY-MM-DD', locality);
        const photoPath = `data/photos/${recordSlug(locality)}`;
        field('desc_md').placeholder = markdownPath;
        field('photo_folder').placeholder = photoPath;
        dialog.querySelector('[data-editor-photo-path-preview]').textContent = photoPath;
        field('trip_id').placeholder = suggestedTripId(getDraft().input) || '同次旅行共用';
    }

    function updateAutofill() {
        const input = getDraft().input;
        const records = getRecords() || [];
        const values = getRecordAutofill(input, countries, records);
        const filled = [];
        ['country', 'admin_area', 'admin_area_type', 'locality_type'].forEach(name => {
            const previousAutoValue = autoFilledValues.get(name);
            if (previousAutoValue && !values[name] && field(name).value === previousAutoValue && !userEditedAutofillFields.has(name)) {
                field(name).value = '';
                autoFilledValues.delete(name);
            }
        });
        Object.entries(values).forEach(([name, value]) => {
            const control = field(name);
            const previousAutoValue = autoFilledValues.get(name);
            const mayReplace = !control.value.trim() || control.value === previousAutoValue || control.value === value;
            if (!value || userEditedAutofillFields.has(name) || !mayReplace) return;
            if (control.value !== value) {
                control.value = value;
                filled.push(fieldLabel(name));
            }
            autoFilledValues.set(name, value);
        });
        updatePathHint();
        renderOptionLists(getRecordOptions(getDraft().input, countries, records));
        const hint = dialog.querySelector('[data-editor-autofill]');
        hint.textContent = filled.length
            ? `已自动补全：${filled.join('、')}。所有自动填写内容均可修改。`
            : '会根据当前国家、行政区、目的地和历史记录补全可靠信息；所有内容均可修改。';
    }

    function renderOptionLists(options) {
        dialog.querySelectorAll('[data-editor-autocomplete]').forEach(input => {
            const menu = input.closest('.record-editor-autocomplete')?.querySelector('[data-editor-autocomplete-menu]');
            if (!menu) return;
            menu.innerHTML = (options[input.dataset.editorAutocomplete] || []).map((value, index) => `
                <span id="${menu.id}-option-${index}" role="option" data-autocomplete-value="${escapeHtml(value)}">${escapeHtml(value)}</span>`).join('');
            menu.hidden = true;
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
        });
    }

    function autocompleteOptions(input) {
        const menu = input.closest('.record-editor-autocomplete')?.querySelector('[data-editor-autocomplete-menu]');
        return menu ? [...menu.querySelectorAll('[role="option"]')].filter(option => !option.hidden) : [];
    }

    function closeAutocomplete(input) {
        const wrapper = input?.closest('.record-editor-autocomplete');
        const menu = wrapper?.querySelector('[data-editor-autocomplete-menu]');
        if (!wrapper || !menu) return;
        wrapper.classList.remove('is-open');
        menu.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        menu.querySelectorAll('.is-active').forEach(option => option.classList.remove('is-active'));
    }

    function closeOtherAutocompletes(current) {
        dialog.querySelectorAll('[data-editor-autocomplete]').forEach(input => {
            if (input !== current) closeAutocomplete(input);
        });
    }

    function showAutocomplete(input) {
        const menu = input.closest('.record-editor-autocomplete')?.querySelector('[data-editor-autocomplete-menu]');
        if (!menu) return;
        const query = input.value.trim().toLocaleLowerCase();
        const options = [...menu.querySelectorAll('[role="option"]')];
        options.forEach(option => {
            option.hidden = Boolean(query) && !option.textContent.toLocaleLowerCase().includes(query);
            option.classList.remove('is-active');
        });
        const visible = options.filter(option => !option.hidden);
        if (!visible.length) {
            closeAutocomplete(input);
            return;
        }
        closeOtherAutocompletes(input);
        menu.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        input.removeAttribute('aria-activedescendant');
        input.closest('.record-editor-autocomplete').classList.add('is-open');
    }

    function selectAutocompleteOption(input, option) {
        if (!option) return;
        input.value = option.dataset.autocompleteValue || option.textContent;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        closeAutocomplete(input);
        input.focus();
    }

    function moveAutocompleteSelection(input, direction) {
        showAutocomplete(input);
        const options = autocompleteOptions(input);
        if (!options.length) return;
        const current = options.findIndex(option => option.classList.contains('is-active'));
        const next = (current + direction + options.length) % options.length;
        options.forEach(option => option.classList.remove('is-active'));
        const option = options[next];
        option.classList.add('is-active');
        input.setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView({ block: 'nearest' });
    }

    function fieldLabel(name) {
        return ({ country: '国家显示名称', admin_area: '一级行政区', admin_area_type: '行政区类型', locality_type: '目的地类型' })[name] || name;
    }

    function updateBodyView(view) {
        bodyView = view;
        const input = getDraft().input;
        const markdown = buildMarkdown(input);
        if (view === 'preview') {
            dialog.querySelector('[data-editor-rich]').innerHTML = previewHtml(markdown, input.title);
        }
        if (view === 'source') {
            dialog.querySelector('[data-editor-source]').value = markdown;
            updateMarkdownHighlight(markdown);
        }
        dialog.querySelectorAll('[data-editor-view]').forEach(button => {
            const active = button.dataset.editorView === view;
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
        });
        dialog.querySelectorAll('[data-editor-panel]').forEach(panel => { panel.hidden = panel.dataset.editorPanel !== view; });
    }

    function syncMarkdown(source) {
        const input = splitMarkdown(source, field('title').value);
        field('title').value = input.title;
        field('body').value = input.body;
        updateMarkdownHighlight(source);
        dirty = true;
    }

    function updateMarkdownHighlight(source) {
        dialog.querySelector('[data-editor-highlight] code').innerHTML = `${highlightMarkdown(source)}\n`;
    }

    function syncPreview() {
        syncMarkdown(previewToMarkdown(dialog.querySelector('[data-editor-rich]')));
    }

    function renderPhotos() {
        dialog.querySelector('[data-editor-photo-list]').innerHTML = uploads.map((photo, index) => `
            <figure class="record-editor-photo">
                <img src="data:image/${photo.extension === 'jpg' ? 'jpeg' : photo.extension};base64,${photo.data}" alt="${escapeHtml(photo.name)}">
                <figcaption>${escapeHtml(photo.name)}</figcaption>
                <div>
                    <button type="button" data-photo-move="${index}" data-direction="-1" aria-label="前移 ${escapeHtml(photo.name)}" ${index === 0 || saved ? 'disabled' : ''}>←</button>
                    <button type="button" data-photo-move="${index}" data-direction="1" aria-label="后移 ${escapeHtml(photo.name)}" ${index === uploads.length - 1 || saved ? 'disabled' : ''}>→</button>
                    <button type="button" data-photo-remove="${index}" aria-label="移除 ${escapeHtml(photo.name)}" ${saved ? 'disabled' : ''}>移除</button>
                </div>
            </figure>`).join('');
    }

    function updatePhotoStatus() {
        status(uploads.length ? `当前有 ${uploads.length} 张照片待保存，导出 ZIP 草稿时会作为独立文件一并包含。` : '');
    }

    async function addPhotos(files) {
        if (busy || saved || readingPhotos || !files.length) return;
        readingPhotos = true;
        const saveButton = dialog.querySelector('[data-editor-save]');
        saveButton.disabled = true;
        status('正在读取照片…');
        try {
            if (files.some(file => !file.size)) throw new Error('不能上传空图片文件。');
            const pending = [];
            for (const file of files) {
                const data = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result).split(',')[1]);
                    reader.onerror = () => reject(new Error('照片读取失败，请重新选择。'));
                    reader.readAsDataURL(file);
                });
                const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
                const photo = readUploads([{ id, name: file.name.slice(0, 200), data }])[0];
                const image = new Image();
                image.src = `data:image/${photo.extension === 'jpg' ? 'jpeg' : photo.extension};base64,${data}`;
                await image.decode().catch(() => { throw new Error(`无法解码图片：${file.name}`); });
                pending.push(photo);
            }
            uploads.push(...pending);
            dirty = true;
            renderPhotos();
            updatePhotoStatus();
        } catch (error) { status(error.message); }
        finally { readingPhotos = false; saveButton.disabled = saved || !token; }
    }

    function download(content, name, type) {
        const url = URL.createObjectURL(new Blob([content], { type }));
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function close() {
        if (busy || readingPhotos) return;
        dialog.close();
        if (trigger?.isConnected) trigger.focus();
        else document.querySelector('[data-action="add-record"]')?.focus();
    }

    dialog.addEventListener('cancel', event => {
        if (event.target !== dialog) return;
        event.preventDefault();
        close();
    });
    // 正文标签使用方向键切换；其他按键由原生 dialog 处理，避免触发背景日记快捷键。
    dialog.addEventListener('keydown', event => {
        const tab = event.target.closest('[data-editor-view]');
        if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const tabs = [...dialog.querySelectorAll('[data-editor-view]')];
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            tabs[index].focus();
            updateBodyView(tabs[index].dataset.editorView);
        }
        event.stopPropagation();
    });
    dialog.addEventListener('focusin', event => {
        if (event.target.matches('[data-editor-autocomplete]')) showAutocomplete(event.target);
    });
    dialog.addEventListener('focusout', event => {
        if (!event.target.matches('[data-editor-autocomplete]')) return;
        window.setTimeout(() => {
            if (!event.target.closest('.record-editor-autocomplete')?.contains(document.activeElement)) closeAutocomplete(event.target);
        }, 0);
    });
    dialog.addEventListener('keydown', event => {
        const input = event.target.closest('[data-editor-autocomplete]');
        if (!input) return;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveAutocompleteSelection(input, 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveAutocompleteSelection(input, -1);
        } else if (event.key === 'Enter' && input.getAttribute('aria-expanded') === 'true') {
            const option = autocompleteOptions(input).find(item => item.classList.contains('is-active')) || autocompleteOptions(input)[0];
            if (option) {
                event.preventDefault();
                selectAutocompleteOption(input, option);
            }
        } else if (event.key === 'Escape') {
            closeAutocomplete(input);
        }
    });
    dialog.addEventListener('input', event => {
        if (event.target.matches('[data-editor-source]')) syncMarkdown(event.target.value);
        if (event.target.closest('[data-editor-rich]')) syncPreview();
        if (!saved && RECORD_FIELDS.includes(event.target.name)) dirty = true;
        if (['country', 'admin_area', 'admin_area_type', 'locality_type'].includes(event.target.name)) {
            userEditedAutofillFields.add(event.target.name);
            autoFilledValues.delete(event.target.name);
        }
        if (event.target.name === 'date' || event.target.name === 'locality' || event.target.name === 'admin_area') updatePathHint();
        if (['country_code', 'admin_area', 'locality'].includes(event.target.name)) updateAutofill();
        if (event.target.name === 'title') updateBodyView(bodyView);
    });
    dialog.addEventListener('scroll', event => {
        if (!event.target.matches('[data-editor-source]')) return;
        const highlight = dialog.querySelector('[data-editor-highlight]');
        highlight.scrollTop = event.target.scrollTop;
        highlight.scrollLeft = event.target.scrollLeft;
    }, true);
    dialog.addEventListener('pointerdown', event => {
        const option = event.target.closest('[data-autocomplete-value]');
        if (option) {
            event.preventDefault();
            selectAutocompleteOption(option.closest('.record-editor-autocomplete').querySelector('[data-editor-autocomplete]'), option);
            return;
        }
        if (event.target.closest('[data-format]')) event.preventDefault();
    });
    dialog.addEventListener('paste', event => {
        if (!event.target.closest('[data-editor-rich]') || saved || busy) return;
        event.preventDefault();
        document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
        syncPreview();
    });
    dialog.addEventListener('dragover', event => {
        if (event.target.closest('[data-editor-drop], [data-editor-rich]')) event.preventDefault();
        if (event.target.closest('[data-editor-drop]')) dialog.querySelector('[data-editor-drop]').classList.add('is-dragging');
    });
    dialog.addEventListener('dragleave', event => {
        const zone = event.target.closest('[data-editor-drop]');
        if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove('is-dragging');
    });
    dialog.addEventListener('drop', event => {
        if (event.target.closest('[data-editor-rich]')) { event.preventDefault(); return; }
        if (!event.target.closest('[data-editor-drop]')) return;
        event.preventDefault();
        dialog.querySelector('[data-editor-drop]').classList.remove('is-dragging');
        void addPhotos([...event.dataTransfer.files]);
    });
    dialog.addEventListener('click', event => {
        if (event.target.closest('[data-editor-close]')) close();
        if (busy || readingPhotos) return;
        if (event.target.closest('[data-editor-rich] a')) event.preventDefault();
        const format = event.target.closest('[data-format]');
        if (format && !saved) {
            dialog.querySelector('[data-editor-rich]').focus();
            document.execCommand(format.dataset.format, false, format.dataset.formatValue || null);
            syncPreview();
        }
        if (event.target.closest('[data-editor-upload]') && !saved) dialog.querySelector('[data-editor-photos]').click();
        const remove = event.target.closest('[data-photo-remove]');
        const move = event.target.closest('[data-photo-move]');
        if (remove && !saved) {
            uploads.splice(Number(remove.dataset.photoRemove), 1);
            dirty = true;
            renderPhotos();
            updatePhotoStatus();
        }
        if (move && !saved) {
            const index = Number(move.dataset.photoMove);
            const next = index + Number(move.dataset.direction);
            if (next >= 0 && next < uploads.length) {
                [uploads[index], uploads[next]] = [uploads[next], uploads[index]];
                dirty = true;
                renderPhotos();
                updatePhotoStatus();
            }
        }
        const view = event.target.closest('[data-editor-view]');
        if (view) updateBodyView(view.dataset.editorView);
        if (event.target.closest('[data-editor-download]')) {
            const input = getDraft().input;
            download(createDraftArchive(getDraft()), `travel-diary-draft-${input.date || 'undated'}-${recordSlug(input.locality || 'destination')}.zip`, 'application/zip');
            status('已发起 ZIP 草稿下载；照片作为独立文件保存，draft.json 不包含 Base64 图片。');
        }
        if (event.target.closest('[data-editor-import]')) dialog.querySelector('[data-editor-file]').click();
    });
    dialog.addEventListener('change', async event => {
        if (event.target.name === 'country_code') {
            const countryField = field('country');
            const previousAutoValue = autoFilledValues.get('country');
            if (!userEditedAutofillFields.has('country') && (!countryField.value.trim() || countryField.value === previousAutoValue)) {
                countryField.value = '';
            }
            autoFilledValues.delete('country');
            updateCountry();
            updateAutofill();
        }
        if (event.target.matches('[data-editor-photos]')) {
            await addPhotos([...event.target.files]);
            event.target.value = '';
            return;
        }
        if (!event.target.matches('[data-editor-file]')) return;
        const file = event.target.files[0];
        if (!file) return;
        try {
            const draft = file.name.toLocaleLowerCase('en-US').endsWith('.zip')
                ? readDraftArchive(await file.arrayBuffer())
                : readDraft(JSON.parse(await file.text()));
            if (dirty) throw new Error('当前存在未保存内容。请先保存，或导出草稿并刷新页面后再导入。');
            for (const key of RECORD_FIELDS) field(key).value = key === 'photos' ? draft.input.photos.join('\n') : draft.input[key];
            requestId = draft.requestId;
            uploads = readUploads(draft.uploads);
            dirty = true;
            userEditedAutofillFields.clear();
            autoFilledValues.clear();
            for (const name of ['country', 'admin_area', 'admin_area_type', 'locality_type']) {
                userEditedAutofillFields.add(name);
            }
            updateCountry();
            updatePathHint();
            updateAutofill();
            updateBodyView(bodyView);
            renderPhotos();
            dialog.querySelector('.record-editor-files').open = Boolean(draft.input.desc_md || draft.input.photo_folder || draft.input.photos.length);
            status('草稿已导入，尚未保存。请核对内容后保存旅行记录。');
        } catch (error) {
            status(error instanceof SyntaxError ? '文件不是有效的 JSON 草稿。' : error.message);
        } finally {
            event.target.value = '';
        }
    });
    dialog.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || saved || readingPhotos || !token) return;
        const draft = getDraft();
        try { prepareRecord(draft, countries); }
        catch (error) { status(error.message); return; }
        busy = true;
        dialog.querySelector('[data-editor-rich]').contentEditable = 'false';
        dialog.querySelector('[data-editor-source]').readOnly = true;
        dialog.querySelectorAll('[name], button').forEach(control => { control.disabled = true; });
        status('正在保存旅行记录…');
        try {
            const response = await fetch(new URL('api/travel-records', window.location.href), {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Travel-Token': token },
                body: JSON.stringify(draft), signal: AbortSignal.timeout(60000)
            });
            const result = await response.json();
            if (!response.ok || !result.saved) throw new Error(result.error || '服务器未确认保存成功。');
            saved = true;
            dirty = false;
            status(`已保存到项目文件：${result.record.desc_md}，旅行索引已更新。`);
            try { await onSaved(result.record); }
            catch { status(`文件已保存：${result.record.desc_md}。页面加载失败，请刷新后查看。`); }
        } catch (error) {
            status(`未能确认保存成功：${error.message} 草稿仍保留，可导出或重试。`);
        } finally {
            busy = false;
            dialog.querySelectorAll('[name]').forEach(control => { control.disabled = saved; });
            dialog.querySelectorAll('button').forEach(button => { button.disabled = false; });
            dialog.querySelector('[data-editor-save]').disabled = saved || !token;
            dialog.querySelector('[data-editor-import]').disabled = saved;
            dialog.querySelector('[data-editor-upload]').disabled = saved;
            dialog.querySelectorAll('[data-format]').forEach(button => { button.disabled = saved; });
            dialog.querySelector('[data-editor-rich]').contentEditable = String(!saved);
            dialog.querySelector('[data-editor-source]').readOnly = saved;
            renderPhotos();
        }
    });
    window.addEventListener('beforeunload', event => {
        if (!dirty && !busy && !readingPhotos) return;
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
