const DEFAULT_LOCATION_LABELS = Object.freeze({
    adminArea: '一级行政区',
    adminAreaOption: '州 / 省 / 地区',
    locality: '城市 / 目的地'
});

const COUNTRY_PROFILES = new Map();
const COUNTRY_NAME_TO_CODE = new Map();
let configuredLocationLabels = DEFAULT_LOCATION_LABELS;

export function configureCountryCatalog(catalog = {}) {
    const countries = Array.isArray(catalog) ? catalog : catalog.countries;
    if (!Array.isArray(countries)) {
        throw new Error('Country catalog must contain a countries array.');
    }

    const defaults = Array.isArray(catalog) ? {} : (catalog.defaults || {});
    configuredLocationLabels = {
        adminArea: cleanText(defaults.admin_area_label) || DEFAULT_LOCATION_LABELS.adminArea,
        adminAreaOption: cleanText(defaults.admin_area_option) || DEFAULT_LOCATION_LABELS.adminAreaOption,
        locality: cleanText(defaults.locality_label) || DEFAULT_LOCATION_LABELS.locality
    };
    COUNTRY_PROFILES.clear();
    COUNTRY_NAME_TO_CODE.clear();

    countries.forEach((country) => {
        const code = cleanText(country.code).toUpperCase();
        if (!/^[A-Z]{2}$/.test(code)) return;

        const names = [
            country.name_zh,
            country.name_en,
            country.alpha3,
            country.numeric,
            ...(Array.isArray(country.aliases) ? country.aliases : [])
        ].map(cleanText).filter(Boolean);
        const profile = {
            names,
            adminArea: cleanText(country.admin_area_label) || configuredLocationLabels.adminArea,
            adminAreaOption: cleanText(country.admin_area_option) || configuredLocationLabels.adminAreaOption,
            locality: configuredLocationLabels.locality,
            adminAreaOptional: Boolean(country.admin_area_optional),
            domestic: Boolean(country.domestic)
        };

        COUNTRY_PROFILES.set(code, profile);
        COUNTRY_NAME_TO_CODE.set(code.toLocaleLowerCase(), code);
        names.forEach(name => COUNTRY_NAME_TO_CODE.set(name.toLocaleLowerCase(), code));
    });

    return COUNTRY_PROFILES.size;
}

export function getConfiguredCountryCount() {
    return COUNTRY_PROFILES.size;
}

export function normalizeTravelLocation(record = {}) {
    const country = cleanText(record.country) || '未知国家/地区';
    const countryCode = normalizeCountryCode(record.country_code || record.countryCode, country);
    const adminArea = firstText(record.admin_area, record.adminArea, record.province);
    const locality = firstText(record.locality, record.city, adminArea, country);
    const adminAreaType = firstText(
        record.admin_area_type,
        record.adminAreaType,
        inferAdminAreaType(adminArea, countryCode)
    );
    const localityType = firstText(record.locality_type, record.localityType);
    const countryKey = countryCode || country;
    const adminAreaKey = adminArea ? createLocationKey(countryKey, adminArea) : '';
    const locationKey = createLocationKey(countryKey, adminArea, locality);

    return {
        ...record,
        country,
        countryCode,
        adminArea,
        adminAreaType,
        locality,
        localityType,
        countryKey,
        adminAreaKey,
        locationKey
    };
}

export function normalizeCountryCode(value, country = '') {
    const explicitCode = cleanText(value).toUpperCase();
    if (/^[A-Z]{2}$/.test(explicitCode)) {
        return explicitCode;
    }

    return COUNTRY_NAME_TO_CODE.get(cleanText(country).toLocaleLowerCase()) || '';
}

export function getCountryLocationLabels(location = {}) {
    const countryCode = typeof location === 'string'
        ? normalizeCountryCode(location, location)
        : normalizeCountryCode(location.country_code || location.countryCode, location.country);
    const profile = COUNTRY_PROFILES.get(countryCode) || {};

    return {
        ...configuredLocationLabels,
        ...profile,
        countryCode
    };
}

export function getAdminAreaFilterLabel(records = [], countryKey = 'all') {
    if (!countryKey || countryKey === 'all') {
        return DEFAULT_LOCATION_LABELS.adminArea;
    }

    const record = records.find(item => item.countryKey === countryKey || item.country === countryKey);
    return getCountryLocationLabels(record || countryKey).adminArea;
}

export function formatLocationText(location = {}, options = {}) {
    const normalized = normalizeTravelLocation(location);
    const includeCountry = options.includeCountry !== false;
    const separator = options.separator || ' · ';
    const parts = [];

    if (includeCountry) {
        appendDistinct(parts, normalized.country);
    }
    appendDistinct(parts, normalized.adminArea);
    appendDistinct(parts, normalized.locality);

    return parts.filter(Boolean).join(separator) || '未知地点';
}

export function createLocationKey(...parts) {
    return parts
        .map(cleanText)
        .filter(Boolean)
        .map(part => part.replaceAll('|', '||'))
        .join('|');
}

export function getLocationSearchValues(record = {}) {
    const normalized = normalizeTravelLocation(record);

    return [
        normalized.country,
        normalized.countryCode,
        normalized.adminArea,
        normalized.adminAreaType,
        normalized.locality,
        normalized.localityType
    ].filter(Boolean);
}

export function isDomesticLocation(location = {}) {
    return Boolean(getCountryLocationLabels(location).domestic);
}

function inferAdminAreaType(adminArea, countryCode) {
    if (!adminArea) return '';

    if (countryCode === 'CN') {
        if (adminArea.endsWith('特别行政区')) return '特别行政区';
        if (adminArea.endsWith('自治区')) return '自治区';
        if (adminArea.endsWith('省')) return '省';
        if (adminArea.endsWith('市')) return '直辖市';
    }

    if (countryCode === 'JP') {
        const suffix = adminArea.slice(-1);
        if (['都', '道', '府', '県'].includes(suffix)) return suffix;
    }

    return '';
}

function appendDistinct(parts, value) {
    const normalized = cleanText(value);
    if (normalized && parts[parts.length - 1] !== normalized) {
        parts.push(normalized);
    }
}

function firstText(...values) {
    return values.map(cleanText).find(Boolean) || '';
}

function cleanText(value) {
    return String(value || '').trim();
}
