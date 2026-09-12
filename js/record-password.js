import { showFeedback } from './feedback-dialog.js';

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

export function readRecordPassword(config) {
    const password = typeof config === 'string' ? config : config?.password;
    if (typeof password !== 'string' || !/^\d{6}$/.test(password)) {
        throw new Error('访问密码配置无效，密码必须是 6 位数字。');
    }
    return password;
}

export function createPasswordGate(onVerified, options = {}) {
    const titleId = `passwordGateTitle${passwordGateSequence += 1}`;
    const copy = {
        title: options.title || '访问验证',
        description: options.description || '输入 6 位数字密码后继续。',
        verifying: options.verifying || '验证成功，正在继续…',
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
    let expectedPassword = '';
    let loading = false;
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
        expectedPassword = '';
        reset();
        restoreTriggerFocus();
    }

    function showError() {
        reset('密码不正确，请重新输入。');
        dialog.classList.remove('record-password-error');
        requestAnimationFrame(() => dialog.classList.add('record-password-error'));
    }

    async function verify() {
        if (verifying || loading || enteredPassword.length !== PASSWORD_LENGTH) return;
        if (enteredPassword !== expectedPassword) {
            showError();
            return;
        }
        const verifiedPassword = enteredPassword;
        verifying = true;
        setControlsDisabled(true);
        status(copy.verifying);
        dialog.close();
        expectedPassword = '';
        enteredPassword = '';
        updateDigits();
        restoreTriggerFocus();
        try {
            await onVerified(verifiedPassword);
        } catch (error) {
            void showFeedback(error?.message || copy.actionError, {
                label: '访问验证',
                title: '操作未完成'
            });
        } finally {
            verifying = false;
            setControlsDisabled(false);
            status('');
        }
    }

    function enterDigit(digit) {
        if (loading || verifying || enteredPassword.length >= PASSWORD_LENGTH) return;
        dialog.classList.remove('record-password-error');
        status('');
        enteredPassword += digit;
        updateDigits();
        if (enteredPassword.length === PASSWORD_LENGTH) void verify();
    }

    function deleteDigit() {
        if (loading || verifying || !enteredPassword.length) return;
        dialog.classList.remove('record-password-error');
        status('');
        enteredPassword = enteredPassword.slice(0, -1);
        updateDigits();
    }

    async function loadPassword() {
        loading = true;
        setControlsDisabled(true);
        status('正在读取访问设置…');
        try {
            const response = await fetch(new URL('data/password.json', window.location.href), {
                cache: 'no-store',
                signal: AbortSignal.timeout(4000)
            });
            if (!response.ok) throw new Error('无法读取访问密码。');
            expectedPassword = readRecordPassword(await response.json());
            status('');
            setControlsDisabled(false);
            dialog.querySelector('[data-password-key]')?.focus();
        } catch (error) {
            expectedPassword = '';
            status(error?.message || '访问密码读取失败，请刷新后重试。');
        } finally {
            loading = false;
        }
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
        await loadPassword();
    };
}

export function createPasswordSetup(options = {}) {
    const titleId = `passwordGateTitle${passwordGateSequence += 1}`;
    const copy = {
        title: options.title || '设置访问密码',
        description: options.description || '备份中未包含访问密码，请设置 6 位数字密码。',
        confirmation: options.confirmation || '请再次输入相同密码以确认。'
    };
    const dialog = document.createElement('dialog');
    dialog.className = 'record-password entry-sheet';
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.innerHTML = passwordKeypadMarkup(titleId);
    document.body.append(dialog);
    dialog.querySelector(`#${titleId}`).textContent = copy.title;
    dialog.querySelector('[data-password-note]').textContent = copy.description;

    let enteredPassword = '';
    let firstPassword = '';
    let resolver;
    let trigger;

    const status = message => { dialog.querySelector('[data-password-status]').textContent = message; };

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
        else document.querySelector('[data-action="import-all-data"]')?.focus();
    }

    function finish(password = null) {
        if (!resolver) return;
        const resolve = resolver;
        resolver = null;
        dialog.close();
        firstPassword = '';
        reset();
        restoreTriggerFocus();
        resolve(password);
    }

    function showMismatch() {
        firstPassword = '';
        reset('两次输入不一致，请重新设置。');
        dialog.querySelector('[data-password-note]').textContent = copy.description;
        dialog.classList.remove('record-password-error');
        requestAnimationFrame(() => dialog.classList.add('record-password-error'));
    }

    function submit() {
        if (enteredPassword.length !== PASSWORD_LENGTH) return;
        if (!firstPassword) {
            firstPassword = enteredPassword;
            dialog.querySelector('[data-password-note]').textContent = copy.confirmation;
            reset();
            return;
        }
        if (enteredPassword !== firstPassword) {
            showMismatch();
            return;
        }
        finish(enteredPassword);
    }

    function enterDigit(digit) {
        if (enteredPassword.length >= PASSWORD_LENGTH) return;
        dialog.classList.remove('record-password-error');
        status('');
        enteredPassword += digit;
        updateDigits();
        if (enteredPassword.length === PASSWORD_LENGTH) submit();
    }

    function deleteDigit() {
        if (!enteredPassword.length) return;
        dialog.classList.remove('record-password-error');
        status('');
        enteredPassword = enteredPassword.slice(0, -1);
        updateDigits();
    }

    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        finish();
    });

    dialog.addEventListener('click', event => {
        const digitButton = event.target.closest('[data-password-key]');
        if (digitButton) enterDigit(digitButton.dataset.passwordKey);
        if (event.target.closest('[data-password-delete]')) deleteDigit();
        if (event.target.closest('[data-password-clear]')) reset();
        if (event.target.closest('[data-password-close]')) finish();
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
            submit();
        }
        event.stopPropagation();
    });

    return () => {
        if (dialog.open || resolver) return Promise.resolve(null);
        trigger = document.activeElement;
        firstPassword = '';
        dialog.querySelector('[data-password-note]').textContent = copy.description;
        reset();
        dialog.showModal();
        dialog.querySelector('[data-password-key]')?.focus();
        return new Promise(resolve => { resolver = resolve; });
    };
}
