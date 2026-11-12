import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecycleTree, buildRestorePreviewTree, groupRecycleItems, recycleRestoreConflicts, recycleRecordLabel, recyclePartGroups, recycleDiaryGroups, recycleSelectionGroups, selectRecycleParts } from '../js/recycle-tree.mjs';

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
    assert.deepEqual(tree.get(`record:${records[0].desc_md}`).directories.map(node => node.name), ['图片']);
    assert.deepEqual(tree.get('shared').files.map(file => file.path), ['data/photos/trip/shared.jpg']);
    const info = tree.get(`record:${records[0].desc_md}`).files.find(file => file.label === '日记信息');
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
    assert.equal(tree.get(`record:${record.desc_md}`).files.length, 2);
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
    assert.deepEqual(tree.get('').directories.map(node => node.name), ['图片', '视频']);
    assert.equal(tree.get('type:1').count, 2);
    assert.equal(tree.get('type:1').totalBytes, 50);
    assert.ok(tree.get('').files.includes(files[4]));
    assert.ok(tree.get('').files.includes(files[0]));
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
    assert.equal(buildRecycleTree(files, '图片').get('').matches, true);
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
    assert.equal(tree.size, 1);
    assert.equal(tree.get('').depth, 0);
    assert.equal(tree.get('').count, 3);
    assert.equal(tree.get('').totalBytes, 6);
    assert.equal(tree.get('').files.length, 3);
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
    assert.equal(tree.get('shared').files[0].path, files[4].path);
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
    assert.deepEqual(tree.get('').directories.map(node => node.name), ['图片', '视频', '个人资料']);
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
    assert.deepEqual(tree.get('').directories, []);
    assert.equal(tree.get('').files[0].path, changes[0].record.desc_md);
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


test('按日记恢复自动包含正文和全部归档附件，共用文件去重且不更新未选日记', () => {
    const a = { date: '2026-11-12', desc_md: 'data/a.md', photo_folder: 'data/photos/trip', photos: ['shared.png', 'a.png'] };
    const b = { ...a, desc_md: 'data/b.md', photos: ['shared.png', 'b.png'] };
    for (const kind of ['snapshot', 'record', 'files']) {
        const item = { kind, records: kind === 'record' ? [a, b] : [], mediaReferences: kind === 'files' ? [a, b] : [],
            displayRecords: [a, b], files: ['data/travel_data.json', 'data/a.md', 'data/b.md', 'data/photos/trip/shared.png',
                'data/photos/trip/a.png', 'data/photos/trip/b.png', 'data/profile/owner-name.txt'].map(path => ({ path, size: 1 })) };
        const before = structuredClone(item);
        const groups = recycleDiaryGroups(item);
        assert.equal(groups.length, 2);
        assert.ok(groups.every(group => group.parts.some(part => part.key === 'file:data/photos/trip/shared.png')));
        const partial = selectRecycleParts(item, ['diary:data/a.md'], [a, { ...b, photos: [] }]);
        assert.deepEqual(partial.files.map(file => file.path), ['data/a.md', 'data/photos/trip/shared.png', 'data/photos/trip/a.png']);
        assert.ok([...partial.records, ...partial.mediaReferences, ...partial.displayRecords].every(record => record.desc_md === a.desc_md));
        const both = selectRecycleParts(item, ['diary:data/a.md', 'diary:data/b.md'], []);
        assert.equal(both.files.filter(file => file.path.endsWith('shared.png')).length, 1);
        assert.deepEqual(item, before);
        for (const parts of [['diary:data/missing.md'], ['diary:data/a.md', 'diary:data/a.md'], ['diary:data/a.md', 'file:data/a.md']]) {
            assert.throws(() => selectRecycleParts(item, parts, []), /恢复内容/);
        }
    }
});

test('仅共用附件的日记仍可整篇勾选，空正文与纯信息日记可在逻辑目录直接显示', () => {
    const a = { desc_md: 'data/a.md', photo_folder: 'data/photos/trip', photos: ['shared.png'] };
    const b = { ...a, desc_md: 'data/b.md' };
    const item = { kind: 'files', records: [], mediaReferences: [a, b], files: [{ path: 'data/photos/trip/shared.png', size: 0 }] };
    assert.equal(recycleDiaryGroups(item).length, 2);
    assert.deepEqual(selectRecycleParts(item, ['diary:data/a.md'], [a, b]).mediaReferences, [a]);
    const tree = buildRecycleTree([], '', { records: [a, b], includeEmptyRecords: true });
    assert.equal(tree.get('').directories.length, 2);
    assert.equal(tree.get('record:data/a.md').record, a);
    assert.equal(tree.get('').count, 0);
    assert.equal(buildRecycleTree([], '', { records: [a, b] }).get('').directories.length, 0);
    assert.equal(buildRecycleTree([], '', { records: [a], includeEmptyRecords: true, groupSingleRecord: true }).get('').directories.length, 1);
});

test('单一分类直接展示全部文件，保留排序、搜索、零字节与原始对象', () => {
    const files = ['10.jpg', '2.jpg', 'empty.jpg'].map((name, index) => ({ path: `data/photos/trip/${name}`, size: index }));
    const before = structuredClone(files);
    for (const query of ['', '图片', 'trip/10.jpg', '不存在']) {
        const tree = buildRecycleTree(files, query);
        const root = tree.get('');
        assert.equal(tree.size, 1);
        assert.deepEqual(root.directories, []);
        assert.deepEqual(root.files, [files[1], files[0], files[2]]);
        assert.equal(root.files[1], files[0]);
        assert.equal(root.count, 3);
        assert.equal(root.totalBytes, 3);
        assert.equal(root.matches, Boolean(query && query !== '不存在'));
    }
    assert.deepEqual(files, before);
});

test('单个正文与文件合并入口，多正文继续保留文件区分且统计搜索不变', () => {
    const body = { path: 'data/a.md', size: 0 };
    const photo = { path: 'data/photos/a.jpg', size: 8 };
    const tree = buildRecycleTree([body, photo], '正文');
    assert.deepEqual(tree.get('').files, [body]);
    assert.deepEqual(tree.get('').directories.map(node => node.name), ['图片']);
    assert.equal(tree.has('type:0'), false);
    assert.equal(tree.get('').count, 2);
    assert.equal(tree.get('').totalBytes, 8);
    assert.equal(tree.get('').matches, true);
    const second = { path: 'data/b.md', size: 3 };
    const multiple = buildRecycleTree([body, second, photo]);
    assert.deepEqual(multiple.get('type:0').files, [body, second]);
    assert.equal(multiple.get('').count, 3);
});

test('日记索引始终直接展示，混合目录和恢复预览只统计一次且保留搜索', () => {
    const index = { path: 'data/travel_data.json', size: 0 };
    const body = { path: 'data/a.md', size: 8 };
    for (const files of [[index], [index, body]]) {
        const tree = buildRecycleTree(files, '日记索引');
        const root = tree.get('');
        assert.equal(tree.has('type:4'), false);
        assert.ok(root.files.includes(index));
        assert.equal(root.count, files.length);
        assert.equal(root.totalBytes, files.length === 1 ? 0 : 8);
        assert.equal(root.matches, true);
    }
    const comparison = { status: 'changed', fields: [], markdownChanged: true, media: [] };
    const tree = buildRestorePreviewTree([
        { record: { desc_md: index.path }, comparison },
        { record: { date: '2026-11-12', desc_md: body.path }, comparison }
    ]);
    assert.equal(tree.get('').files[0].path, index.path);
    assert.equal(tree.get('').count, 2);
    assert.ok(tree.get('').directories.every(node => node.name !== '日记索引'));
});

test('索引旁仅剩一个分类时继续压扁，归档和恢复预览保留全部文件及统计', () => {
    const files = [
        { path: 'data/travel_data.json', size: 0 },
        { path: 'data/profile/owner-name.txt', size: 8 },
        { path: 'data/profile/profile-picture.png', size: 12 }
    ];
    const before = structuredClone(files);
    const tree = buildRecycleTree(files, '个人资料');
    const root = tree.get('');
    assert.equal(tree.size, 1);
    assert.deepEqual(root.directories, []);
    assert.equal(root.count, 3);
    assert.equal(root.totalBytes, 20);
    assert.equal(root.matches, true);
    assert.equal(root.files.length, 3);
    for (const file of files) assert.ok(root.files.includes(file));
    assert.deepEqual(files, before);
    const comparison = { status: 'changed', fields: [], markdownChanged: true, media: [] };
    const preview = buildRestorePreviewTree(files.slice(0, 2).map(file => ({ record: { desc_md: file.path }, comparison })));
    assert.equal(preview.size, 1);
    assert.equal(preview.get('').count, 2);
    assert.deepEqual(preview.get('').directories, []);
    assert.deepEqual(preview.get('').files.map(file => file.path).sort(), files.slice(0, 2).map(file => file.path).sort());
    const mixed = buildRecycleTree([...files, { path: 'data/a.md', size: 1 }]);
    assert.deepEqual(mixed.get('').directories.map(node => node.name), ['个人资料']);
    const record = { date: '2026-11-12', desc_md: 'data/a.md' };
    const diary = buildRecycleTree([files[0], { path: record.desc_md, size: 1 }], '', { records: [record], groupSingleRecord: true });
    assert.equal(diary.get('').directories[0].record, record);
    assert.equal(diary.get('').files[0], files[0]);
});

test('单篇日记的单一分类压扁后仍保留按篇选择入口，多分类继续分层', () => {
    const record = { date: '2026-11-12', desc_md: 'data/a.md', photo_folder: 'data/photos/a', photos: ['a.jpg'] };
    const body = { path: record.desc_md, size: 0 };
    const photo = { path: 'data/photos/a/a.jpg', size: 8 };
    const options = { records: [record], groupSingleRecord: true, includeEmptyRecords: true };
    const tree = buildRecycleTree([body], '正文', options);
    const diary = tree.get(`record:${record.desc_md}`);
    assert.deepEqual(tree.get('').directories, [diary]);
    assert.equal(diary.record, record);
    assert.equal(diary.depth, 1);
    assert.deepEqual(diary.directories, []);
    assert.deepEqual(diary.files, [body]);
    assert.equal(diary.matches, true);
    assert.equal(tree.size, 2);
    const mixed = buildRecycleTree([body, photo], '', options).get(diary.path);
    assert.deepEqual(mixed.directories.map(node => node.name), ['图片']);
    assert.ok(mixed.directories.every(node => node.depth === 2));
    assert.equal(mixed.count, 2);
    assert.equal(mixed.totalBytes, 8);
});

test('共用内容仅移除单一分类，空日记入口、未知文件和恢复范围保持独立', () => {
    const a = { desc_md: 'data/a.md', photo_folder: 'data/photos/trip', photos: ['shared.jpg'] };
    const b = { ...a, desc_md: 'data/b.md' };
    const shared = { path: 'data/photos/trip/shared.jpg', size: 10 };
    const unknown = { path: 'data/photos/unknown.jpg', size: 5 };
    const item = { kind: 'snapshot', records: [], displayRecords: [a, b], files: [shared, unknown] };
    const tree = buildRecycleTree(item.files, '图片', { displayRecords: item.displayRecords, includeEmptyRecords: true });
    const root = tree.get('');
    assert.deepEqual(root.directories.map(node => node.path), ['record:data/a.md', 'record:data/b.md', 'shared', 'type:1']);
    assert.equal(root.count, 2);
    assert.equal(root.totalBytes, 15);
    assert.equal(tree.get('record:data/a.md').count, 0);
    assert.equal(tree.get('record:data/b.md').record, b);
    assert.deepEqual(tree.get('shared').directories, []);
    assert.deepEqual(tree.get('shared').files, [shared]);
    assert.equal(tree.get('shared').matches, true);
    assert.deepEqual(tree.get('type:1').files, [unknown]);
    assert.deepEqual(selectRecycleParts(item, ['diary:data/a.md'], [a, b]).mediaReferences, [a]);
    const sharedOnly = buildRecycleTree([shared], '', { records: [a, b] });
    assert.deepEqual(sharedOnly.get('').directories, [sharedOnly.get('shared')]);
    assert.deepEqual(sharedOnly.get('shared').files, [shared]);
});

test('恢复预览同步压扁单一分类且保留差异数据、日记链接归属和文件索引', () => {
    const changes = ['a', 'b'].map(name => ({
        record: { date: '2026-11-12', desc_md: `data/${name}.md` },
        comparison: { status: 'changed', fields: [], markdownChanged: true, markdown: '# 正文', media: [] }
    }));
    const before = structuredClone(changes);
    const tree = buildRestorePreviewTree(changes);
    assert.equal(tree.size, 3);
    assert.equal(tree.get('').count, 2);
    for (const change of changes) {
        const diary = tree.get(`record:${change.record.desc_md}`);
        assert.equal(diary.record, change.record);
        assert.deepEqual(diary.directories, []);
        assert.equal(diary.files[0].path, change.record.desc_md);
        assert.equal(diary.files[0].record, change.record);
        assert.equal(diary.files[0].comparison.markdownChanged, true);
        assert.equal(diary.files[0].comparison.markdown, '# 正文');
    }
    const single = buildRestorePreviewTree([changes[0]], () => '', { groupSingleRecord: false });
    assert.equal(single.size, 1);
    assert.equal(single.get('').files[0].path, changes[0].record.desc_md);
    const info = buildRestorePreviewTree([{ ...changes[0], comparison: { status: 'changed', fields: ['title'], markdownChanged: false, media: [] } }]);
    assert.equal(info.get(`record:${changes[0].record.desc_md}`).files[0].label, '日记信息');
    assert.deepEqual(changes, before);
});

test('日记信息始终合并为一个入口，与正文和多种媒体并存时仍直接显示', () => {
    const record = { date: '2026-11-12', desc_md: 'data/a.md', photo_folder: 'data/photos/a', photos: ['a.jpg'], video_folder: 'data/videos/a', videos: ['a.mp4'] };
    for (const markdownChanged of [true, false]) {
        const comparison = { status: 'changed', fields: ['locality'], markdownChanged, media: ['data/photos/a/a.jpg', 'data/videos/a/a.mp4'] };
        const tree = buildRestorePreviewTree([{ record, comparison }], name => name.endsWith('.jpg') ? 'image' : name.endsWith('.mp4') ? 'video' : '');
        const diary = tree.get(`record:${record.desc_md}`);
        assert.deepEqual(diary.directories.map(node => node.name), ['图片', '视频']);
        assert.equal(diary.files.filter(file => file.label === '日记信息').length, 1);
        assert.equal(diary.files[0].label, '日记信息');
        if (markdownChanged) assert.equal(diary.files[1].comparison.markdownChanged, true);
        assert.equal(tree.has(`${diary.path}/type:0`), false);
        assert.equal(diary.count, markdownChanged ? 4 : 3);
        assert.equal(tree.get('').count, diary.count);
    }
});

test('个人资料可单独勾选或与日记混合选择，纯资料批次保留目录勾选入口', () => {
    const record = { date: '2026-11-12', desc_md: 'data/a.md' };
    const files = ['data/travel_data.json', record.desc_md, 'data/profile/owner-name.txt', 'data/profile/profile-picture.png']
        .map(path => ({ path, size: 1 }));
    const item = { kind: 'snapshot', displayRecords: [record], files };
    const original = structuredClone(item);
    assert.deepEqual(recycleSelectionGroups(item).map(group => group.key), ['diary:data/a.md', 'profile']);
    const profile = selectRecycleParts(item, ['profile'], [record]);
    assert.equal(profile.kind, 'version');
    assert.deepEqual(profile.files, files.slice(2));
    for (const key of ['records', 'mediaReferences', 'displayRecords']) assert.deepEqual(profile[key], []);
    const mixed = selectRecycleParts(item, ['profile', 'diary:data/a.md'], []);
    assert.deepEqual(mixed.files, files.slice(1));
    assert.equal(mixed.records.length, 1);
    assert.deepEqual(item, original);
    for (const parts of [['profile', 'profile'], ['profile', 'file:data/a.md']]) {
        assert.throws(() => selectRecycleParts(item, parts), /恢复内容/);
    }
    assert.throws(() => selectRecycleParts({ ...item, files: files.slice(0, 2) }, ['profile']), /恢复内容/);
    const tree = buildRecycleTree(files.filter(file => file.path !== record.desc_md), '', { preserveProfileGroup: true });
    assert.deepEqual(tree.get('').directories.map(node => node.name), ['个人资料']);
    assert.deepEqual(tree.get('').directories[0].files, files.slice(2));
});
