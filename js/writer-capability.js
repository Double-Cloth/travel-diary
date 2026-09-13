export async function detectWriterCapability(timeout = 4000) {
    const endpoint = new URL('api/travel-records', window.location.href);
    let response;
    let result;
    try {
        response = await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(timeout) });
        result = await response.json();
    } catch {
        throw new Error('当前站点未提供可用的服务器写入服务。');
    }
    if (!response.ok || result?.service !== 'travel-diary-writer-v1' || !result.token) {
        throw new Error(result?.error || '当前站点未提供可用的服务器写入服务。');
    }
    return {
        endpoint,
        token: result.token,
        methods: new Set(Array.isArray(result.methods) ? result.methods : ['POST']),
        writeMode: result.writeMode || ''
    };
}
