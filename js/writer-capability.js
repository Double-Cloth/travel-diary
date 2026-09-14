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
        throw writerError('服务器写入服务暂时无法连接，请检查网络后重试。', 'WRITER_UNREACHABLE');
    }
    const result = await readResult(response);
    if (result?.service === 'travel-diary-static-v1' && result.readonly === true) {
        throw writerError('当前站点为静态只读页面。', 'STATIC_READONLY');
    }
    if (result?.service !== 'travel-diary-writer-v1') {
        throw writerError(
            result?.error || '服务器写入服务返回了无法识别的结果，请稍后重试。',
            'WRITER_INVALID_RESPONSE'
        );
    }
    if (response.status !== 401 && (response.ok === false || response.status < 200 || response.status >= 300)) {
        throw writerError(
            result?.error || '服务器写入服务暂时不可用，请稍后重试。',
            result?.code || 'WRITER_UNAVAILABLE'
        );
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

export async function initializeWriterPassword(password, timeout = 15000) {
    const endpoint = new URL('api/travel-auth/setup', window.location.href);
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
        throw writerError('当前站点未提供可用的首次密码设置服务。');
    }
    const result = await readResult(response);
    if (!response.ok || result?.service !== 'travel-diary-writer-v1'
        || !result.authenticated || !result.token) {
        throw writerError(result?.error || '访问密码创建失败。', result?.code || 'AUTH_SETUP_FAILED');
    }
    return capabilityFrom(new URL('api/travel-records', window.location.href), result);
}
