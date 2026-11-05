import { recordIdentity, matchRecord } from './record-identity.mjs?v=2.1.66';
import { recordFilePaths } from './record-backup.mjs?v=2.1.66';
import { sourceOf, updateCrc, readSourceText } from './zip-stream.mjs';

export function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

export async function fileSignature(data, { signal } = {}) {
    signal?.throwIfAborted();
    const source = sourceOf(data);
    if (source.checksum !== undefined) return `${source.size}:${source.checksum}`;
    let crc = 0xffffffff;
    for await (const bytes of source.chunks()) {
        signal?.throwIfAborted();
        crc = updateCrc(crc, bytes);
    }
    return `${source.size}:${(crc ^ 0xffffffff) >>> 0}`;
}

export async function recordFingerprint(record, signatures) {
    const { record_id, ...metadata } = record;
    const content = canonical([metadata, [...recordFilePaths([record])].sort().map(name => [name, signatures[name] ?? 'missing'])]);
    const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function describeRecords(records, entries, { signal } = {}) {
    const files = new Map(entries.map(entry => [entry.name, entry.data]));
    const signatures = {};
    for (const name of recordFilePaths(records)) {
        signal?.throwIfAborted();
        signatures[name] = files.has(name) ? await fileSignature(files.get(name), { signal }) : 'missing';
    }
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
        const previousMediaPaths = previous ? recordFilePaths([previous]) : new Set();
        const incomingMediaPaths = recordFilePaths([record]);
        const media = [...new Set([...incomingMediaPaths, ...previousMediaPaths])]
            .filter(name => name !== record.desc_md && name !== previous?.desc_md)
            .filter(name => previousMediaPaths.has(name) !== incomingMediaPaths.has(name) || incoming.signatures[name] !== current.signatures[name]);
        comparisons.set(record.desc_md, { status, previous, expected, fields, media,
            previousMediaPaths, incomingMediaPaths,
            markdownChanged: !previous || incoming.signatures[record.desc_md] !== current.signatures[previous.desc_md],
            markdown: files.has(record.desc_md) ? new TextDecoder('utf-8', { fatal: true }).decode(await readSourceText(sourceOf(files.get(record.desc_md)))) : '' });
    }
    return comparisons;
}

// 以相同行为锚点对齐，仅返回改动块；比较工作量设上限，长正文不会阻塞界面。
export function changedTextBlocks(before, after) {
    before = String(before ?? '');
    after = String(after ?? '');
    if (before === after) return [];
    const left = before ? before.split('\n') : [];
    const right = after ? after.split('\n') : [];
    const positions = new Map();
    right.forEach((line, index) => {
        if (!positions.has(line)) positions.set(line, []);
        positions.get(line).push(index);
    });
    const blocks = [];
    let a = 0;
    let b = 0;
    let work = 0;
    while (a < left.length || b < right.length) {
        if (a < left.length && b < right.length && left[a] === right[b]) { a++; b++; continue; }
        const startA = a;
        const startB = b;
        let anchor;
        // 按行索引查找最近公共行，长段新增也不会把后面的相同段落列为差异。
        let distance = Infinity;
        for (let i = a; i < left.length && i - a < distance && work < 500000; i++) {
            work++;
            const matches = positions.get(left[i]);
            if (!matches) continue;
            let low = 0;
            let high = matches.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (matches[middle] < b) low = middle + 1;
                else high = middle;
            }
            const j = matches[low];
            if (j !== undefined && i - a + j - b < distance) { distance = i - a + j - b; anchor = [i, j]; }
        }
        if (anchor) [a, b] = anchor;
        else {
            let endA = left.length;
            let endB = right.length;
            while (endA > a && endB > b && left[endA - 1] === right[endB - 1]) { endA--; endB--; }
            blocks.push({ before: left.slice(a, endA).join('\n'), after: right.slice(b, endB).join('\n'), lineBefore: a + 1, lineAfter: b + 1, countBefore: endA - a, countAfter: endB - b });
            break;
        }
        blocks.push({ before: left.slice(startA, a).join('\n'), after: right.slice(startB, b).join('\n'), lineBefore: startA + 1, lineAfter: startB + 1, countBefore: a - startA, countAfter: b - startB });
    }
    return blocks;
}
