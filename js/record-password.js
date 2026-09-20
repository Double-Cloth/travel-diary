import { showFeedback } from './feedback-dialog.js';
import { authenticateWriter, changeWriterPassword, initializeWriterPassword, probeWriterService } from './writer-capability.js?v=20260920-password-change-v1';

const PASSWORD_LENGTH = 6;
let passwordGateSequence = 0;

function authConfigurationFeedback(error) {
    if (error?.code !== 'AUTH_NOT_PRODUCTION_READY' && !error?.code?.startsWith('AUTH_CONFIG_')) return null;
    const repairHint = '请在项目根目录运行 npm run auth:set 重新创建密码配置。';
    const needsRepair = error.code === 'AUTH_CONFIG_INVALID' || error.code === 'AUTH_NOT_PRODUCTION_READY';
    return {
        label: '密码配置',
        title: error.code === 'AUTH_CONFIG_MISSING'
            ? '密码配置缺失'
            : (error.code === 'AUTH_CONFIG_UNREADABLE' ? '无法读取密码配置' : '密码配置无效'),
        message: needsRepair && !error.message.includes('npm run auth:set')
            ? `${error.message} ${repairHint}`
            : error.message
    };
}

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
        actionError: options.actionError || '操作未完成，请重试。',
        staticMessage: options.staticMessage || '当前站点为静态只读页面，无法执行此操作。'
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
    let mode = 'login';
    let probing = false;
    let verifying = false;
    let trigger;
    let pendingContext;
    const status = message => { dialog.querySelector('[data-password-status]').textContent = message; };

    function updatePrompt() {
        const prompt = mode === 'setup-first'
            ? { title: '未设置访问密码，请先创建密码', description: '请输入新的 6 位数字密码。' }
            : mode === 'setup-confirm'
                ? { title: '再次输入密码', description: '请再次输入相同的 6 位数字密码。' }
                : copy;
        dialog.querySelector(`#${titleId}`).textContent = prompt.title;
        dialog.querySelector('[data-password-note]').textContent = prompt.description;
    }

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
        firstPassword = '';
        mode = 'login';
        updatePrompt();
        pendingContext = undefined;
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
        if (mode === 'setup-first') {
            firstPassword = password;
            mode = 'setup-confirm';
            updatePrompt();
            reset();
            dialog.querySelector('[data-password-key]')?.focus();
            return;
        }
        if (mode === 'setup-confirm' && password !== firstPassword) {
            firstPassword = '';
            mode = 'setup-first';
            updatePrompt();
            showError('两次输入的密码不一致，请重新设置。');
            return;
        }
        verifying = true;
        setControlsDisabled(true);
        status(mode === 'setup-confirm' ? '正在安全创建访问密码…' : copy.verifying);
        let capability;
        try {
            capability = mode === 'setup-confirm'
                ? await initializeWriterPassword(password)
                : await authenticateWriter(password);
        } catch (error) {
            const feedback = authConfigurationFeedback(error);
            if (feedback) {
                dialog.close();
                reset();
                pendingContext = undefined;
                restoreTriggerFocus();
                void showFeedback(feedback.message, feedback);
                return;
            }
            if (mode === 'setup-confirm') {
                firstPassword = '';
                mode = error?.code === 'AUTH_SETUP_ALREADY_COMPLETE' ? 'login' : 'setup-first';
                updatePrompt();
            }
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
        firstPassword = '';
        mode = 'login';
        updatePrompt();
        const verifiedContext = pendingContext;
        pendingContext = undefined;
        restoreTriggerFocus();
        try {
            await onVerified(capability, verifiedContext);
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

    return async context => {
        if (dialog.open || probing || verifying) return;
        trigger = document.activeElement;
        probing = true;
        let setupRequired = false;
        try {
            await probeWriterService();
        } catch (error) {
            if (error?.code === 'AUTH_SETUP_REQUIRED') {
                setupRequired = true;
            } else {
                const feedback = authConfigurationFeedback(error);
                if (feedback) {
                    void showFeedback(feedback.message, feedback);
                    return;
                }
                if (error?.code === 'STATIC_READONLY') {
                    if (typeof options.onStatic === 'function') {
                        try { await options.onStatic(context); }
                        catch (staticError) {
                            void showFeedback(staticError?.message || copy.actionError, { label: '只读模式', title: '操作未完成' });
                        }
                    } else {
                        void showFeedback(copy.staticMessage, { label: '只读模式', title: '当前站点为静态页面' });
                    }
                    return;
                }
                void showFeedback(error?.message || copy.actionError, { label: '访问验证', title: '服务暂不可用' });
                return;
            }
        } finally {
            probing = false;
        }
        if (typeof options.beforePrompt === 'function' && !await options.beforePrompt(context)) return;
        pendingContext = context;
        firstPassword = '';
        mode = setupRequired ? 'setup-first' : 'login';
        updatePrompt();
        reset();
        dialog.showModal();
        dialog.querySelector('[data-password-key]')?.focus();
    };
}

export function createPasswordChangeDialog(onChanged) {
    const titleId = `passwordChangeTitle${passwordGateSequence += 1}`;
    const dialog = document.createElement('dialog');
    dialog.className = 'record-password entry-sheet';
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.innerHTML = passwordKeypadMarkup(titleId);
    document.body.append(dialog);

    let enteredPassword = '';
    let firstPassword = '';
    let capability;
    let trigger;
    let mode = 'new';
    let submitting = false;
    const title = dialog.querySelector(`#${titleId}`);
    const note = dialog.querySelector('[data-password-note]');
    const status = message => { dialog.querySelector('[data-password-status]').textContent = message; };

    function updatePrompt() {
        const prompt = mode === 'confirm'
            ? { title: '再次输入新密码', description: '输入到第 6 位后将自动提交修改。' }
            : { title: '设置新访问密码', description: '请输入新的 6 位数字密码，不能使用连续、重复或常见组合。' };
        title.textContent = prompt.title;
        note.textContent = prompt.description;
    }

    function updateDigits() {
        dialog.querySelectorAll('[data-password-digit]').forEach((slot, index) => {
            slot.classList.toggle('is-filled', index < enteredPassword.length);
        });
        dialog.querySelector('[data-password-digits]').setAttribute(
            'aria-label',
            enteredPassword.length ? `已输入 ${enteredPassword.length} 位新密码` : '尚未输入新密码'
        );
    }

    function setControlsDisabled(disabled) {
        dialog.querySelectorAll('[data-password-key], [data-password-clear], [data-password-delete]')
            .forEach(button => { button.disabled = disabled; });
    }

    function reset(message = '') {
        enteredPassword = '';
        dialog.classList.remove('record-password-error');
        status(message);
        updateDigits();
    }

    function showError(message) {
        reset(message || '访问密码修改失败，请重试。');
        dialog.classList.remove('record-password-error');
        requestAnimationFrame(() => dialog.classList.add('record-password-error'));
    }

    function restoreTriggerFocus() {
        if (trigger?.isConnected) trigger.focus();
        else document.querySelector('[data-action="change-password"]')?.focus();
    }

    function close() {
        if (submitting) return;
        dialog.close();
        reset();
        firstPassword = '';
        capability = undefined;
        mode = 'new';
        updatePrompt();
        restoreTriggerFocus();
    }

    async function submit() {
        if (submitting || enteredPassword.length !== PASSWORD_LENGTH) return;
        const password = enteredPassword;
        if (mode === 'new') {
            firstPassword = password;
            mode = 'confirm';
            updatePrompt();
            reset();
            dialog.querySelector('[data-password-key]')?.focus();
            return;
        }
        if (password !== firstPassword) {
            firstPassword = '';
            mode = 'new';
            updatePrompt();
            showError('两次输入的新密码不一致，请重新设置。');
            return;
        }

        submitting = true;
        setControlsDisabled(true);
        status('正在安全更新访问密码…');
        try {
            const nextCapability = await changeWriterPassword(password, capability);
            dialog.close();
            reset();
            firstPassword = '';
            capability = undefined;
            mode = 'new';
            updatePrompt();
            restoreTriggerFocus();
            await onChanged(nextCapability);
        } catch (error) {
            firstPassword = '';
            mode = 'new';
            updatePrompt();
            showError(error?.message || '访问密码修改失败，请重试。');
        } finally {
            submitting = false;
            setControlsDisabled(false);
            if (dialog.open) dialog.querySelector('[data-password-key]')?.focus();
        }
    }

    function enterDigit(digit) {
        if (submitting || enteredPassword.length >= PASSWORD_LENGTH) return;
        dialog.classList.remove('record-password-error');
        status('');
        enteredPassword += digit;
        updateDigits();
        if (enteredPassword.length === PASSWORD_LENGTH) void submit();
    }

    function deleteDigit() {
        if (submitting || !enteredPassword.length) return;
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
            void submit();
        }
        event.stopPropagation();
    });

    updatePrompt();
    return authenticatedCapability => {
        if (dialog.open || submitting) return;
        if (!authenticatedCapability?.authenticated || !authenticatedCapability.token) {
            void showFeedback('登录会话已失效，请重新输入当前密码。', { label: '修改密码', title: '需要重新验证' });
            return;
        }
        trigger = document.activeElement;
        capability = authenticatedCapability;
        firstPassword = '';
        mode = 'new';
        updatePrompt();
        reset();
        dialog.showModal();
        dialog.querySelector('[data-password-key]')?.focus();
    };
}
