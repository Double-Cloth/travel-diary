import { escapeHtml } from './utils.js';
import { highlightMarkdown, splitMarkdown, previewHtml, previewToMarkdown } from './markdown-editor.js';
import { readUploads } from './photo-uploads.mjs';
import { DRAFT_FORMAT, RECORD_FIELDS, buildMarkdown, defaultMarkdownPath, prepareRecord, readDraft, recordSlug } from './record-input.mjs';
import { getRecordAutofill, getRecordOptions, suggestedTripId } from './record-suggestions.mjs?v=20260913-editor-location-autofill-v1';
import { createDraftArchive, readDraftArchive } from './draft-archive.mjs';
import { detectWriterCapability } from './writer-capability.js';
import { enhanceCustomSelects } from './custom-select.js?v=20260913-select-placement-v3';
import { confirmFeedback } from './feedback-dialog.js';

const POINTER_MOVE_TOLERANCE = 8;
const PHOTO_PREVIEW_WIDTH = 320;
const PHOTO_PREVIEW_HEIGHT = 200;
let recordEditorCount = 0;

function pointerMoved(start, event) {
    return Math.abs(event.clientX - start.x) > POINTER_MOVE_TOLERANCE
        || Math.abs(event.clientY - start.y) > POINTER_MOVE_TOLERANCE;
}

export function createRecordEditor(onSaved, getRecords = () => []) {
    const editorIndex = ++recordEditorCount;
    const editorId = suffix => `recordEditor${editorIndex}${suffix}`;
    const dialog = document.createElement('dialog');
    dialog.className = 'record-editor entry-sheet';
    dialog.setAttribute('aria-labelledby', editorId('Title'));
    document.body.append(dialog);
    let countries = [];
    let chinaLocations = {};
    let token = '';
    let writerMethods = new Set();
    let requestId = '';
    let busy = false;
    let dirty = false;
    let saved = false;
    let initialized = false;
    let opening = false;
    let editingRecord = null;
    let bodyView = 'source';
    let uploads = [];
    let readingPhotos = false;
    const photoPreviewUrls = new Map();
    let trigger;
    let autocompletePointer = null;
    let suppressAutocompleteClick = false;
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

    function getRecordInput(record) {
        const markdown = splitMarkdown(record.descMarkdown || '', record.title || record.descTitle || '');
        return {
            date: record.date || '',
            country_code: record.country_code || record.countryCode || '',
            country: record.country || '',
            admin_area: record.admin_area || record.adminArea || '',
            admin_area_type: record.admin_area_type || record.adminAreaType || '',
            locality: record.locality || '',
            locality_type: record.locality_type || record.localityType || '',
            trip_id: record.trip_id || '',
            title: markdown.title || record.title || '',
            body: markdown.body || '',
            desc_md: record.desc_md || '',
            photo_folder: record.photo_folder || '',
            photos: Array.isArray(record.photos) ? [...record.photos] : []
        };
    }

    function photoMimeType(photo) {
        return `image/${photo.extension === 'jpg' ? 'jpeg' : photo.extension}`;
    }

    function previewBlob(photo) {
        const binary = atob(photo.data);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return new Blob([bytes], { type: photoMimeType(photo) });
    }

    function ensurePhotoPreviewUrl(photo) {
        if (!photoPreviewUrls.has(photo.id)) {
            photoPreviewUrls.set(photo.id, URL.createObjectURL(previewBlob(photo)));
        }
        return photoPreviewUrls.get(photo.id);
    }

    async function createPhotoPreviewUrl(file) {
        let source;
        let releaseSource = () => {};
        if (typeof createImageBitmap === 'function') {
            try {
                source = await createImageBitmap(file, {
                    resizeWidth: PHOTO_PREVIEW_WIDTH,
                    resizeQuality: 'medium'
                });
                releaseSource = () => source.close();
            } catch {
                // Safari 的部分版本暴露了 createImageBitmap，但无法解码所有图片格式。
            }
        }
        if (!source) {
            const sourceUrl = URL.createObjectURL(file);
            const image = new Image();
            image.src = sourceUrl;
            try { await image.decode(); }
            catch {
                URL.revokeObjectURL(sourceUrl);
                throw new Error(`无法解码图片：${file.name}`);
            }
            source = image;
            releaseSource = () => URL.revokeObjectURL(sourceUrl);
        }

        try {
            const canvas = document.createElement('canvas');
            canvas.width = PHOTO_PREVIEW_WIDTH;
            canvas.height = PHOTO_PREVIEW_HEIGHT;
            const context = canvas.getContext('2d', { alpha: false });
            if (!context) throw new Error(`无法生成图片预览：${file.name}`);
            context.fillStyle = '#f3e4bd';
            context.fillRect(0, 0, canvas.width, canvas.height);
            const sourceRatio = source.width / source.height;
            const previewRatio = canvas.width / canvas.height;
            const cropWidth = sourceRatio > previewRatio ? source.height * previewRatio : source.width;
            const cropHeight = sourceRatio > previewRatio ? source.height : source.width / previewRatio;
            context.drawImage(
                source,
                (source.width - cropWidth) / 2,
                (source.height - cropHeight) / 2,
                cropWidth,
                cropHeight,
                0,
                0,
                canvas.width,
                canvas.height
            );
            const preview = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
            if (!preview) throw new Error(`无法生成图片预览：${file.name}`);
            return URL.createObjectURL(preview);
        } finally {
            releaseSource();
        }
    }

    function releasePhotoPreview(id) {
        const url = photoPreviewUrls.get(id);
        if (!url) return;
        URL.revokeObjectURL(url);
        photoPreviewUrls.delete(id);
    }

    function releasePhotoPreviews(keepIds = new Set()) {
        for (const id of photoPreviewUrls.keys()) {
            if (!keepIds.has(id)) releasePhotoPreview(id);
        }
    }

    async function detectWriter() {
        token = '';
        writerMethods = new Set();
        dialog.querySelector('[data-editor-save]').disabled = true;
        const hint = dialog.querySelector('[data-editor-mode]');
        hint.textContent = '正在连接服务器写入服务…';
        try {
            const capability = await detectWriterCapability();
            writerMethods = capability.methods;
            if (editingRecord && !writerMethods.has('PUT')) {
                hint.textContent = '服务器写入服务版本过旧 · 请更新或重新启动服务后再修改记录。';
                return;
            }
            token = capability.token;
            hint.textContent = '服务器写入可用 · 保存后写入项目文件。';
            dialog.querySelector('[data-editor-save]').disabled = saved;
        } catch {
            hint.textContent = '当前站点为只读模式 · 可先导出草稿，再到可写站点导入并保存。';
        }
    }

    function render(record = null) {
        releasePhotoPreviews();
        editingRecord = record;
        requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
        const today = new Date();
        const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const editing = Boolean(record);
        dialog.innerHTML = `
            <header class="record-editor-heading">
                <div><p class="journal-label">旅行日记</p><h2 id="${editorId('Title')}">${editing ? '修改旅行记录' : '新增旅行记录'}</h2></div>
                <button class="paper-button" type="button" data-editor-close aria-label="关闭编辑器并保留本页草稿">关闭</button>
            </header>
            <form>
                <div class="record-editor-scroll">
                    <p class="record-editor-mode" data-editor-mode></p>
                    <div class="record-editor-layout">
                        <section class="record-editor-section" aria-labelledby="${editorId('LocationTitle')}">
                            <h3 id="${editorId('LocationTitle')}"><span>01</span> 行程与地点</h3>
                            <div class="record-editor-fields">
                                <div class="record-editor-grid">
                                    <label>旅行日期 <span>必填</span><input name="date" type="date" value="${date}" required></label>
                                    <label>旅行标识 <span>选填</span><span class="record-editor-autocomplete"><input name="trip_id" maxlength="200" data-editor-autocomplete="trip_id" placeholder="填写地点后自动生成" aria-describedby="${editorId('TripHelp')}" aria-autocomplete="list" aria-controls="${editorId('TripOptions')}" aria-expanded="false" autocomplete="off"><span class="record-editor-autocomplete-chevron" aria-hidden="true"></span><span class="record-editor-autocomplete-menu" id="${editorId('TripOptions')}" role="listbox" data-editor-autocomplete-menu hidden></span></span></label>
                                </div>
                                <p class="record-editor-note" id="${editorId('TripHelp')}">按日期与地点自动生成；同一次旅行可沿用下拉列表中的已有标识。</p>
                                <div class="record-editor-grid">
                                    <label>国家 / 地区 <span>必填</span><span class="custom-select"><select name="country_code" data-custom-select aria-label="国家 / 地区" required>
                                        ${countries.map(country => `<option value="${escapeHtml(country.code)}" ${country.code === 'CN' ? 'selected' : ''}>${escapeHtml(country.code)} · ${escapeHtml(country.name_zh)}</option>`).join('')}
                                    </select></span></label>
                                    <label>国家显示名称 <span>选填</span><span class="record-editor-autocomplete"><input name="country" maxlength="200" data-editor-autocomplete="country" placeholder="留空使用目录名称" aria-autocomplete="list" aria-controls="${editorId('CountryOptions')}" aria-expanded="false" autocomplete="off"><span class="record-editor-autocomplete-chevron" aria-hidden="true"></span><span class="record-editor-autocomplete-menu" id="${editorId('CountryOptions')}" role="listbox" data-editor-autocomplete-menu hidden></span></span></label>
                                    <label><span class="record-editor-field-name" data-editor-area>一级行政区</span> <span>选填</span><span class="record-editor-autocomplete"><input name="admin_area" maxlength="200" data-editor-autocomplete="admin_area" placeholder="例如：江苏省" aria-autocomplete="list" aria-controls="${editorId('AdminAreaOptions')}" aria-expanded="false" autocomplete="off"><span class="record-editor-autocomplete-chevron" aria-hidden="true"></span><span class="record-editor-autocomplete-menu" id="${editorId('AdminAreaOptions')}" role="listbox" data-editor-autocomplete-menu hidden></span></span></label>
                                    <label>行政区类型 <span>选填</span><span class="record-editor-autocomplete"><input name="admin_area_type" maxlength="200" data-editor-autocomplete="admin_area_type" placeholder="例如：省、州" aria-autocomplete="list" aria-controls="${editorId('AdminAreaTypeOptions')}" aria-expanded="false" autocomplete="off"><span class="record-editor-autocomplete-chevron" aria-hidden="true"></span><span class="record-editor-autocomplete-menu" id="${editorId('AdminAreaTypeOptions')}" role="listbox" data-editor-autocomplete-menu hidden></span></span></label>
                                    <label>城市 / 目的地 <span>必填</span><span class="record-editor-autocomplete"><input name="locality" maxlength="200" data-editor-autocomplete="locality" required placeholder="例如：苏州市" aria-autocomplete="list" aria-controls="${editorId('LocalityOptions')}" aria-expanded="false" autocomplete="off"><span class="record-editor-autocomplete-chevron" aria-hidden="true"></span><span class="record-editor-autocomplete-menu" id="${editorId('LocalityOptions')}" role="listbox" data-editor-autocomplete-menu hidden></span></span></label>
                                    <label>目的地类型 <span>选填</span><span class="record-editor-autocomplete"><input name="locality_type" maxlength="200" data-editor-autocomplete="locality_type" placeholder="例如：城市、岛屿" aria-autocomplete="list" aria-controls="${editorId('LocalityTypeOptions')}" aria-expanded="false" autocomplete="off"><span class="record-editor-autocomplete-chevron" aria-hidden="true"></span><span class="record-editor-autocomplete-menu" id="${editorId('LocalityTypeOptions')}" role="listbox" data-editor-autocomplete-menu hidden></span></span></label>
                                </div>
                                <p class="record-editor-note record-editor-autofill" data-editor-autofill>中国填写行政区或目的地后会互相补全，内容仍可修改。</p>
                                <div data-editor-option-lists hidden></div>
                            </div>
                        </section>
                        <section class="record-editor-section" aria-labelledby="${editorId('BodyTitle')}">
                            <h3 id="${editorId('BodyTitle')}"><span>02</span> 旅行正文</h3>
                            <label>日记标题 <span>必填</span><input name="title" maxlength="200" required placeholder="写下这篇日记的标题"></label>
                            <div class="record-editor-workbench">
                                <div class="record-editor-tabs" role="tablist" aria-label="正文视图">
                                    <button type="button" role="tab" id="${editorId('TabSource')}" aria-controls="${editorId('PanelSource')}" aria-selected="true" data-editor-view="source">源码</button>
                                    <button type="button" role="tab" id="${editorId('TabPreview')}" aria-controls="${editorId('PanelPreview')}" aria-selected="false" tabindex="-1" data-editor-view="preview">预览</button>
                                    <span class="record-editor-format">Markdown</span>
                                </div>
                                <div id="${editorId('PanelSource')}" role="tabpanel" aria-labelledby="${editorId('TabSource')}" data-editor-panel="source">
                                    <div class="record-editor-source-layer">
                                        <pre data-editor-highlight aria-hidden="true"><code></code></pre>
                                        <textarea data-editor-source maxlength="100210" rows="10" aria-label="Markdown 源码" spellcheck="false"></textarea>
                                    </div>
                                </div>
                                <div id="${editorId('PanelPreview')}" role="tabpanel" aria-labelledby="${editorId('TabPreview')}" data-editor-panel="preview" hidden>
                                    <div class="record-editor-formatting" role="toolbar" aria-label="预览格式">
                                        <button type="button" data-format="bold" aria-label="加粗"><b>粗体</b></button>
                                        <button type="button" data-format="italic" aria-label="斜体"><i>斜体</i></button>
                                        <button type="button" data-format="formatBlock" data-format-value="h2">标题</button>
                                        <button type="button" data-format="formatBlock" data-format-value="p">段落</button>
                                        <button type="button" data-format="insertUnorderedList">列表</button>
                                    </div>
                                    <div class="record-editor-preview markdown-content" data-editor-rich contenteditable="true" role="textbox" aria-label="预览正文，可直接编辑" aria-multiline="true"></div>
                                </div>
                                <textarea name="body" hidden></textarea>
                            </div>
                        </section>
                    </div>
                    <section class="record-editor-photos" aria-labelledby="${editorId('PhotosTitle')}">
                        <h3 id="${editorId('PhotosTitle')}"><span>03</span> 旅行照片</h3>
                        <div class="record-editor-upload-zone" data-editor-drop>
                            <button class="paper-button" type="button" data-editor-upload>＋ 选择照片</button>
                            <p>也可将照片拖到这里</p>
                            <small>支持 JPEG / PNG / GIF / WebP</small>
                            <input type="file" data-editor-photos accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden aria-label="选择旅行照片">
                        </div>
                        <div class="record-editor-photo-list" data-editor-photo-list aria-label="待保存照片"></div>
                    </section>
                    <details class="record-editor-files">
                        <summary><span>文件设置</span><span>按需设置正文路径或引用已有照片</span></summary>
                        <div class="record-editor-fields">
                            <label>正文路径 <span>自动填写 · 可修改</span><input name="desc_md" maxlength="200"></label>
                            <div class="record-editor-grid record-editor-files-grid">
                                <label>照片目录 <span>选填</span><input name="photo_folder" maxlength="200" placeholder="data/photos/suzhou" aria-describedby="${editorId('PhotoHelp')}"></label>
                                <label>已有照片文件名 <span>选填 · 每行一个</span><textarea name="photos" rows="3" maxlength="201000" placeholder="canal.jpg&#10;garden.jpg" aria-describedby="${editorId('PhotoHelp')}"></textarea></label>
                            </div>
                            <p class="record-editor-note" id="${editorId('PhotoHelp')}">这里仅填写项目内已有的照片；新添加的照片会自动保存到：<output data-editor-photo-path-preview></output></p>
                        </div>
                    </details>
                </div>
                <footer class="record-editor-footer">
                    <p class="record-editor-status" data-editor-status role="status" aria-live="polite"></p>
                    <div class="record-editor-actions">
                        <div class="record-editor-exports">
                            <button class="paper-button" type="button" data-editor-import>导入草稿</button>
                            <button class="paper-button" type="button" data-editor-download>导出草稿</button>
                            <button class="paper-button" type="button" data-editor-clear>清空编辑器</button>
                        </div>
                        <button class="brass-button" type="submit" data-editor-save disabled>${editing ? '保存修改' : '保存旅行记录'}</button>
                        <input type="file" accept=".zip,.json,application/zip,application/json" data-editor-file hidden aria-label="选择草稿 ZIP 或旧版 JSON 文件">
                    </div>
                    <p class="record-editor-note">草稿仅保留在本页，刷新或离开前请保存或导出。</p>
                </footer>
            </form>`;
        saved = false;
        dirty = false;
        uploads = [];
        bodyView = 'source';
        userEditedAutofillFields.clear();
        autoFilledValues.clear();
        const initialInput = editing ? getRecordInput(record) : { date, country_code: 'CN' };
        for (const key of RECORD_FIELDS) {
            const value = initialInput[key] ?? (key === 'photos' ? [] : '');
            field(key).value = key === 'photos' ? value.join('\n') : value;
        }
        if (editing) {
            for (const name of ['country', 'admin_area', 'admin_area_type', 'locality', 'locality_type', 'trip_id']) {
                userEditedAutofillFields.add(name);
            }
            if (initialInput.desc_md === defaultMarkdownPath(initialInput.date, initialInput.locality)) {
                autoFilledValues.set('desc_md', initialInput.desc_md);
            } else {
                userEditedAutofillFields.add('desc_md');
            }
            dialog.querySelector('.record-editor-files').open = Boolean(initialInput.desc_md || initialInput.photo_folder || initialInput.photos.length);
        }
        enhanceCustomSelects(dialog);
        updateCountry(!editing);
        updatePathHint();
        updateAutofill();
        updateBodyView(bodyView);
    }

    function updateCountry(fillName = false) {
        const country = countries.find(item => item.code === field('country_code').value);
        dialog.querySelector('[data-editor-area]').textContent = country?.admin_area_label || '一级行政区';
        field('country').placeholder = country?.name_zh ? `留空使用${country.name_zh}` : '留空使用目录名称';
        if (fillName) field('country').value = country?.name_zh || '';
    }

    function updatePathHint() {
        const locality = field('locality').value || '目的地';
        const markdownPath = defaultMarkdownPath(field('date').value || 'YYYY-MM-DD', locality);
        const photoPath = `data/photos/${recordSlug(locality)}`;
        field('desc_md').placeholder = markdownPath;
        field('photo_folder').placeholder = photoPath;
        dialog.querySelector('[data-editor-photo-path-preview]').textContent = photoPath;
        field('trip_id').placeholder = suggestedTripId(getDraft().input) || '填写地点后自动生成';
    }

    function updateAutofill() {
        const input = getDraft().input;
        const records = getRecords() || [];
        let values = getRecordAutofill(input, countries, records, chinaLocations);
        const filled = [];
        let clearedStaleAutofill;
        do {
            clearedStaleAutofill = false;
            ['country', 'admin_area', 'admin_area_type', 'locality_type', 'trip_id', 'desc_md'].forEach(name => {
                const previousAutoValue = autoFilledValues.get(name);
                if (previousAutoValue && !values[name] && field(name).value === previousAutoValue && !userEditedAutofillFields.has(name)) {
                    field(name).value = '';
                    autoFilledValues.delete(name);
                    clearedStaleAutofill = true;
                }
            });
            if (clearedStaleAutofill) values = getRecordAutofill(getDraft().input, countries, records, chinaLocations);
        } while (clearedStaleAutofill);
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
        renderOptionLists(getRecordOptions(getDraft().input, countries, records, chinaLocations));
        const hint = dialog.querySelector('[data-editor-autofill]');
        hint.textContent = filled.length
            ? `已补全：${filled.join('、')}。如有需要可直接修改。`
            : '会结合地点和历史记录补全空白项，内容仍可修改。';
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
        const query = input.name === 'trip_id' ? '' : input.value.trim().toLocaleLowerCase();
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
        input.focus({ preventScroll: true });
        closeAutocomplete(input);
    }

    function moveAutocompleteSelection(input, direction) {
        if (input.getAttribute('aria-expanded') !== 'true') showAutocomplete(input);
        const options = autocompleteOptions(input);
        if (!options.length) return;
        const current = options.findIndex(option => option.classList.contains('is-active'));
        const next = current < 0 ? (direction > 0 ? 0 : options.length - 1)
            : (current + direction + options.length) % options.length;
        options.forEach(option => option.classList.remove('is-active'));
        const option = options[next];
        option.classList.add('is-active');
        input.setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView({ block: 'nearest' });
    }

    function fieldLabel(name) {
        return ({ country: '国家显示名称', admin_area: '一级行政区', admin_area_type: '行政区类型', locality: '城市 / 目的地', locality_type: '目的地类型', trip_id: '旅行标识', desc_md: '正文路径' })[name] || name;
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

    function createPhotoPreview(photo) {
        const figure = document.createElement('figure');
        figure.className = 'record-editor-photo';
        figure.dataset.photoId = photo.id;
        figure.innerHTML = `
            <img loading="lazy" decoding="async" width="${PHOTO_PREVIEW_WIDTH}" height="${PHOTO_PREVIEW_HEIGHT}">
            <figcaption></figcaption>
            <div>
                <button type="button" data-photo-move data-direction="-1">←</button>
                <button type="button" data-photo-move data-direction="1">→</button>
                <button type="button" data-photo-remove>移除</button>
            </div>`;
        const image = figure.querySelector('img');
        image.src = ensurePhotoPreviewUrl(photo);
        return figure;
    }

    function updatePhotoPreview(figure, photo, index) {
        const image = figure.querySelector('img');
        const caption = figure.querySelector('figcaption');
        const [previous, next] = figure.querySelectorAll('[data-photo-move]');
        const remove = figure.querySelector('[data-photo-remove]');
        image.alt = photo.name;
        caption.textContent = photo.name;
        previous.dataset.photoMove = String(index);
        previous.disabled = index === 0 || saved;
        previous.setAttribute('aria-label', `前移 ${photo.name}`);
        next.dataset.photoMove = String(index);
        next.disabled = index === uploads.length - 1 || saved;
        next.setAttribute('aria-label', `后移 ${photo.name}`);
        remove.dataset.photoRemove = String(index);
        remove.disabled = saved;
        remove.setAttribute('aria-label', `移除 ${photo.name}`);
    }

    function renderPhotos() {
        const list = dialog.querySelector('[data-editor-photo-list]');
        const existing = new Map([...list.children].map(item => [item.dataset.photoId, item]));
        const activeIds = new Set(uploads.map(photo => photo.id));
        uploads.forEach((photo, index) => {
            const figure = existing.get(photo.id) || createPhotoPreview(photo);
            updatePhotoPreview(figure, photo, index);
            const current = list.children[index];
            if (current !== figure) list.insertBefore(figure, current || null);
        });
        [...list.children].forEach(item => {
            if (!activeIds.has(item.dataset.photoId)) item.remove();
        });
        releasePhotoPreviews(activeIds);
    }

    function updatePhotoStatus() {
        status(uploads.length ? `已选择 ${uploads.length} 张照片，保存记录或导出草稿时会一并处理。` : '');
    }

    async function clearEditor() {
        if (busy || saved || readingPhotos) return;
        const confirmed = await confirmFeedback('当前编辑器中的表单、正文和待保存照片都会被清除，操作无法撤销。', {
            label: '编辑器',
            title: '清空编辑器？',
            cancelLabel: '保留内容',
            confirmLabel: '清空内容'
        });
        if (!confirmed || busy || saved || readingPhotos) return;

        releasePhotoPreviews();
        uploads = [];
        for (const key of RECORD_FIELDS) field(key).value = '';
        field('country_code').selectedIndex = -1;
        field('country_code').dispatchEvent(new Event('change', { bubbles: true }));
        dialog.querySelector('[data-editor-file]').value = '';
        dialog.querySelector('[data-editor-rich]').innerHTML = previewHtml('', '');
        dialog.querySelector('[data-editor-source]').value = '';
        updateMarkdownHighlight('');
        userEditedAutofillFields.clear();
        autoFilledValues.clear();
        dirty = false;
        dialog.querySelector('.record-editor-files').open = false;
        updateCountry();
        updatePathHint();
        updateAutofill();
        renderPhotos();
        status('编辑器已清空，可以重新填写内容。');
        field('date').focus();
    }

    async function addPhotos(files) {
        if (busy || saved || readingPhotos || !files.length) return;
        readingPhotos = true;
        const saveButton = dialog.querySelector('[data-editor-save]');
        saveButton.disabled = true;
        status('正在读取照片…');
        const pendingPreviews = [];
        try {
            if (files.some(file => !file.size)) throw new Error('不能选择空图片文件。');
            const pending = [];
            for (const file of files) {
                let previewUrl;
                try { previewUrl = await createPhotoPreviewUrl(file); }
                catch (error) {
                    throw new Error(error.message.startsWith('无法') ? error.message : `无法解码图片：${file.name}`);
                }
                const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
                pendingPreviews.push([id, previewUrl]);
                const data = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result).split(',')[1]);
                    reader.onerror = () => reject(new Error('照片读取失败，请重新选择。'));
                    reader.readAsDataURL(file);
                });
                const photo = readUploads([{ id, name: file.name.slice(0, 200), data }])[0];
                pending.push(photo);
            }
            pendingPreviews.forEach(([id, url]) => photoPreviewUrls.set(id, url));
            uploads.push(...pending);
            dirty = true;
            renderPhotos();
            updatePhotoStatus();
        } catch (error) {
            pendingPreviews.forEach(([id, url]) => {
                if (photoPreviewUrls.get(id) === url) photoPreviewUrls.delete(id);
                URL.revokeObjectURL(url);
            });
            status(error.message);
        }
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
        } else if (event.key === 'Escape' && input.getAttribute('aria-expanded') === 'true') {
            event.preventDefault();
            closeAutocomplete(input);
        }
    });
    dialog.addEventListener('input', event => {
        if (event.target.matches('[data-editor-source]')) syncMarkdown(event.target.value);
        if (event.target.closest('[data-editor-rich]')) syncPreview();
        if (!saved && RECORD_FIELDS.includes(event.target.name)) dirty = true;
        if (['country', 'admin_area', 'admin_area_type', 'locality', 'locality_type', 'trip_id', 'desc_md'].includes(event.target.name)) {
            userEditedAutofillFields.add(event.target.name);
            autoFilledValues.delete(event.target.name);
        }
        if (['country_code', 'date', 'admin_area', 'locality'].includes(event.target.name)) updateAutofill();
        if (event.target.name === 'title') updateBodyView(bodyView);
    });
    dialog.addEventListener('scroll', event => {
        if (!event.target.matches('[data-editor-source]')) return;
        const highlight = dialog.querySelector('[data-editor-highlight]');
        highlight.scrollTop = event.target.scrollTop;
        highlight.scrollLeft = event.target.scrollLeft;
    }, true);
    dialog.addEventListener('pointerdown', event => {
        if (event.target.closest('[data-autocomplete-value]')) {
            suppressAutocompleteClick = false;
            if (event.pointerType === 'mouse') {
                event.preventDefault();
                autocompletePointer = null;
                return;
            }
            autocompletePointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
            return;
        }
        if (event.target.closest('[data-format]')) event.preventDefault();
    });
    dialog.addEventListener('pointermove', event => {
        if (!autocompletePointer || event.pointerId !== autocompletePointer.id) return;
        if (pointerMoved(autocompletePointer, event)) suppressAutocompleteClick = true;
    }, { passive: true });
    dialog.addEventListener('pointerup', event => {
        if (!autocompletePointer || event.pointerId !== autocompletePointer.id) return;
        if (pointerMoved(autocompletePointer, event)) suppressAutocompleteClick = true;
        autocompletePointer = null;
    }, { passive: true });
    dialog.addEventListener('pointercancel', event => {
        if (!autocompletePointer || event.pointerId !== autocompletePointer.id) return;
        suppressAutocompleteClick = true;
        autocompletePointer = null;
    }, { passive: true });
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
        const autocompleteOption = event.target.closest('[data-autocomplete-value]');
        if (autocompleteOption) {
            event.preventDefault();
            if (suppressAutocompleteClick) {
                suppressAutocompleteClick = false;
                return;
            }
            selectAutocompleteOption(
                autocompleteOption.closest('.record-editor-autocomplete').querySelector('[data-editor-autocomplete]'),
                autocompleteOption
            );
            return;
        }
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
            status('草稿已开始下载，所选照片已一并打包。');
        }
        if (event.target.closest('[data-editor-clear]')) {
            void clearEditor();
            return;
        }
        if (event.target.closest('[data-editor-import]')) dialog.querySelector('[data-editor-file]').click();
    });
    dialog.addEventListener('change', async event => {
        if (event.target.name === 'country_code') {
            if (!saved) dirty = true;
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
        if (busy || saved || readingPhotos) { event.target.value = ''; return; }
        if (dirty) {
            status('当前有未保存内容。请先导出草稿，再清空编辑器后导入。');
            event.target.value = '';
            return;
        }
        busy = true;
        dialog.querySelector('form').inert = true;
        try {
            const draft = file.name.toLocaleLowerCase('en-US').endsWith('.zip')
                ? readDraftArchive(await file.arrayBuffer())
                : readDraft(JSON.parse(await file.text()));
            for (const key of RECORD_FIELDS) field(key).value = key === 'photos' ? draft.input.photos.join('\n') : draft.input[key];
            requestId = draft.requestId;
            uploads = readUploads(draft.uploads);
            dirty = true;
            userEditedAutofillFields.clear();
            autoFilledValues.clear();
            for (const name of ['country', 'admin_area', 'admin_area_type', 'locality', 'locality_type', 'trip_id', 'desc_md']) {
                userEditedAutofillFields.add(name);
            }
            updateCountry();
            updatePathHint();
            updateAutofill();
            updateBodyView(bodyView);
            renderPhotos();
            dialog.querySelector('.record-editor-files').open = Boolean(draft.input.desc_md || draft.input.photo_folder || draft.input.photos.length);
            status('草稿已导入，请核对内容后保存。');
        } catch (error) {
            status(error instanceof SyntaxError ? '文件不是有效的 JSON 草稿。' : error.message);
        } finally {
            busy = false;
            dialog.querySelector('form').inert = false;
            event.target.value = '';
        }
    });
    dialog.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || saved || readingPhotos || !token) return;
        if (editingRecord && !writerMethods.has('PUT')) {
            status('服务器写入服务版本过旧，请更新或重新启动服务后再修改记录。');
            return;
        }
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
                method: editingRecord ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Travel-Token': token },
                body: JSON.stringify(editingRecord ? { originalDescMd: editingRecord.desc_md, draft } : draft),
                signal: AbortSignal.timeout(60000)
            });
            const result = await response.json();
            if (!response.ok || !result.saved) throw new Error(result.error || '未收到服务器的成功响应。');
            saved = true;
            dirty = false;
            status(`${editingRecord ? '修改' : '记录'}已保存并更新旅行索引：${result.record.desc_md}`);
            try { await onSaved(result.record, { mode: editingRecord ? 'edit' : 'create', originalRecord: editingRecord }); }
            catch { status(`记录已保存：${result.record.desc_md}。页面数据刷新失败，请手动刷新后查看。`); }
        } catch (error) {
            status(`保存结果未确认：${error.message} 草稿仍在本页，可导出或重试。`);
        } finally {
            busy = false;
            dialog.querySelectorAll('[name]').forEach(control => { control.disabled = saved; });
            dialog.querySelectorAll('button').forEach(button => { button.disabled = false; });
            dialog.querySelector('[data-editor-save]').disabled = saved || !token;
            dialog.querySelector('[data-editor-import]').disabled = saved;
            dialog.querySelector('[data-editor-clear]').disabled = saved;
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

    return async (record = null) => {
        if (dialog.open || opening) return;
        opening = true;
        try {
            if (record?.descLoadFailed) throw new Error('这篇日记的正文加载失败，暂时不能安全修改。请修复正文文件后重试。');
            trigger = document.activeElement;
            const requestedRecordKey = record ? `record:${record.desc_md || record.id || ''}` : 'new';
            const currentRecordKey = editingRecord ? `record:${editingRecord.desc_md || editingRecord.id || ''}` : 'new';
            let shouldRender = !initialized || saved || requestedRecordKey !== currentRecordKey;
            if (initialized && !saved && dirty && requestedRecordKey !== currentRecordKey) {
                const confirmed = await confirmFeedback('打开另一条记录会清空当前未保存内容，且无法撤销。需要保留时，请取消并导出草稿。', {
                    label: '编辑器',
                    title: '编辑器中有未保存内容',
                    cancelLabel: '取消',
                    confirmLabel: '立即清空编辑器'
                });
                if (!confirmed) return;
                shouldRender = true;
            }
            if (shouldRender) {
                if (!countries.length) {
                    const [countryResponse, chinaLocationResponse] = await Promise.all([
                        fetch(new URL('assets/catalogs/countries.json', window.location.href)),
                        fetch(new URL('assets/catalogs/china-locations.json', window.location.href))
                    ]);
                    if (!countryResponse.ok || !chinaLocationResponse.ok) throw new Error('地点目录加载失败，请刷新后重试。');
                    countries = (await countryResponse.json()).countries;
                    chinaLocations = await chinaLocationResponse.json();
                }
                render(record);
                initialized = true;
            }
            dialog.showModal();
            await detectWriter();
        } finally {
            opening = false;
        }
    };
}
