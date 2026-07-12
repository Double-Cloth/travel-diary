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

    const width = normalizeAvailableWidth(availableWidth, capacity);
    const matchedRange = ROUTE_MAP_RESPONSIVE_COUNT_RANGES.find(range => width <= range.maxWidth)
        || ROUTE_MAP_RESPONSIVE_COUNT_RANGES[ROUTE_MAP_RESPONSIVE_COUNT_RANGES.length - 1];

    return { min: matchedRange.min, max: matchedRange.max };
}

export function getRouteMapRandomCount(availableWidth, availableLocations, slotCapacity, random = Math.random) {
    const locationCapacity = normalizeCapacity(availableLocations);
    const slotCount = normalizeCapacity(slotCapacity);
    if (locationCapacity === 0 || slotCount === 0) {
        return 0;
    }

    const visualCapacity = getRouteMapVisualCapacity(availableWidth, slotCount);
    const capacity = Math.min(locationCapacity, slotCount, visualCapacity);
    const range = getRouteMapCountRange(availableWidth, slotCount);
    const max = Math.min(range.max, capacity);
    const min = Math.min(range.min, max);
    const randomValue = typeof random === 'function' ? random() : Math.random();
    const normalizedRandom = Number.isFinite(randomValue)
        ? Math.min(Math.max(randomValue, 0), 0.999999999999)
        : 0;

    return min + Math.floor(normalizedRandom * (max - min + 1));
}

function normalizeAvailableWidth(availableWidth, slotCapacity) {
    return Number.isFinite(availableWidth) && availableWidth > 0
        ? availableWidth
        : slotCapacity * ROUTE_MAP_FALLBACK_SLOT_WIDTH;
}

function getRouteMapVisualCapacity(availableWidth, slotCapacity) {
    const width = normalizeAvailableWidth(availableWidth, slotCapacity);
    if (width <= ROUTE_MAP_RESPONSIVE_COUNT_RANGES[0].maxWidth) {
        return ROUTE_MAP_RESPONSIVE_COUNT_RANGES[0].max;
    }

    return Math.max(
        ROUTE_MAP_RESPONSIVE_COUNT_RANGES[0].max,
        Math.floor(width / ROUTE_MAP_FALLBACK_SLOT_WIDTH)
    );
}

function normalizeCapacity(value) {
    return Math.max(0, Math.floor(Number(value) || 0));
}
