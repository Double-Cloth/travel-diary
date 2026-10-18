import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const customSelect = await loadBrowserModule(new URL('../js/custom-select.js', import.meta.url), 'export { enhanceCustomSelect };');

function createSelectFixture(t) {
    const originals = { document: globalThis.document, window: globalThis.window, MutationObserver: globalThis.MutationObserver };
    t.after(() => Object.assign(globalThis, originals));
    const timers = [];
    const elements = [];
    function element() {
        const attributes = new Map();
        const classes = new Set();
        const node = {
            dataset: {}, style: {}, children: [], handlers: {}, scrollTop: 0, scrollHeight: 400,
            classList: {
                add: name => classes.add(name), remove: name => classes.delete(name),
                contains: name => classes.has(name),
                toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
            },
            setAttribute: (name, value) => attributes.set(name, value),
            getAttribute: name => attributes.get(name),
            removeAttribute: name => attributes.delete(name),
            addEventListener: (name, handler) => { node.handlers[name] = handler; },
            append(child) { child.parentElement = node; node.children.push(child); },
            insertBefore(child) { node.append(child); },
            matches: selector => selector === '.custom-select',
            closest: () => null,
            getBoundingClientRect: () => ({ top: 100, bottom: 140, left: 20, right: 260, width: 240 }),
            focus: () => { globalThis.document.activeElement = node; },
            scrollIntoView() {},
            set innerHTML(value) { node.children = []; },
            emit(name, extra = {}) {
                const event = {
                    target: node, defaultPrevented: false, propagationStopped: false,
                    preventDefault() { this.defaultPrevented = true; },
                    stopPropagation() { this.propagationStopped = true; },
                    ...extra
                };
                let current = node;
                while (current) {
                    current.handlers[name]?.(event);
                    if (event.propagationStopped) break;
                    current = current.parentElement;
                }
                return event;
            }
        };
        elements.push(node);
        return node;
    }
    const wrapper = element();
    const select = element();
    const label = element();
    select.id = 'testSelect';
    select.options = [{ value: 'all', textContent: '全部', selected: true }];
    select.selectedOptions = select.options;
    select.selectedIndex = 0;
    select.labels = [];
    wrapper.append(select);
    wrapper.querySelector = selector => selector === 'select' ? select
        : selector === '[data-custom-select-label]' ? label
            : elements.find(node => selector === '[data-custom-select-trigger]'
                ? node.dataset.customSelectTrigger !== undefined : node.dataset.customSelectMenu !== undefined);
    wrapper.querySelectorAll = () => wrapper.querySelector('[data-custom-select-menu]')?.children || [];
    wrapper.contains = target => {
        while (target) {
            if (target === wrapper) return true;
            target = target.parentElement;
        }
        return false;
    };
    globalThis.document = { documentElement: {}, createElement: element, querySelectorAll: () => [] };
    globalThis.window = { innerWidth: 1000, innerHeight: 800, setTimeout: callback => timers.push(callback) };
    globalThis.MutationObserver = class { observe() {} };
    customSelect.enhanceCustomSelect(select);
    const trigger = wrapper.querySelector('[data-custom-select-trigger]');
    const menu = wrapper.querySelector('[data-custom-select-menu]');
    return { wrapper, trigger, menu, flush: () => { while (timers.length) timers.shift()(); } };
}

test('菜单内边距点击不激活外层标签，滚动条按下保留原生默认行为', t => {
    const { trigger, menu, flush } = createSelectFixture(t);
    trigger.focus();
    trigger.emit('click');
    assert.equal(menu.hidden, false);
    assert.equal(menu.tabIndex, -1);
    assert.equal(menu.emit('pointerdown', { pointerType: 'mouse' }).defaultPrevented, false);
    trigger.emit('focusout');
    menu.focus();
    flush();
    assert.equal(menu.hidden, false);
    const click = menu.emit('click');
    assert.equal(click.defaultPrevented, true);
    assert.equal(click.propagationStopped, true);
    assert.equal(menu.hidden, false);
});

test('菜单获得焦点后仍可键盘导航，Escape 关闭并恢复按钮焦点，移出焦点也关闭', t => {
    const { trigger, menu, flush } = createSelectFixture(t);
    trigger.emit('click');
    menu.focus();
    assert.equal(menu.emit('keydown', { key: 'ArrowDown' }).defaultPrevented, true);
    assert.ok(menu.children[0].classList.contains('is-active'));
    menu.emit('keydown', { key: 'Escape' });
    assert.equal(menu.hidden, true);
    assert.equal(globalThis.document.activeElement, trigger);
    trigger.emit('click');
    menu.focus();
    menu.emit('focusout');
    globalThis.document.activeElement = {};
    flush();
    assert.equal(menu.hidden, true);
});

test('关闭的选择框在初始化布局、滚动和窗口变化后同步方向，隐藏控件跳过测量', () => {
    const originals = { document: globalThis.document, window: globalThis.window, requestAnimationFrame: globalThis.requestAnimationFrame };
    const events = {};
    const frames = [];
    const classes = new Set();
    let top = 510;
    let visible = true;
    let measurements = 0;
    const menu = { hidden: true, scrollHeight: 472, style: {} };
    const trigger = {
        getClientRects: () => visible ? [{}] : [],
        getBoundingClientRect: () => {
            measurements += 1;
            return { top, bottom: top + 38, left: 752, right: 995, width: 243 };
        }
    };
    const wrapper = {
        querySelector: selector => selector === '[data-custom-select-trigger]' ? trigger : menu,
        closest: () => true,
        getBoundingClientRect: () => ({ left: 752 }),
        classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) }
    };
    try {
        globalThis.document = {
            documentElement: {},
            querySelectorAll: selector => selector === '.custom-select' ? [wrapper] : [],
            addEventListener: (name, handler) => { events[name] = handler; }
        };
        globalThis.window = {
            innerWidth: 1440, innerHeight: 824,
            addEventListener: (name, handler) => { events[name] = handler; }
        };
        globalThis.requestAnimationFrame = callback => frames.push(callback);

        customSelect.enhanceCustomSelects();
        assert.equal(frames.length, 1);
        frames.shift()();
        assert.ok(classes.has('is-open-upward'));
        assert.equal(menu.hidden, true);

        top = 455;
        events.scroll();
        events.scroll();
        events.resize();
        assert.equal(frames.length, 1);
        frames.shift()();
        assert.ok(classes.has('is-open-downward'));
        assert.ok(!classes.has('is-open-upward'));
        assert.equal(menu.hidden, true);

        globalThis.window.innerHeight = 600;
        events.resize();
        frames.shift()();
        assert.ok(classes.has('is-open-upward'));

        visible = false;
        const previousMeasurements = measurements;
        events.scroll();
        frames.shift()();
        assert.equal(measurements, previousMeasurements);
    } finally {
        Object.assign(globalThis, originals);
    }
});
