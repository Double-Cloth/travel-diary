import { recordIdentity, matchRecord } from './record-identity.mjs';
import { recordFilePaths } from './record-backup.mjs';
import { sourceOf, updateCrc, readSourceText } from './zip-stream.mjs';

export function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

export async function fileSignature(data) {
    const source = sourceOf(data);
    if (source.checksum !== undefined) return `${source.size}:${source.checksum}`;
    let crc = 0xffffffff;
    for await (const bytes of source.chunks()) crc = updateCrc(crc, bytes);
    return `${source.size}:${(crc ^ 0xffffffff) >>> 0}`;
}

export async function recordFingerprint(record, signatures) {
    const { record_id, ...metadata } = record;
    const content = canonical([metadata, [...recordFilePaths([record])].sort().map(name => [name, signatures[name] ?? 'missing'])]);
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function describeRecords(records, entries) {
    const files = new Map(entries.map(entry => [entry.name, entry.data]));
    const signatures = {};
    for (const name of recordFilePaths(records)) signatures[name] = files.has(name) ? await fileSignature(files.get(name)) : 'missing';
    const fingerprints = {};
    for (const record of records) fingerprints[recordIdentity(record)] = await recordFingerprint(record, signatures);
    return { records, signatures, fingerprints };
}

export async function compareBackup(records, entries, current) {
    const incoming = await describeRecords(records, entries);
    const files = new Map(entries.map(entry => [entry.name, entry.data]));
    const comparisons = new Map();
    for (const record of records) {
        let previous;
        try { previous = matchRecord(record, current.records); }
        catch (error) { comparisons.set(record.desc_md, { status: 'conflict', message: error.message }); continue; }
        const fingerprint = incoming.fingerprints[recordIdentity(record)];
        const expected = previous ? current.fingerprints[recordIdentity(previous)] : null;
        const status = !previous ? 'added' : fingerprint === expected ? 'same' : 'changed';
        const { record_id: ignored, ...metadata } = record;
        const oldMetadata = previous ? Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'record_id')) : {};
        const fields = [...new Set([...Object.keys(metadata), ...Object.keys(oldMetadata)])]
            .filter(key => canonical(metadata[key] ?? '') !== canonical(oldMetadata[key] ?? ''));
        const media = [...new Set([...recordFilePaths([record]), ...(previous ? recordFilePaths([previous]) : [])])]
            .filter(name => name !== record.desc_md && name !== previous?.desc_md)
            .filter(name => incoming.signatures[name] !== current.signatures[name]);
        comparisons.set(record.desc_md, { status, previous, expected, fields, media,
            markdown: new TextDecoder('utf-8', { fatal: true }).decode(await readSourceText(sourceOf(files.get(record.desc_md)))) });
    }
    return comparisons;
}
