import { showFeedback } from './feedback-dialog.js';
import { authenticateWriter } from './writer-capability.js?v=20260913-server-auth-v2';

const PASSWORD_LENGTH = 6;
let passwordGateSequence = 0;

function passwordKeypadMarkup(titleId) {
    return `
        <div class="record-password-card">
            <button class="paper-button record-password-close" type="button" data-password-close aria-label="关闭密码窗口">关闭</button>
            <div class="record-password-seal" aria-hidden="true">
                <svg viewBox="0 0 32 32" focusable="false">
                    <path d="M10 14v-3a6 6 0 0 1 12 0v3"></path>
                    <rect x="7" y="14" width="18" height="14" rx="2"></rect>
                    <path d="M16 19v4"></path>
                </svg>
            </div>
            <h2 id="${titleId}"></h2>
            <p class="record-password-note" data-password-note></p>
            <div class="record-password-digits" data-password-digits role="status" aria-live="polite" aria-label="尚未输入密码">
                ${Array.from({ length: PASSWORD_LENGTH }, (_, index) => `<span data-password-digit="${index}" aria-hidden="true"></span>`).join('')}
            </div>
            <p class="record-password-status" data-password-status aria-live="assertive"></p>
            <div class="record-password-keypad" data-password-keypad role="group" aria-label="数字键盘">
                ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(number => `<button type="button" data-password-key="${number}" aria-label="数字 ${number}">${number}</button>`).join('')}
                <button class="record-password-command" type="button" data-password-clear aria-label="清除全部密码">清除</button>
                <button type="button" data-password-key="0" aria-label="数字 0">0</button>
                <button class="record-password-command record-password-delete" type="button" data-password-delete aria-label="删除上一位">
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 7-5 5 5 5h10V7H9Z"></path><path d="m12 10 4 4m0-4-4 4"></path></svg>
                </button>
            </div>
        </div>`;
}

export function createPasswordGate(onVerified, options = {}) {
    const titleId = `passwordGateTitle${passwordGateSequence += 1}`;
    const copy = {
        title: options.title || '访问验证',
        description: options.description || '输入 6 位数字密码后继续。',
        verifying: options.verifying || '正在安全验证…',
        actionError: options.actionError || '操作未完成，请重试。'
    };
    const dialog = document.createElement('dialog');
    dialog.className = 'record-password entry-sheet';
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.innerHTML = passwordKeypadMarkup(titleId);
    document.body.append(dialog);
    dialog.querySelector(`#${titleId}`).textContent = copy.title;
    dialog.querySelector('[data-password-note]').textContent = copy.description;

    let enteredPassword = '';
    let verifying = false;
    let trigger;
    const status = message => { dialog.querySelector('[data-password-status]').textContent = message; };

    function setControlsDisabled(disabled) {
        dialog.querySelectorAll('[data-password-key], [data-password-clear], [data-password-delete]')
            .forEach(button => { button.disabled = disabled; });
    }

    function updateDigits() {
        dialog.querySelectorAll('[data-password-digit]').forEach((slot, index) => {
            slot.classList.toggle('is-filled', index < enteredPassword.length);
        });
        dialog.querySelector('[data-password-digits]').setAttribute(
            'aria-label',
            enteredPassword.length ? `已输入 ${enteredPassword.length} 位密码` : '尚未输入密码'
        );
    }

    function reset(message = '') {
        enteredPassword = '';
        dialog.classList.remove('record-password-error');
        status(message);
        updateDigits();
    }

    function restoreTriggerFocus() {
        if (trigger?.isConnected) trigger.focus();
        else document.querySelector('[data-action="add-record"]')?.focus();
    }

    function close() {
        if (verifying) return;
        dialog.close();
        reset();
        restoreTriggerFocus();
    }

    function showError(message) {
        reset(message || '密码不正确，请重新输入。');
        dialog.classList.remove('record-password-error');
        requestAnimationFrame(() => dialog.classList.add('record-password-error'));
    }

    async function verify() {
        if (verifying || enteredPassword.length !== PASSWORD_LENGTH) return;
        const password = enteredPassword;
        verifying = true;
        setControlsDisabled(true);
        status(copy.verifying);
        let capability;
        try {
            capability = await authenticateWriter(password);
        } catch (error) {
            showError(error?.message || '访问密码验证失败。');
            if (error?.code === 'WRITER_UNAVAILABLE') {
                void showFeedback(error.message, { label: '访问验证', title: '当前站点为只读模式' });
            }
            return;
        } finally {
            verifying = false;
            setControlsDisabled(false);
            if (dialog.open) dialog.querySelector('[data-password-key]')?.focus();
        }
        dialog.close();
        reset();
        restoreTriggerFocus();
        try {
            await onVerified(capability);
        } catch (error) {
            void showFeedback(error?.message || copy.actionError, { label: '访问验证', title: '操作未完成' });
        }
    }

    function enterDigit(digit) {
        if (verifying || enteredPassword.length >= PASSWORD_LENGTH) return;
        dialog.classList.remove('record-password-error');
        status('');
        enteredPassword += digit;
        updateDigits();
        if (enteredPassword.length === PASSWORD_LENGTH) void verify();
    }

    function deleteDigit() {
        if (verifying || !enteredPassword.length) return;
        dialog.classList.remove('record-password-error');
        status('');
        enteredPassword = enteredPassword.slice(0, -1);
        updateDigits();
    }

    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        close();
    });

    dialog.addEventListener('click', event => {
        const digitButton = event.target.closest('[data-password-key]');
        if (digitButton) enterDigit(digitButton.dataset.passwordKey);
        if (event.target.closest('[data-password-delete]')) deleteDigit();
        if (event.target.closest('[data-password-clear]')) reset();
        if (event.target.closest('[data-password-close]')) close();
    });

    dialog.addEventListener('keydown', event => {
        if (/^\d$/.test(event.key)) {
            event.preventDefault();
            enterDigit(event.key);
        } else if (event.key === 'Backspace' || event.key === 'Delete') {
            event.preventDefault();
            deleteDigit();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            void verify();
        }
        event.stopPropagation();
    });

    return async () => {
        if (dialog.open || verifying) return;
        trigger = document.activeElement;
        reset();
        dialog.showModal();
        dialog.querySelector('[data-password-key]')?.focus();
    };
}
