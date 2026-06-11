export const currentState = {
    search: '',
    year: 'All',
    sortDesc: true,
    page: 'home'
};

let travelRecords = [];

export function setTravelRecords(records) {
    travelRecords = Array.isArray(records) ? records : [];
}

export function getTravelRecords() {
    return travelRecords;
}
