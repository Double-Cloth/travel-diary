const PHOTO_VIEWER_MIN_SCALE_BASE = 0.25;
const PHOTO_VIEWER_MIN_SCALE_RATIO = 0.5;
const PHOTO_VIEWER_MAX_SCALE_BASE = 5;
const PHOTO_VIEWER_MAX_SCALE_RATIO = 5;
const PHOTO_VIEWER_FIT_MIN_SCALE = 0.08;

export function getInitialPhotoScale({ stageWidth, stageHeight, naturalWidth, naturalHeight }) {
    if (!naturalWidth || !naturalHeight || !stageWidth || !stageHeight) {
        return 1;
    }

    const fitScale = Math.min(1, stageWidth / naturalWidth, stageHeight / naturalHeight);
    return Math.max(PHOTO_VIEWER_FIT_MIN_SCALE, fitScale);
}

export function getMinimumPhotoScale(initialScale = 1) {
    return Math.min(PHOTO_VIEWER_MIN_SCALE_BASE, initialScale * PHOTO_VIEWER_MIN_SCALE_RATIO);
}

export function getMaximumPhotoScale(initialScale = 1) {
    return Math.max(PHOTO_VIEWER_MAX_SCALE_BASE, initialScale * PHOTO_VIEWER_MAX_SCALE_RATIO);
}

export function getPhotoViewerBounds({ stageWidth, stageHeight, sourceWidth, sourceHeight, scale, rotation = 0 }) {
    if (!stageWidth || !stageHeight || !sourceWidth || !sourceHeight || !scale) {
        return null;
    }

    const radians = (Math.abs(rotation) % 180) * Math.PI / 180;
    const scaledWidth = sourceWidth * scale;
    const scaledHeight = sourceHeight * scale;
    const imageWidth = Math.abs(Math.cos(radians)) * scaledWidth + Math.abs(Math.sin(radians)) * scaledHeight;
    const imageHeight = Math.abs(Math.sin(radians)) * scaledWidth + Math.abs(Math.cos(radians)) * scaledHeight;

    return {
        stageWidth,
        stageHeight,
        imageWidth,
        imageHeight
    };
}

export function constrainPhotoViewerTranslate({ translateX, translateY, bounds }) {
    if (!bounds) {
        return {
            translateX,
            translateY
        };
    }

    const maxTranslateX = getPhotoViewerAxisTranslateLimit(bounds.stageWidth, bounds.imageWidth);
    const maxTranslateY = getPhotoViewerAxisTranslateLimit(bounds.stageHeight, bounds.imageHeight);

    return {
        translateX: clampTranslateAxis(translateX, maxTranslateX),
        translateY: clampTranslateAxis(translateY, maxTranslateY)
    };
}

export function getPhotoViewerRenderMetrics({ naturalWidth, naturalHeight, scale = 1 }) {
    if (!naturalWidth || !naturalHeight) {
        return null;
    }

    return {
        width: naturalWidth,
        height: naturalHeight,
        transformScale: scale
    };
}

function getPhotoViewerAxisTranslateLimit(stageSize, imageSize) {
    if (!stageSize || !imageSize || imageSize <= stageSize) {
        return 0;
    }

    return (imageSize - stageSize) / 2;
}

function clampTranslateAxis(value, maxTranslate) {
    if (maxTranslate === 0) {
        return 0;
    }

    return clamp(value, -maxTranslate, maxTranslate);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
