import { createMediaPreview, saveMediaPreview } from './media-preview.mjs?v=2.1.69';
import { escapeHtml, getMediaFileUrl } from './utils.js?v=2.1.69';
import { createMediaFileLink, mediaOrderIcon } from './media-file-link.js?v=2.1.69';
import { highlightMarkdown, splitMarkdown, previewHtml, previewToMarkdown } from './markdown-editor.js?v=2.1.69';
import {
    MAXIMUM_IMAGE_FILE_BYTES,
    MAXIMUM_MEDIA_BATCH_BYTES,
    MAXIMUM_MEDIA_FILE_BYTES,
    MAXIMUM_VIDEO_FILE_BYTES,
    mediaBytes,
    readUploads,
    sameMediaContent
} from './photo-uploads.mjs?v=2.1.69';
import { DRAFT_FORMAT, RECORD_FIELDS, buildMarkdown, defaultMarkdownPath, prepareRecord, readDraft, recordSlug } from './record-input.mjs?v=2.1.69';
import { getRecordAutofill, getRecordOptions, suggestedMarkdownPath, suggestedTripId } from './record-suggestions.mjs?v=2.1.69';
import { createDraftBlob, readRecordSource } from './draft-archive.mjs?v=2.1.69';
import { fetchMediaTime, readMediaTime, sortMediaByTime } from './media-time.mjs?v=2.1.69';
import { orderMedia } from './media-order.mjs?v=2.1.69';
import { detectWriterCapability } from './writer-capability.js?v=2.1.69';
import { enhanceCustomSelects } from './custom-select.js?v=2.1.69';
import { confirmFeedback, showFeedback } from './feedback-dialog.js?v=2.1.69';
import { ByteSource, sourceOf } from './zip-stream.mjs';
import { MAXIMUM_JSON_DRAFT_BYTES, MAXIMUM_RECORD_ARCHIVE_BYTES } from './file-limits.mjs?v=2.1.69';
import { createOperationProgress, saveBlobDownload, uploadWithProgress } from './operation-progress.js?v=2.1.69';

const POINTER_MOVE_TOLERANCE = 8;
const PHOTO_PREVIEW_WIDTH = 320;
const PHOTO_PREVIEW_HEIGHT = 200;
let recordEditorCount = 0;

function pointerMoved(start, event) {
    return Math.abs(event.clientX - start.x) > POINTER_MOVE_TOLERANCE
        || Math.abs(event.clientY - start.y) > POINTER_MOVE_TOLERANCE;
}

function moveMediaGroup(order, keys, beforeKey = null) {
    const moving = order.filter(key => keys.has(key));
    const remaining = order.filter(key => !keys.has(key));
    const index = beforeKey === null ? remaining.length : remaining.indexOf(beforeKey);
    if (!moving.length || index < 0) return order;
    return [...remaining.slice(0, index), ...moving, ...remaining.slice(index)];
}

function mediaDragIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';
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
    let originalDerivedLocation = null;
    let derivedPathsActivated = false;
    let bodyView = 'source';
    let bodyFullscreen = false;
    let bodyScrollTop = 0;
    let uploads = [];
    let removedMedia = [];
    let mediaOrder = [];
    let existingMediaEntries = { photo: [], video: [] };
    let mediaKeySequence = 0;
    const selectedMedia = new Set();
    const selectedRemovedMedia = new Set();
    const mediaReferenceEdits = new Map();
    let readingPhotos = false;
    let operationProgress;
    let archivePhase = '正在校验并打包媒体…';
    const photoPreviewUrls = new Map();
    const photoPreviewTasks = new Map();
    const mediaSourceUrls = new Map();
    let trigger;
    let autocompletePointer = null;
    let suppressAutocompleteClick = false;
    let mediaDrag = null;
    const mediaGroupObserver = new ResizeObserver(updateMediaGroupSlider);
    const userEditedAutofillFields = new Set();
    const autoFilledValues = new Map();
    const userEditedPaths = new Set();

    const field = name => dialog.querySelector(`[name="${name}"]`);
    const status = message => { dialog.querySelector('[data-editor-status]').textContent = message; };
    function startProgress(title, phase) {
        operationProgress?.remove();
        operationProgress = createOperationProgress(title);
        operationProgress.phase(phase);
    }
    const getDraft = () => ({
        format: DRAFT_FORMAT,
        requestId,
        uploads: uploads.map(({ id, name, data }) => ({ id, name, data })),
        mediaOrder: { sequence: orderedMedia().map(item => item.type), ...Object.fromEntries(['photo', 'video'].map(type => {
            const items = canonicalMedia(type);
            const indexes = new Map(items.map((item, index) => [item.key, index]));
            return [`${type}s`, orderedMedia(type).map(item => indexes.get(item.key))];
        })) },
        input: Object.fromEntries(RECORD_FIELDS.map(key => [key, ['photos', 'videos'].includes(key)
            ? field(key).value.split(/\r?\n/).map(name => name.trim()).filter(Boolean)
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
            photos: Array.isArray(record.photos) ? [...record.photos] : [],
            video_folder: record.video_folder || '',
            videos: Array.isArray(record.videos) ? [...record.videos] : []
        };
    }

    function previewBlob(media) {
        return media.data instanceof ByteSource ? media.data.blob : new Blob([mediaBytes(media.data)], { type: media.mimeType });
    }

    function ensurePhotoPreviewUrl(media) {
        if (photoPreviewUrls.has(media.id)) return Promise.resolve(photoPreviewUrls.get(media.id));
        if (!photoPreviewTasks.has(media.id)) {
            const task = createLocalPreviewUrl(previewBlob(media), media.kind).then(url => {
                if (photoPreviewTasks.get(media.id) !== task) {
                    if (url) URL.revokeObjectURL(url);
                    return '';
                }
                photoPreviewUrls.set(media.id, url);
                return url;
            }).finally(() => { if (photoPreviewTasks.get(media.id) === task) photoPreviewTasks.delete(media.id); });
            photoPreviewTasks.set(media.id, task);
        }
        return photoPreviewTasks.get(media.id);
    }

    async function createLocalPreviewUrl(file, kind) {
        try {
            const blob = await createMediaPreview(file, kind, {
                width: PHOTO_PREVIEW_WIDTH, height: PHOTO_PREVIEW_HEIGHT, fit: 'cover', quality: 0.82
            });
            return URL.createObjectURL(blob);
        } catch (error) {
            // 不支持的编码仍可保存原视频，列表保留占位，查看器可下载原文件。
            if (kind === 'video') return '';
            throw error;
        }
    }

    function releasePhotoPreview(id) {
        photoPreviewTasks.delete(id);
        const sourceUrl = mediaSourceUrls.get(id);
        if (sourceUrl) URL.revokeObjectURL(sourceUrl.url);
        mediaSourceUrls.delete(id);
        const url = photoPreviewUrls.get(id);
        if (!url) return;
        URL.revokeObjectURL(url);
        photoPreviewUrls.delete(id);
    }

    function releasePhotoPreviews(keepIds = new Set()) {
        for (const id of new Set([...photoPreviewUrls.keys(), ...photoPreviewTasks.keys(), ...mediaSourceUrls.keys()])) {
            if (!keepIds.has(id)) releasePhotoPreview(id);
        }
    }

    async function detectWriter(writerAccess = null) {
        token = '';
        writerMethods = new Set();
        dialog.querySelector('[data-editor-save]').disabled = true;
        const hint = dialog.querySelector('[data-editor-mode]');
        if (writerAccess?.readonly === true) {
            hint.textContent = '当前站点为静态只读页面 · 可编辑并导出草稿，再到可写站点导入保存。';
            return;
        }
        hint.textContent = '正在连接服务器写入服务…';
        try {
            const capability = writerAccess || await detectWriterCapability();
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
                        <section class="record-editor-section record-editor-body-section" aria-labelledby="${editorId('BodyTitle')}">
                            <h3 id="${editorId('BodyTitle')}"><span>02</span> 旅行正文</h3>
                            <label>日记标题 <span>必填</span><input name="title" maxlength="200" required placeholder="写下这篇日记的标题"></label>
                            <div class="record-editor-workbench" id="${editorId('Workbench')}">
                                <div class="record-editor-toolbar">
                                    <div class="record-editor-tabs" role="tablist" aria-label="正文视图">
                                        <button type="button" role="tab" id="${editorId('TabSource')}" aria-controls="${editorId('PanelSource')}" aria-selected="true" data-editor-view="source">源码</button>
                                        <button type="button" role="tab" id="${editorId('TabPreview')}" aria-controls="${editorId('PanelPreview')}" aria-selected="false" tabindex="-1" data-editor-view="preview">预览</button>
                                        <span class="record-editor-format">Markdown</span>
                                    </div>
                                    <button class="paper-button" type="button" data-editor-fullscreen aria-controls="${editorId('Workbench')}" aria-pressed="false" title="全屏编辑，按 Esc 退出">全屏</button>
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
                                <output class="record-editor-word-count" data-editor-word-count aria-live="off" title="统计标题与正文中的非空白字符，不含 Markdown 格式标记和链接地址">0 字</output>
                            </div>
                        </section>
                    </div>
                    <section class="record-editor-photos" aria-labelledby="${editorId('PhotosTitle')}">
                        <div class="record-editor-media-heading">
                            <h3 id="${editorId('PhotosTitle')}"><span>03</span> 图片与视频</h3>
                            <span data-editor-media-count></span>
                        </div>
                        <p class="record-editor-media-intro">点击缩略图或文件名预览，抓住六点手柄上下拖动排序。更改保存后生效。</p>
                        <div class="record-editor-media-tools">
                            <div class="record-editor-upload-zone" data-editor-drop>
                                <button class="paper-button" type="button" data-editor-upload>添加图片或视频</button>
                                <p>或将文件拖到这里</p>
                                <button type="button" class="record-editor-upload-help" data-editor-upload-help aria-expanded="false" aria-controls="${editorId('UploadLimits')}">支持格式与大小</button>
                                <small id="${editorId('UploadLimits')}" class="record-editor-upload-limits" data-editor-upload-limits hidden>图片：JPEG / PNG / GIF / WebP，单张最大 ${MAXIMUM_IMAGE_FILE_BYTES / 1024 / 1024} MiB · 视频：MP4 / M4V / MOV / WebM / Ogg，单个最大 ${MAXIMUM_VIDEO_FILE_BYTES / 1024 / 1024} MiB · 本次新媒体合计最大 ${MAXIMUM_MEDIA_BATCH_BYTES / 1024 / 1024} MiB</small>
                                <input type="file" data-editor-photos accept=".mp4,.m4v,.mov,.webm,.ogv,.ogg,image/jpeg,image/png,image/gif,image/webp,video/mp4,video/x-m4v,video/quicktime,video/webm,video/ogg" multiple hidden aria-label="选择旅行图片或视频">
                            </div>
                            <button class="paper-button" type="button" data-media-sort-time title="图片与视频一起按元数据时间从早到晚排序；没有时间的文件放在最后，按文件名排序">按拍摄时间排序</button>
                        </div>
                        <div data-editor-media-empty class="record-editor-media-empty">暂无图片或视频，可从上方添加。</div>
                        <div class="record-editor-media-batch" data-editor-media-batch role="group" aria-label="批量文件操作" hidden>
                            <div class="record-editor-media-selection">
                                <span data-media-selected-count role="status" hidden>未选择文件</span>
                                <button class="paper-button" type="button" data-media-select-all>全选文件</button>
                                <button class="paper-button" type="button" data-media-select-clear disabled>取消选择</button>
                            </div>
                            <div class="record-editor-media-operations" data-editor-media-operations hidden>
                                <button class="paper-button" type="button" data-media-batch="previous" disabled>前移所选</button>
                                <button class="paper-button" type="button" data-media-batch="next" disabled>后移所选</button>
                                <button class="paper-button media-file-remove" type="button" data-media-batch="remove" disabled>移除所选</button>
                            </div>
                        </div>
                        <div class="record-editor-media-group" data-editor-existing-group hidden>
                            <h4>文件顺序</h4>
                            <div data-media-viewer-group>
                                <ul class="record-editor-existing-media media-file-list" data-editor-existing-media aria-label="图片与视频文件操作"></ul>
                                <button class="media-file-drag" type="button" data-media-drag-group hidden aria-label="拖动所选文件组" title="上下拖动所选文件；也可用方向键调整">${mediaDragIcon()}</button>
                            </div>
                        </div>
                        <div class="record-editor-media-group record-editor-removed-group" data-editor-removed-group hidden>
                            <h4>待移除 <span>保存前可恢复</span></h4>
                            <div class="record-editor-media-batch" data-editor-restore-batch role="group" aria-label="批量恢复操作" hidden>
                                <div class="record-editor-media-selection">
                                    <span data-media-restore-count role="status" hidden></span>
                                    <button class="paper-button" type="button" data-media-restore-all>全选待移除</button>
                                    <button class="paper-button" type="button" data-media-restore-clear hidden>取消选择</button>
                                </div>
                                <div class="record-editor-media-operations" data-editor-restore-operations hidden>
                                    <button class="paper-button" type="button" data-media-restore-selected hidden>恢复所选</button>
                                </div>
                            </div>
                            <ul class="media-file-list" data-editor-removed-list data-media-viewer-group aria-label="待移除文件"></ul>
                        </div>
                        <p class="record-editor-media-announcement" data-editor-media-announcement role="status" aria-live="polite"></p>
                        ${editing ? `<div class="record-editor-sync-setting">
                            <label class="record-editor-media-sync"><input type="checkbox" name="syncMediaFiles" checked aria-describedby="${editorId('MediaSyncHelp')}">保存时同步删除、移动真实文件</label>
                            <p class="record-editor-note" id="${editorId('MediaSyncHelp')}">关闭后仅更新文件引用，原文件不删除或移动；其他日记使用的文件始终保留。</p>
                        </div>` : ''}
                    </section>
                    <details class="record-editor-files">
                        <summary><span>高级文件设置</span><span>路径与文件名</span></summary>
                        <div class="record-editor-fields">
                            <label>正文路径 <span>自动填写 · 可修改</span><input name="desc_md" maxlength="200"></label>
                            <div class="record-editor-grid record-editor-files-grid">
                                <label>照片目录 <span>选填</span><input name="photo_folder" maxlength="200" placeholder="data/photos/suzhou" aria-describedby="${editorId('PhotoHelp')}"></label>
                                <div>
                                    <label>已有照片文件名 <span>选填 · 每行一个</span><textarea name="photos" rows="3" maxlength="201000" placeholder="canal.jpg&#10;garden.jpg" aria-describedby="${editorId('PhotoHelp')}"></textarea></label>
                                </div>
                                <label>视频目录 <span>选填</span><input name="video_folder" maxlength="200" placeholder="data/videos/suzhou" aria-describedby="${editorId('PhotoHelp')}"></label>
                                <div>
                                    <label>已有视频文件名 <span>选填 · 每行一个</span><textarea name="videos" rows="3" maxlength="201000" placeholder="sunset.mp4&#10;street.webm" aria-describedby="${editorId('PhotoHelp')}"></textarea></label>
                                </div>
                            </div>
                            <p class="record-editor-note" id="${editorId('PhotoHelp')}">已有文件名与上方列表同步。新图片保存到 <output data-editor-photo-path-preview></output>；新视频保存到 <output data-editor-video-path-preview></output>。</p>
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
        mediaGroupObserver.disconnect();
        mediaGroupObserver.observe(dialog.querySelector('[data-media-viewer-group]'));
        saved = false;
        dirty = false;
        uploads = [];
        removedMedia = [];
        mediaOrder = [];
        existingMediaEntries = { photo: [], video: [] };
        selectedMedia.clear();
        selectedRemovedMedia.clear();
        mediaReferenceEdits.clear();
        bodyView = 'source';
        userEditedAutofillFields.clear();
        autoFilledValues.clear();
        userEditedPaths.clear();
        const initialInput = editing ? getRecordInput(record) : { date, country_code: 'CN' };
        originalDerivedLocation = editing ? { date: initialInput.date, locality: initialInput.locality } : null;
        derivedPathsActivated = !editing;
        for (const key of RECORD_FIELDS) {
            const value = initialInput[key] ?? (['photos', 'videos'].includes(key) ? [] : '');
            field(key).value = ['photos', 'videos'].includes(key) ? value.join('\n') : value;
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
        }
        enhanceCustomSelects(dialog);
        updateCountry(!editing);
        updatePathHint();
        updateAutofill();
        updateBodyView(bodyView);
        const original = record?.sourceRecord || record;
        mediaOrder = orderMedia(['photo', 'video'].flatMap(canonicalMedia), original?.media_order).map(item => item.key);
        renderExistingMedia();
    }

    function existingMediaPath(type, name) {
        const original = editingRecord?.sourceRecord || editingRecord;
        const folder = !saved && field('syncMediaFiles')?.checked && original?.[`${type}s`]?.includes(name)
            ? original[`${type}_folder`] : field(`${type}_folder`).value.trim();
        return `${folder}/${name}`;
    }

    function mediaNames(type) {
        return field(`${type}s`).value.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
    }

    function canonicalMedia(type) {
        const byName = new Map();
        for (const item of existingMediaEntries[type]) {
            if (!byName.has(item.name)) byName.set(item.name, []);
            byName.get(item.name).push(item);
        }
        existingMediaEntries[type] = mediaNames(type).map(name => byName.get(name)?.shift()
            || { key: `${type}:${++mediaKeySequence}`, type, name });
        return [
            ...existingMediaEntries[type],
            ...uploads.filter(upload => upload.kind === (type === 'photo' ? 'image' : 'video'))
                .map(upload => ({ key: `upload:${upload.id}`, type, name: upload.name, upload }))
        ];
    }

    function orderedMedia(type) {
        const items = ['photo', 'video'].flatMap(canonicalMedia);
        const byKey = new Map(items.map(item => [item.key, item]));
        const removedKeys = new Set(removedMedia.map(item => item.orderKey));
        mediaOrder = mediaOrder.filter(key => byKey.has(key) || removedKeys.has(key));
        const known = new Set(mediaOrder);
        mediaOrder.push(...items.filter(item => !known.has(item.key)).map(item => item.key));
        return mediaOrder.filter(key => byKey.has(key)).map(key => byKey.get(key))
            .filter(item => !type || item.type === type);
    }

    function syncExistingOrder(type) {
        field(`${type}s`).value = orderedMedia(type).filter(item => !item.upload).map(item => item.name).join('\n');
    }

    function syncAdvancedMediaOrder(type) {
        const previousKeys = new Set(existingMediaEntries[type].map(item => item.key));
        if (!mediaReferenceEdits.has(type)) {
            mediaReferenceEdits.set(type, existingMediaEntries[type].map(item => ({ ...item,
                path: existingMediaPath(type, item.name) })));
        }
        const baseline = mediaReferenceEdits.get(type);
        // 一次文本编辑只追踪原有引用，避免逐字输入产生大量待恢复的临时文件名。
        existingMediaEntries[type].push(...baseline.filter(item => !previousKeys.has(item.key)));
        const keys = canonicalMedia(type).filter(item => !item.upload).map(item => item.key);
        const active = new Set(keys);
        removedMedia = removedMedia.filter(item => !active.has(item.orderKey));
        const removedKeys = new Set(removedMedia.map(item => item.orderKey));
        baseline.forEach((item, index) => {
            if (active.has(item.key) || removedKeys.has(item.key)) return;
            removedMedia.push({ ...item, orderKey: item.key, index });
            removedKeys.add(item.key);
        });
        const order = mediaOrder;
        const slots = new Set([...previousKeys, ...keys]);
        let lastSlot = -1;
        order.forEach((key, index) => { if (slots.has(key) && !removedKeys.has(key)) lastSlot = index; });
        let index = 0;
        // 已有引用按文本框排列，新增文件与待恢复文件继续保留各自的槽位。
        mediaOrder = order.flatMap((key, position) => {
            if (!slots.has(key) || removedKeys.has(key)) return [key];
            const replacement = index < keys.length ? [keys[index++]] : [];
            if (position === lastSlot) replacement.push(...keys.slice(index));
            return replacement;
        });
        if (lastSlot === -1) mediaOrder.unshift(...keys);
    }

    function renderExistingMedia() {
        let mediaIndex = 0;
        const list = dialog.querySelector('[data-editor-existing-media]');
        const items = orderedMedia();
        const existing = new Map([...list.children].map(row => [row.dataset.mediaKey, row]));
        const rows = items.map((item, index) => {
            const type = item.type;
            const targetFolder = uploads.some(upload => upload.kind === (type === 'photo' ? 'image' : 'video'))
                ? `data/${type}s/${recordSlug(field('locality').value || '目的地')}` : field(`${type}_folder`).value.trim();
            const path = item.upload ? '' : existingMediaPath(type, item.name);
            let row = existing.get(item.key);
            if (row?.dataset.mediaPath !== path) row = null;
            if (!row) {
                row = document.createElement('li');
                row.dataset.mediaKey = item.key;
                row.dataset.mediaPath = path;
                const selection = document.createElement('label');
                selection.className = 'media-file-selection';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.dataset.mediaSelect = item.key;
                checkbox.setAttribute('aria-label', `选择 ${item.name}`);
                selection.append(checkbox);
                row.append(selection, item.upload ? uploadMediaLink(item.upload, mediaIndex)
                    : createMediaFileLink({ path, name: item.name, kind: type === 'video' ? 'video' : 'image' }),
                document.createElement('div'));
            }
            const checkbox = row.querySelector('[data-media-select]');
            checkbox.checked = selectedMedia.has(item.key);
            checkbox.disabled = saved;
            row.classList.toggle('is-selected', checkbox.checked);
            const link = row.querySelector('.media-file-link');
            link.dataset.mediaIndex = String(mediaIndex);
            if (link.matches('a')) {
                mediaIndex++;
                const destination = `${targetFolder}/${item.name}`;
                const note = item.upload ? saved ? '已保存' : `保存到 ${targetFolder}/`
                    : !getMediaFileUrl(destination) ? '路径无效，请检查高级设置'
                    : destination !== path ? `保存到 ${destination} · 预览原文件` : `引用 ${destination}`;
                const detail = link.querySelector('.media-file-detail');
                detail.textContent = `${type === 'photo' ? '图片' : '视频'} · ${index + 1} / ${items.length} · ${note}`;
                if (item.upload && !saved) {
                    const badge = document.createElement('span');
                    badge.className = 'record-editor-upload-pending';
                    badge.textContent = '待上传';
                    detail.prepend(badge, ' · ');
                }
            }
            const actions = row.lastElementChild;
            actions.className = 'media-file-actions';
            const label = escapeHtml(item.name);
            actions.innerHTML = `
                <button type="button" class="media-file-remove" data-media-action="remove" aria-label="移除 ${label}"${saved ? ' disabled' : ''}>移除</button>
                <button type="button" data-media-action="previous" aria-label="前移 ${label}" title="前移"${saved || index === 0 ? ' disabled' : ''}>${mediaOrderIcon(-1)}</button>
                <button type="button" data-media-action="next" aria-label="后移 ${label}" title="后移"${saved || index === items.length - 1 ? ' disabled' : ''}>${mediaOrderIcon(1)}</button>
                <button type="button" class="media-file-drag" data-media-drag aria-label="拖动 ${label} 排序" title="上下拖动排序；也可用方向键调整"${saved || items.length < 2 ? ' disabled' : ''}>${mediaDragIcon()}</button>`;
            return row;
        });
        list.replaceChildren(...rows);
        updateMediaSelection();
        renderRemovedMedia();
    }

    function updateMediaSelection() {
        const items = orderedMedia();
        const keys = new Set(items.map(item => item.key));
        for (const key of selectedMedia) if (!keys.has(key)) selectedMedia.delete(key);
        dialog.querySelectorAll('[data-media-select]').forEach(checkbox => {
            checkbox.checked = selectedMedia.has(checkbox.dataset.mediaSelect);
            checkbox.disabled = saved;
            checkbox.closest('li').classList.toggle('is-selected', checkbox.checked);
        });
        dialog.querySelector('[data-editor-media-batch]').hidden = saved || !items.length;
        dialog.querySelector('[data-media-sort-time]').disabled = saved || items.length < 2;
        const allSelected = items.length > 0 && selectedMedia.size === items.length;
        const selectAll = dialog.querySelector('[data-media-select-all]');
        selectAll.textContent = items.every(item => item.type === 'photo') ? '全选图片'
            : items.every(item => item.type === 'video') ? '全选视频' : '全选文件';
        selectAll.hidden = allSelected;
        selectAll.disabled = saved || !items.length;
        const count = dialog.querySelector('[data-media-selected-count]');
        count.textContent = `已选 ${selectedMedia.size} 项`;
        count.hidden = !selectedMedia.size;
        dialog.querySelector('[data-editor-media-operations]').hidden = !selectedMedia.size;
        const clear = dialog.querySelector('[data-media-select-clear]');
        clear.hidden = !selectedMedia.size;
        clear.disabled = saved || !selectedMedia.size;
        const groupDrag = dialog.querySelector('[data-media-drag-group]');
        groupDrag.hidden = selectedMedia.size < 2 || !items.some(item => !selectedMedia.has(item.key));
        groupDrag.disabled = saved;
        groupDrag.setAttribute('aria-label', `拖动所选 ${selectedMedia.size} 项排序`);
        updateMediaGroupSlider();
        dialog.querySelectorAll('[data-media-batch]').forEach(button => {
            const action = button.dataset.mediaBatch;
            button.hidden = !selectedMedia.size;
            button.disabled = saved || (action === 'remove' ? !selectedMedia.size : !items.some((item, index) => selectedMedia.has(item.key)
                && items[index + (action === 'previous' ? -1 : 1)]
                && !selectedMedia.has(items[index + (action === 'previous' ? -1 : 1)].key)));
        });
    }

    function updateMediaGroupSlider() {
        const handle = dialog.querySelector('[data-media-drag-group]');
        const allRows = [...handle.parentElement.querySelectorAll('[data-media-key]')];
        const first = allRows.findIndex(row => selectedMedia.has(row.dataset.mediaKey));
        const last = allRows.findLastIndex(row => selectedMedia.has(row.dataset.mediaKey));
        // 大滑块覆盖的行不再显示小手柄，避免非连续多选时控件重叠。
        allRows.forEach((row, index) => {
            row.querySelector('[data-media-drag]').hidden = !handle.hidden && index >= first && index <= last;
        });
        if (handle.hidden) return;
        const group = handle.parentElement;
        const rows = [...group.querySelectorAll('[data-media-key]')].filter(row => selectedMedia.has(row.dataset.mediaKey));
        if (!rows.length) return;
        const top = rows[0].getBoundingClientRect().top - group.getBoundingClientRect().top;
        handle.style.top = `${top}px`;
        handle.style.height = `${Math.max(44, rows.at(-1).getBoundingClientRect().bottom - rows[0].getBoundingClientRect().top)}px`;
    }

    function updateMediaDragTarget() {
        if (!mediaDrag?.active) return;
        const drag = mediaDrag;
        const scroll = dialog.querySelector('.record-editor-scroll');
        const bounds = scroll.getBoundingClientRect();
        drag.valid = drag.x >= bounds.left && drag.x <= bounds.right
            && drag.y >= bounds.top - 44 && drag.y <= bounds.bottom + 44;
        drag.targets.clear();
        dialog.querySelectorAll('.is-drop-before, .is-drop-after').forEach(row => row.classList.remove('is-drop-before', 'is-drop-after'));
        if (!drag.valid) return;
        const list = dialog.querySelector('[data-editor-existing-media]');
        const rows = [...list.children];
        if (!rows.some(row => drag.keys.has(row.dataset.mediaKey))) return;
        const remaining = rows.filter(row => !drag.keys.has(row.dataset.mediaKey));
        const before = remaining.find(row => {
            const rect = row.getBoundingClientRect();
            return drag.y < rect.top + rect.height / 2;
        });
        drag.targets.set('all', before?.dataset.mediaKey ?? null);
        (before || remaining.at(-1))?.classList.add(before ? 'is-drop-before' : 'is-drop-after');
        drag.badge.style.top = `${Math.max(bounds.top, Math.min(drag.y + 16, bounds.bottom - 36))}px`;
    }

    function scrollMediaDrag() {
        if (!mediaDrag?.active) return;
        const scroll = dialog.querySelector('.record-editor-scroll');
        const bounds = scroll.getBoundingClientRect();
        if (mediaDrag.valid) {
            const edge = 56;
            const speed = mediaDrag.y < bounds.top + edge ? -Math.min(16, (bounds.top + edge - mediaDrag.y) / 4)
                : mediaDrag.y > bounds.bottom - edge ? Math.min(16, (mediaDrag.y - bounds.bottom + edge) / 4) : 0;
            if (speed) {
                scroll.scrollTop += speed;
                updateMediaDragTarget();
            }
        }
        mediaDrag.frame = requestAnimationFrame(scrollMediaDrag);
    }

    function finishMediaDrag(commit = false) {
        const drag = mediaDrag;
        if (!drag) return;
        mediaDrag = null;
        cancelAnimationFrame(drag.frame);
        drag.badge?.remove();
        dialog.classList.remove('is-media-dragging');
        dialog.querySelectorAll('.is-media-drag-source, .is-drop-before, .is-drop-after').forEach(row => {
            row.classList.remove('is-media-drag-source', 'is-drop-before', 'is-drop-after');
        });
        if (dialog.hasPointerCapture(drag.id)) dialog.releasePointerCapture(drag.id);
        let changed = false;
        if (commit && drag.active && drag.valid && !saved && !busy && !readingPhotos) {
            for (const beforeKey of drag.targets.values()) {
                const order = orderedMedia().map(item => item.key);
                const next = moveMediaGroup(order, drag.keys, beforeKey);
                if (next.every((key, index) => key === order[index])) continue;
                const active = new Set(order);
                let index = 0;
                // 待恢复文件保留原来的槽位，拖动只重排当前可见文件。
                mediaOrder = mediaOrder.map(key => active.has(key) ? next[index++] : key);
                ['photo', 'video'].forEach(syncExistingOrder);
                changed = true;
            }
        }
        if (changed) {
            dirty = true;
            renderPhotos();
            updatePhotoStatus();
        }
        if (drag.active) {
            dialog.querySelector('[data-editor-media-announcement]').textContent = changed
                ? `已调整 ${drag.keys.size} 项的顺序，保存后生效。` : '顺序未更改。';
        }
        const focus = drag.handle.matches('[data-media-drag-group]') ? drag.handle
            : [...dialog.querySelectorAll('[data-media-key]')].find(row => row.dataset.mediaKey === drag.key)?.querySelector('[data-media-drag]');
        focus?.focus({ preventScroll: true });
    }

    async function sortMediaTime() {
        finishMediaDrag();
        const items = orderedMedia();
        const times = new Map();
        let unreadable = 0;
        busy = true;
        dialog.querySelector('form').inert = true;
        startProgress('按拍摄时间排序', '正在读取媒体元数据…');
        try {
            for (const [index, item] of items.entries()) {
                operationProgress.throwIfCancelled();
                operationProgress.update(index, items.length, `正在读取：${item.name}`, 'files');
                let time = null;
                try {
                    time = item.upload ? await readMediaTime(previewBlob(item.upload))
                        : await fetchMediaTime(getMediaFileUrl(existingMediaPath(item.type, item.name)),
                            AbortSignal.any([operationProgress.signal, AbortSignal.timeout(20000)]));
                } catch {
                    operationProgress.throwIfCancelled();
                    unreadable++;
                }
                times.set(item.key, time);
            }
            operationProgress.throwIfCancelled();
            const ordered = orderedMedia();
            const next = sortMediaByTime(ordered, times);
            const active = new Set(ordered.map(item => item.key));
            let index = 0;
            // 保留待移除文件的槽位，恢复操作继续沿用现有顺序规则。
            mediaOrder = mediaOrder.map(key => active.has(key) ? next[index++].key : key);
            ['photo', 'video'].forEach(syncExistingOrder);
            dirty = true;
            renderPhotos();
            const timed = [...times.values()].filter(Number.isFinite).length;
            const message = `已按拍摄时间从早到晚排序：${timed} 项有时间，${items.length - timed} 项无可用时间，放在最后按文件名排序。${unreadable ? `其中 ${unreadable} 项元数据无法读取。` : ''}保存后生效。`;
            status(message);
            dialog.querySelector('[data-editor-media-announcement]').textContent = message;
            operationProgress.complete(message);
        } catch (error) {
            status(operationProgress.signal.aborted ? '排序已取消，文件顺序未更改。' : `排序失败，文件顺序未更改：${error.message}`);
            operationProgress.fail(error);
        } finally {
            busy = false;
            dialog.querySelector('form').inert = false;
            dialog.querySelector('[data-media-sort-time]').focus({ preventScroll: true });
        }
    }

    function operateMedia(keys, action) {
        const items = orderedMedia();
        if (action === 'remove') {
            for (const item of items.filter(item => keys.has(item.key))) {
                const type = item.type;
                const index = item.upload ? uploads.indexOf(item.upload) : existingMediaEntries[type].findIndex(entry => entry.key === item.key);
                removedMedia.push({ ...item, orderKey: item.key, index,
                    path: item.upload ? '' : existingMediaPath(type, item.name) });
                if (item.upload) uploads.splice(index, 1);
                else {
                    const names = mediaNames(type);
                    names.splice(index, 1);
                    existingMediaEntries[type].splice(index, 1);
                    field(`${type}s`).value = names.join('\n');
                }
                selectedMedia.delete(item.key);
            }
        } else {
            const direction = action === 'previous' ? -1 : 1;
            const indexes = items.map((_, index) => index);
            if (direction === 1) indexes.reverse();
            for (const index of indexes) {
                const next = index + direction;
                if (keys.has(items[index].key) && items[next] && !keys.has(items[next].key)) {
                    [items[index], items[next]] = [items[next], items[index]];
                }
            }
            // 保留待移除条目的槽位，恢复时仍回到原来的相对位置。
            let index = 0;
            const active = new Set(items.map(item => item.key));
            mediaOrder = mediaOrder.map(key => active.has(key) ? items[index++].key : key);
            ['photo', 'video'].forEach(syncExistingOrder);
        }
        dirty = true;
        renderPhotos();
        updatePhotoStatus();
        dialog.querySelector('[data-editor-media-announcement]').textContent = action === 'remove'
            ? `已移除 ${keys.size} 项，可在下方恢复。保存前不会删除文件。` : '所选文件已调整顺序，保存后生效。';
    }

    function renderRemovedMedia() {
        removedMedia = removedMedia.filter(item => item.upload
            ? !uploads.some(upload => upload.id === item.upload.id)
            : !canonicalMedia(item.type).some(active => active.key === item.orderKey));
        const list = dialog.querySelector('[data-editor-removed-list]');
        let mediaIndex = 0;
        list.replaceChildren(...removedMedia.map(item => {
            const row = document.createElement('li');
            const selection = document.createElement('label');
            selection.className = 'media-file-selection';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.dataset.mediaRemovedSelect = item.orderKey;
            checkbox.setAttribute('aria-label', `选择待恢复 ${item.name}`);
            selection.append(checkbox);
            const link = item.upload ? uploadMediaLink(item.upload, mediaIndex) : createMediaFileLink({
                path: item.path, name: item.name, kind: item.type === 'video' ? 'video' : 'image', index: mediaIndex,
                detail: field('syncMediaFiles')?.checked ? '保存时删除原文件（其他日记仍引用时保留）' : '仅移除引用，原文件保留'
            });
            if (link.matches('a')) mediaIndex++;
            if (item.upload) link.querySelector('.media-file-detail').textContent = '已取消上传';
            const restore = document.createElement('button');
            restore.type = 'button';
            restore.className = 'media-file-restore';
            restore.dataset.mediaRestore = item.orderKey;
            restore.textContent = '恢复';
            restore.setAttribute('aria-label', `恢复 ${item.name}`);
            restore.disabled = saved;
            row.append(selection, link, restore);
            return row;
        }));
        updateRemovedSelection();
        updateMediaSummary();
    }

    function updateRemovedSelection() {
        const keys = new Set(removedMedia.map(item => item.orderKey));
        for (const key of selectedRemovedMedia) if (!keys.has(key)) selectedRemovedMedia.delete(key);
        dialog.querySelectorAll('[data-media-removed-select]').forEach(checkbox => {
            checkbox.checked = selectedRemovedMedia.has(checkbox.dataset.mediaRemovedSelect);
            checkbox.disabled = saved;
            checkbox.closest('li').classList.toggle('is-selected', checkbox.checked);
        });
        dialog.querySelector('[data-editor-restore-batch]').hidden = saved || !keys.size;
        dialog.querySelector('[data-media-restore-all]').hidden = selectedRemovedMedia.size === keys.size;
        dialog.querySelector('[data-media-restore-clear]').hidden = !selectedRemovedMedia.size;
        dialog.querySelector('[data-media-restore-selected]').hidden = !selectedRemovedMedia.size;
        dialog.querySelector('[data-editor-restore-operations]').hidden = !selectedRemovedMedia.size;
        const count = dialog.querySelector('[data-media-restore-count]');
        count.hidden = !selectedRemovedMedia.size;
        count.textContent = `已选 ${selectedRemovedMedia.size} 项`;
    }

    function restoreMedia(keys) {
        const items = removedMedia.filter(item => keys.has(item.orderKey));
        for (const item of items) {
            // 逐项恢复，其他选中项的槽位在它们恢复之前仍由待移除列表保留。
            removedMedia = removedMedia.filter(removed => removed.orderKey !== item.orderKey);
            if (item.upload) uploads.splice(Math.min(item.index, uploads.length), 0, item.upload);
            else {
                const names = mediaNames(item.type);
                names.push(item.name);
                existingMediaEntries[item.type].push({ key: item.orderKey, type: item.type, name: item.name });
                field(`${item.type}s`).value = names.join('\n');
            }
            syncExistingOrder(item.type);
            selectedRemovedMedia.delete(item.orderKey);
        }
        renderPhotos();
        updatePhotoStatus();
        dirty = true;
        dialog.querySelector('[data-editor-media-announcement]').textContent = `已恢复 ${items.length} 项，文件已回到上方列表。`;
        const row = [...dialog.querySelectorAll('[data-media-key]')].find(row => row.dataset.mediaKey === items[0]?.orderKey);
        (row?.querySelector('a, [data-media-select]') || dialog.querySelector('[data-editor-upload]')).focus();
    }

    function updateMediaSummary() {
        const existingCount = mediaNames('photo').length + mediaNames('video').length;
        dialog.querySelector('[data-editor-media-count]').textContent = `${existingCount + uploads.length} 项${uploads.length && !saved ? ` · ${uploads.length} 项待上传` : ''}`;
        dialog.querySelector('[data-editor-existing-group]').hidden = !(existingCount || uploads.length);
        dialog.querySelector('[data-editor-removed-group]').hidden = !removedMedia.length;
        dialog.querySelector('[data-editor-media-empty]').hidden = Boolean(existingCount || uploads.length || removedMedia.length);
    }

    function uploadMediaLink(photo, index) {
        if (!mediaSourceUrls.has(photo.id)) {
            const blob = previewBlob(photo);
            mediaSourceUrls.set(photo.id, { blob, url: URL.createObjectURL(blob) });
        }
        const source = mediaSourceUrls.get(photo.id);
        return createMediaFileLink({ src: source.url, blob: source.blob, name: photo.name, kind: photo.kind, index,
            loadThumbnail: () => ensurePhotoPreviewUrl(photo), detail: `${photo.kind === 'video' ? '视频' : '图片'} · 待上传` });
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
        const videoPath = `data/videos/${recordSlug(locality)}`;
        field('desc_md').placeholder = markdownPath;
        field('photo_folder').placeholder = photoPath;
        field('video_folder').placeholder = videoPath;
        dialog.querySelector('[data-editor-photo-path-preview]').textContent = photoPath;
        dialog.querySelector('[data-editor-video-path-preview]').textContent = videoPath;
        field('trip_id').placeholder = suggestedTripId(getDraft().input) || '填写地点后自动生成';
    }

    function derivedLocationChanged() {
        if (!editingRecord || !originalDerivedLocation) return true;
        return field('date').value !== originalDerivedLocation.date
            || field('locality').value !== originalDerivedLocation.locality;
    }

    function regenerateDerivedPaths() {
        if (!derivedPathsActivated) return;
        const input = getDraft().input;
        const slug = recordSlug(input.locality);
        const markdownPath = suggestedMarkdownPath(input);
        if (markdownPath && !userEditedPaths.has('desc_md')) {
            field('desc_md').value = markdownPath;
            autoFilledValues.set('desc_md', markdownPath);
            userEditedAutofillFields.delete('desc_md');
        }
        if (slug && !userEditedPaths.has('photo_folder')) {
            field('photo_folder').value = `data/photos/${slug}`;
        }
        if (slug && input.videos.length && !userEditedPaths.has('video_folder')) {
            field('video_folder').value = `data/videos/${slug}`;
        }
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
        if (derivedLocationChanged()) derivedPathsActivated = true;
        regenerateDerivedPaths();
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

    function setBodyFullscreen(fullscreen, restoreFocus = true) {
        if (bodyFullscreen === fullscreen) return;
        const scroll = dialog.querySelector('.record-editor-scroll');
        if (fullscreen) {
            bodyScrollTop = scroll.scrollTop;
            closeOtherAutocompletes();
        }
        bodyFullscreen = fullscreen;
        dialog.classList.toggle('is-body-fullscreen', fullscreen);
        const button = dialog.querySelector('[data-editor-fullscreen]');
        button.textContent = fullscreen ? '退出全屏' : '全屏';
        button.setAttribute('aria-pressed', String(fullscreen));
        if (!fullscreen) scroll.scrollTop = bodyScrollTop;
        if (restoreFocus) {
            const target = fullscreen ? dialog.querySelector(bodyView === 'source' ? '[data-editor-source]' : '[data-editor-rich]') : button;
            target.focus({ preventScroll: true });
        }
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
        updateWordCount();
    }

    function updateWordCount() {
        const preview = document.createElement('div');
        // 固定解析用标题，避免空标题的标记被计入正文，并保留正文开头的内容。
        preview.innerHTML = previewHtml(`# _\n\n${field('body').value}`, field('title').value);
        const count = Array.from(preview.textContent.replace(/\s/g, '')).length;
        dialog.querySelector('[data-editor-word-count]').textContent = `${count} 字`;
    }

    function syncMarkdown(source) {
        const input = splitMarkdown(source, field('title').value);
        field('title').value = input.title;
        field('body').value = input.body;
        updateMarkdownHighlight(source);
        updateWordCount();
        dirty = true;
    }

    function updateMarkdownHighlight(source) {
        dialog.querySelector('[data-editor-highlight] code').innerHTML = `${highlightMarkdown(source)}\n`;
    }

    function syncPreview() {
        syncMarkdown(previewToMarkdown(dialog.querySelector('[data-editor-rich]')));
    }

    function renderPhotos() {
        releasePhotoPreviews(new Set([...uploads.map(photo => photo.id), ...removedMedia.filter(item => item.upload).map(item => item.upload.id)]));
        renderExistingMedia();
    }

    function updatePhotoStatus() {
        const photoCount = uploads.filter(upload => upload.kind === 'image').length;
        const videoCount = uploads.filter(upload => upload.kind === 'video').length;
        status(uploads.length ? `已选择 ${photoCount} 张图片、${videoCount} 个视频，保存记录或导出草稿时会一并处理。` : '');
    }

    async function clearEditor() {
        if (busy || saved || readingPhotos) return;
        const confirmed = await confirmFeedback('当前编辑器中的表单、正文和待保存图片、视频都会被清除，操作无法撤销。', {
            label: '编辑器',
            title: '清空编辑器？',
            cancelLabel: '保留内容',
            confirmLabel: '清空内容'
        });
        if (!confirmed || busy || saved || readingPhotos) return;

        releasePhotoPreviews();
        uploads = [];
        removedMedia = [];
        mediaOrder = [];
        existingMediaEntries = { photo: [], video: [] };
        selectedMedia.clear();
        selectedRemovedMedia.clear();
        mediaReferenceEdits.clear();
        for (const key of RECORD_FIELDS) field(key).value = '';
        field('country_code').selectedIndex = -1;
        field('country_code').dispatchEvent(new Event('change', { bubbles: true }));
        dialog.querySelector('[data-editor-file]').value = '';
        dialog.querySelector('[data-editor-rich]').innerHTML = previewHtml('', '');
        dialog.querySelector('[data-editor-source]').value = '';
        updateMarkdownHighlight('');
        updateWordCount();
        userEditedAutofillFields.clear();
        autoFilledValues.clear();
        userEditedPaths.clear();
        dirty = false;
        dialog.querySelector('.record-editor-files').open = false;
        updateCountry();
        updatePathHint();
        updateAutofill();
        renderPhotos();
        renderExistingMedia();
        status('编辑器已清空，可以重新填写内容。');
        field('date').focus();
    }

    async function addPhotos(files) {
        if (busy || saved || readingPhotos || !files.length) return;
        readingPhotos = true;
        startProgress('读取图片和视频', '正在校验媒体文件…');
        const saveButton = dialog.querySelector('[data-editor-save]');
        saveButton.disabled = true;
        status('正在读取图片和视频…');
        try {
            if (files.some(file => !file.size)) throw new Error('不能选择空媒体文件。');
            if (files.some(file => file.size > MAXIMUM_MEDIA_FILE_BYTES)) {
                throw new Error(`单个视频不能超过 ${MAXIMUM_VIDEO_FILE_BYTES / 1024 / 1024} MiB。`);
            }
            if (files.some(file => file.type.startsWith('image/') && file.size > MAXIMUM_IMAGE_FILE_BYTES)) {
                throw new Error(`单张图片不能超过 ${MAXIMUM_IMAGE_FILE_BYTES / 1024 / 1024} MiB。`);
            }
            const selectedBytes = files.reduce((total, file) => total + file.size, 0);
            const pendingBytes = uploads.reduce((total, media) => total + media.size, 0);
            if (selectedBytes + pendingBytes > MAXIMUM_MEDIA_BATCH_BYTES) {
                throw new Error(`待保存的图片和视频合计不能超过 ${MAXIMUM_MEDIA_BATCH_BYTES / 1024 / 1024} MiB。`);
            }
            const pending = [];
            for (const [fileIndex, file] of files.entries()) {
                const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
                status(`正在读取 ${fileIndex + 1}/${files.length}：${file.name}`);
                operationProgress.update(fileIndex, files.length, `正在处理：${file.name}`, 'files');
                const data = sourceOf(file);
                data.head = await data.read(0, Math.min(16386, data.size));
                operationProgress.throwIfCancelled();
                const photo = readUploads([{ id, name: file.name.slice(0, 200), data }])[0];
                operationProgress.throwIfCancelled();
                for (const existing of [...uploads, ...pending]) {
                    if (existing.kind === photo.kind && existing.size === photo.size
                        && await sameMediaContent(existing.data, photo.data, () => operationProgress.throwIfCancelled())) {
                        throw Object.assign(new Error(`“${photo.name}”已选择过同样的文件，不能重复上传。`), { code: 'DUPLICATE_MEDIA' });
                    }
                }
                pending.push(photo);
                operationProgress.update(fileIndex + 1, files.length, '正在校验媒体文件…', 'files');
            }
            uploads.push(...pending);
            dirty = true;
            renderPhotos();
            updatePhotoStatus();
            operationProgress.complete(`已读取 ${files.length} 项媒体，保存记录时将一并上传。`);
        } catch (error) {
            status(error.message);
            if (error.code === 'DUPLICATE_MEDIA') {
                operationProgress.remove();
                showFeedback(error.message, { label: '媒体上传', title: '文件重复' });
            } else operationProgress.fail(error);
        }
        finally { readingPhotos = false; saveButton.disabled = saved || !token; }
    }

    function archiveProgress(processed, total) {
        operationProgress?.throwIfCancelled();
        operationProgress?.update(processed, total, archivePhase);
    }

    function download(content, name, type) {
        operationProgress?.throwIfCancelled();
        saveBlobDownload(new Blob([content], { type }), name);
    }

    function close() {
        if (busy || readingPhotos) return;
        finishMediaDrag();
        setBodyFullscreen(false, false);
        dialog.close();
        if (trigger?.isConnected) trigger.focus();
        else document.querySelector('[data-action="add-record"]')?.focus();
    }

    dialog.addEventListener('cancel', event => {
        if (event.target !== dialog) return;
        event.preventDefault();
        if (bodyFullscreen) {
            setBodyFullscreen(false);
            return;
        }
        close();
    });
    // 正文标签使用方向键切换；其他按键由原生 dialog 处理，避免触发背景日记快捷键。
    dialog.addEventListener('keydown', event => {
        if (mediaDrag && event.key === 'Escape') {
            event.preventDefault();
            finishMediaDrag();
        }
        const dragHandle = event.target.closest('[data-media-drag], [data-media-drag-group]');
        if (dragHandle && !saved && !busy && !readingPhotos && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            const key = dragHandle.closest('[data-media-key]')?.dataset.mediaKey;
            const keys = key ? new Set([key]) : new Set(selectedMedia);
            operateMedia(keys, event.key === 'ArrowUp' ? 'previous' : 'next');
            const focus = key ? [...dialog.querySelectorAll('[data-media-key]')].find(row => row.dataset.mediaKey === key)?.querySelector('[data-media-drag]') : dragHandle;
            focus?.focus({ preventScroll: true });
        }
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
        if (!saved && (RECORD_FIELDS.includes(event.target.name) || event.target.name === 'syncMediaFiles')) dirty = true;
        if (['country', 'admin_area', 'admin_area_type', 'locality', 'locality_type', 'trip_id', 'desc_md'].includes(event.target.name)) {
            userEditedAutofillFields.add(event.target.name);
            autoFilledValues.delete(event.target.name);
        }
        if (['desc_md', 'photo_folder', 'video_folder'].includes(event.target.name)) userEditedPaths.add(event.target.name);
        if (['country_code', 'date', 'admin_area', 'locality'].includes(event.target.name)) updateAutofill();
        if (event.target.name === 'title') updateBodyView(bodyView);
        if (['photos', 'videos'].includes(event.target.name)) {
            const type = event.target.name === 'photos' ? 'photo' : 'video';
            syncAdvancedMediaOrder(type);
        }
        if (['photo_folder', 'photos', 'video_folder', 'videos', 'date', 'locality', 'syncMediaFiles'].includes(event.target.name)) renderExistingMedia();
    });
    dialog.addEventListener('scroll', event => {
        if (mediaDrag?.active && event.target.matches('.record-editor-scroll')) updateMediaDragTarget();
        if (!event.target.matches('[data-editor-source]')) return;
        const highlight = dialog.querySelector('[data-editor-highlight]');
        highlight.scrollTop = event.target.scrollTop;
        highlight.scrollLeft = event.target.scrollLeft;
    }, true);
    dialog.addEventListener('pointerdown', event => {
        const handle = event.target.closest('[data-media-drag], [data-media-drag-group]');
        if (handle && !handle.disabled && !saved && !busy && !readingPhotos && event.button === 0 && event.isPrimary) {
            event.preventDefault();
            window.getSelection()?.removeAllRanges();
            dialog.classList.add('is-media-dragging');
            const key = handle.closest('[data-media-key]')?.dataset.mediaKey;
            const keys = key ? new Set([key]) : new Set(selectedMedia);
            mediaDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, startY: event.clientY,
                key, keys, handle, active: false, targets: new Map() };
            handle.focus({ preventScroll: true });
            dialog.setPointerCapture(event.pointerId);
            return;
        }
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
    dialog.addEventListener('selectstart', event => {
        if (mediaDrag || event.target.closest?.('.media-file-drag')) event.preventDefault();
    });
    dialog.addEventListener('contextmenu', event => {
        if (mediaDrag || event.target.closest?.('.media-file-drag')) event.preventDefault();
    });
    dialog.addEventListener('pointermove', event => {
        if (mediaDrag && event.pointerId === mediaDrag.id) {
            mediaDrag.x = event.clientX;
            mediaDrag.y = event.clientY;
            if (!mediaDrag.active && Math.abs(event.clientY - mediaDrag.startY) > POINTER_MOVE_TOLERANCE) {
                mediaDrag.active = true;
                dialog.classList.add('is-media-dragging');
                dialog.querySelectorAll('[data-media-key]').forEach(row => {
                    row.classList.toggle('is-media-drag-source', mediaDrag.keys.has(row.dataset.mediaKey));
                });
                const badge = document.createElement('div');
                badge.className = 'media-drag-badge';
                badge.setAttribute('aria-hidden', 'true');
                badge.textContent = `正在移动 ${mediaDrag.keys.size} 项`;
                badge.style.left = `${dialog.getBoundingClientRect().left + 16}px`;
                dialog.append(badge);
                mediaDrag.badge = badge;
                mediaDrag.frame = requestAnimationFrame(scrollMediaDrag);
            }
            updateMediaDragTarget();
            return;
        }
        if (!autocompletePointer || event.pointerId !== autocompletePointer.id) return;
        if (pointerMoved(autocompletePointer, event)) suppressAutocompleteClick = true;
    }, { passive: true });
    dialog.addEventListener('pointerup', event => {
        if (mediaDrag && event.pointerId === mediaDrag.id) {
            mediaDrag.x = event.clientX;
            mediaDrag.y = event.clientY;
            updateMediaDragTarget();
            finishMediaDrag(true);
            return;
        }
        if (!autocompletePointer || event.pointerId !== autocompletePointer.id) return;
        if (pointerMoved(autocompletePointer, event)) suppressAutocompleteClick = true;
        autocompletePointer = null;
    }, { passive: true });
    dialog.addEventListener('pointercancel', event => {
        if (mediaDrag && event.pointerId === mediaDrag.id) finishMediaDrag();
        if (!autocompletePointer || event.pointerId !== autocompletePointer.id) return;
        suppressAutocompleteClick = true;
        autocompletePointer = null;
    }, { passive: true });
    dialog.addEventListener('lostpointercapture', event => {
        if (mediaDrag && event.pointerId === mediaDrag.id) finishMediaDrag();
    });
    window.addEventListener('blur', () => finishMediaDrag());
    dialog.addEventListener('close', () => finishMediaDrag());
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
    dialog.addEventListener('click', async event => {
        if (event.target.closest('[data-editor-close]')) close();
        if (busy || readingPhotos) return;
        if (event.target.closest('[data-media-sort-time]') && !saved) {
            await sortMediaTime();
            return;
        }
        const uploadHelp = event.target.closest('[data-editor-upload-help]');
        if (uploadHelp) {
            const expanded = uploadHelp.getAttribute('aria-expanded') === 'true';
            uploadHelp.setAttribute('aria-expanded', String(!expanded));
            dialog.querySelector('[data-editor-upload-limits]').hidden = expanded;
            return;
        }
        if (event.target.closest('[data-editor-fullscreen]')) setBodyFullscreen(!bodyFullscreen);
        if (event.target.closest('[data-media-restore-all]') && !saved) {
            removedMedia.forEach(item => selectedRemovedMedia.add(item.orderKey));
            updateRemovedSelection();
            dialog.querySelector('[data-media-restore-selected]').focus();
            return;
        }
        if (event.target.closest('[data-media-restore-clear]') && !saved) {
            selectedRemovedMedia.clear();
            updateRemovedSelection();
            dialog.querySelector('[data-media-restore-all]').focus();
            return;
        }
        const restore = event.target.closest('[data-media-restore]');
        if ((restore || event.target.closest('[data-media-restore-selected]')) && !saved) {
            restoreMedia(restore ? new Set([restore.dataset.mediaRestore]) : new Set(selectedRemovedMedia));
            return;
        }
        if (event.target.closest('[data-media-select-all]') && !saved) {
            orderedMedia().forEach(item => selectedMedia.add(item.key));
            updateMediaSelection();
            dialog.querySelector('[data-media-select-clear]').focus();
            return;
        }
        if (event.target.closest('[data-media-select-clear]') && !saved) {
            selectedMedia.clear();
            updateMediaSelection();
            dialog.querySelector('[data-media-select-all]').focus();
            return;
        }
        const batch = event.target.closest('[data-media-batch]');
        const mediaAction = event.target.closest('[data-media-action]');
        if ((batch || mediaAction) && !saved) {
            const key = mediaAction?.closest('[data-media-key]').dataset.mediaKey;
            const action = batch?.dataset.mediaBatch || mediaAction.dataset.mediaAction;
            const keys = batch ? new Set(selectedMedia) : new Set([key]);
            operateMedia(keys, action);
            const row = [...dialog.querySelectorAll('[data-media-key]')].find(row => row.dataset.mediaKey === key);
            const focus = batch && !batch.disabled && !batch.hidden ? batch
                : row?.querySelector(`[data-media-action="${action}"]:not(:disabled)`) || row?.querySelector('a')
                || dialog.querySelector('[data-media-restore]') || dialog.querySelector('[data-media-select-all]');
            focus.focus();
            return;
        }
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
        const view = event.target.closest('[data-editor-view]');
        if (view) updateBodyView(view.dataset.editorView);
        if (event.target.closest('[data-editor-download]')) {
            busy = true;
            archivePhase = '正在校验并打包草稿媒体…';
            startProgress('导出草稿', archivePhase);
            dialog.querySelector('form').inert = true;
            try {
                const draft = getDraft();
                const input = draft.input;
                download(await createDraftBlob(draft, {}, archiveProgress), `travel-diary-draft-${input.date || 'undated'}-${recordSlug(input.locality || 'destination')}.zip`, 'application/zip');
                status('草稿已开始下载，所选图片和视频已一并打包。');
                operationProgress.complete('草稿已打包，已交给浏览器保存。');
            } catch (error) {
                status(operationProgress.signal.aborted ? '草稿导出已取消。' : `草稿导出失败：${error.message}`);
                operationProgress.fail(error);
            } finally {
                busy = false;
                dialog.querySelector('form').inert = false;
            }
            return;
        }
        if (event.target.closest('[data-editor-clear]')) {
            void clearEditor();
            return;
        }
        if (event.target.closest('[data-editor-import]')) dialog.querySelector('[data-editor-file]').click();
    });
    dialog.addEventListener('change', async event => {
        if (['photos', 'videos'].includes(event.target.name)) {
            mediaReferenceEdits.delete(event.target.name === 'photos' ? 'photo' : 'video');
        }
        if (event.target.matches('[data-media-select], [data-media-removed-select]')) {
            const removed = event.target.matches('[data-media-removed-select]');
            const selection = removed ? selectedRemovedMedia : selectedMedia;
            const key = removed ? event.target.dataset.mediaRemovedSelect : event.target.dataset.mediaSelect;
            if (saved || busy || readingPhotos) {
                event.target.checked = selection.has(key);
                return;
            }
            if (event.target.checked) selection.add(key);
            else selection.delete(key);
            if (removed) updateRemovedSelection();
            else updateMediaSelection();
            return;
        }
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
        archivePhase = '正在读取并校验草稿媒体…';
        startProgress('导入草稿', archivePhase);
        dialog.querySelector('form').inert = true;
        try {
            const isZip = file.name.toLocaleLowerCase('en-US').endsWith('.zip');
            const maximumBytes = isZip ? MAXIMUM_RECORD_ARCHIVE_BYTES : MAXIMUM_JSON_DRAFT_BYTES;
            if (file.size > maximumBytes) {
                throw new Error(`草稿 ${isZip ? 'ZIP' : 'JSON'} 不能超过 ${maximumBytes / 1024 / 1024} MiB，大媒体请使用 ZIP 草稿。`);
            }
            const draft = isZip
                ? (await readRecordSource(file, { verifyMedia: true, onProgress: archiveProgress })).draft
                : readDraft(JSON.parse(await file.text()));
            operationProgress.throwIfCancelled();
            for (const key of RECORD_FIELDS) field(key).value = ['photos', 'videos'].includes(key) ? draft.input[key].join('\n') : draft.input[key];
            // 程序赋值后同步原生选择框的增强显示。
            field('country_code').dispatchEvent(new Event('change'));
            requestId = draft.requestId;
            uploads = readUploads(draft.uploads);
            removedMedia = [];
            selectedMedia.clear();
            selectedRemovedMedia.clear();
            mediaReferenceEdits.clear();
            mediaOrder = [];
            existingMediaEntries = { photo: [], video: [] };
            const groups = Object.fromEntries(['photo', 'video'].map(type => {
                const items = canonicalMedia(type);
                return [type, (draft.mediaOrder?.[`${type}s`] || items.map((_, index) => index)).map(index => items[index].key)];
            }));
            const sequence = draft.mediaOrder?.sequence || ['photo', 'video'].flatMap(type => groups[type].map(() => type));
            mediaOrder = sequence.map(type => groups[type].shift());
            dirty = true;
            userEditedAutofillFields.clear();
            autoFilledValues.clear();
            userEditedPaths.clear();
            for (const name of ['country', 'admin_area', 'admin_area_type', 'locality', 'locality_type', 'trip_id', 'desc_md']) {
                userEditedAutofillFields.add(name);
            }
            for (const name of ['desc_md', 'photo_folder', 'video_folder']) userEditedPaths.add(name);
            updateCountry();
            updatePathHint();
            updateAutofill();
            updateBodyView(bodyView);
            removedMedia = [];
            renderPhotos();
            dialog.querySelector('.record-editor-files').open = false;
            renderExistingMedia();
            status('草稿已导入，请核对内容后保存。');
            operationProgress.complete('草稿和媒体已导入，请核对后保存。');
        } catch (error) {
            status(error instanceof SyntaxError ? '文件不是有效的 JSON 草稿。' : error.message);
            operationProgress.fail(error);
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
        let prepared;
        try { prepared = prepareRecord(draft, countries); }
        catch (error) { status(error.message); return; }
        if (editingRecord && field('syncMediaFiles').checked) {
            const previous = editingRecord.sourceRecord || editingRecord;
            const files = ['photo', 'video'].flatMap(type => {
                const folder = `${type}_folder`;
                const list = `${type}s`;
                const remaining = new Set([prepared.record, ...getRecords()
                    .map(record => record.sourceRecord || record)
                    .filter(record => record.desc_md !== previous.desc_md)]
                    .flatMap(record => (record[list] || []).map(name => `${record[folder]}/${name}`)));
                return [...new Set(previous[list] || [])]
                    .map(name => ({
                        path: `${previous[folder]}/${name}`,
                        destination: (prepared.record[list] || []).includes(name) ? `${prepared.record[folder]}/${name}` : ''
                    }))
                    .filter(file => !remaining.has(file.path));
            });
            if (files.length) {
                busy = true;
                try {
                    if (!await confirmFeedback('请核对下方文件。移除的原文件会存入回收站；移动的文件也会保留在新目录中。', {
                        label: '文件管理', title: '确认文件变更', cancelLabel: '返回编辑', confirmLabel: '确认变更并保存', files
                    })) return;
                } finally { busy = false; }
            }
        }
        busy = true;
        archivePhase = '正在校验并打包待上传媒体…';
        startProgress('保存旅行记录', archivePhase);
        dialog.querySelector('[data-editor-rich]').contentEditable = 'false';
        dialog.querySelector('[data-editor-source]').readOnly = true;
        dialog.querySelectorAll('[name], [data-media-select], [data-media-removed-select], button:not([data-progress-cancel])').forEach(control => { control.disabled = true; });
        status('正在保存旅行记录…');
        try {
            const customMediaOrder = ['photos', 'videos'].some(type => draft.mediaOrder[type].some((index, position) => index !== position));
            const mixedMediaOrder = draft.mediaOrder.sequence.includes('photo') && draft.mediaOrder.sequence.includes('video');
            if ((editingRecord && field('syncMediaFiles').checked) || customMediaOrder || mixedMediaOrder) {
                const capability = await detectWriterCapability();
                if (editingRecord && field('syncMediaFiles').checked && !capability.syncMediaFiles) throw new Error('当前服务尚未支持真实媒体文件同步，请重新启动服务后再保存。');
                if (mixedMediaOrder && !capability.mixedMediaOrder) throw new Error('当前服务尚未支持图片与视频统一排序，请重新启动服务后再保存。草稿和顺序仍保留。');
                if (customMediaOrder && !capability.mediaOrder) throw new Error('当前服务尚未支持新旧文件混合排序，请重新启动服务后再保存。草稿和顺序仍保留。');
            }
            const archive = await createDraftBlob(draft, editingRecord ? {
                originalDescMd: editingRecord.desc_md,
                syncMediaFiles: field('syncMediaFiles').checked,
                expected: { record: editingRecord.sourceRecord || editingRecord, markdown: editingRecord.descMarkdown }
            } : {}, archiveProgress);
            operationProgress.throwIfCancelled();
            operationProgress.phase('正在上传旅行记录和媒体…');
            const response = await uploadWithProgress(new URL('api/travel-records', window.location.href), {
                method: editingRecord ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/zip', 'X-Travel-Token': token },
                credentials: 'same-origin',
                body: archive,
                timeout: 8 * 60 * 60 * 1000,
                signal: operationProgress.signal,
            }, (loaded, total) => operationProgress.update(loaded, total, '正在上传旅行记录和媒体…'),
            () => {
                operationProgress.setCancelable(false);
                operationProgress.phase('上传完成，服务器正在校验并保存记录…');
            });
            const result = await response.json();
            if (!response.ok || !result.saved) throw Object.assign(new Error(result.error || '未收到服务器的成功响应。'), { code: result.code });
            saved = true;
            for (const type of ['photo', 'video']) {
                for (const [index, item] of orderedMedia(type).entries()) {
                    const previewUrl = item.upload && photoPreviewUrls.get(item.upload.id);
                    if (!previewUrl) continue;
                    try {
                        const preview = await fetch(previewUrl).then(response => response.blob());
                        await saveMediaPreview(getMediaFileUrl(`${result.record[`${type}_folder`]}/${result.record[`${type}s`][index]}`), preview);
                    } catch { /* 记录已保存，缓存失败时保留占位，可用批量命令补齐。 */ }
                }
            }
            removedMedia = [];
            selectedMedia.clear();
            selectedRemovedMedia.clear();
            dirty = false;
            status(`${editingRecord ? '修改' : '记录'}已保存并更新旅行索引：${result.record.desc_md}`);
            operationProgress.phase('记录已保存，正在刷新旅行档案…');
            try { await onSaved(result.record, { mode: editingRecord ? 'edit' : 'create', originalRecord: editingRecord }); }
            catch { status(`记录已保存：${result.record.desc_md}。页面数据刷新失败，请手动刷新后查看。`); }
            operationProgress.complete('记录和媒体已保存。');
        } catch (error) {
            if (error.code === 'DUPLICATE_MEDIA') {
                const message = `${error.message} 请移除重复文件后保存。`;
                status(message);
                operationProgress.remove();
                showFeedback(message, { label: '媒体上传', title: '文件重复' });
            } else {
                status(operationProgress.signal.aborted ? '保存已取消，草稿仍在本页。' : `保存结果未确认：${error.message} 草稿仍在本页，可导出或重试。`);
                operationProgress.fail(error);
            }
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
            renderExistingMedia();
        }
    });
    window.addEventListener('beforeunload', event => {
        if (!dirty && !busy && !readingPhotos) return;
        event.preventDefault();
        event.returnValue = '';
    });

    async function confirmDiscard(record = null) {
        if (record?.descLoadFailed) throw new Error('这篇日记的正文加载失败，暂时不能安全修改。请修复正文文件后重试。');
        const requestedRecordKey = record ? `record:${record.desc_md || record.id || ''}` : 'new';
        const currentRecordKey = editingRecord ? `record:${editingRecord.desc_md || editingRecord.id || ''}` : 'new';
        if (!initialized || saved || !dirty || requestedRecordKey === currentRecordKey) return true;
        return confirmFeedback('打开另一条记录会清空当前未保存内容，且无法撤销。需要保留时，请取消并导出草稿。', {
            label: '编辑器',
            title: '编辑器中有未保存内容',
            cancelLabel: '取消',
            confirmLabel: '继续验证'
        });
    }

    const openEditor = async (record = null, writerAccess = null, discardConfirmed = false) => {
        if (dialog.open || opening) return;
        opening = true;
        try {
            if (!discardConfirmed && !await confirmDiscard(record)) return;
            if (record?.descLoadFailed) throw new Error('这篇日记的正文加载失败，暂时不能安全修改。请修复正文文件后重试。');
            trigger = document.activeElement;
            const requestedRecordKey = record ? `record:${record.desc_md || record.id || ''}` : 'new';
            const currentRecordKey = editingRecord ? `record:${editingRecord.desc_md || editingRecord.id || ''}` : 'new';
            const shouldRender = !initialized || saved || requestedRecordKey !== currentRecordKey;
            if (shouldRender) {
                if (!countries.length) {
                    const [countryResponse, chinaLocationResponse] = await Promise.all([
                        fetch(new URL('assets/catalogs/countries.json', window.location.href), { signal: AbortSignal.timeout(20000) }),
                        fetch(new URL('assets/catalogs/china-locations.json', window.location.href), { signal: AbortSignal.timeout(20000) })
                    ]);
                    if (!countryResponse.ok || !chinaLocationResponse.ok) throw new Error('地点目录加载失败，请刷新后重试。');
                    const countryCatalog = await countryResponse.json();
                    const locationCatalog = await chinaLocationResponse.json();
                    if (!Array.isArray(countryCatalog?.countries) || !countryCatalog.countries.length
                        || !Array.isArray(locationCatalog?.provinces)) {
                        throw new Error('地点目录格式无效，请检查目录文件后重试。');
                    }
                    countries = countryCatalog.countries;
                    chinaLocations = locationCatalog;
                }
                render(record);
                initialized = true;
            }
            dialog.showModal();
            await detectWriter(writerAccess);
        } finally {
            opening = false;
        }
    };
    openEditor.beforePrompt = record => {
        if (dialog.open || opening) return Promise.resolve(false);
        return confirmDiscard(record);
    };
    return openEditor;
}
