const fs = require('fs/promises');
const path = require('path');
const { createMediaPreviewStore, findFfmpeg } = require('../js/media-preview-store.js');

async function main() {
    const root = await fs.realpath(path.resolve(process.argv[2] || '.'));
    const records = JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8'));
    const getPreview = createMediaPreviewStore(root, { ffmpegPath: findFfmpeg(path.resolve(__dirname, '..')) });
    const sources = new Set(records.flatMap(record => [
        ...(record.photo_folder ? (record.photos || []).map(name => `${record.photo_folder}/${name}`) : []),
        ...(record.video_folder ? (record.videos || []).map(name => `${record.video_folder}/${name}`) : [])
    ]));
    let built = 0;
    let missing = 0;
    for (const source of sources) {
        const previewPath = source.replace(/^data\/(photos|videos)\//, '/data/previews/$1/') + '.jpg';
        try {
            await getPreview(previewPath);
            built += 1;
        } catch (error) {
            if (error.code !== 'ENOENT') throw new Error(`无法生成 ${source} 的预览：${error.message}`);
            missing += 1;
        }
    }
    console.log(`媒体预览：${built} 项已就绪，${missing} 项原文件缺失。`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
