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

test('图片始终以原图尺寸作为渲染基准，初始缩放只影响变换倍率', () => {
    const fitted = getPhotoViewerRenderMetrics({
        naturalWidth: 4000,
        naturalHeight: 2526,
        scale: 0.13
    });

    assert.equal(fitted.width, 4000);
    assert.equal(fitted.height, 2526);
    assert.equal(fitted.transformScale, 0.13);

    const zoomed = getPhotoViewerRenderMetrics({
        naturalWidth: 4000,
        naturalHeight: 2526,
        scale: 1
    });

    assert.equal(zoomed.width, 4000);
    assert.equal(zoomed.height, 2526);
    assert.equal(zoomed.transformScale, 1);
});
