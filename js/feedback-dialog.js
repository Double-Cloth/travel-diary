let feedbackDialog;
let feedbackResolver;
let feedbackTrigger;

function getFeedbackDialog() {
    if (feedbackDialog) return feedbackDialog;

    feedbackDialog = document.createElement('dialog');
    feedbackDialog.className = 'feedback-dialog entry-sheet';
    feedbackDialog.setAttribute('aria-labelledby', 'feedbackDialogTitle');
    feedbackDialog.setAttribute('aria-describedby', 'feedbackDialogMessage');
    feedbackDialog.innerHTML = `
        <div class="feedback-dialog-card">
            <div class="feedback-dialog-seal" aria-hidden="true">
                <svg viewBox="0 0 32 32" focusable="false">
                    <circle cx="16" cy="16" r="12"></circle>
                    <path d="M16 14v7"></path>
                    <path d="M16 10h.01"></path>
                </svg>
            </div>
            <p class="journal-label" data-feedback-label>旅行档案</p>
            <h2 id="feedbackDialogTitle" data-feedback-title>操作提示</h2>
            <p class="feedback-dialog-message" id="feedbackDialogMessage" data-feedback-message></p>
            <div class="feedback-dialog-guide" data-feedback-guide hidden></div>
            <div class="feedback-dialog-actions">
                <button class="paper-button feedback-dialog-cancel" type="button" data-feedback-cancel>取消</button>
                <button class="paper-button feedback-dialog-confirm" type="button" data-feedback-confirm>知道了</button>
            </div>
        </div>`;
    document.body.append(feedbackDialog);

    const finish = confirmed => {
        if (!feedbackResolver) return;
        const resolve = feedbackResolver;
        feedbackResolver = null;
        feedbackDialog.close();
        if (feedbackTrigger?.isConnected) feedbackTrigger.focus();
        resolve(confirmed);
    };

    feedbackDialog.addEventListener('cancel', event => {
        event.preventDefault();
        finish(false);
    });

    feedbackDialog.addEventListener('click', event => {
        if (event.target.closest('[data-feedback-cancel]')) finish(false);
        if (event.target.closest('[data-feedback-confirm]')) finish(true);
    });

    feedbackDialog.addEventListener('keydown', event => {
        event.stopPropagation();
    });

    return feedbackDialog;
}

function openFeedback(message, options = {}) {
    const dialog = getFeedbackDialog();
    if (dialog.open || feedbackResolver) return Promise.resolve(false);

    const isConfirmation = Boolean(options.confirm);
    feedbackTrigger = document.activeElement;
    dialog.querySelector('[data-feedback-label]').textContent = options.label || '旅行档案';
    dialog.querySelector('[data-feedback-title]').textContent = options.title || (isConfirmation ? '请确认操作' : '操作提示');
    dialog.querySelector('[data-feedback-message]').textContent = message || '';
    const guide = dialog.querySelector('[data-feedback-guide]');
    const hasSteps = Array.isArray(options.steps) && options.steps.length > 0;
    guide.hidden = !hasSteps;
    dialog.classList.toggle('feedback-dialog-with-guide', hasSteps);
    if (hasSteps) {
        const list = document.createElement('ol');
        for (const step of options.steps) {
            const item = document.createElement('li');
            const title = document.createElement('h3');
            title.textContent = step.title;
            const description = document.createElement('p');
            description.textContent = step.description;
            item.append(title, description);
            if (step.command) {
                const block = document.createElement('pre');
                const command = document.createElement('code');
                command.textContent = step.command;
                block.append(command);
                item.append(block);
            }
            list.append(item);
        }
        guide.replaceChildren(list);
        if (options.note) {
            const note = document.createElement('p');
            note.className = 'feedback-dialog-guide-note';
            note.textContent = options.note;
            guide.append(note);
        }
    }
    dialog.querySelector('[data-feedback-cancel]').textContent = options.cancelLabel || '取消';
    dialog.querySelector('[data-feedback-cancel]').hidden = !isConfirmation;
    dialog.querySelector('[data-feedback-confirm]').textContent = options.confirmLabel || (isConfirmation ? '确认' : '知道了');
    dialog.classList.toggle('feedback-dialog-confirmation', isConfirmation);

    return new Promise(resolve => {
        feedbackResolver = resolve;
        dialog.showModal();
        if (hasSteps) {
            const title = dialog.querySelector('[data-feedback-title]');
            title.tabIndex = -1;
            title.focus({ preventScroll: true });
            dialog.scrollTop = 0;
        } else {
            dialog.querySelector(isConfirmation ? '[data-feedback-cancel]' : '[data-feedback-confirm]').focus();
        }
    });
}

export function showFeedback(message, options = {}) {
    return openFeedback(message, options);
}

export function confirmFeedback(message, options = {}) {
    return openFeedback(message, { ...options, confirm: true });
}
