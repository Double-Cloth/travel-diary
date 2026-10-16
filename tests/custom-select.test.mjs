import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const customSelect = await loadBrowserModule(new URL('../js/custom-select.js', import.meta.url));

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
