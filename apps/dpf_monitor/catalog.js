'use strict';

/*
 * Read-only DPF records shared by BMW D70BX7A0, D75BX7A0 and D83BX7C0.
 * The definitions are a small, reviewed subset of the public EdiabasX SGBD
 * documentation. All numeric fields are big-endian unless marked otherwise.
 */
const records = {
    '44AC': { label: 'Measured soot (uncorrected)', length: 2, field: { t: 'u16', at: 0, k: 0.1, u: 'g' } },
    '44B7': { label: 'Operating time since regeneration', length: 4, field: { t: 'u32', at: 0, u: 's' } },
    '44B8': { label: 'Successful regenerations', length: 2, field: { t: 'u16', at: 0 } },
    '44B9': { label: 'Corrected soot channel (auxiliary)', length: 2, field: { t: 'u16', at: 0, k: 0.01, u: 'g' }, live: true },
    '44BA': { label: 'Simulated soot', length: 2, field: { t: 'u16', at: 0, k: 0.01, u: 'g' }, live: true },
    '44BB': { label: 'Regeneration request code', length: 1, field: { t: 'u8', at: 0 }, live: true },
    '44BC': { label: 'Fuel since regeneration', length: 2, field: { t: 'u16', at: 0, k: 0.01, u: 'l' } },
    '44BD': { label: 'Oil ash mass', length: 2, field: { t: 'u16', at: 0, k: 0.01525902, u: 'g' } },
    // D83BX7C0 field evidence: this tracks the DDE's plausible DPF load while 44B9 may remain zero.
    '44BE': { label: 'DPF soot mass', length: 2, field: { t: 'u16', at: 0, k: 0.01525902, u: 'g' }, live: true },
    '44BF': { label: 'Distance since regeneration', length: 4, field: { t: 'u32', at: 0, k: 0.001, u: 'km' } },
    '44C0': { label: 'Regeneration interruption code', length: 2, field: { t: 'u16', at: 0 } },
    '44C2': { label: 'Regeneration block/release code', length: 1, field: { t: 'u8', at: 0 } },
    '44C7': { label: 'Average regeneration interval', length: 2, field: { t: 'u16', at: 0, u: 'km' } },
    '44D1': { label: 'Mileage at last regeneration', length: 4, field: { t: 'u32', at: 0, k: 0.001, u: 'km' } },
    '44ED': { label: 'DPF differential pressure', length: 2, field: { t: 'u16', at: 0, k: 0.04577707, o: -1000, u: 'hPa' }, live: true },
    '44EF': { label: 'Temperature before DPF (corrected)', length: 2, field: { t: 'u16', at: 0, k: 0.03128099, o: -50, u: '°C' }, live: true },
    '4502': { label: 'Temperature before DPF', length: 2, field: { t: 'u16', at: 0, k: 0.03128099, o: -50, u: '°C' }, live: true },
    '4C78': { label: 'CBS DPF remaining distance', length: 2, field: { t: 'u16', at: 0, k: 10, u: 'km' } },
};

const variants = {
    '0F1F70': 'D75BX7A0', '0F1F80': 'D75BX7A0',
    '0F1F90': 'D70BX7A0', '0F1FA0': 'D70BX7A0',
    '0F1FE8': 'D83BX7C0', '0F1FF0': 'D83BX7C0', '0F1FF4': 'D83BX7C0', '0F1FF8': 'D83BX7C0',
    '0F2670': 'D83BX7C0', '0F2674': 'D83BX7C0', '0F2678': 'D83BX7C0', '0F267C': 'D83BX7C0',
};

const LIVE = Object.keys(records).filter((id) => records[id].live);
const HISTORY = ['44B7', '44B8', '44BC', '44BF', '44C7', '44D1'];
const HEALTH = ['44BD', '4C78', '44C0', '44C2'];

module.exports = { records, variants, LIVE, HISTORY, HEALTH };
