function writerError(message, code = 'WRITER_UNAVAILABLE') {
    return Object.assign(new Error(message), { code });
}

// 响应体仍属于请求过程，中断或网关错误不能作为密码校验结果使用。
export async function requestWriterJson(endpoint, options, interruptionMessage) {
    let response;
    let result;
    try {
        response = await fetch(endpoint, options);
        result = await response.json();
    } catch (error) {
        if (response && !options.signal?.aborted && !(error instanceof TypeError) && error?.name !== 'AbortError') {
            throw writerError(`服务器返回了无法识别的结果。${interruptionMessage}`,
                response.status >= 500 ? 'WRITER_UNAVAILABLE' : 'WRITER_INVALID_RESPONSE');
        }
        throw writerError(interruptionMessage, 'WRITER_UNREACHABLE');
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw writerError(`服务器返回了无法识别的结果。${interruptionMessage}`, 'WRITER_INVALID_RESPONSE');
    }
    if (response.status >= 500 && !result.code) {
        throw writerError(result.error || `服务器验证服务暂不可用。${interruptionMessage}`);
    }
    return { response, result };
}

function capabilityFrom(endpoint, result) {
    return {
        endpoint,
        token: result.token,
        methods: new Set(Array.isArray(result.methods) ? result.methods : []),
        writeMode: result.writeMode || '',
        syncMediaFiles: result.syncMediaFiles === true,
        mediaOrder: result.mediaOrder === true,
        mixedMediaOrder: result.mixedMediaOrder === true,
        partialRecords: result.partialRecords === true,
        recordManagement: result.recordManagement === true,
        mediaReferenceRemoval: result.mediaReferenceRemoval === true,
        recycleBin: result.recycleBin === true,
        recyclePreviews: result.recyclePreviews === true,
        recycleClear: result.recycleClear === true,
        recycleDiff: result.recycleDiff === true,
        recycleSelection: result.recycleSelection === true,
        batchDelete: result.batchDelete === true,
        recycleParts: result.recycleParts === true,
        recyclePurgeSelection: result.recyclePurgeSelection === true,
        authenticated: result.authenticated === true
    };
}

export async function probeWriterService(timeout = 4000) {
    const endpoint = new URL('api/travel-records', window.location.href);
    const { response, result } = await requestWriterJson(endpoint, {
        cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(timeout)
    }, '服务器写入服务暂时无法连接，请检查网络后重试。');
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
    const { response, result } = await requestWriterJson(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        cache: 'no-store',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(timeout)
    }, '服务器认证连接中断，请检查服务及网络后重新验证。');
    if (!response.ok || result?.service !== 'travel-diary-writer-v1'
        || !result.authenticated || !result.token) {
        throw writerError(result?.error || '未收到服务器确认的认证结果，请重新验证。',
            result?.code || (response.ok ? 'WRITER_INVALID_RESPONSE' : 'AUTH_INVALID'));
    }
    return capabilityFrom(new URL('api/travel-records', window.location.href), result);
}

export async function initializeWriterPassword(password, timeout = 15000) {
    const endpoint = new URL('api/travel-auth/setup', window.location.href);
    const { response, result } = await requestWriterJson(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        cache: 'no-store',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(timeout)
    }, '访问密码创建结果尚未确认，请恢复连接后重新打开验证入口核对。');
    if (!response.ok || result?.service !== 'travel-diary-writer-v1'
        || !result.authenticated || !result.token) {
        throw writerError(result?.error || '访问密码创建结果尚未确认，请重新打开验证入口核对。',
            result?.code || (response.ok ? 'WRITER_INVALID_RESPONSE' : 'AUTH_SETUP_FAILED'));
    }
    return capabilityFrom(new URL('api/travel-records', window.location.href), result);
}

export async function changeWriterPassword(password, capability, timeout = 15000) {
    if (!capability?.authenticated || !capability.token) {
        throw writerError('登录会话已失效，请重新输入当前密码。', 'AUTH_REQUIRED');
    }
    const endpoint = new URL('api/travel-auth', window.location.href);
    const { response, result } = await requestWriterJson(endpoint, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'X-Travel-Token': capability.token
        },
        body: JSON.stringify({ password }),
        cache: 'no-store',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(timeout)
    }, '访问密码修改结果尚未确认，请恢复连接后使用新密码验证，必要时再尝试原密码。');
    if (!response.ok || result?.service !== 'travel-diary-writer-v1'
        || !result.changed || !result.authenticated || !result.token) {
        throw writerError(result?.error || '访问密码修改结果尚未确认，请重新验证。',
            result?.code || (response.ok ? 'WRITER_INVALID_RESPONSE' : 'AUTH_CHANGE_FAILED'));
    }
    return capabilityFrom(new URL('api/travel-records', window.location.href), result);
}
