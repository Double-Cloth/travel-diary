// 公开路径仅影响响应 URL 和 Cookie，入口网关须先剥离此前缀。
function normalizeBasePath(value) {
    if (value === '/') return '/';
    if (typeof value !== 'string' || value.length > 256
        || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/.test(value)) {
        throw new Error('basePath 必须是 / 或由字母、数字、下划线、短横线组成的绝对路径。');
    }
    return value.replace(/\/$/, '');
}

function normalizePublicOrigin(value) {
    if (value === '') return '';
    try {
        if (typeof value !== 'string' || !/^https:\/\/[^\s/?#\\@]+$/.test(value) || value.endsWith(':')) throw new Error();
        const origin = new URL(value);
        if (!origin.hostname || origin.port === '0' || origin.username || origin.password || origin.pathname !== '/') throw new Error();
        return origin.origin;
    } catch {
        throw new Error('publicOrigin 必须是完整 HTTPS Origin，可含端口，不能包含路径、查询、片段或用户信息。');
    }
}

module.exports = { normalizeBasePath, normalizePublicOrigin };
