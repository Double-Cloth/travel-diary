import { showFeedback } from './feedback-dialog.js';
import { authenticateWriter } from './writer-capability.js?v=20260913-server-auth-v1';

let passwordGateSequence = 0;

function passwordFormMarkup(titleId) {
    return `
        <form class="record-password-card" method="dialog" data-password-form>
            <button class="paper-button record-password-close" type="button" data-password-close aria-label="关闭密码窗口">关闭</button>
            <div class="record-password-seal" aria-hidden="true">
                <svg viewBox="0 0 32 32" focusable="false">
                    <path d="M10 14v-3a6 6 0 1 1 12 0v3"></path>
                    <rect x="7" y="14" width="18" height="14" rx="2"></rect>
                    <path d="M16 19v4"></path>
                </svg>
            </div>
            <h2 id="${titleId}"></h2>
            <p class="record-password-note" data-password-note></p>
            <label class="record-password-field">
                <span>访问口令</span>
                <input type="password" name="password" autocomplete="current-password"
                    minlength="1" maxlength="128" required data-password-input>
            </label>
            <p class="record-password-status" data-password-status aria-live="assertive"></p>
            <button class="paper-button record-password-submit" type="submit" data-password-submit>验证并继续</button>
        </form>`;
}

export function createPasswordGate(onVerified, options = {}) {
    const titleId = `passwordGateTitle${passwordGateSequence += 1}`;
    const copy = {
        title: options.title || '访问验证',
        description: options.description || '输入服务器访问口令后继续。',
        verifying: options.verifying || '正在安全验证…',
        actionError: options.actionError || '操作未完成，请重试。'
    };
    const dialog = document.createElement('dialog');
    dialog.className = 'record-password entry-sheet';
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.innerHTML = passwordFormMarkup(titleId);
    document.body.append(dialog);
    dialog.querySelector(`#${titleId}`).textContent = copy.title;
    dialog.querySelector('[data-password-note]').textContent = copy.description;
    const form = dialog.querySelector('[data-password-form]');
    const input = dialog.querySelector('[data-password-input]');
    const submit = dialog.querySelector('[data-password-submit]');
    const status = message => { dialog.querySelector('[data-password-status]').textContent = message; };
    let verifying = false;
    let trigger;

    function restoreTriggerFocus() {
        if (trigger?.isConnected) trigger.focus();
        else document.querySelector('[data-action="add-record"]')?.focus();
    }

    function close() {
        if (verifying) return;
        dialog.close();
        input.value = '';
        status('');
        restoreTriggerFocus();
    }

    async function verify() {
        if (verifying || !input.value) return;
        verifying = true;
        input.disabled = true;
        submit.disabled = true;
        status(copy.verifying);
        let capability;
        try {
            capability = await authenticateWriter(input.value);
        } catch (error) {
            status(error?.message || '访问口令验证失败。');
            dialog.classList.remove('record-password-error');
            requestAnimationFrame(() => dialog.classList.add('record-password-error'));
            input.select();
            if (error?.code === 'WRITER_UNAVAILABLE') {
                void showFeedback(error.message, { label: '访问验证', title: '当前站点为只读模式' });
            }
            return;
        } finally {
            verifying = false;
            input.disabled = false;
            submit.disabled = false;
            if (dialog.open) input.focus();
        }
        input.value = '';
        dialog.close();
        restoreTriggerFocus();
        try {
            await onVerified(capability);
        } catch (error) {
            void showFeedback(error?.message || copy.actionError, { label: '访问验证', title: '操作未完成' });
        }
    }

    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        close();
    });
    dialog.addEventListener('click', event => {
        if (event.target.closest('[data-password-close]')) close();
    });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    form.addEventListener('submit', event => {
        event.preventDefault();
        void verify();
    });

    return async () => {
        if (dialog.open || verifying) return;
        trigger = document.activeElement;
        input.value = '';
        status('');
        dialog.showModal();
        input.focus();
    };
}
