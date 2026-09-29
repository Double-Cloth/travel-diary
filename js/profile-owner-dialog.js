import { OWNER_NAME_MAX_LENGTH, normalizeOwnerName } from './profile-owner.js?v=20260929-owner-name-v1';

let ownerDialog;
let ownerResolver;
let ownerTrigger;

function getOwnerDialog() {
    if (ownerDialog) return ownerDialog;

    ownerDialog = document.createElement('dialog');
    ownerDialog.className = 'profile-owner-dialog entry-sheet';
    ownerDialog.setAttribute('aria-labelledby', 'profileOwnerDialogTitle');
    ownerDialog.setAttribute('aria-describedby', 'profileOwnerDialogNote');
    ownerDialog.innerHTML = `
        <form class="profile-owner-dialog-card" novalidate>
            <div class="profile-owner-dialog-seal" aria-hidden="true">
                <svg viewBox="0 0 32 32" focusable="false">
                    <path d="M6 25l2.2-6.4L20 6.8l4.2 4.2-11.8 11.8z"></path>
                    <path d="M18.6 8.2l4.2 4.2"></path>
                </svg>
            </div>
            <p class="journal-label">扉页署名</p>
            <h2 id="profileOwnerDialogTitle">修改署名</h2>
            <p class="profile-owner-dialog-note" id="profileOwnerDialogNote">署名显示在扉页的收藏铭牌上，并随全部数据备份一起导出。</p>
            <input class="profile-owner-dialog-input" data-owner-name-input type="text" maxlength="${OWNER_NAME_MAX_LENGTH}" autocomplete="off" spellcheck="false" aria-label="日记署名" placeholder="请输入署名">
            <p class="profile-owner-dialog-error" data-owner-name-error role="alert"></p>
            <div class="profile-owner-dialog-actions">
                <button class="paper-button" type="button" data-owner-name-cancel>取消</button>
                <button class="paper-button profile-owner-dialog-submit" type="submit" data-owner-name-confirm>保存署名</button>
            </div>
        </form>`;
    document.body.append(ownerDialog);

    const input = ownerDialog.querySelector('[data-owner-name-input]');
    const error = ownerDialog.querySelector('[data-owner-name-error]');

    const finish = value => {
        if (!ownerResolver) return;
        const resolve = ownerResolver;
        ownerResolver = null;
        ownerDialog.close();
        if (ownerTrigger?.isConnected) ownerTrigger.focus();
        resolve(value);
    };

    const submit = () => {
        const value = normalizeOwnerName(input.value);
        if (!value) {
            error.textContent = '署名不能只包含空白字符。';
            input.focus();
            return;
        }
        finish(value);
    };

    ownerDialog.addEventListener('cancel', event => {
        event.preventDefault();
        finish(null);
    });

    ownerDialog.addEventListener('click', event => {
        if (event.target.closest('[data-owner-name-cancel]')) finish(null);
    });

    ownerDialog.querySelector('form').addEventListener('submit', event => {
        event.preventDefault();
        submit();
    });

    input.addEventListener('input', () => {
        if (error.textContent) error.textContent = '';
    });

    ownerDialog.addEventListener('keydown', event => {
        event.stopPropagation();
    });

    return ownerDialog;
}

export function createOwnerNameDialog() {
    return {
        open(currentName = '') {
            const dialog = getOwnerDialog();
            if (dialog.open || ownerResolver) return Promise.resolve(null);
            const input = dialog.querySelector('[data-owner-name-input]');
            const error = dialog.querySelector('[data-owner-name-error]');
            error.textContent = '';
            input.value = normalizeOwnerName(currentName);
            ownerTrigger = document.activeElement;
            return new Promise(resolve => {
                ownerResolver = resolve;
                dialog.showModal();
                input.focus();
                input.select();
            });
        }
    };
}
