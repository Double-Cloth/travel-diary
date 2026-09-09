import { readFile } from 'node:fs/promises';

// 将浏览器 ES 模块转成 data URL，保持项目的 CommonJS 开发服务器配置。
export async function loadBrowserModule(file, extraSource = '') {
    return import(await buildModuleUrl(file, extraSource));
}

async function buildModuleUrl(file, extraSource = '') {
    let source = await readFile(file, 'utf8');
    const imports = [...source.matchAll(/from\s+(['"])(\.\/[^'"]+)\1/g)];
    for (const match of imports) {
        const dependency = new URL(match[2], file);
        const url = dependency.pathname.endsWith('.js')
            ? await buildModuleUrl(dependency)
            : dependency.href;
        source = source.replace(match[0], `from ${JSON.stringify(url)}`);
    }
    return `data:text/javascript;base64,${Buffer.from(source + '\n' + extraSource).toString('base64')}`;
}
