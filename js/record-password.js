const PASSWORD_LENGTH = 6;

export function readRecordPassword(config) {
    const password = typeof config === 'string' ? config : config?.password;
    if (typeof password !== 'string' || !/^\d{6}$/.test(password)) {
        throw new Error('新增记录密码配置无效，密码必须是 6 位数字。');
    }
    return password;
}

export function createRecordPasswordGate(openEditor) {
    const dialog = document.createElement('dialog');
    dialog.className = 'record-password entry-sheet';
    dialog.setAttribute('aria-labelledby', 'recordPasswordTitle');
    dialog.innerHTML = `
        <div class="record-password-card">
            <button class="paper-button record-password-close" type="button" data-password-close aria-label="关闭密码窗口">关闭</button>
            <div class="record-password-seal" aria-hidden="true">
                <svg viewBox="0 0 32 32" focusable="false">
                    <path d="M10 14v-3a6 6 0 0 1 12 0v3"></path>
                    <rect x="7" y="14" width="18" height="14" rx="2"></rect>
                    <path d="M16 19v4"></path>
                </svg>
            </div>
            <p class="journal-label">私人档案 · ACCESS</p>
            <h2 id="recordPasswordTitle">输入访问密码</h2>
            <p class="record-password-note">请输入 6 位数字密码，以新增旅行记录。</p>
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
    document.body.append(dialog);

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
        verifying = true;
        setControlsDisabled(true);
        status('验证通过，正在打开旅行记录编辑器…');
        dialog.close();
        expectedPassword = '';
        enteredPassword = '';
        updateDigits();
        restoreTriggerFocus();
        try {
            await openEditor();
        } catch (error) {
            window.alert(error?.message || '旅行记录编辑器打开失败，请重试。');
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
            if (!response.ok) throw new Error('无法读取新增记录密码。');
            expectedPassword = readRecordPassword(await response.json());
            status('');
            setControlsDisabled(false);
            dialog.querySelector('[data-password-key]')?.focus();
        } catch (error) {
            expectedPassword = '';
            status(error?.message || '新增记录密码读取失败，请刷新后重试。');
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
