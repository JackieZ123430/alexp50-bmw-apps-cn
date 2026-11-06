'use strict';

const finite = (n) => typeof n === 'number' && isFinite(n);
const u16 = (b) => ((b[0] << 8) | b[1]) >>> 0;
const u32 = (b) => ((b[0] * 0x1000000) + (b[1] << 16) + (b[2] << 8) + b[3]) >>> 0;

const LENGTHS = Object.freeze({
    '58B1':4, '58B2':4, '58B3':4, '58B4':4, '58B5':4,
    '58B7':2, '58B8':1, '58BA':1, '425A':2, '4286':2, '428C':2, '428D':2, '4290':1,
    '429D':1, '43CA':2, '43CB':2, '43CC':1, '43FD':2, '4D12':1, '489A':1, '4D03':1,
    '43B9':2, '43C0':2, '43C1':2, '43FE':2, '4A98':2, '48F9':2, '4D0B':2, '56E3':2
});

function raw(bytes) {
    if (!Array.isArray(bytes)) return null;
    if (bytes.length === 1) return bytes[0];
    if (bytes.length === 2) return u16(bytes);
    if (bytes.length === 4) return u32(bytes);
    return null;
}

function splitReply(reply, dids) {
    if (!Array.isArray(reply) || reply[0] !== 0x62) return null;
    const out = {}, expected = (dids || []).map((x) => Number(x));
    let at = 1;
    for (const did of expected) {
        if (at + 1 >= reply.length || ((reply[at] << 8) | reply[at + 1]) !== did) return null;
        const id = did.toString(16).toUpperCase().padStart(4, '0'), n = LENGTHS[id];
        if (!n || at + 2 + n > reply.length) return null;
        out[id] = reply.slice(at + 2, at + 2 + n); at += 2 + n;
    }
    return at === reply.length ? out : null;
}

function bitList(value) {
    if (!finite(value)) return [];
    const out = [], n = value >>> 0;
    for (let i = 0; i < 32; i++) if ((n >>> i) & 1) out.push(i);
    return out;
}

const WORDS = Object.freeze([
    ['58B1', 'MSA deactivated'],
    ['58B2', 'Automatic restart requested'],
    ['58B3', 'Automatic restart inhibited'],
    ['58B4', 'Stop inhibited · driver condition'],
    ['58B5', 'Stop inhibited · system condition']
]);

function stateOf(values) {
    const active = WORDS.map(([did, label]) => ({ did, label, value: values[did], bits: bitList(values[did]) })).filter((x) => x.bits.length);
    const priority = ['58B2','58B3','58B4','58B5','58B1'];
    const main = priority.map((id) => active.find((x) => x.did === id)).find(Boolean);
    return {
        title: main ? main.label.toUpperCase() : 'NO CURRENT INHIBITOR',
        tone: main && main.did === '58B2' ? 'blue' : main ? 'amber' : 'green',
        active,
        signature: active.map((x) => x.did + ':' + (x.value >>> 0).toString(16).padStart(8, '0')).join('|') || 'clear'
    };
}

function engineRunning(value) {
    if (value === 'MOTOR_LAEUFT' || value === 2) return true;
    if (value === 'MOTOR_AUS' || value === 'MOTOR_STARTET' || value === 0 || value === 1) return false;
    return null;
}

/** The inhibit words describe permission for a future stop; they are not proof the engine is running. */
function operatingState(values, running) {
    const base = stateOf(values);
    if (running !== false) return Object.assign({}, base, { running });
    const restartInhibit = base.active.find((x) => x.did === '58B3');
    const restartRequest = base.active.find((x) => x.did === '58B2');
    if (restartInhibit) return { title:'AUTO-STOPPED · RESTART INHIBITED', tone:'amber', active:[restartInhibit], running:false,
        signature:'engine:stopped|' + restartInhibit.did + ':' + (restartInhibit.value >>> 0).toString(16) };
    if (restartRequest) return { title:'AUTO-STOPPED · RESTART REQUESTED', tone:'blue', active:[restartRequest], running:false,
        signature:'engine:stopped|' + restartRequest.did + ':' + (restartRequest.value >>> 0).toString(16) };
    return { title:'AUTO-STOPPED · READY TO RESTART', tone:'green', active:[], running:false, signature:'engine:stopped|ready' };
}

function decode(values) {
    const out = {};
    Object.keys(values || {}).forEach((id) => {
        const bytes = values[id]; if (!Array.isArray(bytes)) return;
        const n = raw(bytes); out[id] = n;
    });
    if (finite(out['425A'])) out.generatorLoad = out['425A'] * 0.003052;
    if (finite(out['4286'])) out.batteryCurrent = out['4286'] * 0.08 - 200;
    if (finite(out['428C'])) out.batteryTemp = out['428C'] * 0.009237 - 50;
    if (finite(out['428D'])) out.voltage = out['428D'] * 0.00025 + 6;
    if (finite(out['4290'])) out.generatorCurrent = out['4290'];
    // D83 / 0F1FE8 live energy-management channels, verified on the target car.
    if (finite(out['43B9'])) out.generatorCurrent = out['43B9'] * 0.125 - 4095.875;
    if (finite(out['43C0'])) out.batteryCurrent = out['43C0'] * 0.05 - 1638.35;
    if (finite(out['43C1'])) out.voltage = out['43C1'] * 0.001;
    return out;
}

function consumers(v) {
    const volts = finite(v.voltage) ? v.voltage : 13.8, list = [];
    const add = (name, watts, kind, detail) => { if (finite(watts) && watts >= 0) list.push({ name, watts, kind, detail }); };
    if (finite(v['429D']) && !finite(v['43FE'])) add('Fuel supply pump', v['429D'] * 0.1 * volts, 'DIRECT', (v['429D'] * 0.1).toFixed(1) + ' A');
    if (finite(v['43CA'])) add('SCR line heater', v['43CA'] * 0.000500008 * volts, 'DIRECT', (v['43CA'] * 0.000500008).toFixed(1) + ' A');
    if (finite(v['43CB'])) add('SCR tank heater', v['43CB'] * 0.000500008 * volts, 'DIRECT', (v['43CB'] * 0.000500008).toFixed(1) + ' A');
    if (finite(v['43FD']) && v['43CC'] && !finite(v['43FE'])) add('Fuel-filter heater', v['43FD'] * 0.1, 'EST', 'learned power');
    if (finite(v['4D12'])) add('EGR coolant pump', v['4D12'] * 0.00392157 * 80, 'EST', (v['4D12'] * 0.392157).toFixed(0) + '% duty');
    if (finite(v['43FE'])) add('Fuel supply pump', v['43FE'] * 0.1, 'DIRECT', 'filtered electrical power');
    if (finite(v['43FD'])) add('Fuel-filter heater', v['43CC'] ? v['43FD'] * 0.1 : 0, 'EST', v['43CC'] ? 'active · learned power' : 'inactive');
    if (finite(v['4A98'])) {
        const duty = Math.max(0, Math.min(100, v['4A98'] * 0.0015259));
        add('Electric cooling fan', duty * 6, 'EST', duty.toFixed(0) + '% duty');
    }
    if (finite(v['48F9'])) {
        const duty = Math.max(0, Math.min(100, v['48F9'] * 0.01 - 327.67));
        add('Charge-air coolant pump', duty, 'EST', duty.toFixed(0) + '% demand');
    }
    if (finite(v['4D0B'])) add('Cabin flow heater', Math.max(0, v['4D0B'] - 32767), 'REQUEST', 'requested power');
    if (finite(v['56E3'])) add('Glow system', Math.max(0, v['56E3'] * 0.05 - 1638.35), 'DIRECT', 'measured power');
    return list.sort((a, b) => b.watts - a.watts).slice(0, 5);
}

function totals(v) {
    const volts = finite(v.voltage) ? v.voltage : null;
    return {
        generatorW: volts !== null && finite(v.generatorCurrent) ? volts * v.generatorCurrent : null,
        batteryW: volts !== null && finite(v.batteryCurrent) ? volts * v.batteryCurrent : null
    };
}

module.exports = { LENGTHS, WORDS, raw, splitReply, bitList, stateOf, engineRunning, operatingState, decode, consumers, totals, finite };
