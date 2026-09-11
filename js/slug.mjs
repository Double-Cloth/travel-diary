import './vendor/pinyin-pro.mjs';

const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const PLACE_SUFFIX = /(?:特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|自治县|市辖区|行政区|地区|新区|林区|矿区|省|市|州|盟|县|区|旗)$/u;

function stripPlaceSuffix(value) {
    return value.replace(PLACE_SUFFIX, '') || value;
}

function fallbackSlug(value, fallback) {
    if (fallback) return fallback;
    let hash = 2166136261;
    for (const character of value) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return `travel-${(hash >>> 0).toString(36)}`;
}

export function pinyinSlug(value, fallback = 'travel', options = {}) {
    const normalized = String(value || '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
    const source = options.keepPlaceSuffix ? normalized : stripPlaceSuffix(normalized);
    const transliterated = globalThis.pinyinPro.pinyin(source, {
        toneType: 'none',
        type: 'array',
        nonZh: 'consecutive',
        v: 'v'
    }).join('');
    const slug = transliterated.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/ü/g, 'v')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/\.+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[._-]+|[._-]+$/g, '')
        .slice(0, 120);
    return slug && !RESERVED_NAMES.test(slug) ? slug : fallbackSlug(normalized, fallback);
}

export function isSafeAsciiFileName(name) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
        && !name.includes('..')
        && !name.endsWith('.')
        && !RESERVED_NAMES.test(name.replace(/\..*$/, ''));
}
