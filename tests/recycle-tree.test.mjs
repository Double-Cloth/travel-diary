import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecycleTree, buildRestorePreviewTree, groupRecycleItems, recycleRestoreConflicts, recycleRecordLabel, recyclePartGroups, selectRecycleParts } from '../js/recycle-tree.mjs';

test('恢复冲突识别同篇改名正文与旧标识，多篇混合批次也检测且不修改输入', () => {
    const saved = { record_id: `r-${'a'.repeat(32)}`, desc_md: 'data/old.md' };
    const current = { ...saved, desc_md: 'data/new.md' };
    const legacy = { desc_md: saved.desc_md };
    const another = { record_id: `r-${'b'.repeat(32)}`, desc_md: 'data/b.md' };
    const items = [
        { id: 'first', kind: 'version', displayRecords: [legacy], files: [{ path: saved.desc_md }] },
        { id: 'second', kind: 'version', displayRecords: [saved], files: [{ path: current.desc_md }] },
        { id: 'mixed', kind: 'record', records: [current, another], files: [] },
        { id: 'other', kind: 'version', files: [{ path: another.desc_md }] }
    ];
    const before = structuredClone(items);
    const conflict = ids => recycleRestoreConflicts(items, [current, another], ids.map(id => ({ id })));
    assert.deepEqual(conflict(['first', 'second'])[0].items.map(item => item.id), ['first', 'second']);
    assert.equal(conflict(['second', 'other']).length, 0);
    assert.equal(conflict(['first']).length, 0);
    assert.equal(conflict(['mixed', 'second', 'other']).length, 2);
    assert.deepEqual(items, before);
});

test('附件目标切换参与版本冲突判断，同篇独立附件仍可一起恢复', () => {
    const record = { desc_md: 'data/a.md', photo_folder: 'data/photos/a', photos: ['one.jpg', 'two.jpg'] };
    const items = [
        { id: 'body', kind: 'version', files: [{ path: record.desc_md }] },
        { id: 'media', kind: 'files', files: [{ path: 'data/photos/unknown.jpg' }] },
        { id: 'one', kind: 'files', mediaReferences: [record], files: [{ path: 'data/photos/a/one.jpg' }] },
        { id: 'two', kind: 'files', mediaReferences: [record], files: [{ path: 'data/photos/a/two.jpg' }] }
    ];
    assert.equal(recycleRestoreConflicts(items, [record], [{ id: 'body' }, { id: 'media', targetDescMd: record.desc_md }]).length, 1);
    assert.equal(recycleRestoreConflicts(items, [record], [{ id: 'one' }, { id: 'two' }]).length, 0);
    assert.equal(recycleRestoreConflicts(items, [record], []).length, 0);
});

test('恢复变化按日记和信息、正文、附件分层，共用附件仅展示一次', () => {
    const records = ['a', 'b'].map(name => ({ date: '2026-11-12', locality: name, desc_md: `data/travel-diary/2026/${name}.md`, photo_folder: 'data/photos/trip', photos: ['shared.jpg', `${name}.jpg`] }));
    const changes = records.map(record => ({ record, comparison: { status: 'changed', previous: record, fields: ['locality'], markdownChanged: true, markdown: '# 新正文', media: ['data/photos/trip/shared.jpg', `data/photos/trip/${record.locality}.jpg`], previousMediaPaths: new Set(), incomingMediaPaths: new Set() } }));
    const original = structuredClone(changes);
    const tree = buildRestorePreviewTree(changes);
    assert.equal(tree.get('').count, 7);
    assert.deepEqual(tree.get(`record:${records[0].desc_md}`).directories.map(node => node.name), ['日记信息', '正文', '图片']);
    assert.deepEqual(tree.get('shared/type:2').files.map(file => file.path), ['data/photos/trip/shared.jpg']);
    const info = tree.get(`record:${records[0].desc_md}/type:0`).files[0];
    assert.deepEqual(info.comparison.fields, ['locality']);
    assert.equal(info.comparison.markdownChanged, false);
    assert.deepEqual(info.comparison.media, []);
    assert.deepEqual(changes, original);
    assert.equal(buildRestorePreviewTree([]).get('').count, 0);
});

test('恢复目录覆盖移除附件、个人资料和同名独立文件', () => {
    const previous = { date: '2026-11-12', desc_md: 'data/travel-diary/2026/old.md', photo_folder: 'data/photos/old', photos: ['same.jpg'] };
    const record = { ...previous, photo_folder: 'data/photos/new', photos: ['same.jpg'] };
    const comparison = { status: 'changed', previous, fields: [], markdownChanged: false, media: ['data/photos/old/same.jpg', 'data/photos/new/same.jpg'], previousMediaPaths: new Set(['data/photos/old/same.jpg']), incomingMediaPaths: new Set(['data/photos/new/same.jpg']) };
    const tree = buildRestorePreviewTree([{ record, comparison }, { record: { desc_md: 'data/profile/owner-name.txt' }, comparison: { status: 'removed', fields: [], markdownChanged: true, media: [] } }]);
    assert.equal(tree.get(`record:${record.desc_md}/type:2`).files.length, 2);
    assert.equal(tree.get('type:4').files[0].path, 'data/profile/owner-name.txt');
    assert.equal(tree.get('').count, 3);
});

test('回收目录按内容类型展示，保留原文件并汇总大小', () => {
    const files = [
        { path: 'data/travel-diary/2026/note.md', size: 10 },
        { path: 'data/photos/trip/day1/a.jpg', size: 20 },
        { path: 'data/photos/trip/day2/a.jpg', size: 30 },
        { path: 'data/videos/trip/a.mp4', size: 40 },
        { path: 'data/travel_data.json', size: 0 }
    ];
    const before = structuredClone(files);
    const tree = buildRecycleTree(files);
    assert.equal(tree.get('').count, 5);
    assert.equal(tree.get('').totalBytes, 100);
    assert.deepEqual(tree.get('').directories.map(node => node.name), ['正文', '图片', '视频', '日记索引']);
    assert.equal(tree.get('type:1').count, 2);
    assert.equal(tree.get('type:1').totalBytes, 50);
    assert.equal(tree.get('type:4').files[0], files[4]);
    assert.equal(tree.get('type:1').files[0], files[1]);
    assert.equal(tree.get('type:1').files[1], files[2]);
    assert.equal(tree.has('data'), false);
    assert.deepEqual(files, before);
});

test('同名文件不合并，文件名自然排序且保留大小写与特殊名称', () => {
    const names = ['data/photos/day10/a.jpg', 'data/photos/day2/10.jpg', 'data/photos/day2/2.jpg',
        'data/photos/Trip/a.jpg', 'data/photos/trip/b.jpg', 'data/photos/__proto__/x.jpg', 'data/<旧目录>/"文件".txt'];
    const tree = buildRecycleTree(names.map(path => ({ path, size: 0 })));
    assert.deepEqual(tree.get('type:1').files.slice(0, 2).map(file => file.path.split('/').pop()), ['2.jpg', '10.jpg']);
    assert.equal(tree.get('type:1').count, 6);
    assert.deepEqual(tree.get('type:1').files.filter(file => file.path.endsWith('/a.jpg')).map(file => file.path).sort(), [names[0], names[3]].sort());
    assert.equal(tree.get('type:5').files[0].path, names.at(-1));
});

test('原路径和逻辑分类搜索标记祖先，旧批次和空批次可正常展示', () => {
    const files = [{ path: 'data/photos/trip/old.JPG', size: 7 }, { path: 'data/profile/name.txt', size: 3 }];
    const tree = buildRecycleTree(files, ' OLD.jpg ');
    for (const name of ['', 'type:1']) assert.equal(tree.get(name).matches, true);
    assert.equal(tree.get('type:3').matches, false);
    assert.equal(buildRecycleTree(files, '图片').get('type:1').matches, true);
    const empty = buildRecycleTree([]).get('');
    assert.equal(empty.count, 0);
    assert.equal(empty.totalBytes, 0);
    assert.deepEqual(empty.directories, []);
    assert.deepEqual(empty.files, []);
    assert.notEqual(buildRecycleTree(files).get('type:1'), tree.get('type:1'));
});

test('真实路径的深度与文件目录同名不影响逻辑层级', () => {
    const deepPath = `data/${Array(1500).fill('level').join('/')}/a.txt`;
    const tree = buildRecycleTree([{ path: deepPath, size: 1 }, { path: 'data/old', size: 2 }, { path: 'data/old/a.txt', size: 3 }]);
    assert.equal(tree.size, 2);
    assert.equal(tree.get('type:5').depth, 1);
    assert.equal(tree.get('').count, 3);
    assert.equal(tree.get('').totalBytes, 6);
    assert.equal(tree.get('type:5').files.length, 3);
});

test('多篇日记按精确引用分组，共用文件仅统计一次，独立文件保留', () => {
    const records = [
        { date: '2026-11-01', locality: '南京', desc_md: 'data/a.md', photo_folder: 'data/photos/a', photos: ['same.jpg', 'shared.jpg'] },
        { date: '2026-11-01', locality: '南京', desc_md: 'data/b.md', photo_folder: 'data/photos/b', photos: ['same.jpg'] }
    ];
    const mediaReferences = [{ ...records[1], date: '2020-01-01', locality: '旧地点', photo_folder: 'data/photos/a', photos: ['shared.jpg'] }, records[0]];
    const files = ['data/a.md', 'data/b.md', 'data/photos/a/same.jpg', 'data/photos/b/same.jpg', 'data/photos/a/shared.jpg', 'data/photos/orphan/same.jpg'].map(path => ({ path, size: 10 }));
    const before = structuredClone({ files, records, mediaReferences });
    const tree = buildRecycleTree(files, 'same.jpg', { records, mediaReferences });
    assert.equal(tree.get('').count, 6);
    assert.equal(tree.get('').totalBytes, 60);
    assert.equal(tree.get('record:data/a.md').count, 2);
    assert.equal(tree.get('record:data/b.md').count, 2);
    assert.equal(tree.get('record:data/b.md').name, '2026-11-01 · 南京');
    assert.equal(tree.get('record:data/a.md/type:1').files[0].path, files[2].path);
    assert.equal(tree.get('record:data/b.md/type:1').files[0].path, files[3].path);
    assert.equal(tree.get('shared/type:1').files[0].path, files[4].path);
    assert.equal(tree.get('shared').count, 1);
    assert.equal(tree.get('type:1').files[0].path, files[5].path);
    assert.equal(tree.get('record:data/a.md').matches, true);
    assert.equal(tree.get('shared').matches, false);
    assert.deepEqual({ files, records, mediaReferences }, before);
});

test('单篇关联日记省略重复目录，媒体分类复用调用方能力且头像归入个人资料', () => {
    const record = { desc_md: 'data/a.md', photo_folder: 'data/photos/a', photos: ['missing.jpg'] };
    const files = ['data/profile/avatar.jpg', 'data/old/image.HEIC', 'data/old/video.MOV', 'data/a.md'].map(path => ({ path, size: 0 }));
    const tree = buildRecycleTree(files, '', { mediaReferences: [record], mediaKind: name => name.endsWith('.HEIC') || name.endsWith('.jpg') ? 'image' : name.endsWith('.MOV') ? 'video' : '' });
    assert.deepEqual(tree.get('').directories.map(node => node.name), ['正文', '图片', '视频', '个人资料']);
    assert.equal(tree.get('type:3').files[0], files[0]);
    assert.equal(tree.get('').count, 4);
    assert.equal(tree.get('').directories.some(node => node.path.startsWith('record:')), false);
    assert.equal(recycleRecordLabel({}), '日记');
    assert.equal(recycleRecordLabel({ date: '2026-11-06', country: '中国', locality: '南京' }), '2026-11-06 · 中国 · 南京');
});

test('同篇日记的多次删除合并展示，正文移动和新旧标识兼容且批次保持独立', () => {
    const record = { record_id: `r-${'a'.repeat(32)}`, date: '2026-11-01', desc_md: 'data/old.md', photo_folder: 'data/photos/trip', photos: ['a.jpg'] };
    const current = { ...record, title: '当前标题', desc_md: 'data/new.md', photos: [] };
    const legacy = { ...record };
    delete legacy.record_id;
    const items = [
        { id: 'media', kind: 'files', records: [], mediaReferences: [legacy], files: [{ path: 'data/photos/trip/a.jpg' }] },
        { id: 'text', kind: 'version', records: [], displayRecords: [record], files: [{ path: record.desc_md }] },
        { id: 'new', kind: 'version', records: [], files: [{ path: current.desc_md }] }
    ];
    const before = structuredClone({ items, current });
    const { groups, recordsByItem } = groupRecycleItems(items, [current]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].record, current);
    assert.deepEqual(groups[0].items.map(item => item.id), ['media', 'text', 'new']);
    assert.equal(groups[0].items[0], items[0]);
    assert.equal(recordsByItem.get('text')[0], record);
    assert.deepEqual({ items, current }, before);
});

test('外层已有单篇日记时恢复目录省略重复日记层，多篇变化仍保留归属', () => {
    const changes = [{ record: { date: '2026-11-01', desc_md: 'data/a.md' }, comparison: { status: 'changed', fields: [], markdownChanged: true, media: [] } }];
    const tree = buildRestorePreviewTree(changes, () => '', { groupSingleRecord: false });
    assert.deepEqual(tree.get('').directories.map(node => node.name), ['正文']);
    const multiple = buildRestorePreviewTree([...changes, { ...changes[0], record: { date: '2026-11-02', desc_md: 'data/b.md' } }], () => '', { groupSingleRecord: false });
    assert.deepEqual(multiple.get('').directories.map(node => node.name), ['2026-11-01', '2026-11-02']);
});

test('旧正文与媒体结合精确路径、历史关联和唯一媒体目录补全所属日记', () => {
    const record = { date: '2026-11-01', desc_md: 'data/a.md', photo_folder: 'data/photos/trip', photos: ['a.jpg'] };
    const items = [
        { id: 'deleted', kind: 'record', records: [record], files: [] },
        { id: 'text', kind: 'version', files: [{ path: record.desc_md }] },
        { id: 'exact', kind: 'files', files: [{ path: 'data/photos/trip/a.jpg' }] },
        { id: 'folder', kind: 'files', files: [{ path: 'data/photos/trip/removed.jpg' }] }
    ];
    const { groups, recordsByItem } = groupRecycleItems(items);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].items.length, 4);
    for (const item of items) assert.equal(recordsByItem.get(item.id)[0], record);
    assert.equal(items[3].mediaReferences, undefined);
});

test('同日同地点、共享目录、未知文件和整站批次保持边界且每个批次仅展示一次', () => {
    const records = [
        { date: '2026-11-01', locality: '南京', desc_md: 'data/a.md', photo_folder: 'data/photos/shared', photos: ['same.jpg'] },
        { date: '2026-11-01', locality: '南京', desc_md: 'data/b.md', photo_folder: 'data/photos/shared', photos: ['same.jpg'] }
    ];
    const items = [
        ...records.map((record, index) => ({ id: `record-${index}`, kind: 'record', records: [record], files: [] })),
        { id: 'shared', kind: 'files', files: [{ path: 'data/photos/shared/same.jpg' }] },
        { id: 'unknown', kind: 'files', files: [{ path: 'data/photos/else/same.jpg' }] },
        { id: 'prefix', kind: 'files', files: [{ path: 'data/photos/shared-other/a.jpg' }] },
        { id: 'mixed', kind: 'files', files: [{ path: 'data/a.md' }, { path: 'data/profile/avatar.png' }] },
        { id: 'snapshot', kind: 'snapshot', displayRecords: [records[0]], files: [{ path: 'data/a.md' }] }
    ];
    const { groups, recordsByItem } = groupRecycleItems(items);
    assert.equal(groups.length, 7);
    assert.equal(groups[0].record.desc_md, 'data/a.md');
    assert.equal(groups[1].record.desc_md, 'data/b.md');
    assert.equal(recordsByItem.get('shared').length, 2);
    assert.deepEqual(recordsByItem.get('unknown'), []);
    assert.deepEqual(recordsByItem.get('prefix'), []);
    assert.equal(groups.find(group => group.items[0].id === 'mixed').record, null);
    assert.equal(groups.find(group => group.items[0].id === 'snapshot').record, null);
    assert.deepEqual(groups.flatMap(group => group.items).map(item => item.id), items.map(item => item.id));
});

test('共用路径的不同固定标识保持独立，媒体根目录不用于归属推断', () => {
    const records = ['a', 'b'].map(value => ({ record_id: `r-${value.repeat(32)}`, desc_md: 'data/same.md', photo_folder: 'data/photos', photos: [] }));
    const items = records.map((record, index) => ({ id: String(index), kind: 'record', records: [record], files: [] }));
    items.push({ id: 'root', kind: 'files', files: [{ path: 'data/photos/a.jpg' }] });
    const { groups, recordsByItem } = groupRecycleItems(items);
    assert.equal(groups.length, 3);
    assert.deepEqual(recordsByItem.get('root'), []);
    assert.deepEqual(groupRecycleItems([]), { groups: [], recordsByItem: new Map() });
});


test('部分恢复选项按日记和共用内容分组，文件只出现一次且不暴露原索引', () => {
    const a = { date: '2026-11-12', desc_md: 'data/a.md', photo_folder: 'data/photos/shared', photos: ['shared.png', 'a.png'] };
    const b = { ...a, desc_md: 'data/b.md', photos: ['shared.png'] };
    const item = { kind: 'snapshot', records: [], displayRecords: [a, b], files: [
        'data/travel_data.json', 'data/a.md', 'data/b.md', 'data/photos/shared/shared.png', 'data/photos/shared/a.png', 'data/profile/owner-name.txt'
    ].map(path => ({ path, size: 0 })) };
    const groups = recyclePartGroups(item);
    const keys = groups.flatMap(group => group.parts.map(part => part.key));
    assert.equal(keys.length, 7);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(!keys.includes('file:data/travel_data.json'));
    assert.deepEqual(groups.find(group => group.key === 'shared').parts.map(part => part.key), ['file:data/photos/shared/shared.png']);
    const before = structuredClone(item);
    const partial = selectRecycleParts(item, ['record:data/a.md', 'file:data/photos/shared/a.png'], []);
    assert.deepEqual(partial.files.map(file => file.path), ['data/photos/shared/a.png', 'data/a.md']);
    assert.deepEqual(partial.records[0].photos, ['a.png']);
    assert.deepEqual(item, before);
});

test('部分恢复纯附件保留合并能力，缺失原日记仍保留恢复关联用于校验', () => {
    const note = { date: '2026-11-12', desc_md: 'data/a.md', photo_folder: 'data/photos/a', photos: ['a.png', 'b.png'] };
    const items = ['a.png', 'b.png'].map((name, index) => ({ id: String(index), kind: 'files', records: [], mediaReferences: [note], files: [{ path: `data/photos/a/${name}` }] }));
    const selections = items.map(item => ({ id: item.id, parts: [`file:${item.files[0].path}`] }));
    assert.equal(recycleRestoreConflicts(items, [note], selections).length, 0);
    assert.deepEqual(selectRecycleParts(items[0], selections[0].parts, []).mediaReferences, [note]);
});


test('部分恢复共用文件保留原附件批次的关联，整站批次仅更新明确勾选的日记', () => {
    const a = { date: '2026-11-12', desc_md: 'data/a.md', photo_folder: 'data/photos/shared', photos: ['shared.png'] };
    const b = { ...a, desc_md: 'data/b.md' };
    const file = { path: 'data/photos/shared/shared.png', size: 1 };
    const media = { kind: 'files', records: [], mediaReferences: [a, b], files: [file] };
    assert.deepEqual(selectRecycleParts(media, [`file:${file.path}`], [a,b]).mediaReferences, [a,b]);
    const snapshot = { kind: 'snapshot', records: [], displayRecords: [a,b], files: [file,{path:'data/travel_data.json'}] };
    const current = [a,b].map(record => ({...record,photos:[]}));
    const partial = selectRecycleParts(snapshot, ['record:data/a.md', `file:${file.path}`], current);
    assert.equal(partial.records.length, 1);
    assert.equal(partial.records[0].desc_md, a.desc_md);
    assert.deepEqual(partial.records[0].photos, ['shared.png']);
    assert.deepEqual(partial.mediaReferences, [a]);
});
