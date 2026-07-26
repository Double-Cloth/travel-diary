import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const gitignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const dataJs = await readFile(new URL('../js/data.js', import.meta.url), 'utf8');

test('离线启动只依赖 Node 和仓库内文件', () => {
    assert.equal(packageJson.scripts.start, 'node js/server.js');
    assert.equal(packageJson.scripts.serve, 'node js/server.js');
    assert.doesNotMatch(packageJson.scripts.start, /npm run|npx|pip|fetch|curl|countries|fonts/);
    assert.deepEqual(packageLock.packages?.['']?.dependencies || {}, {});
});

test('浏览器入口没有远程资源', async () => {
    const resourcePaths = Array.from(
        indexHtml.matchAll(/\b(?:src|href)="([^"]+)"/g),
        match => match[1]
    ).filter(resourcePath => !/^(?:#|data:|mailto:)/i.test(resourcePath));

    assert.ok(resourcePaths.length > 0);

    for (const resourcePath of resourcePaths) {
        assert.doesNotMatch(resourcePath, /^(?:https?:)?\/\//i);
        await assertLocalFile(resolve(projectRoot, stripQueryAndHash(resourcePath)), resourcePath);
    }
});

test('样式引用的字体、图片和纹理全部存在于本地', async () => {
    const cssDirectory = resolve(projectRoot, 'css');
    const cssFiles = (await readdir(cssDirectory)).filter(fileName => fileName.endsWith('.css'));
    let localAssetCount = 0;

    for (const cssFile of cssFiles) {
        const cssPath = resolve(cssDirectory, cssFile);
        const css = await readFile(cssPath, 'utf8');
        const resourcePaths = Array.from(
            css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g),
            match => match[2]
        ).filter(resourcePath => !resourcePath.startsWith('data:'));

        for (const resourcePath of resourcePaths) {
            assert.doesNotMatch(resourcePath, /^(?:https?:)?\/\//i);
            await assertLocalFile(
                resolve(dirname(cssPath), stripQueryAndHash(resourcePath)),
                `${cssFile}: ${resourcePath}`
            );
            localAssetCount += 1;
        }
    }

    assert.ok(localAssetCount > 0);
});

test('压缩字体随项目分发且不会再被忽略', async () => {
    const fontFiles = [
        'LXGWWenKaiMono-Regular-subset.woff2',
        'LXGWWenKaiMono-Medium-subset.woff2',
        'SourceCodePro-Regular-subset.woff2',
        'SourceCodePro-Bold-subset.woff2'
    ];

    assert.doesNotMatch(gitignore, /assets\/fonts\/\*-subset\.woff2/);

    for (const fontFile of fontFiles) {
        await assertLocalFile(resolve(projectRoot, 'assets', 'fonts', fontFile), fontFile);
    }
});

test('运行时数据请求只根据当前本地页面解析', () => {
    assert.match(dataJs, /new URL\('data\/travel_data\.json', window\.location\.href\)/);
    assert.match(dataJs, /new URL\('data\/countries\.json', window\.location\.href\)/);
    assert.match(dataJs, /new URL\(markdownPath, window\.location\.href\)/);
    assert.doesNotMatch(dataJs, /https?:\/\//);
});

async function assertLocalFile(filePath, label) {
    const fileStat = await stat(filePath);
    assert.ok(fileStat.isFile(), `${label} 必须对应本地文件`);
    assert.ok(fileStat.size > 0, `${label} 不能为空`);
}

function stripQueryAndHash(resourcePath) {
    return resourcePath.split(/[?#]/, 1)[0];
}
