import test from 'node:test';
import assert from 'node:assert/strict';
import {
    constrainPhotoViewerTranslate,
    getPhotoViewerRenderMetrics
} from '../js/photo-viewer-transform.mjs';

test('缩小到小于舞台时照片平移会回到中心', () => {
    const result = constrainPhotoViewerTranslate({
        translateX: 420,
        translateY: -360,
        bounds: {
            stageWidth: 360,
            stageHeight: 610,
            imageWidth: 320,
            imageHeight: 202
        }
    });

    assert.deepEqual(result, {
        translateX: 0,
        translateY: 0
    });
});

test('大于舞台的照片只允许拖动到边缘贴合舞台', () => {
    const result = constrainPhotoViewerTranslate({
        translateX: 500,
        translateY: -500,
        bounds: {
            stageWidth: 360,
            stageHeight: 610,
            imageWidth: 1000,
            imageHeight: 800
        }
    });

    assert.deepEqual(result, {
        translateX: 320,
        translateY: -95
    });
});

test('手机适配比例作为图片渲染基准，避免缩小时保留超大合成层', () => {
    const fitted = getPhotoViewerRenderMetrics({
        naturalWidth: 4000,
        naturalHeight: 2526,
        initialScale: 0.13,
        scale: 0.13
    });

    assert.equal(fitted.width, 520);
    assert.equal(fitted.height, 328.38);
    assert.equal(fitted.transformScale, 1);

    const zoomed = getPhotoViewerRenderMetrics({
        naturalWidth: 4000,
        naturalHeight: 2526,
        initialScale: 0.13,
        scale: 1
    });

    assert.equal(zoomed.width, 520);
    assert.equal(zoomed.height, 328.38);
    assert.equal(Number(zoomed.transformScale.toFixed(4)), 7.6923);
});
