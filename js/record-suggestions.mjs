import { recordSlug } from './record-input.mjs';

const AUTOFILL_FIELDS = ['country', 'admin_area', 'admin_area_type', 'locality_type', 'trip_id'];
const RECENT_TRIP_LIMIT = 5;

export function getRecordAutofill(input = {}, countries = [], records = []) {
    const countryCode = clean(input.country_code).toUpperCase();
    const country = countries.find(item => item.code === countryCode);
    const locality = clean(input.locality);
    const adminArea = clean(input.admin_area);
    const matches = records
        .filter(record => sameCountry(record, countryCode))
        .filter(record => !locality || sameText(recordValue(record, 'locality'), locality))
        .filter(record => !adminArea || sameText(recordValue(record, 'admin_area'), adminArea))
        .sort(compareRecent);
    const matchingAdminAreas = uniqueValues(matches.map(record => recordValue(record, 'admin_area')));
    const exactLocation = !locality ? null : adminArea ? matches[0]
        : matchingAdminAreas.length === 1
            ? matches.find(record => sameText(recordValue(record, 'admin_area'), matchingAdminAreas[0]))
            : null;
    const resolvedAdminArea = adminArea || recordValue(exactLocation, 'admin_area');
    const values = {
        country: country?.name_zh || '',
        admin_area: locality ? recordValue(exactLocation, 'admin_area') : '',
        admin_area_type: recordValue(exactLocation, 'admin_area_type')
            || mostFrequentValue(records.filter(record => sameCountry(record, countryCode) && sameText(recordValue(record, 'admin_area'), resolvedAdminArea)), 'admin_area_type')
            || inferAdminAreaType(resolvedAdminArea, countryCode),
        locality_type: recordValue(exactLocation, 'locality_type') || inferLocalityType(locality),
        trip_id: suggestedTripId({ ...input, admin_area: resolvedAdminArea })
    };

    return Object.fromEntries(AUTOFILL_FIELDS.filter(key => values[key]).map(key => [key, values[key]]));
}

export function getRecordOptions(input = {}, countries = [], records = []) {
    const countryCode = clean(input.country_code).toUpperCase();
    const adminArea = clean(input.admin_area);
    const locality = clean(input.locality);
    const countryRecords = records.filter(record => sameCountry(record, countryCode));
    const areaRecords = countryRecords.filter(record => !adminArea || sameText(recordValue(record, 'admin_area'), adminArea));
    const localityRecords = areaRecords.filter(record => !locality || sameText(recordValue(record, 'locality'), locality));
    const country = countries.find(item => item.code === countryCode);

    return {
        country: uniqueValues([country?.name_zh, ...(country?.aliases || []), ...countryRecords.map(record => recordValue(record, 'country'))]),
        admin_area: rankedValues(countryRecords, 'admin_area'),
        admin_area_type: rankedValues(adminArea ? areaRecords : countryRecords, 'admin_area_type'),
        locality: rankedValues(areaRecords, 'locality'),
        locality_type: rankedValues(locality ? localityRecords : areaRecords, 'locality_type'),
        trip_id: recentTripIds(records)
    };
}

export function suggestedTripId(input = {}) {
    const date = clean(input.date);
    const place = clean(input.locality) || clean(input.admin_area);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !place) return '';
    return `${date}-${recordSlug(place)}`;
}

function recordValue(record, field) {
    const aliases = {
        country: ['country'],
        admin_area: ['admin_area', 'adminArea', 'province'],
        admin_area_type: ['admin_area_type', 'adminAreaType'],
        locality: ['locality', 'city'],
        locality_type: ['locality_type', 'localityType'],
        trip_id: ['trip_id', 'tripId']
    };
    return (aliases[field] || [field]).map(key => clean(record?.[key])).find(Boolean) || '';
}

function sameCountry(record, countryCode) {
    if (!countryCode) return true;
    return clean(record?.country_code || record?.countryCode).toUpperCase() === countryCode;
}

function inferAdminAreaType(adminArea, countryCode) {
    if (!adminArea) return '';
    if (countryCode === 'CN') {
        if (adminArea.endsWith('特别行政区')) return '特别行政区';
        if (adminArea.endsWith('自治区')) return '自治区';
        if (adminArea.endsWith('省')) return '省';
        if (adminArea.endsWith('市')) return '直辖市';
    }
    if (countryCode === 'JP' && ['都', '道', '府', '県'].includes(adminArea.slice(-1))) return adminArea.slice(-1);
    return '';
}

function inferLocalityType(locality) {
    if (!locality) return '';
    if (/国家公园$/u.test(locality)) return '国家公园';
    if (/群岛$/u.test(locality)) return '群岛';
    if (/岛$/u.test(locality)) return '岛屿';
    if (/市$/u.test(locality)) return '城市';
    return '';
}

function rankedValues(records, field) {
    const stats = new Map();
    records.forEach((record, index) => {
        const value = recordValue(record, field);
        if (!value) return;
        const key = value.toLocaleLowerCase();
        const current = stats.get(key) || { value, count: 0, newest: '', order: index };
        current.count += 1;
        current.newest = [current.newest, clean(record.date)].sort().at(-1);
        stats.set(key, current);
    });
    return [...stats.values()]
        .sort((a, b) => b.count - a.count || b.newest.localeCompare(a.newest) || a.order - b.order)
        .map(item => item.value);
}

function mostFrequentValue(records, field) {
    return rankedValues(records, field)[0] || '';
}

function recentTripIds(records) {
    const seen = new Set();
    return records
        .map((record, order) => ({ record, order }))
        .sort((a, b) => compareRecent(a.record, b.record) || a.order - b.order)
        .map(({ record }) => recordValue(record, 'trip_id'))
        .filter(value => {
            const key = value.toLocaleLowerCase();
            if (!value || seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, RECENT_TRIP_LIMIT);
}

function uniqueValues(values) {
    const seen = new Set();
    return values.map(clean).filter(value => {
        const key = value.toLocaleLowerCase();
        if (!value || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function compareRecent(a, b) {
    return clean(b?.date).localeCompare(clean(a?.date));
}

function sameText(a, b) {
    return clean(a).toLocaleLowerCase() === clean(b).toLocaleLowerCase();
}

function clean(value) {
    return String(value || '').trim();
}
