import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const AUTH_PASSWORD = '483920';
export const AUTH_CONFIG = Object.freeze({
    version: 1,
    algorithm: 'scrypt',
    salt: 'MDEyMzQ1Njc4OWFiY2RlZg==',
    hash: 'TjGzYhK4G4S1xMNE7O6jYCwO8ZC9EaDjjeewpmFnUhs=',
    keyLength: 32,
    cost: { N: 32768, r: 8, p: 1 },
    policy: { format: 'digits', length: 6, productionReady: true }
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
