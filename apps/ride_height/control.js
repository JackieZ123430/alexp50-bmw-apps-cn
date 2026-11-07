'use strict';

const { Diag, replyTo, NRC } = require('./kit/diag');

const VDP = 0x76;
const LEVELS = Object.freeze({ Low: 2, Standard: 8, High: 16 });
const AXLES = Object.freeze({ Front: 0xC6, Rear: 0xC3 });
const AXLE_ACTIONS = Object.freeze({ Vent: 2, Fill: 3 });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const word = (n) => [(n >> 8) & 255, n & 255];

function valueOf(reply, did) {
    if (!reply || reply[0] !== 0x62 || reply[1] !== (did >> 8) || reply[2] !== (did & 255))
        throw new Error('VDP read ' + did.toString(16) + ' failed');
    return reply.slice(3);
}

function sensorValues(bytes) {
    if (bytes.length < 16) throw new Error('VDP returned incomplete height data');
    return [0, 1, 2, 3].map((i) => {
        const mm = Buffer.from(bytes.slice(i * 4, i * 4 + 4)).readFloatBE(0) * 1000;
        if (!Number.isFinite(mm) || Math.abs(mm) > 500) throw new Error('VDP height sensor invalid');
        return mm;
    });
}

class ParkGuard {
    constructor(signals, log) {
        this.signals = signals; this.log = log;
        this.speed = null; this.stage = null;
        this.speedAt = 0; this.stageAt = 0;
        this.subs = [];
    }
    async init() {
        const speed = await this.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const raw = v && v.speedVehicleCentreOfGravity;
                if (typeof raw === 'number' && raw >= 0 && raw < 65535) {
                    this.speed = raw * 0.015625; this.speedAt = Date.now();
                }
            },
        }, this.log, { pollMs: 1000 });
        const gear = await this.signals.watch('de.bmw.infrastructure.VehicleInformation', '1', {
            statusGearboxDrive: (v) => {
                const x = v && v.statusActualStageDrive;
                this.stage = ({ 1: 'P', 2: 'R', 3: 'N', 4: 'D', P: 'P', R: 'R', N: 'N', D: 'D' })[x] || null;
                this.stageAt = Date.now();
            },
            DataPowerTrain2: (v) => {
                const x = v && v.statusGearSelectionDrive;
                const n = typeof x === 'number' ? x : ({ P: 3, R: 2, N: 1, NP: 4 })[x];
                this.stage = n === 3 ? 'P' : n === 2 ? 'R' : n === 1 ? 'N' : n >= 5 ? 'D' : null;
                this.stageAt = Date.now();
            },
        }, this.log, { pollMs: 1000 });
        this.subs = [speed, gear];
        return this;
    }
    check() {
        const now = Date.now();
        if (!this.subs.every((s) => s && s.available && !s.error)) throw new Error('Vehicle safety signals unavailable');
        if (now - this.speedAt > 3000 || now - this.stageAt > 3000) throw new Error('Waiting for fresh speed and Park signals');
        if (this.stage !== 'P' || this.speed === null || this.speed > 0.5) throw new Error('Park the stationary car before control');
    }
    get status() {
        return this.stage === null ? 'Park status unavailable' : 'Gear ' + this.stage + ' • ' +
            (this.speed === null ? '--' : this.speed.toFixed(1)) + ' km/h';
    }
}

class VdpControl {
    constructor(signals, log, guard) {
        this.diag = new Diag(signals, log); this.diag.quiet = true;
        this.guard = guard; this.busy = false;
        this.queue = Promise.resolve();
    }
    async init() { await this.diag.init(); return this; }
    exchange(fn) {
        const next = this.queue.then(fn, fn);
        this.queue = next.catch(() => {});
        return next;
    }
    async read(did) {
        const data = word(did);
        const r = await this.exchange(() => this.diag.physical(VDP, 0x22, data, 3500, replyTo(0x22, data)));
        return valueOf(r, did);
    }
    async write(did, payload) {
        const data = word(did).concat(payload);
        const r = await this.exchange(() => this.diag.physical(VDP, 0x2E, data, 5000, replyTo(0x2E, data)));
        if (!r) throw new Error('VDP did not answer the control request');
        if (r[0] === 0x7F) throw new Error('VDP refused control: ' + (NRC[r[2]] || 'code 0x' + r[2].toString(16)));
        if (r[0] !== 0x6E || r[1] !== data[0] || r[2] !== data[1]) throw new Error('Unexpected VDP response');
    }
    async requireVdpStopped() {
        // DD3A's second Motorola float is VDP's own filtered vehicle speed in km/h.
        const bytes = await this.read(0xDD3A);
        if (bytes.length < 8) throw new Error('VDP speed response incomplete');
        const speed = Buffer.from(bytes.slice(4, 8)).readFloatBE(0);
        if (!Number.isFinite(speed) || speed < 0 || speed > 350) throw new Error('VDP speed invalid');
        if (speed > 0.5) throw new Error('Vehicle is moving (' + speed.toFixed(1) + ' km/h)');
        return speed;
    }
    async run(fn) {
        if (this.busy) throw new Error('A VDP command is already in progress');
        this.busy = true;
        try { this.guard.check(); await this.requireVdpStopped(); return await fn(); }
        finally { this.busy = false; }
    }
    async level(name) {
        if (!Object.prototype.hasOwnProperty.call(LEVELS, name)) throw new Error('Unknown ride level');
        return this.run(async () => {
            await this.read(0xF150); // A VDP identity reply must precede every control session.
            this.guard.check();
            await this.requireVdpStopped();
            // 0xDC11 is the BMW VDP_G11 "Steuern: Fahrzeughöhe" DID, with a 16-bit unsigned value.
            await this.write(0xDC11, word(LEVELS[name]));
            for (let i = 0; i < 12; i++) {
                await pause(1000);
                const bytes = await this.read(0xD8EC);
                const state = bytes.reduce((n, b) => (n << 8) | b, 0);
                if (state === LEVELS[name]) return name;
                this.guard.check();
            }
            throw new Error('VDP accepted the request but did not report ' + name + ' within 12 s');
        });
    }
    async axle(axle, direction, seconds) {
        if (!Object.prototype.hasOwnProperty.call(AXLES, axle)) throw new Error('Unknown axle');
        if (!Object.prototype.hasOwnProperty.call(AXLE_ACTIONS, direction)) throw new Error('Unknown direction');
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30)
            throw new Error('Select an axle-control duration from 1 to 30 seconds');
        return this.run(async () => {
            const health = await this.read(0xDC06);
            if (health.length < 8 || [0, 2, 4, 6].some((i) => health[i] !== 0 || health[i + 1] !== 0))
                throw new Error('Height sensor fault or incomplete status');
            const before = sensorValues(await this.read(0xDC05));
            await this.read(0xF150);
            this.guard.check();
            await this.requireVdpStopped();
            const localId = AXLES[axle];
            const action = AXLE_ACTIONS[direction];
            // VDP_G11 DB77 uses three big-endian unsigned integers in PRG order:
            // action, adjustment time in seconds, aggregate air-spring local ID.
            // C6 selects both front struts; C3 selects both rear struts.
            try {
                await this.write(0xDB77, word(action).concat(word(seconds), word(localId)));
                await pause(seconds * 1000 + 150);
            } finally {
                // The ECU owns the command timer. OFF is an independent stop path.
                await this.write(0xDB77, word(0).concat(word(0), word(localId))).catch(() => {});
            }
            await pause(500);
            this.guard.check();
            const after = sensorValues(await this.read(0xDC05));
            const indexes = axle === 'Front' ? [0, 1] : [2, 3];
            const average = (values) => (values[indexes[0]] + values[indexes[1]]) / 2;
            return { before: average(before), after: average(after), axle, direction, seconds };
        });
    }
}

module.exports = { VdpControl, ParkGuard, LEVELS, AXLES, AXLE_ACTIONS, sensorValues, word };
