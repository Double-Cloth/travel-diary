import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const AUTH_PASSWORD = 'correct horse battery staple';
export const AUTH_CONFIG = Object.freeze({
    version: 1,
    algorithm: 'scrypt',
    salt: 'MDEyMzQ1Njc4OWFiY2RlZg==',
    hash: '9rcVF+DZ8uU77qz3H/v29+n2g8c877AOCRXSQvC/fs0=',
    keyLength: 32,
    cost: { N: 32768, r: 8, p: 1 },
    policy: { minimumLength: 16, productionReady: true }
});

export async function installAuth(root, config = AUTH_CONFIG) {
    await mkdir(path.join(root, '.secrets'), { recursive: true });
    await writeFile(path.join(root, '.secrets/auth.json'), `${JSON.stringify(config, null, 2)}\n`);
}

export async function login(base, { origin = base, host } = {}) {
    const response = await fetch(`${base}/api/travel-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, ...(host ? { Host: host } : {}) },
        body: JSON.stringify({ password: AUTH_PASSWORD })
    });
    const result = await response.json();
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] || '';
    return { response, result, cookie, token: result.token };
}
