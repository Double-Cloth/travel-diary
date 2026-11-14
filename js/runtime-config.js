const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILENAME = 'travel-diary.config.json';
const LOCAL_CONFIG_FILENAME = 'travel-diary.config.local.json';
const DEFAULT_CONFIG = {
    server: { port: 9000, local: true, maxPortRetries: 100, writeMode: 'local', allowedOrigins: [] },
    mediaPreviews: { enabled: true, browserPath: '', progressTimeoutMs: 70000 }
};

function validateKeys(value, defaults, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 必须是 JSON 对象。`);
    }
    for (const key of Object.keys(value)) {
        if (!Object.hasOwn(defaults, key)) throw new Error(`${label} 包含未知配置项：${key}`);
    }
}

function validateInteger(value, minimum, maximum, label) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
    }
}

function readConfigFile(file) {
    let saved = {};
    try {
        saved = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`无法读取配置文件 ${file}：${error.message}`);
    }
    validateKeys(saved, { ...DEFAULT_CONFIG, $schema: '' }, file);
    if (saved.$schema !== undefined && typeof saved.$schema !== 'string') {
        throw new Error(`${file} 的 $schema 必须是字符串。`);
    }
    for (const section of Object.keys(DEFAULT_CONFIG)) {
        if (saved[section] !== undefined) validateKeys(saved[section], DEFAULT_CONFIG[section], `${file}.${section}`);
    }
    return saved;
}

function loadRuntimeConfig(root) {
    const config = {};
    for (const section of Object.keys(DEFAULT_CONFIG)) {
        config[section] = { ...DEFAULT_CONFIG[section] };
    }
    for (const name of [CONFIG_FILENAME, LOCAL_CONFIG_FILENAME]) {
        const file = path.resolve(root, name);
        const saved = readConfigFile(file);
        for (const section of Object.keys(DEFAULT_CONFIG)) {
            Object.assign(config[section], saved[section]);
        }
        try {
            validateConfig(config);
        } catch (error) {
            throw new Error(`配置文件 ${file} 无效：${error.message}`);
        }
    }
    const { server, mediaPreviews } = config;
    server.allowedOrigins = [...server.allowedOrigins];
    if (mediaPreviews.browserPath.trim()) mediaPreviews.browserPath = path.resolve(root, mediaPreviews.browserPath.trim());
    else mediaPreviews.browserPath = '';
    return config;
}

function validateConfig(config) {
    const { server, mediaPreviews } = config;
    validateInteger(server.port, 1, 65535, 'server.port');
    validateInteger(server.maxPortRetries, 1, 65535, 'server.maxPortRetries');
    validateInteger(mediaPreviews.progressTimeoutMs, 1000, 2147483647, 'mediaPreviews.progressTimeoutMs');
    if (typeof server.local !== 'boolean') throw new Error('server.local 必须是布尔值。');
    if (!['local', 'remote'].includes(server.writeMode)) throw new Error('server.writeMode 必须是 local 或 remote。');
    if (!Array.isArray(server.allowedOrigins) || server.allowedOrigins.some(value => typeof value !== 'string')) {
        throw new Error('server.allowedOrigins 必须是 HTTPS Origin 字符串数组。');
    }
    if (typeof mediaPreviews.enabled !== 'boolean') throw new Error('mediaPreviews.enabled 必须是布尔值。');
    if (typeof mediaPreviews.browserPath !== 'string' || mediaPreviews.browserPath.includes('\0')) {
        throw new Error('mediaPreviews.browserPath 必须是有效的路径字符串。');
    }
}

module.exports = { CONFIG_FILENAME, LOCAL_CONFIG_FILENAME, loadRuntimeConfig };
