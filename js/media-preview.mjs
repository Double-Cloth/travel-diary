// 保留原扩展名，避免同名图片或视频的预览互相覆盖；输入为已编码的项目相对 URL。
export function getMediaPreviewUrl(src) {
    if (typeof src !== 'string' || !/^data\/(photos|videos)\/.+/.test(src)) return '';
    return src.replace(/^data\/(photos|videos)\//, 'data/previews/$1/') + '.jpg';
}
