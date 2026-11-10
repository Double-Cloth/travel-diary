import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const { createRecordEditor } = await loadBrowserModule(new URL('../js/record-editor.js', import.meta.url));

function installEditor(t) {
    const handlers = [];
    const previous = { document: globalThis.document, window: globalThis.window, ResizeObserver: globalThis.ResizeObserver };
    t.after(() => Object.assign(globalThis, previous));
    const dialog = {
        setAttribute() {},
        addEventListener(type, handler) { if (type === 'keydown') handlers.push(handler); },
        querySelectorAll() { return []; }
    };
    globalThis.document = { createElement: () => dialog, body: { append() {} } };
    globalThis.window = { addEventListener() {} };
    globalThis.ResizeObserver = class { constructor() {} };
    createRecordEditor(() => {});
    return (input, options = {}) => {
        const event = {
            key: 'Tab', defaultPrevented: false,
            target: { closest: selector => selector === 'input[data-editor-suggestion]' ? input : null },
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() {},
            ...options
        };
        handlers.forEach(handler => handler(event));
        return event;
    };
}

function suggestionInput(suggestion, value = '') {
    return {
        value, dataset: { editorSuggestion: suggestion }, events: [],
        dispatchEvent(event) { this.events.push(event); }
    };
}

test('空白字段按 Tab 接受建议，并触发原有输入处理', t => {
    const keydown = installEditor(t);
    for (const value of ['2026-11-10-suzhou', '中国', 'data/travel-diary/2026/2026-11-10-suzhou.md', 'data/photos/suzhou', 'data/videos/suzhou']) {
        const input = suggestionInput(value);
        assert.equal(keydown(input).defaultPrevented, true);
        assert.equal(input.value, value);
        assert.equal(input.events.length, 1);
        assert.equal(input.events[0].type, 'input');
        assert.equal(input.events[0].bubbles, true);
        assert.equal(keydown(input).defaultPrevented, false);
        assert.equal(input.events.length, 1);
    }
});

test('已有内容、无建议、禁用或只读字段保留原生 Tab 行为', t => {
    const keydown = installEditor(t);
    for (const input of [
        suggestionInput('generated', 'custom'), suggestionInput('generated', ' '), suggestionInput(''),
        { ...suggestionInput('generated'), disabled: true },
        { ...suggestionInput('generated'), readOnly: true }
    ]) {
        const previous = input.value;
        assert.equal(keydown(input).defaultPrevented, false);
        assert.equal(input.value, previous);
        assert.equal(input.events.length, 0);
    }
    assert.equal(keydown(null).defaultPrevented, false);
});

test('修饰键、输入法组合与其他按键不会接受建议', t => {
    const keydown = installEditor(t);
    for (const options of [
        { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true },
        { isComposing: true }, { defaultPrevented: true }, { key: 'Enter' }, { key: 'Escape' }
    ]) {
        const input = suggestionInput('generated');
        const event = keydown(input, options);
        assert.equal(event.defaultPrevented, Boolean(options.defaultPrevented));
        assert.equal(input.value, '');
        assert.equal(input.events.length, 0);
    }
});
