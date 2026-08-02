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

export function buildTripRecordCounts(records = []) {
    const counts = new Map();

    records.forEach((record) => {
        const tripId = cleanVisitPart(record.tripId || record.trip_id);
        if (!tripId) {
            return;
        }

        const visitKey = `trip:${tripId}`;
        counts.set(visitKey, (counts.get(visitKey) || 0) + 1);
    });

    return counts;
}

export function buildItineraryGroups(records = []) {
    const chronologicalRecords = [...records].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const counts = new Map();
    const groups = new Map();

    chronologicalRecords.forEach((record) => {
        const visitKey = getVisitKey(record);
        counts.set(visitKey, (counts.get(visitKey) || 0) + 1);
    });

    chronologicalRecords.forEach((record) => {
        const visitKey = getVisitKey(record);
        if (groups.has(visitKey)) {
            return;
        }

        groups.set(visitKey, {
            count: counts.get(visitKey) || 1,
            label: String(groups.size + 1)
        });
    });

    return groups;
}

export function getScopedVisitKey(record = {}, scopeKey = '') {
    return `${cleanVisitPart(scopeKey)}\u0000${getVisitKey(record)}`;
}
