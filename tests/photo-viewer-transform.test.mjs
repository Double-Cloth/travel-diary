import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getPhotoViewerZoomTranslate,
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

test('缩小显示时使用当前显示尺寸作为合成层，避免移动端大图缩小缺块', () => {
    const fitted = getPhotoViewerRenderMetrics({
        naturalWidth: 4000,
        naturalHeight: 2526,
        scale: 0.13
    });

    assert.equal(fitted.width, 520);
    assert.equal(fitted.height, 328.38);
    assert.equal(fitted.transformScale, 1);

    const zoomed = getPhotoViewerRenderMetrics({
        naturalWidth: 4000,
        naturalHeight: 2526,
        scale: 1
    });

    assert.equal(zoomed.width, 4000);
    assert.equal(zoomed.height, 2526);
    assert.equal(zoomed.transformScale, 1);
});

test('双指缩放围绕当前手势中心而不是照片中心放大', () => {
    const result = getPhotoViewerZoomTranslate({
        translateX: 20,
        translateY: -10,
        previousScale: 1,
        nextScale: 2,
        startFocalPoint: { x: 120, y: -80 },
        currentFocalPoint: { x: 135, y: -70 }
    });

    assert.deepEqual(result, {
        translateX: -65,
        translateY: 70
    });
});
