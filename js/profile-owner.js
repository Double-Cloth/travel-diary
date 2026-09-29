const OWNER_NAME_PATH = 'data/profile/owner-name.txt';

export const DEFAULT_OWNER_NAME = '山川过客';
export const OWNER_NAME_MAX_LENGTH = 24;

export function normalizeOwnerName(value) {
    if (typeof value !== 'string') return '';
    return [...value.replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, OWNER_NAME_MAX_LENGTH).join('');
}

export async function loadOwnerName(cacheKey = '') {
    const ownerNameUrl = new URL(OWNER_NAME_PATH, window.location.href);
    if (cacheKey) ownerNameUrl.searchParams.set('v', cacheKey);
    try {
        const response = await fetch(ownerNameUrl, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) return DEFAULT_OWNER_NAME;
        return normalizeOwnerName(await response.text()) || DEFAULT_OWNER_NAME;
    } catch {
        return DEFAULT_OWNER_NAME;
    }
}

export async function saveOwnerName(name, capability) {
    if (!capability?.token || !capability.methods?.has('PUT')) {
        throw new Error('当前服务不支持修改署名。');
    }
    const normalized = normalizeOwnerName(name);
    if (!normalized) throw new Error('请输入扉页署名。');
    const endpoint = new URL('api/travel-profile', window.location.href);
    let response;
    try {
        response = await fetch(endpoint, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Travel-Token': capability.token
            },
            body: JSON.stringify({ name: normalized }),
            credentials: 'same-origin'
        });
    } catch {
        throw new Error('署名保存服务暂时无法连接，请稍后重试。');
    }
    let result = {};
    try { result = await response.json(); }
    catch {}
    if (!response.ok || result.saved !== true) {
        throw new Error(result.error || '署名保存失败，请稍后重试。');
    }
    return normalized;
}
