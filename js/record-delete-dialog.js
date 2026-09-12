export function createRecordDeleteDialog() {
    const dialog = document.createElement('dialog');
    dialog.className = 'record-delete-dialog entry-sheet';
    dialog.setAttribute('aria-labelledby', 'recordDeleteDialogTitle');
    dialog.setAttribute('aria-describedby', 'recordDeleteDialogDescription');
    dialog.innerHTML = `
        <div class="record-delete-dialog-card">
            <div class="record-delete-dialog-seal" aria-hidden="true">
                <svg data-delete-warning-icon viewBox="0 0 32 32" focusable="false">
                    <path d="M16 4 29 27H3L16 4Z"></path>
                    <path d="M16 11v8"></path>
                    <path d="M16 23h.01"></path>
                </svg>
                <svg data-delete-success-icon viewBox="0 0 32 32" focusable="false">
                    <circle cx="16" cy="16" r="12"></circle>
                    <path d="m9.5 16.5 4.2 4.2 8.8-9.4"></path>
                </svg>
                <svg data-delete-error-icon viewBox="0 0 32 32" focusable="false">
                    <circle cx="16" cy="16" r="12"></circle>
                    <path d="m11.5 11.5 9 9m0-9-9 9"></path>
                </svg>
            </div>
            <p class="journal-label">记录管理</p>
            <h2 id="recordDeleteDialogTitle" data-delete-dialog-title></h2>
            <p class="record-delete-dialog-note" id="recordDeleteDialogDescription" data-delete-dialog-description></p>
            <p class="record-delete-dialog-record" data-delete-dialog-record>即将删除 <strong data-delete-record-title></strong></p>
            <div class="record-delete-dialog-actions" data-delete-confirm-actions>
                <button class="paper-button" type="button" data-delete-cancel>暂不删除</button>
                <button class="paper-button record-delete-dialog-submit" type="button" data-delete-confirm>确认删除</button>
            </div>
            <div class="record-delete-dialog-actions" data-delete-result-actions hidden>
                <button class="paper-button record-delete-dialog-close" type="button" data-delete-close>完成</button>
            </div>
        </div>`;
    document.body.append(dialog);

    const title = dialog.querySelector('[data-delete-dialog-title]');
    const description = dialog.querySelector('[data-delete-dialog-description]');
    const recordSummary = dialog.querySelector('[data-delete-dialog-record]');
    const recordTitle = dialog.querySelector('[data-delete-record-title]');
    const confirmActions = dialog.querySelector('[data-delete-confirm-actions]');
    const resultActions = dialog.querySelector('[data-delete-result-actions]');
    let confirmationResolver;
    let trigger;

    function restoreTriggerFocus() {
        if (trigger?.isConnected) trigger.focus();
        else document.getElementById('journalStage')?.focus();
    }

    function closeDialog() {
        if (!dialog.open) return;
        dialog.close();
        restoreTriggerFocus();
    }

    function finishConfirmation(confirmed) {
        if (!confirmationResolver) return;
        const resolve = confirmationResolver;
        confirmationResolver = null;
        closeDialog();
        resolve(confirmed);
    }

    function setMode(mode) {
        const isConfirmation = mode === 'confirm';
        dialog.classList.toggle('record-delete-dialog-result', !isConfirmation);
        dialog.classList.toggle('record-delete-dialog-success', mode === 'success');
        dialog.classList.toggle('record-delete-dialog-error', mode === 'error');
        recordSummary.hidden = !isConfirmation;
        confirmActions.hidden = !isConfirmation;
        resultActions.hidden = isConfirmation;
    }

    function confirm(record) {
        if (dialog.open || confirmationResolver) return Promise.resolve(false);
        trigger = document.activeElement;
        setMode('confirm');
        title.textContent = '确定删除这条旅行记录？';
        description.textContent = '旅行索引和 Markdown 正文将被永久删除，照片文件会保留。此操作无法撤销。';
        recordTitle.textContent = `“${record.title}”`;
        return new Promise(resolve => {
            confirmationResolver = resolve;
            dialog.showModal();
            dialog.querySelector('[data-delete-cancel]')?.focus();
        });
    }

    function showResult(mode, heading, message) {
        if (dialog.open) closeDialog();
        trigger = document.activeElement;
        setMode(mode);
        title.textContent = heading;
        description.textContent = message;
        dialog.showModal();
        dialog.querySelector('[data-delete-close]')?.focus();
    }

    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        if (confirmationResolver) finishConfirmation(false);
        else closeDialog();
    });

    dialog.addEventListener('click', event => {
        if (event.target.closest('[data-delete-cancel]')) finishConfirmation(false);
        if (event.target.closest('[data-delete-confirm]')) finishConfirmation(true);
        if (event.target.closest('[data-delete-close]')) closeDialog();
    });

    dialog.addEventListener('keydown', event => {
        event.stopPropagation();
    });

    return {
        confirm,
        showSuccess(record) {
            showResult('success', '记录已删除', `旅行记录“${record.title}”已删除，相关照片文件仍然保留。`);
        },
        showError(error) {
            showResult('error', '删除未完成', error?.message || '删除记录失败，请重试。');
        }
    };
}
