'use strict';

class ParkGuard {
    constructor(signals, log) {
        this.signals = signals; this.log = log;
        this.speed = null; this.stage = null; this.speedAt = 0; this.stageAt = 0;
        this.subs = [];
    }
    async init() {
        const speed = await this.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const raw = v && v.speedVehicleCentreOfGravity;
                if (typeof raw === 'number' && raw >= 0 && raw < 65535) {
                    this.speed = raw * 0.015625; this.speedAt = Date.now();
                }
            }
        }, this.log, { pollMs: 1000 });
        const gear = await this.signals.watch('de.bmw.infrastructure.VehicleInformation', '1', {
            statusGearboxDrive: (v) => {
                const x = v && v.statusActualStageDrive;
                this.stage = ({ 1:'P', 2:'R', 3:'N', 4:'D', P:'P', R:'R', N:'N', D:'D' })[x] || null;
                this.stageAt = Date.now();
            },
            DataPowerTrain2: (v) => {
                const x = v && v.statusGearSelectionDrive;
                const n = typeof x === 'number' ? x : ({ P:3, R:2, N:1, NP:4 })[x];
                this.stage = n === 3 ? 'P' : n === 2 ? 'R' : n === 1 ? 'N' : n >= 5 ? 'D' : null;
                this.stageAt = Date.now();
            }
        }, this.log, { pollMs: 1000 });
        this.subs = [speed, gear];
    }
    get fresh() {
        const now = Date.now();
        return this.subs.length === 2 && this.subs.every((s) => s && s.available && !s.error) &&
            now - this.speedAt < 5000 && now - this.stageAt < 5000;
    }
    get parked() { return this.fresh && this.stage === 'P' && this.speed !== null && this.speed <= 0.5; }
    get status() {
        if (!this.fresh) return 'Waiting for fresh Park and speed signals';
        return 'Gear ' + (this.stage || '--') + '  •  ' + (this.speed === null ? '--' : this.speed.toFixed(1)) + ' km/h';
    }
}

module.exports = ParkGuard;
