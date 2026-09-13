function writerError(message, code = 'WRITER_UNAVAILABLE') {
    return Object.assign(new Error(message), { code });
}

async function readResult(response) {
    try { return await response.json(); }
    catch { return {}; }
}

function capabilityFrom(endpoint, result) {
    return {
        endpoint,
        token: result.token,
        methods: new Set(Array.isArray(result.methods) ? result.methods : []),
        writeMode: result.writeMode || '',
        authenticated: result.authenticated === true
    };
}

export async function probeWriterService(timeout = 4000) {
    const endpoint = new URL('api/travel-records', window.location.href);
    let response;
    try {
        response = await fetch(endpoint, {
            cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(timeout)
        });
    } catch {
        throw writerError('当前站点未提供可用的服务器写入服务。');
    }
    const result = await readResult(response);
    if (result?.service !== 'travel-diary-writer-v1') {
        throw writerError(result?.error || '当前站点未提供可用的服务器写入服务。');
    }
    return { ...capabilityFrom(endpoint, result), status: response.status };
}

export async function detectWriterCapability(timeout = 4000) {
    const capability = await probeWriterService(timeout);
    if (!capability.authenticated || !capability.token) {
        throw writerError('请输入访问口令后继续。', 'AUTH_REQUIRED');
    }
    return capability;
}

export async function authenticateWriter(password, timeout = 15000) {
    const endpoint = new URL('api/travel-auth', window.location.href);
    let response;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
            cache: 'no-store',
            credentials: 'same-origin',
            signal: AbortSignal.timeout(timeout)
        });
    } catch {
        throw writerError('当前站点未提供可用的服务器认证服务。');
    }
    const result = await readResult(response);
    if (!response.ok || result?.service !== 'travel-diary-writer-v1'
        || !result.authenticated || !result.token) {
        throw writerError(result?.error || '访问口令验证失败。', result?.code || 'AUTH_INVALID');
    }
    return capabilityFrom(new URL('api/travel-records', window.location.href), result);
}
