const MAXIMUM_SOURCE_BYTES = 12 * 1024 * 1024;
const MAXIMUM_EDGE = 1024;
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function loadImageElement(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => resolve({
            width: image.naturalWidth,
            height: image.naturalHeight,
            draw: (context, width, height) => context.drawImage(image, 0, 0, width, height),
            close: () => URL.revokeObjectURL(url)
        });
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('无法读取所选图片，请换一张后重试。'));
        };
        image.src = url;
    });
}

async function loadImageSource(file) {
    if (typeof createImageBitmap !== 'function') return loadImageElement(file);
    try {
        const bitmap = await createImageBitmap(file);
        return {
            width: bitmap.width,
            height: bitmap.height,
            draw: (context, width, height) => context.drawImage(bitmap, 0, 0, width, height),
            close: () => bitmap.close()
        };
    } catch {
        return loadImageElement(file);
    }
}

function canvasToPng(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error('头像转换失败，请换一张图片后重试。'));
        }, 'image/png');
    });
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const value = typeof reader.result === 'string' ? reader.result : '';
            const separator = value.indexOf(',');
            if (separator < 0) reject(new Error('头像编码失败，请重试。'));
            else resolve(value.slice(separator + 1));
        };
        reader.onerror = () => reject(new Error('头像编码失败，请重试。'));
        reader.readAsDataURL(blob);
    });
}

export async function prepareProfilePicture(file) {
    if (!file || !SUPPORTED_IMAGE_TYPES.has(file.type)) {
        throw new Error('请选择 JPEG、PNG、GIF 或 WebP 图片。');
    }
    if (!file.size || file.size > MAXIMUM_SOURCE_BYTES) {
        throw new Error('头像图片不能超过 12 MB。');
    }

    const source = await loadImageSource(file);
    try {
        if (!source.width || !source.height) throw new Error('所选图片尺寸无效。');
        const scale = Math.min(1, MAXIMUM_EDGE / Math.max(source.width, source.height));
        const width = Math.max(1, Math.round(source.width * scale));
        const height = Math.max(1, Math.round(source.height * scale));
        const outputCanvas = document.createElement('canvas');
        outputCanvas.width = width;
        outputCanvas.height = height;
        const outputContext = outputCanvas.getContext('2d');
        if (!outputContext) throw new Error('当前浏览器无法处理头像图片。');
        outputContext.imageSmoothingEnabled = true;
        outputContext.imageSmoothingQuality = 'high';
        source.draw(outputContext, width, height);
        const png = await canvasToPng(outputCanvas);
        return { data: await blobToBase64(png) };
    } finally {
        source.close();
    }
}

export async function uploadProfilePicture(picture, capability) {
    if (!capability?.token || !capability.methods?.has('PUT')) {
        throw new Error('当前服务不支持更新头像。');
    }
    const endpoint = new URL('api/travel-profile', window.location.href);
    let response;
    try {
        response = await fetch(endpoint, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Travel-Token': capability.token
            },
            body: JSON.stringify(picture),
            credentials: 'same-origin'
        });
    } catch {
        throw new Error('头像上传服务暂时无法连接，请稍后重试。');
    }
    let result = {};
    try { result = await response.json(); }
    catch {}
    if (!response.ok || result.saved !== true) {
        throw new Error(result.error || '头像上传失败，请稍后重试。');
    }
    return result;
}
