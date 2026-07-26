function cleanVisitPart(value) {
    return String(value || '').trim();
}

export function getVisitKey(record = {}) {
    const existingVisitKey = cleanVisitPart(record.visitKey);
    if (existingVisitKey) {
        return existingVisitKey;
    }

    const tripId = cleanVisitPart(record.tripId || record.trip_id);
    if (tripId) {
        return `trip:${tripId}`;
    }

    const recordId = cleanVisitPart(record.id || record.desc_md) || [
        record.date,
        record.countryCode || record.country_code || record.country,
        record.adminAreaKey || record.admin_area || record.adminArea || record.province,
        record.locationKey || record.locality || record.city
    ].map(cleanVisitPart).filter(Boolean).join('|');

    return `record:${recordId || 'unknown'}`;
}

export function countDistinctVisits(records = []) {
    return new Set(records.map(getVisitKey)).size;
}

export function getScopedVisitKey(record = {}, scopeKey = '') {
    return `${cleanVisitPart(scopeKey)}\u0000${getVisitKey(record)}`;
}
