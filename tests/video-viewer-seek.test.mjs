import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

globalThis.document = { addEventListener() {} };
const app = await loadBrowserModule(new URL('../js/app.js', import.meta.url), `
export { handlePhotoPointerDown, handlePhotoPointerEnd, handleDocumentInput,
    handleDocumentChange, syncVideoViewerControls, handleViewerVideoSeeked };
export function resetTestVideoGesture() { photoGestureState = createPhotoGestureState(); }
`);
delete globalThis.document;

function createPlayer(t) {
    const previousDocument = globalThis.document;
    t.after(() => { globalThis.document = previousDocument; });
    app.resetTestVideoGesture();
    const writes = [];
    let currentTime = 12;
    const video = {
        duration: 120, readyState: 1, seeking: false, paused: false,
        volume: 0.85, muted: false, playbackRate: 1,
        get currentTime() { return currentTime; },
        set currentTime(value) { writes.push(value); this.seeking = true; }
    };
    let value = '12';
    let max = '120';
    let maxWrites = 0;
    const seek = {
        min: '0', style: { setProperty() {} },
        get max() { return max; },
        set max(next) { maxWrites += 1; max = next; value = String(Math.min(Number(value), Number(max))); },
        get value() { return value; },
        set value(next) { value = next; },
        matches: selector => selector === '[data-video-seek]',
        closest: () => null
    };
    const time = { textContent: '' };
    globalThis.document = { body: { querySelector: selector => ({
        '[data-video-viewer-video]': video,
        '[data-video-seek]': seek,
        '[data-video-time]': time
    })[selector] || null } };
    return {
        video, seek, time, writes,
        get maxWrites() { return maxWrites; },
        begin: () => app.handlePhotoPointerDown({ target: seek, pointerId: 1, pointerType: 'touch' }),
        input(next) { seek.value = String(next); app.handleDocumentInput({ target: seek }); },
        end: (type = 'pointerup') => app.handlePhotoPointerEnd({ pointerId: 1, type }),
        complete(next) {
            currentTime = next;
            video.seeking = false;
            app.handleViewerVideoSeeked({ target: video });
        }
    };
}

test('触摸慢拖和暂停手指超过 400ms 时，不被旧 timeupdate 或范围同步覆盖', t => {
    const player = createPlayer(t);
    const previousNow = Date.now;
    let now = previousNow();
    Date.now = () => now;
    t.after(() => { Date.now = previousNow; });
    player.begin();
    player.input(70);
    now += 5000;
    app.syncVideoViewerControls();
    assert.equal(player.seek.value, '70');
    assert.equal(player.time.textContent, '01:10 / 02:00');
    assert.equal(player.maxWrites, 0);
    assert.deepEqual(player.writes, []);
    player.input(85);
    player.end();
    assert.deepEqual(player.writes, [85]);
    assert.equal(player.seek.value, '85');
    app.handleDocumentChange({ target: player.seek });
    assert.deepEqual(player.writes, [85]);
});

test('松手后异步定位超过 400ms 仍保留目标，seeked 后恢复真实进度', t => {
    const player = createPlayer(t);
    player.begin();
    player.input(90);
    player.end();
    app.syncVideoViewerControls();
    assert.equal(player.seek.value, '90');
    assert.equal(player.maxWrites, 0);
    player.complete(89.98);
    assert.equal(player.seek.value, '89.98');
    assert.equal(player.time.textContent, '01:29 / 02:00');
});

test('时长暂不可用时不把范围和视频时间重置到 0', t => {
    const player = createPlayer(t);
    player.begin();
    player.input(75);
    player.video.duration = NaN;
    app.syncVideoViewerControls();
    player.end();
    app.handleDocumentChange({ target: player.seek });
    assert.equal(player.seek.max, '120');
    assert.equal(player.maxWrites, 0);
    assert.deepEqual(player.writes, []);
    player.video.duration = 120;
    app.handleDocumentChange({ target: player.seek });
    assert.deepEqual(player.writes, [75]);
});

test('取消触摸拖动恢复原进度，不执行跳转', t => {
    const player = createPlayer(t);
    player.begin();
    player.input(75);
    player.end('pointercancel');
    assert.deepEqual(player.writes, []);
    assert.equal(player.seek.value, '12');
});

test('键盘和辅助技术直接输入及 change 跳转仍生效', t => {
    const player = createPlayer(t);
    player.input(40);
    assert.deepEqual(player.writes, [40]);
    player.complete(40);
    player.seek.value = '60';
    app.handleDocumentChange({ target: player.seek });
    assert.deepEqual(player.writes, [40, 60]);
});

test('其他指针结束或旧视频 seeked 不会释放正在拖动的进度条', t => {
    const player = createPlayer(t);
    player.begin();
    player.input(45);
    app.handlePhotoPointerEnd({ pointerId: 2, type: 'pointerup' });
    app.handleViewerVideoSeeked({ target: { seeking: false } });
    app.syncVideoViewerControls();
    assert.equal(player.seek.value, '45');
    assert.deepEqual(player.writes, []);
    player.end();
    player.complete(45);
    player.seek.value = '15';
    app.syncVideoViewerControls();
    assert.equal(player.seek.value, '45');
});

test('尚未加载元数据时不跳转，同一时长不会重复写入 range.max', t => {
    const player = createPlayer(t);
    player.video.readyState = 0;
    player.input(80);
    assert.deepEqual(player.writes, []);
    app.syncVideoViewerControls();
    assert.equal(player.maxWrites, 0);
    player.video.readyState = 1;
    player.video.duration = 100;
    app.syncVideoViewerControls();
    assert.equal(player.maxWrites, 1);
    app.syncVideoViewerControls();
    assert.equal(player.maxWrites, 1);
});
