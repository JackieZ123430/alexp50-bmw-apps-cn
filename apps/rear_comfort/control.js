'use strict';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stage = (value) => {
    if (typeof value === 'number') return value >= 0 && value <= 3 ? value : 0;
    const m = /STUFE_(\d)/.exec(String(value || ''));
    return m ? Number(m[1]) : 0;
};
const active = (value) => /EIN|AKTIV|ACTIVE|USER_ON|FULL_ON/.test(String(value || ''));

class RearControl {
    constructor(signals, log, changed) {
        this.signals = signals; this.log = log; this.changed = changed || (() => {});
        this.p = {}; this.subs = []; this.busy = false; this.speed = null; this.frontBeforeRearOn = null;
        this.state = {
            climate: { left: null, right: null, blower: null, auto: null, on: null, lock: null, frontOn: null },
            left: { heat: 0, vent: 0, massage: 0, program: 1 },
            right: { heat: 0, vent: 0, massage: 0, program: 1 },
            shades: { left: null, right: null, rear: null },
            screens: { left: null, right: null, focus: 'NO_RSE_SELECTION', display: null,
                brightness: null, volume: null, ready: null, remote: null, apps: [] },
            available: {}
        };
    }
    touch() { this.changed(this.state); }
    async watch(name, iface, instance, handlers, pollMs) {
        const sub = await this.signals.watch(iface, instance, handlers, this.log, { pollMs: pollMs || 1500 });
        this.subs.push(sub); this.p[name] = sub.proxy; this.state.available[name] = !!sub.available;
        if (sub.proxy) this.signals.onAvailable(sub.proxy, (yes) => {
            this.state.available[name] = yes; this.touch();
        }).catch(() => {});
        return sub;
    }
    async init() {
        await this.watch('vehicle', 'de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const n = v && v.speedVehicleCentreOfGravity;
                this.speed = typeof n === 'number' ? n * 0.015625 : null; this.touch();
            }
        }, 1000);
        await this.watch('climate', 'de.bmw.infotainment.climate.Climate', '1', {
            statusClimateFond: (v) => {
                this.state.climate.left = Number(v.statusDisplayTemperatureLeftHandAirConditioningRearCompartment);
                this.state.climate.right = Number(v.statusDisplayTemperatureRightHandAirConditioningRearCompartment);
                this.state.climate.blower = stage(v.statusDisplayBlowerSettingAirConditioningRearCompartment);
                this.state.climate.auto = String(v.statusDisplayModeAirConditioningRearCompartment) === 'AUTOMATIK'; this.touch();
            },
            statusACFond2: (v) => {
                this.state.climate.on = active(v.statusOn2Tier) || active(v.statusModeAirConditioning2Tier);
                this.state.climate.lock = active(v.statusLock2Tier); this.touch();
            },
            statusSeatHeatingDRR: (v) => { this.state.left.heat = stage(v.statusSeatHeaterDRR); this.touch(); },
            statusSeatHeatingPSR: (v) => { this.state.right.heat = stage(v.statusSeatHeaterPSR); this.touch(); },
            statusSeatClimateDRR: (v) => { this.state.left.vent = stage(v.statusSeatClimateDRR); this.touch(); },
            statusSeatClimatePSR: (v) => { this.state.right.vent = stage(v.statusSeatClimatePSR); this.touch(); }
        });
        await this.watch('climateFront', 'de.bmw.infotainment.climate.Climate2', '1', {
            statusACFrontFunctions: (v) => {
                this.state.climate.frontOn = String(v && v.statusAC) === 'KLIMAANLAGE_EIN'; this.touch();
            }
        });
        await this.watch('comfort', 'de.bmw.infotainment.misc.ComfortFunctionIuK', '1', {
            statusSeatMassageRL: (v) => {
                this.state.left.massage = stage(v.statusIntensityPneumaticSeatRLH);
                const p = Number(String(v.statusProgramPneumaticSeatRLH || '').replace('PROGRAMM_', ''));
                this.state.left.program = p >= 1 && p <= 4 ? p : 1; this.touch();
            },
            statusSeatMassageRR: (v) => {
                this.state.right.massage = stage(v.statusIntensityPneumaticSeatRRH);
                const p = Number(String(v.statusProgramPneumaticSeatRRH || '').replace('PROGRAMM_', ''));
                this.state.right.program = p >= 1 && p <= 4 ? p : 1; this.touch();
            },
            statusAdjustmentLumbarRL: () => this.touch(),
            statusAdjustmentLumbarRR: () => this.touch()
        });
        await this.watch('shades', 'de.bmw.infotainment.vehicle.A4A', '1', {
            statusSunblind: (v) => {
                this.state.shades.left = v.statusEngineRLHSunBlind;
                this.state.shades.right = v.statusEngineRRHSunBlind;
                this.state.shades.rear = v.statusEngineRearSunBlind; this.touch();
            }
        });
        await this.watch('seat', 'com.harman.infotainment.systeminfrastructure.seatcommandproxy.seatcommandproxy.SeatCommandProxyCtrl', 'Inst1', {
            seatProxySeatOperationStatus: () => this.touch()
        });
        await this.watch('lifecycle', 'de.bmw.infotainment.lifecycle.lifecycle.Lifecycle', 'Front', {
            rseHmiMenu: () => {}, rseLock: () => {}, rseLowPowerMode: () => {}, theatreMode: () => {}
        }, 3000);
        await this.watch('rseLife', 'de.bmw.infotainment.lifecycle.lifecyclerse.LifecycleRSE', 'Rear', {
            focusIndicatorHMI: (v) => { this.state.screens.focus = v; this.touch(); },
            powerStateDetailedLeft: (v) => { this.state.screens.left = v; this.touch(); },
            powerStateDetailedRight: (v) => { this.state.screens.right = v; this.touch(); }
        }, 2500);
        await this.watch('rseApps', 'de.bmw.infotainment.rseapplicationcontrol.RSEApplicationControl', '3', {
            launchableApps: (v) => { this.state.screens.apps = Array.isArray(v) ? v : []; this.touch(); }
        }, 5000);
        await this.watch('rseCommand', 'de.bmw.infotainment.rsecommandcontrol.RSECommandControl', '3', {
            currentVolume: (v) => { this.state.screens.volume = Number(v); this.touch(); },
            rseMainSinkAudible: () => {}
        }, 2500);
        await this.watch('rseDisplay', 'de.bmw.infotainment.rsedisplaycontrol.RSEDisplayControl', '3', {
            displayBrightness: (v) => { this.state.screens.brightness = Number(v); this.touch(); },
            displayState: (v) => { this.state.screens.display = v; this.touch(); },
            normalModeReady: (v) => { this.state.screens.ready = v; this.touch(); }
        }, 2500);
        await this.watch('rseRemote', 'de.bmw.infotainment.rseremoteinput.RSERemoteInput', '3', {
            remoteControlEnabled: (v) => { this.state.screens.remote = !!v; this.touch(); }
        }, 3000);
        this.touch(); return this;
    }
    require(name) {
        if (!this.p[name] || !this.state.available[name]) throw new Error(name + ' control is not available right now');
        return this.p[name];
    }
    stopped() {
        if (this.speed !== null && this.speed > 0.5) throw new Error('Seat movement requires the stationary car');
    }
    async operation(label, fn) {
        if (this.busy) throw new Error('Another rear control is in progress');
        this.busy = true; this.touch();
        try { await fn(); return label + ' accepted'; }
        finally { this.busy = false; this.touch(); }
    }
    async setClimateTemperature(side, value) {
        const v = Math.max(16, Math.min(28, Math.round(value)));
        const x = {
            controlTemperatureLeftHandAirConditioningRearCompartment: side === 'left' ? v : 255,
            controlTemperatureRightHandAirConditioningRearCompartment: side === 'right' ? v : 255,
            controlOperationPushButtonMaximumAirconRearCompartment: 'SIGNAL_UNBEFUELLT',
            controlOperationPushButtonAirInjectionManifoldAirConditioningRearCompartment: 'SIGNAL_UNBEFUELLT',
            controlBlowerSettingAirConditioningRearCompartment: 'SIGNAL_UNBEFUELLT',
            controlOperationPushButtonModeAirConditioningRearCompartment: 'SIGNAL_UNBEFUELLT'
        };
        return this.operation('Rear ' + side + ' temperature', () => this.signals.set(this.require('climate'), 'climateFond', x));
    }
    async setClimateMode(auto) {
        const x = {
            controlTemperatureLeftHandAirConditioningRearCompartment: 255,
            controlTemperatureRightHandAirConditioningRearCompartment: 255,
            controlOperationPushButtonMaximumAirconRearCompartment: 'SIGNAL_UNBEFUELLT',
            controlOperationPushButtonAirInjectionManifoldAirConditioningRearCompartment: 'SIGNAL_UNBEFUELLT',
            controlBlowerSettingAirConditioningRearCompartment: 'SIGNAL_UNBEFUELLT',
            controlOperationPushButtonModeAirConditioningRearCompartment: auto ? 'AUTOMATIK' : 'MANUELL'
        };
        return this.operation('Rear climate mode', () => this.signals.set(this.require('climate'), 'climateFond', x));
    }
    async setBlower(level) {
        const n = Math.max(0, Math.min(9, Math.round(level)));
        const x = {
            controlTemperatureLeftHandAirConditioningRearCompartment: 255,
            controlTemperatureRightHandAirConditioningRearCompartment: 255,
            controlOperationPushButtonMaximumAirconRearCompartment: 'SIGNAL_UNBEFUELLT',
            controlOperationPushButtonAirInjectionManifoldAirConditioningRearCompartment: 'SIGNAL_UNBEFUELLT',
            controlBlowerSettingAirConditioningRearCompartment: 'STUFE_' + n,
            controlOperationPushButtonModeAirConditioningRearCompartment: 'MANUELL'
        };
        return this.operation('Rear blower', () => this.signals.set(this.require('climate'), 'climateFond', x));
    }
    async climatePower(on) {
        if (on) this.frontBeforeRearOn = this.state.climate.frontOn;
        const x = {
            operationAirconRearCompartment: on ? 'EINSCHALTEN__S__EIN' : 'AUSSCHALTEN__S_AUS',
            operationAirConditioningDefault2Tier: 'KEINE_AUSWAHL', operationAirConditioningDefault3Tier: 'KEINE_AUSWAHL',
            operationOn2Tier: on ? 'EIN' : 'AUS', operationOn3Tier: 'KEINE_AUSWAHL',
            operationModeAirConditioning2Tier: on ? 'EIN' : 'AUS', operationModeAirConditioning3Tier: 'KEINE_AUSWAHL',
            operationLock2Tier: 'KEINE_AUSWAHL', operationLock3Tier: 'KEINE_AUSWAHL', operationAircon3Tier: 'KEINE_AUSWAHL',
            operationBlowerSettingAirConditionings2Tier: 'SIGNAL_UNBEFUELLT', operationBlowerSettingAirConditionings3Tier: 'SIGNAL_UNBEFUELLT',
            operationTemperatureTarget2TierDR: 255, operationTemperatureTarget2TierPS: 255, operationTemperatureTarget3Tier: 255,
            operationAirDistributionProgramClimate3Seat: 'SIGNAL_UNBEFUELLT', operationAirDistributionProgramClimate2Seat: 'SIGNAL_UNBEFUELLT',
            operationManualBlowerLevelClimate3SeatRow: 'SIGNAL_UNBEFUELLT', operationManualBlowerLevelClimate2SeatRow: 'SIGNAL_UNBEFUELLT'
        };
        return this.operation('Rear climate ' + (on ? 'on' : 'off'), async () => {
            await this.signals.set(this.require('climate'), 'acFond', x);
            if (!on && this.frontBeforeRearOn === false && this.state.climate.frontOn === true) {
                await pause(350);
                await this.signals.set(this.require('climateFront'), 'operationAirConditioningFront', this.frontClimateOffValue());
            }
            if (!on) this.frontBeforeRearOn = null;
        });
    }
    frontClimateOffValue() {
        return {
            operationOnDR:'AUS', operationOnPS:'AUS', operationAircon:'KEINE_AUSWAHL',
            operationModeAirConditioningDR:'KEINE_AUSWAHL', operationModeAirConditioningPS:'KEINE_AUSWAHL',
            operationTemperatureTargetDR:255, operationTemperatureTargetPS:255,
            operationIntensityDR:'KEINE_AUSWAHL', operationIntensityPS:'KEINE_AUSWAHL', requestAICPIA:'KEINE_ANFORDERUNG',
            operationDefrost:'KEINE_AUSWAHL', operationMaximumAirCondition:'KEINE_AUSWAHL',
            operationManualBlowerLevelDR:'KEINE_AUSWAHL', operationManualBlowerLevelPS:'KEINE_AUSWAHL',
            operationAirdistributionProgramDR:'KEINE_AUSWAHL', operationAirdistributionProgramPS:'KEINE_AUSWAHL'
        };
    }
    seatClimateValue(side, kind, level) {
        const x = {
            operationStratificationSeatHeaterDR: 8, operationStratificationSeatHeaterPS: 8,
            operationStratificationSeatHeaterDRR: 8, operationStratificationSeatHeaterPSR: 8,
            operationFunctionStageSeatHeaterDR: 'SIGNAL_UNBEFUELLT', operationFunctionStageSeatClimateDR: 'SIGNAL_UNBEFUELLT',
            operationFunctionStageSeatHeaterPS: 'SIGNAL_UNBEFUELLT', operationFunctionStageSeatClimatePS: 'SIGNAL_UNBEFUELLT',
            operationFunctionStageSeatHeaterDRR: 'SIGNAL_UNBEFUELLT', operationFunctionStageSeatClimateDRR: 'SIGNAL_UNBEFUELLT',
            operationFunctionStageSeatHeaterPSR: 'SIGNAL_UNBEFUELLT', operationFunctionStageSeatClimatePSR: 'SIGNAL_UNBEFUELLT',
            operationSeatHeater3Tier: 'SIGNAL_UNBEFUELLT'
        };
        const member = 'operationFunctionStageSeat' + (kind === 'heat' ? 'Heater' : 'Climate') + (side === 'left' ? 'DRR' : 'PSR');
        x[member] = 'STUFE_' + Math.max(0, Math.min(3, level)); return x;
    }
    setSeatClimate(side, kind, level) {
        return this.operation('Rear ' + side + ' ' + kind,
            () => this.signals.set(this.require('climate'), 'seatHeatingLamination', this.seatClimateValue(side, kind, level)));
    }
    massageValue(side, level, program) {
        const s = side === 'left' ? 'RLH' : 'RRH';
        const x = {};
        x['operationPneumaticSeat' + s + 'Intensity'] = level ? 'STUFE_' + level : 'RESERVIERT';
        x['operationPneumaticSeat' + s + 'Program'] = program ? 'PROGRAMM_' + program : (side === 'left' ? 'SIGNAL_UNBEFUELLT' : 'NOCHANGE');
        x['operationPopUp' + s] = 'SIGNAL_UNGUELTIG';
        x['operationSPNMVelocity' + s] = 'SIGNAL_UNBEFUELLT';
        x['operationMassage' + s] = 'SIGNAL_UNBEFUELLT'; return x;
    }
    setMassage(side, level, program) {
        const field = side === 'left' ? 'seatMassageRL' : 'seatMassageRR';
        return this.operation('Rear ' + side + ' massage',
            () => this.signals.set(this.require('comfort'), field, this.massageValue(side, level, program)));
    }
    async lumbar(side, action) {
        this.stopped(); const field = side === 'left' ? 'adjustmentLumbarRL' : 'adjustmentLumbarRR';
        const member = side === 'left' ? 'operationAdjustmentLumbarRLH' : 'operationAdjustmentLumbarRRH';
        return this.operation('Rear ' + side + ' lumbar', async () => {
            const p = this.require('comfort'); await this.signals.set(p, field, { [member]: action });
            await pause(300); await this.signals.set(p, field, { [member]: 'KEINE_AKTION' });
        });
    }
    async moveSeat(side, action) {
        this.stopped();
        return this.operation('Rear ' + side + ' seat', async () => {
            const p = this.require('seat');
            const r = await this.signals.call(p, 'startSeatOperation', {
                seatPosition: side === 'left' ? 'REAR_LEFT' : 'REAR_RIGHT', seatAction: action
            });
            const id = r && r.requestorID;
            if (id === undefined || id === null) throw new Error('Seat controller did not grant movement');
            try { await pause(350); await this.signals.call(p, 'aliveSeatOperation', { requestorID: id }); }
            finally { await this.signals.call(p, 'stopSeatOperation', { requestorID: id }).catch(() => {}); }
        });
    }
    async shade(which, direction) {
        const x = { operationSwitchRLHSunBlind: 'KEINE_ANGABE', operationSwitchRearWindowBlindSunBlind: 'KEINE_ANGABE',
            operationSwitchRRHSunBlind: 'KEINE_ANGABE', operationSwitchAllShadowing: 'KEINE_ANGABE' };
        if (which === 'all') x.operationSwitchAllShadowing = direction === 'open' ? 'FAEHRT_AUF' : 'FAEHRT_ZU';
        else x[{ left: 'operationSwitchRLHSunBlind', right: 'operationSwitchRRHSunBlind', rear: 'operationSwitchRearWindowBlindSunBlind' }[which]] = 'TASTER_BETAETIGT';
        return this.operation((which === 'all' ? 'All shades' : which + ' shade'), async () => {
            const p = this.require('shades'); await this.signals.set(p, 'sunblind', x); await pause(170);
            x.operationSwitchRLHSunBlind = x.operationSwitchRearWindowBlindSunBlind = x.operationSwitchRRHSunBlind = x.operationSwitchAllShadowing = 'KEINE_ANGABE';
            await this.signals.set(p, 'sunblind', x);
        });
    }
    async screenFocus(side) {
        return this.operation('Rear screen selection', async () => {
            const life = this.require('lifecycle');
            await this.signals.call(life, 'requestRSE', {});
            await this.signals.set(life, 'rseLock', 'FULL_ACCESS');
            await this.signals.set(life, 'rseHmiMenu', true);
            await this.signals.set(this.require('rseLife'), 'focusIndicatorHMI', side === 'left' ? 'RSE_SELECTION_LEFT' : 'RSE_SELECTION_RIGHT');
        });
    }
    async screenPower(side, on) {
        return this.operation('Rear ' + side + ' screen', async () => {
            if (on) {
                await this.signals.call(this.require('lifecycle'), 'requestRSE', {});
                await this.signals.call(this.require('lifecycle'), 'requestRSEEntertainmentMode', {
                    rseEntertainmentMode: side === 'left' ? 'ENTERTAINMENT_MODE_LEFT' : 'ENTERTAINMENT_MODE_RIGHT'
                });
            } else await this.signals.call(this.require('rseLife'), side === 'left' ? 'leaveEntertainmentModeLeft' : 'leaveEntertainmentModeRight', {});
        });
    }
    async screenDisplay(on) { return this.operation('Rear display', () => this.signals.set(this.require('rseDisplay'), 'displayState', on ? 'ON' : 'OFF')); }
    async screenBrightness(value) { return this.operation('Rear display brightness', () => this.signals.set(this.require('rseDisplay'), 'displayBrightness', Math.max(0, Math.min(100, value)))); }
    async remote(kind, key) {
        return this.operation('Rear remote', async () => {
            const side = String(this.state.screens.focus).indexOf('RIGHT') >= 0 ? 'right' : 'left';
            const life = this.require('lifecycle');
            await this.signals.call(life, 'requestRSE', {});
            await this.signals.set(life, 'rseLock', 'FULL_ACCESS');
            await this.signals.set(life, 'rseHmiMenu', true);
            await this.signals.set(this.require('rseLife'), 'focusIndicatorHMI', side === 'left' ? 'RSE_SELECTION_LEFT' : 'RSE_SELECTION_RIGHT');
            for (let i=0; i<10 && !this.state.available.rseRemote; i++) await pause(200);
            return this.signals.call(this.require('rseRemote'), kind === 'direction' ? 'sendDirectionKey' : 'sendCommandKey', { keyValue: key });
        });
    }
}

module.exports = { RearControl, stage, active };
