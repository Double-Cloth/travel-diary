const ROUTE_MAP_FALLBACK_SLOT_WIDTH = 160;

export const ROUTE_MAP_RESPONSIVE_COUNT_RANGES = [
    { maxWidth: 420, min: 2, max: 3 },
    { maxWidth: 760, min: 3, max: 6 },
    { maxWidth: 1024, min: 4, max: 7 },
    { maxWidth: Infinity, min: 5, max: 8 }
];

export function getRouteMapCountRange(availableWidth, slotCapacity) {
    const capacity = normalizeCapacity(slotCapacity);
    if (capacity === 0) {
        return { min: 0, max: 0 };
    }

    const width = Number.isFinite(availableWidth) && availableWidth > 0
        ? availableWidth
        : capacity * ROUTE_MAP_FALLBACK_SLOT_WIDTH;
    const matchedRange = ROUTE_MAP_RESPONSIVE_COUNT_RANGES.find(range => width <= range.maxWidth)
        || ROUTE_MAP_RESPONSIVE_COUNT_RANGES[ROUTE_MAP_RESPONSIVE_COUNT_RANGES.length - 1];
    const max = Math.min(matchedRange.max, capacity);
    const min = Math.min(matchedRange.min, max);

    return { min, max };
}

export function getRouteMapRandomCount(availableWidth, availableLocations, slotCapacity, random = Math.random) {
    const capacity = Math.min(normalizeCapacity(availableLocations), normalizeCapacity(slotCapacity));
    if (capacity === 0) {
        return 0;
    }

    const { min, max } = getRouteMapCountRange(availableWidth, capacity);
    const randomValue = typeof random === 'function' ? random() : Math.random();
    const normalizedRandom = Number.isFinite(randomValue)
        ? Math.min(Math.max(randomValue, 0), 0.999999999999)
        : 0;

    return min + Math.floor(normalizedRandom * (max - min + 1));
}

function normalizeCapacity(value) {
    return Math.max(0, Math.floor(Number(value) || 0));
}
