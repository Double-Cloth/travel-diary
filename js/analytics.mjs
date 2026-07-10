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

export function deriveOverviewAnalytics(records = []) {
    const repeatCount = records.filter(record => record.isRepeated).length;
    const dates = records
        .map(record => record.date || '')
        .filter(date => DATE_PATTERN.test(date))
        .sort();
    const years = new Set(dates.map(date => date.slice(0, 4)));
    const months = new Set(dates.map(date => date.slice(5, 7)));
    let longestGap = null;

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
        repeatRate: records.length ? Math.round((repeatCount / records.length) * 100) : 0,
        activeYearCount: years.size,
        activeMonthCount: months.size,
        longestGap
    };
}
