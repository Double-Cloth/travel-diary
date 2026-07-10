const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function buildRecordSetSnapshot(records = []) {
    const dates = records
        .map(record => record.date || '')
        .filter(Boolean)
        .sort();
    const cities = new Set(records
        .map(record => record.locationKey || [record.country, record.province, record.city].filter(Boolean).join('|'))
        .filter(Boolean));
    const provinces = new Set(records
        .map(record => [record.country, record.province].filter(Boolean).join('|'))
        .filter(Boolean));

    return {
        count: records.length,
        cityCount: cities.size,
        provinceCount: provinces.size,
        firstDate: dates[0] || '',
        latestDate: dates[dates.length - 1] || ''
    };
}

export function deriveOverviewAnalytics(records = [], rangeEndDate = '') {
    const repeatCount = records.filter(record => record.isRepeated).length;
    const locationCounts = new Map();
    const dates = records
        .map(record => record.date || '')
        .filter(isValidDateString)
        .sort();
    const years = new Set(dates.map(date => date.slice(0, 4)));
    const activeMonths = new Set(dates.map(date => date.slice(0, 7)));
    const firstDate = dates[0] || '';
    const latestDate = dates[dates.length - 1] || '';
    const capacityEndDate = isValidDateString(rangeEndDate) ? rangeEndDate : latestDate;
    let longestGap = null;

    records.forEach((record) => {
        const locationKey = record.locationKey || [record.country, record.province, record.city].filter(Boolean).join('|');
        if (!locationKey) return;

        locationCounts.set(locationKey, (locationCounts.get(locationKey) || 0) + 1);
    });

    for (let index = 1; index < dates.length; index += 1) {
        const from = dates[index - 1];
        const to = dates[index];
        const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

        if (!longestGap || days > longestGap.days) {
            longestGap = { days, from, to };
        }
    }

    return {
        repeatCount,
        repeatLocationCount: Array.from(locationCounts.values()).filter(count => count > 1).length,
        activeYearCount: years.size,
        activeMonthCount: activeMonths.size,
        activeMonthCapacity: countInclusiveMonths(firstDate, capacityEndDate),
        longestGap
    };
}

function countInclusiveMonths(fromDate, toDate) {
    if (!isValidDateString(fromDate) || !isValidDateString(toDate) || toDate < fromDate) return 0;

    const fromYear = Number(fromDate.slice(0, 4));
    const fromMonth = Number(fromDate.slice(5, 7));
    const toYear = Number(toDate.slice(0, 4));
    const toMonth = Number(toDate.slice(5, 7));

    return ((toYear - fromYear) * 12) + (toMonth - fromMonth) + 1;
}

function isValidDateString(date) {
    if (!DATE_PATTERN.test(date)) return false;

    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));

    return parsed.getUTCFullYear() === year
        && parsed.getUTCMonth() === month - 1
        && parsed.getUTCDate() === day;
}
