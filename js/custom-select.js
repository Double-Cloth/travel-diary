let customSelectId = 0;
let documentEventsBound = false;
const POINTER_MOVE_TOLERANCE = 8;

function pointerMoved(start, event) {
    return Math.abs(event.clientX - start.x) > POINTER_MOVE_TOLERANCE
        || Math.abs(event.clientY - start.y) > POINTER_MOVE_TOLERANCE;
}

function getOptions(wrapper) {
    return [...wrapper.querySelectorAll('[data-custom-select-option]')];
}

function closeCustomSelect(wrapper) {
    if (!wrapper) return;
    const trigger = wrapper.querySelector('[data-custom-select-trigger]');
    const menu = wrapper.querySelector('[data-custom-select-menu]');
    if (!trigger || !menu) return;
    wrapper.classList.remove('is-open', 'is-open-upward');
    trigger.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
    getOptions(wrapper).forEach(option => option.classList.remove('is-active'));
    trigger.removeAttribute('aria-activedescendant');
}

function getCustomSelectBoundary(wrapper) {
    let boundary = wrapper.parentElement;
    while (boundary && boundary !== document.body) {
        const overflowY = window.getComputedStyle(boundary).overflowY;
        if (['auto', 'scroll', 'hidden', 'clip'].includes(overflowY)) return boundary;
        boundary = boundary.parentElement;
    }
    return document.documentElement;
}

function updateCustomSelectPlacement(wrapper) {
    const trigger = wrapper.querySelector('[data-custom-select-trigger]');
    const menu = wrapper.querySelector('[data-custom-select-menu]');
    if (!trigger || !menu) return;

    const boundary = getCustomSelectBoundary(wrapper);
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const boundaryRect = boundary === document.documentElement
        ? { top: 0, bottom: window.innerHeight }
        : boundary.getBoundingClientRect();
    const gap = 8;
    const spaceBelow = boundaryRect.bottom - triggerRect.bottom - gap;
    const spaceAbove = triggerRect.top - boundaryRect.top - gap;

    wrapper.classList.toggle('is-open-upward', menuRect.height > spaceBelow && spaceAbove > spaceBelow);
}

function closeOtherCustomSelects(current) {
    document.querySelectorAll('[data-custom-select].is-open').forEach(wrapper => {
        if (wrapper !== current) closeCustomSelect(wrapper);
    });
}

function openCustomSelect(wrapper, activeIndex = -1) {
    const trigger = wrapper.querySelector('[data-custom-select-trigger]');
    const menu = wrapper.querySelector('[data-custom-select-menu]');
    const options = getOptions(wrapper);
    if (!trigger || !menu || !options.length) return;
    closeOtherCustomSelects(wrapper);
    wrapper.classList.add('is-open');
    menu.hidden = false;
    updateCustomSelectPlacement(wrapper);
    trigger.setAttribute('aria-expanded', 'true');
    const selected = activeIndex >= 0 ? activeIndex : options.findIndex(option => option.getAttribute('aria-selected') === 'true');
    options.forEach(option => option.classList.remove('is-active'));
    if (selected >= 0) {
        const option = options[selected];
        option.classList.add('is-active');
        trigger.setAttribute('aria-activedescendant', option.id);
        option.scrollIntoView({ block: 'nearest' });
    }
}

function renderCustomSelect(wrapper) {
    const select = wrapper.querySelector('select');
    const triggerLabel = wrapper.querySelector('[data-custom-select-label]');
    const menu = wrapper.querySelector('[data-custom-select-menu]');
    if (!select || !triggerLabel || !menu) return;
    menu.innerHTML = '';
    [...select.options].forEach((nativeOption, index) => {
        const option = document.createElement('span');
        option.id = `${menu.id}-option-${index}`;
        option.dataset.customSelectOption = '';
        option.dataset.customSelectValue = nativeOption.value;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(nativeOption.selected));
        option.textContent = nativeOption.textContent;
        menu.append(option);
    });
    triggerLabel.textContent = select.options[select.selectedIndex]?.textContent || '';
}

function selectCustomOption(wrapper, option) {
    const select = wrapper.querySelector('select');
    const trigger = wrapper.querySelector('[data-custom-select-trigger]');
    if (!select || !option) return;
    if (select.value !== option.dataset.customSelectValue) {
        select.value = option.dataset.customSelectValue;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
        renderCustomSelect(wrapper);
    }
    closeCustomSelect(wrapper);
    trigger?.focus({ preventScroll: true });
}

function moveCustomSelectSelection(wrapper, direction) {
    openCustomSelect(wrapper);
    const options = getOptions(wrapper);
    if (!options.length) return;
    const current = options.findIndex(option => option.classList.contains('is-active'));
    const next = (current + direction + options.length) % options.length;
    options.forEach(option => option.classList.remove('is-active'));
    options[next].classList.add('is-active');
    wrapper.querySelector('[data-custom-select-trigger]')?.setAttribute('aria-activedescendant', options[next].id);
    options[next].scrollIntoView({ block: 'nearest' });
}

function enhanceCustomSelect(select) {
    const existingWrapper = select.parentElement?.matches('.custom-select') ? select.parentElement : null;
    if (existingWrapper?.dataset.customSelect !== undefined) return;
    if (!select.id) select.id = `customSelect${++customSelectId}`;
    const wrapper = existingWrapper || document.createElement('span');
    wrapper.classList.add('custom-select');
    wrapper.dataset.customSelect = '';
    if (!existingWrapper) {
        select.parentNode.insertBefore(wrapper, select);
        wrapper.append(select);
    }
    select.classList.add('custom-select-native');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select-trigger';
    trigger.dataset.customSelectTrigger = '';
    trigger.id = `${select.id}Button`;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `${select.id}Options`);
    trigger.setAttribute('aria-label', select.getAttribute('aria-label') || select.name || '选择');
    trigger.innerHTML = '<span data-custom-select-label></span><span class="custom-select-chevron" aria-hidden="true"></span>';
    wrapper.insertBefore(trigger, select);

    const menu = document.createElement('span');
    menu.id = `${select.id}Options`;
    menu.className = 'custom-select-menu';
    menu.dataset.customSelectMenu = '';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    wrapper.append(menu);

    let optionPointer = null;
    let suppressOptionClick = false;
    menu.addEventListener('pointerdown', event => {
        if (!event.target.closest('[data-custom-select-option]')) return;
        suppressOptionClick = false;
        if (event.pointerType === 'mouse') {
            event.preventDefault();
            optionPointer = null;
            return;
        }
        optionPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    });
    menu.addEventListener('pointermove', event => {
        if (!optionPointer || event.pointerId !== optionPointer.id) return;
        if (pointerMoved(optionPointer, event)) suppressOptionClick = true;
    }, { passive: true });
    menu.addEventListener('pointerup', event => {
        if (!optionPointer || event.pointerId !== optionPointer.id) return;
        if (pointerMoved(optionPointer, event)) suppressOptionClick = true;
        optionPointer = null;
    }, { passive: true });
    menu.addEventListener('pointercancel', event => {
        if (!optionPointer || event.pointerId !== optionPointer.id) return;
        suppressOptionClick = true;
        optionPointer = null;
    }, { passive: true });
    menu.addEventListener('click', event => {
        const option = event.target.closest('[data-custom-select-option]');
        if (!option) return;
        event.preventDefault();
        event.stopPropagation();
        if (suppressOptionClick) {
            suppressOptionClick = false;
            return;
        }
        selectCustomOption(wrapper, option);
    });

    const label = select.closest('label');
    if (label?.htmlFor === select.id) label.htmlFor = trigger.id;
    renderCustomSelect(wrapper);
    select.addEventListener('change', () => renderCustomSelect(wrapper));
    select.addEventListener('focus', () => trigger.focus({ preventScroll: true }));
    trigger.addEventListener('click', () => {
        if (wrapper.classList.contains('is-open')) closeCustomSelect(wrapper);
        else openCustomSelect(wrapper);
    });
    trigger.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveCustomSelectSelection(wrapper, 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveCustomSelectSelection(wrapper, -1);
        } else if ((event.key === 'Enter' || event.key === ' ') && wrapper.classList.contains('is-open')) {
            event.preventDefault();
            const option = getOptions(wrapper).find(item => item.classList.contains('is-active'));
            if (option) selectCustomOption(wrapper, option);
        } else if (event.key === 'Escape') {
            closeCustomSelect(wrapper);
        } else if (event.key === 'Tab') {
            closeCustomSelect(wrapper);
        }
    });
    trigger.addEventListener('focusout', () => {
        window.setTimeout(() => {
            if (!wrapper.contains(document.activeElement)) closeCustomSelect(wrapper);
        }, 0);
    });
}

function bindDocumentEvents() {
    if (documentEventsBound) return;
    documentEventsBound = true;
    document.addEventListener('pointerdown', event => {
        if (event.target.closest('[data-custom-select]')) return;
        document.querySelectorAll('[data-custom-select].is-open').forEach(closeCustomSelect);
    });
}

export function enhanceCustomSelects(root = document) {
    root.querySelectorAll('select[data-custom-select]').forEach(enhanceCustomSelect);
    bindDocumentEvents();
}
