import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecycleTree } from '../js/recycle-tree.mjs';

test('回收目录保留正文、媒体与根文件的原路径并汇总子目录大小', () => {
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
    assert.equal(tree.get('data/photos/trip').count, 2);
    assert.equal(tree.get('data/photos/trip').totalBytes, 50);
    assert.deepEqual(tree.get('data').directories.map(node => node.name), ['photos', 'travel-diary', 'videos']);
    assert.equal(tree.get('data').files[0], files[4]);
    assert.equal(tree.get('data/photos/trip/day1').files[0], files[1]);
    assert.equal(tree.get('data/photos/trip/day2').files[0], files[2]);
    assert.deepEqual(files, before);
});

test('目录与文件自然排序，大小写和特殊名称独立保留', () => {
    const names = ['data/photos/day10/a.jpg', 'data/photos/day2/10.jpg', 'data/photos/day2/2.jpg',
        'data/photos/Trip/a.jpg', 'data/photos/trip/b.jpg', 'data/photos/__proto__/x.jpg', 'data/<旧目录>/"文件".txt'];
    const tree = buildRecycleTree(names.map(path => ({ path, size: 0 })));
    assert.deepEqual(tree.get('data/photos/day2').files.map(file => file.path.split('/').pop()), ['2.jpg', '10.jpg']);
    const directories = tree.get('data/photos').directories.map(node => node.name);
    assert.ok(directories.indexOf('day2') < directories.indexOf('day10'));
    assert.ok(tree.has('data/photos/Trip') && tree.has('data/photos/trip'));
    assert.equal(tree.get('data/photos/__proto__').count, 1);
    assert.equal(tree.get('data/<旧目录>').files[0].path, names.at(-1));
});

test('路径搜索标记所有祖先，旧批次与空批次均可建立目录', () => {
    const files = [{ path: 'data/photos/trip/old.JPG', size: 7 }, { path: 'data/profile/name.txt', size: 3 }];
    const tree = buildRecycleTree(files, ' OLD.jpg ');
    for (const name of ['', 'data', 'data/photos', 'data/photos/trip']) assert.equal(tree.get(name).matches, true);
    assert.equal(tree.get('data/profile').matches, false);
    const empty = buildRecycleTree([]).get('');
    assert.equal(empty.count, 0);
    assert.equal(empty.totalBytes, 0);
    assert.deepEqual(empty.directories, []);
    assert.deepEqual(empty.files, []);
    assert.notEqual(buildRecycleTree(files).get('data'), tree.get('data'));
});

test('极深目录使用迭代建树，文件或目录同名时分别保留', () => {
    const deepPath = `data/${Array(1500).fill('level').join('/')}/a.txt`;
    const tree = buildRecycleTree([{ path: deepPath, size: 1 }, { path: 'data/old', size: 2 }, { path: 'data/old/a.txt', size: 3 }]);
    assert.equal(tree.get(deepPath.slice(0, -6)).depth, 1501);
    assert.equal(tree.get('data').count, 3);
    assert.equal(tree.get('data').totalBytes, 6);
    assert.equal(tree.get('data').files[0].path, 'data/old');
    assert.equal(tree.get('data/old').files[0].path, 'data/old/a.txt');
});
