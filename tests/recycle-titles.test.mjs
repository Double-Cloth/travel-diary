import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/browser-modules.mjs';

const { restoreChangeTitle } = await loadBrowserModule(new URL('../js/recycle-manager.js', import.meta.url), 'export { restoreChangeTitle };');
const record = { date: '2024-07-08', locality: '玉溪', desc_md: 'data/travel-diary/2024/2024-07-08-yuxi.md' };
const comparison = { status: 'changed', fields: [], markdownChanged: false, media: [] };

test('恢复预览按实际变化区分日记信息、正文与附件', () => {
    assert.equal(restoreChangeTitle(record, { ...comparison, status: 'added' }), '日记 · 2024-07-08 · 玉溪');
    assert.equal(restoreChangeTitle(record, { ...comparison, fields: ['locality'] }), '日记信息 · 2024-07-08 · 玉溪');
    assert.equal(restoreChangeTitle(record, { ...comparison, markdownChanged: true }), '日记正文 · 2024-07-08 · 玉溪');
    assert.equal(restoreChangeTitle(record, { ...comparison, fields: ['photos'], media: ['a.jpg'] }), '日记附件 · 2024-07-08 · 玉溪');
    assert.equal(restoreChangeTitle(record, { ...comparison, fields: ['date'], markdownChanged: true, media: ['a.jpg'] }), '日记信息、正文、附件 · 2024-07-08 · 玉溪');
});

test('移除日记使用原记录，地点缺失时使用行政区或国家', () => {
    assert.equal(restoreChangeTitle({ desc_md: record.desc_md }, { ...comparison, status: 'removed', previous: record }), '日记 · 2024-07-08 · 玉溪');
    assert.equal(restoreChangeTitle({ ...record, locality: '', admin_area: '云南' }, comparison), '日记 · 2024-07-08 · 云南');
    assert.equal(restoreChangeTitle({ ...record, locality: '', country: '中国' }, comparison), '日记 · 2024-07-08 · 中国');
    assert.equal(restoreChangeTitle({ ...record, locality: '' }, comparison), '日记 · 2024-07-08');
});

test('个人资料和独立文件使用真实内容类型，不冒充日记', () => {
    const title = name => restoreChangeTitle({ desc_md: name }, comparison);
    assert.equal(title('data/profile/owner-name.txt'), '个人署名');
    assert.equal(title('data/profile/profile-picture.png'), '个人头像');
    assert.equal(title('data/photos/a.jpg'), '图片 · a.jpg');
    assert.equal(title('data/videos/a.mp4'), '视频 · a.mp4');
    assert.equal(title('data/old.md'), '正文文件 · old.md');
    assert.equal(title('data/unknown.json'), '文件 · unknown.json');
});
