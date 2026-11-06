'use strict';
const finite = (n) => typeof n === 'number' && isFinite(n);
const signed16 = (n) => n >= 32768 ? n - 65536 : n;
const splitValid = (q) => q === undefined || q === null || q === 2 || q === 10 ||
    q === 'SIGNALWERT_IST_GUELTIG' || q === 'SIGNALWERT_IST_GUELTIG__REKALIBRIERUNGSBEDARF';
function wheelValues(v) {
    const names = ['actualValueRPMWheelFLH', 'actualValueRPMwheelFRH', 'actualValueRPMWheelRLH', 'actualValueRPMWheelRRH'];
    const out = names.map((k) => finite(v && v[k]) && v[k] >= 0 && v[k] < 65535 ? v[k] : null);
    return out.every(finite) ? out : null;
}
function steeringQualifierValid(q) {
    if (q === undefined || q === null || q === '') return true;
    if (typeof q === 'number') return [1, 2, 9, 10].indexOf(q) >= 0;
    const s = String(q).toUpperCase();
    return s.indexOf('UNGUELTIG') < 0 && s.indexOf('GUELTIG') >= 0;
}
function decodeSteering(raw) {
    if (!finite(raw) || raw < 3 || raw > 65532) return null;
    const deg = raw * 0.04395 - 1440.11;
    return deg >= -900 && deg <= 900 ? deg : null;
}
module.exports = { wheelValues, signed16, splitValid, steeringQualifierValid, decodeSteering };
