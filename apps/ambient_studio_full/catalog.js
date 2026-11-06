'use strict';

const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const LIGHT = 'de.bmw.infotainment.misc.ComfortFunctionIuK';
const CDS = 'de.bmw.infotainment.vehicle.CDS';
const BODY_LIGHT = 'de.bmw.body.Light';

const MODES = [
    [1, 'SPORT_DYNAMIC', 'Sport'],
    [2, 'SPORT_EXPERT', 'Sport Plus'],
    [3, 'SPORT_INDIVIDUAL', 'Sport Individual'],
    [10, 'ADAPTIVE', 'Adaptive'],
    [7, 'ECO_PRO_EFFICIENT', 'Eco Pro'],
    [8, 'ECO_PRO_PLUS', 'Eco Pro Plus'],
    [9, 'ECO_PRO_INDIVIDUAL', 'Eco Pro Individual'],
    [4, 'COMFORT', 'Comfort'],
    [5, 'COMFORT_PLUS', 'Comfort Plus'],
    [6, 'COMFORT_INDIVIDUAL', 'Comfort Individual']
].map((m) => ({ value: m[0], name: m[1], label: m[2] }));

// The requested mapping is deliberately exact: unlisted modes remain unchanged.
const MODE_COLOURS = {
    ECO_PRO_EFFICIENT: 'BLUE',
    ECO_PRO_INDIVIDUAL: 'BLUE',
    SPORT_DYNAMIC: 'RED',
    SPORT_EXPERT: 'RED',
    SPORT_INDIVIDUAL: 'RED',
    ADAPTIVE: 'GREEN',
    COMFORT_PLUS: 'ORANGE'
};
const SEMANTIC = ['BLUE', 'RED', 'GREEN', 'ORANGE'];
const COLORS = Array.from({ length: 12 }, (_, i) => ({ value: i + 1, name: 'FARBAUSWAHL_' + (i + 1) }));

function drivingMode(raw) {
    const v = raw && raw.actualValueModeDrivingExperience;
    return MODES.find((m) => m.name === v || m.value === v) || null;
}
function reportedColor(raw) {
    const v = raw && raw.statusMenuAmbientePanoramicRoofInteriorLighting;
    const c = COLORS.find((x) => x.name === v || x.value === v);
    return c ? c.value : null;
}
function colorRequest(value) {
    const c = COLORS.find((x) => x.value === value);
    if (!c) throw new Error('Unknown factory colour slot');
    return {
        controlHueInteriorLighting: 4095,
        controlMenuAmbientePanoramicRoofInteriorLighting: c.name,
        controlHueValueLayer1IndividualGroup: 255,
        controlHueValueLayer2IndividualGroup: 255,
        controlHueValueLayer3IndividualGroup: 255,
        controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting: 255,
        controlModeAmbientePanoramicRoofInteriorLighting: 'SIGNAL_UNBEFUELLT',
        controlDynamicInteriorLighting: 'SIGNAL_UNBEFUELLT',
        controlDynamicAmbienteInteriorLighting: 'SIGNAL_UNBEFUELLT'
    };
}
function engineRunning(raw) {
    const v = raw && raw.statusEngineRunDrive;
    if (v === 'MOTOR_LAEUFT' || v === 2) return true;
    if (v === 'MOTOR_AUS' || v === 'MOTOR_STARTET' || v === 0 || v === 1) return false;
    return null;
}
function stableObject(value) {
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableObject).join(',') + ']';
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableObject(value[k])).join(',') + '}';
}
function hazardSignature(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const found = {};
    function walk(value, prefix) {
        if (!value || typeof value !== 'object') return;
        Object.keys(value).forEach((key) => {
            const p = prefix ? prefix + '.' + key : key;
            const low = key.toLowerCase();
            if (low.indexOf('specialflashing') >= 0 && low.indexOf('phase') < 0 &&
                low.indexOf('alive') < 0 && low.indexOf('crc') < 0) found[p] = value[key];
            else if (value[key] && typeof value[key] === 'object') walk(value[key], p);
        });
    }
    walk(raw, '');
    return Object.keys(found).length ? stableObject(found) : null;
}

module.exports = { FES, LIGHT, CDS, BODY_LIGHT, MODES, MODE_COLOURS, SEMANTIC, COLORS,
    drivingMode, reportedColor, colorRequest, engineRunning, hazardSignature };
