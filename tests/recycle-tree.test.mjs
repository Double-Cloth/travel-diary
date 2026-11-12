import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecycleTree, recycleRecordLabel } from '../js/recycle-tree.mjs';

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
