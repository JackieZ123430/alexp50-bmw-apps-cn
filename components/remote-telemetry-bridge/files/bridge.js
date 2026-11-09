#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns');
const child = require('child_process');
const url = require('url');

const ROOT = '/var/opt/remote-telemetry-bridge';
const CONFIG = path.join(ROOT, 'config.json');
const SOMEIP_DIR = path.join(ROOT, 'someip');
const RUN = '/run/remote-telemetry-bridge';
const STATUS = path.join(RUN, 'status.json');
const LAST_STATUS = path.join(ROOT, 'last-status.json');
const RETAINED = path.join(ROOT, 'retained-telemetry.json');
const LEASE = '/run/mgu-uplink/lease.json';
const FALLBACK_UID = 65534;
const SIGNAL_APP = 'vehicle_health';
const OAP_UIDS = '/var/opt/public/oap/oap_12201/security/uids.txt';
const UPLINK_UID_FILE = '/var/opt/mgu-uplink/uids.d/remote-telemetry-bridge';
// A five-minute heartbeat stays within Cloudflare KV's free write quota.
// State changes are uploaded immediately through scheduleUpload().
const INTERVAL_MS = 300000;
const DIAGNOSTIC_INTERVAL_MS = 30000;
const COMMAND_INTERVAL_MS = 5000;

const retained = readJson(RETAINED, {});
const state = {
    startedAt: new Date().toISOString(), lastSampleAt: retained.sampledAt || null, lastUploadAt: null,
    lastHttpStatus: null, error: null, configured: false, uplink: false,
    providers: {}, telemetry: retained.telemetry || {}, climate: retained.climate || {}, awake: true, phase: 'starting', signalUid: null,
    batteryVoltageSource: retained.batteryVoltageSource || null,
    outsideTemperatureSource: retained.outsideTemperatureSource || null,
    outsideTemperatureSampledAt: retained.outsideTemperatureSampledAt || null
};
let stopping = false;
const proxies = [];
let runtimeConfig = {};
let climateProxy = null;
let commandBusy = false;
let uploadTimer = null;
let requestIhkaStatus = () => {};
let diagnosticProxy = null;
let ihkaStatusBusy = false;

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function atomicJson(file, value) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value) + '\n');
    fs.renameSync(tmp, file);
}
function writeStatus() {
    try { atomicJson(STATUS, state); } catch (e) {}
    try { atomicJson(LAST_STATUS, state); } catch (e) {}
    const slow = {};
    if (finite(state.telemetry.batteryVoltage)) slow.batteryVoltage = state.telemetry.batteryVoltage;
    if (finite(state.telemetry.outsideTemperatureC)) slow.outsideTemperatureC = state.telemetry.outsideTemperatureC;
    if (Object.keys(slow).length) {
        try { atomicJson(RETAINED, {
            sampledAt: state.lastSampleAt, telemetry: slow, climate: state.climate,
            batteryVoltageSource: state.batteryVoltageSource,
            outsideTemperatureSource: state.outsideTemperatureSource,
            outsideTemperatureSampledAt: state.outsideTemperatureSampledAt
        }); } catch (e) {}
    }
}
function finite(v) { return typeof v === 'number' && isFinite(v); }
function temp(raw) { return finite(raw) && raw !== 255 ? Math.round((raw * 0.5 - 40) * 10) / 10 : null; }
function speed(raw) { return finite(raw) && raw !== 65535 ? Math.round(raw * 0.015625 * 10) / 10 : null; }
function pressure(raw) { return finite(raw) && raw < 65532 ? Math.round(raw) / 10 : null; }
function bytes(value) {
    if (!value) return [];
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || Array.isArray(value)) return Array.prototype.slice.call(value);
    if (value.data) return bytes(value.data);
    if (typeof value === 'object' && typeof value.length === 'number') return Array.prototype.slice.call(value);
    return [];
}

function setTelemetry(name, value) {
    if (value === null || value === undefined) return;
    if (JSON.stringify(state.telemetry[name]) === JSON.stringify(value)) return;
    state.telemetry[name] = value;
    state.lastSampleAt = new Date().toISOString();
    writeStatus();
    scheduleUpload();
}

function scheduleUpload() {
    if (uploadTimer || !runtimeConfig.endpoint) return;
    uploadTimer = setTimeout(() => {
        uploadTimer = null;
        if (!stopping) upload(runtimeConfig).catch(() => {});
    }, 800);
}

function updateClimate(patch) {
    let changed = false;
    for (const name of Object.keys(patch)) {
        if (patch[name] !== undefined && state.climate[name] !== patch[name]) {
            state.climate[name] = patch[name];
            changed = true;
        }
    }
    if (!changed) return;
    state.climate.sampledAt = new Date().toISOString();
    state.lastSampleAt = state.climate.sampledAt;
    writeStatus();
    scheduleUpload();
}

function setOutsideDegrees(degrees, source, preferred) {
    if (!finite(degrees) || degrees < -50 || degrees > 80) return;
    // Once the cluster-filtered signal has arrived, never replace it with a
    // diagnostic or raw-sensor fallback.
    if (!preferred && state.outsideTemperatureSource === 'EnvironmentalInformation.ExteriorTemperature') return;
    setTelemetry('outsideTemperatureC', Math.round(degrees * 10) / 10);
    state.outsideTemperatureSource = source;
    state.outsideTemperatureSampledAt = new Date().toISOString();
    writeStatus();
}

function ensureSomeIp() {
    const marker = path.join(SOMEIP_DIR, '.bridge-config-v6');
    if (fs.existsSync(marker)) return;
    if (!fs.existsSync(SOMEIP_DIR)) fs.mkdirSync(SOMEIP_DIR);
    try {
        child.execFileSync('/usr/bin/node', [path.join(__dirname, 'generate-someip.js'), SOMEIP_DIR], {stdio:'inherit'});
        fs.writeFileSync(marker, new Date().toISOString() + '\n');
    } catch (e) {
        state.error = 'SOME/IP configuration: ' + e.message;
        writeStatus();
    }
}

function configureDns() {
    const lease = readJson(LEASE, {});
    const leaseServers = Array.isArray(lease.dns) ? lease.dns.filter((x) => typeof x === 'string' && x) : [];
    // The Huawei router occasionally refuses a query while its LTE session is
    // renegotiating. Public resolvers remain reachable through the same
    // uid-routed mgu-uplink path and keep command polling alive in that window.
    const servers = Array.from(new Set(['1.1.1.1', '8.8.8.8'].concat(leaseServers)));
    dns.setServers(servers);
    state.uplink = !!lease.interface;
}

function resolveSignalUid() {
    try {
        const lines = fs.readFileSync(OAP_UIDS, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const match = /^(\d+)=(.+)$/.exec(line.trim());
            if (match && match[2] === SIGNAL_APP) return Number(match[1]);
        }
    } catch (e) {}
    return FALLBACK_UID;
}

function allowUplinkUid(uid) {
    try {
        fs.writeFileSync(UPLINK_UID_FILE, String(FALLBACK_UID) + '\n' + String(uid) + '\n');
    } catch (e) {
        state.error = 'cannot register uplink uid: ' + e.message;
    }
}

// https.request uses the OS resolver (dns.lookup), which on this MGU is the
// vehicle dnsmasq instance. When ENET and the Wi-Fi uplink share a subnet,
// that resolver can send its upstream query over the vehicle route. Resolve
// inside this uid-routed process instead; mgu-uplink then carries both DNS
// and HTTPS through the selected Internet adapter.
function uplinkLookup(hostname, options, callback) {
    dns.resolve4(hostname, (error, addresses) => {
        if (error) return callback(error);
        if (!addresses || !addresses.length) return callback(new Error('DNS returned no IPv4 address for ' + hostname));
        callback(null, addresses[0], 4);
    });
}

function loadSomeIp() {
    try { return require('someip'); } catch (globalError) {
        try { return require('/usr/lib/someip.node'); } catch (directError) {
            throw new Error('SOME/IP native module unavailable: ' + globalError.message + '; ' + directError.message);
        }
    }
}

function configFile(iface) { return path.join(SOMEIP_DIR, iface.replace(/\./g, '_') + '.json'); }
let nativeChain = Promise.resolve();
function nativeTick(fn) {
    const run = () => new Promise((resolve, reject) => setImmediate(() => {
        try { Promise.resolve(fn()).then(resolve, reject); } catch (e) { reject(e); }
    }));
    const result = nativeChain.then(run, run);
    nativeChain = result.catch(() => {});
    return result;
}
function watch(someip, iface, field, receive) {
    let cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(configFile(iface), 'utf8'));
    } catch (e) {
        state.providers[iface] = false;
        state.error = iface + ': no generated interface configuration';
        writeStatus();
        return Promise.resolve(null);
    }
    return nativeTick(() => someip.buildProxy(cfg, '1').then((proxy) => proxy.init().then(() => proxy))).then((proxy) => {
        proxies.push(proxy);
        state.providers[iface] = false;
        proxy.subscribeToAvailability((available) => {
            state.providers[iface] = !!available;
            if (available && cfg.fields && cfg.fields[field] && cfg.fields[field].getter) {
                proxy.getValue(field, 3000).then(receive).catch(() => {});
            }
            writeStatus();
        });
        try { proxy.subscribe({name:field, onReceive:receive}).catch(() => {}); } catch (e) {}
        setInterval(() => {
            if (state.providers[iface] && cfg.fields && cfg.fields[field] && cfg.fields[field].getter) {
                proxy.getValue(field, 3000).then(receive).catch(() => {});
            }
        }, 15000);
        return proxy;
    }).catch((e) => { state.providers[iface] = false; state.error = iface + ': ' + e.message; writeStatus(); return null; });
}

function watchClimate(someip) {
    const iface = 'de.bmw.infotainment.climate.Climate2';
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(configFile(iface), 'utf8')); }
    catch (e) { state.providers[iface] = false; state.error = iface + ': no generated interface configuration'; writeStatus(); return Promise.resolve(null); }
    return nativeTick(() => someip.buildProxy(cfg, '1').then((proxy) => proxy.init().then(() => proxy))).then((proxy) => {
        proxies.push(proxy); climateProxy = proxy; state.providers[iface] = false;
        // statusTemperatureInside uses an IHKA-internal encoding on this
        // firmware. The authoritative cabin temperature comes from IHKA DID
        // D8D7 below, so do not apply the exterior-temperature formula here.
        const receive = () => {};
        const remember = (name) => (value) => {
            if (!state.climate) state.climate = {};
            state.climate[name] = value;
            state.climate.sampledAt = new Date().toISOString();
            writeStatus();
            if (name === 'frontFunctions' && value) updateClimate({
                on:value.statusAC === 'KLIMAANLAGE_EIN',
                frontDefrost:value.statusDefrost === 'DEFROST_EIN'
            });
            if (name === 'driver' && value) updateClimate({
                driverTargetC:finite(value.temperatureTargetDRIHKA) ? value.temperatureTargetDRIHKA / 2 : undefined
            });
            if (name === 'passenger' && value) updateClimate({
                passengerTargetC:finite(value.temperatureTargetPSIHKA) ? value.temperatureTargetPSIHKA / 2 : undefined
            });
        };
        proxy.subscribeToAvailability((available) => {
            state.providers[iface] = !!available;
            if (available) {
                proxy.getValue('statusTemperatureInside', 3000).then(receive).catch(() => {});
                proxy.getValue('statusACFrontFunctions', 3000).then(remember('frontFunctions')).catch(() => {});
                proxy.getValue('statusAirConditionDRStatus', 3000).then(remember('driver')).catch(() => {});
                proxy.getValue('statusAirConditionPSStatus', 3000).then(remember('passenger')).catch(() => {});
                proxy.getValue('statusAirConditionParkFunctions', 3000).then(remember('park')).catch(() => {});
            }
            writeStatus();
        });
        try { proxy.subscribe({name:'statusTemperatureInside', onReceive:receive}).catch(() => {}); } catch (e) {}
        for (const pair of [
            ['statusACFrontFunctions','frontFunctions'],
            ['statusAirConditionDRStatus','driver'],
            ['statusAirConditionPSStatus','passenger'],
            ['statusAirConditionParkFunctions','park']
        ]) {
            try { proxy.subscribe({name:pair[0], onReceive:remember(pair[1])}).catch(() => {}); } catch (e) {}
        }
        setInterval(() => { if (state.providers[iface]) proxy.getValue('statusTemperatureInside', 3000).then(receive).catch(() => {}); }, 15000);
        return proxy;
    }).catch((e) => { state.providers[iface] = false; state.error = iface + ': ' + e.message; writeStatus(); return null; });
}

function parkClimateValue(on) {
    return {
        operationParkHeat:'KEINE_AKTION__S__NICHT_VERFUEGBAR',
        operationIndependentVentilate:'KEINE_AKTION__S__NICHT_VERFUEGBAR',
        operationExtraHeater:'KEINE_AKTION__S__NICHT_VERFUEGBAR',
        operationParkAirConditioning:on ? 'STANDKLIMATISIERUNG_EIN' : 'STANDKLIMATISIERUNG_AUS',
        operationParkFunctionAutoMode:'KEINE_AKTION__S__NICHT_VERFUEGBAR',
        operationRemoteStart:'KEINE_AKTION_NICHT_VERFUEGBAR'
    };
}

function frontClimateValue(command) {
    const no = 'KEINE_AUSWAHL';
    const value = {
        operationOnDR:no, operationOnPS:no, operationAircon:no,
        operationModeAirConditioningDR:no, operationModeAirConditioningPS:no,
        operationTemperatureTargetDR:255, operationTemperatureTargetPS:255,
        operationIntensityDR:no, operationIntensityPS:no, requestAICPIA:'KEINE_ANFORDERUNG',
        operationDefrost:no, operationMaximumAirCondition:no,
        operationManualBlowerLevelDR:no, operationManualBlowerLevelPS:no,
        operationAirdistributionProgramDR:no, operationAirdistributionProgramPS:no
    };
    if (command.type === 'climate_on' || command.type === 'climate_off') {
        value.operationOnDR = command.type === 'climate_on' ? 'EIN' : 'AUS';
        value.operationOnPS = value.operationOnDR;
    }
    if (command.type === 'defrost_on' || command.type === 'defrost_off') value.operationDefrost = command.type === 'defrost_on' ? 'EIN' : 'AUS';
    if (command.type === 'set_temperature') {
        value.operationTemperatureTargetDR = Math.round(command.celsius * 2);
        value.operationTemperatureTargetPS = Math.round(command.celsius * 2);
    }
    if (command.type === 'set_fan') {
        value.operationManualBlowerLevelDR = 'STUFE_' + command.level;
        value.operationManualBlowerLevelPS = 'STUFE_' + command.level;
    }
    return value;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitClimate(field, check, timeout) {
    const until = Date.now() + (timeout || 5000);
    let last = null;
    while (Date.now() < until) {
        try {
            last = await nativeTick(() => climateProxy.getValue(field, 3000));
            if (check(last)) return last;
        } catch (e) {}
        await sleep(350);
    }
    throw new Error('BMW Climate2 did not confirm the requested state' + (last ? ': ' + JSON.stringify(last) : ''));
}

function seatClimateValue(command) {
    const value = {
        operationStratificationSeatHeaterDR:255, operationStratificationSeatHeaterPS:255,
        operationStratificationSeatHeaterDRR:255, operationStratificationSeatHeaterPSR:255,
        operationFunctionStageSeatHeaterDR:0, operationFunctionStageSeatClimateDR:0,
        operationFunctionStageSeatHeaterPS:0, operationFunctionStageSeatClimatePS:0,
        operationFunctionStageSeatHeaterDRR:0, operationFunctionStageSeatClimateDRR:0,
        operationFunctionStageSeatHeaterPSR:0, operationFunctionStageSeatClimatePSR:0,
        operationFunctionStageNeckHeaterDR:'KEINE_AKTION', operationFunctionStageNeckHeaterPS:'KEINE_AKTION',
        operationFunctionNeckHeaterDR:'KEINE_AKTION', operationFunctionNeckHeaterPS:'KEINE_AKTION'
    };
    const suffix = {driver:'DR', frontPassenger:'PS', rearLeft:'DRR', rearRight:'PSR'}[command.seat];
    const kind = command.type === 'seat_heat' ? 'Heater' : 'Climate';
    value['operationFunctionStageSeat' + kind + suffix] = command.level + 1;
    return value;
}

async function executeCommand(command) {
    if (!climateProxy || !state.providers['de.bmw.infotainment.climate.Climate2']) throw new Error('BMW Climate2 provider is unavailable');
    let field, value, description;
    if (command.type === 'climate_on' || command.type === 'climate_off' || command.type === 'defrost_on' || command.type === 'defrost_off' || command.type === 'set_temperature' || command.type === 'set_fan') {
        field = 'operationAirConditioningFront'; value = frontClimateValue(command); description = command.type.replace(/_/g, ' ');
    } else if (command.type === 'seat_heat' || command.type === 'seat_vent') {
        field = 'operationStratificationSeatHeating'; value = seatClimateValue(command); description = command.type.replace(/_/g, ' ') + ' ' + command.seat + ' level ' + command.level;
    } else if (command.type === 'rear_defrost_on' || command.type === 'rear_defrost_off') {
        if (!diagnosticProxy) throw new Error('BMW IHKA diagnostic provider is unavailable');
        const wanted = command.type === 'rear_defrost_on';
        requestIhkaStatus();
        for (let i = 0; i < 12 && state.climate.rearDefrost === undefined; i++) await sleep(250);
        if (state.climate.rearDefrost === wanted) return 'rear defrost already ' + (wanted ? 'on' : 'off');
        // BMW IHKA routine A126 simulates the physical climate-panel button.
        // Button 0x02 is HHS (Heckscheibenheizung / rear-window heating).
        // Send a short press and release, then verify the authoritative D8DB
        // function-status byte rather than assuming the toggle succeeded.
        for (const pressed of [1, 0]) {
            await nativeTick(() => diagnosticProxy.callMethod('sendTasuRequest', {
                sourceAddress:0xF2, targetAddress:0x78, serviceID:0x31, subroutineID:0x01,
                udsDataLength:4, udsData:Buffer.from([0xA1, 0x26, 0x02, pressed]), deadlockTime:0
            }, 5000));
            await sleep(pressed ? 250 : 100);
        }
        const until = Date.now() + 10000;
        while (Date.now() < until) {
            requestIhkaStatus();
            if (state.climate.rearDefrost === wanted) return 'rear defrost confirmed ' + (wanted ? 'on' : 'off');
            await sleep(400);
        }
        throw new Error('IHKA did not confirm rear-window heating ' + (wanted ? 'on' : 'off'));
    } else throw new Error('Unsupported command type');
    await nativeTick(() => climateProxy.setValue(field, value, 6000));
    if (command.type === 'climate_on' || command.type === 'climate_off') {
        const wanted = command.type === 'climate_on' ? 'KLIMAANLAGE_EIN' : 'KLIMAANLAGE_AUS';
        const confirmed = await waitClimate('statusACFrontFunctions', (v) => v && v.statusAC === wanted);
        return description + ' confirmed: ' + confirmed.statusAC;
    }
    if (command.type === 'defrost_on' || command.type === 'defrost_off') {
        const wanted = command.type === 'defrost_on' ? 'DEFROST_EIN' : 'DEFROST_AUS';
        const confirmed = await waitClimate('statusACFrontFunctions', (v) => v && v.statusDefrost === wanted);
        return description + ' confirmed: ' + confirmed.statusDefrost;
    }
    if (command.type === 'set_temperature') {
        const raw = Math.round(command.celsius * 2);
        const confirmed = await waitClimate('statusAirConditionDRStatus', (v) => v && v.temperatureTargetDRIHKA === raw);
        return description + ' confirmed: ' + (confirmed.temperatureTargetDRIHKA / 2).toFixed(1) + ' C';
    }
    if (command.type === 'set_fan') {
        requestIhkaStatus();
        const until = Date.now() + 7000;
        while (Date.now() < until) {
            if (Number(state.climate.fanDriver) === command.level) return description + ' confirmed: level ' + command.level;
            await sleep(350);
        }
        throw new Error('IHKA did not confirm blower level ' + command.level);
    }
    if (command.type === 'seat_heat' || command.type === 'seat_vent') {
        requestIhkaStatus();
        const key = {
            driver:{seat_heat:'driverHeat',seat_vent:'driverVent'},
            frontPassenger:{seat_heat:'passengerHeat',seat_vent:'passengerVent'},
            rearLeft:{seat_heat:'rearLeftHeat',seat_vent:'rearLeftVent'},
            rearRight:{seat_heat:'rearRightHeat',seat_vent:'rearRightVent'}
        }[command.seat][command.type];
        const until = Date.now() + 7000;
        while (Date.now() < until) {
            if (Number(state.climate[key]) === command.level) return description + ' confirmed';
            await sleep(350);
        }
        throw new Error('IHKA did not confirm ' + description);
    }
    return description + ' confirmed';
}

function relayRequest(config, method, pathName, body) {
    return new Promise((resolve, reject) => {
        const target = url.parse(config.endpoint.replace(/\/$/, '') + '/v1/cars/' + encodeURIComponent(config.carId) + pathName);
        const payload = body == null ? null : Buffer.from(JSON.stringify(body));
        const headers = {'Authorization':'Bearer ' + config.writeToken, 'Accept':'application/json', 'User-Agent':'BMW-MGU-Remote-Telemetry/0.2'};
        if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
        const req = https.request({protocol:'https:', hostname:target.hostname, port:target.port || 443, path:target.path, method, timeout:10000, lookup:uplinkLookup, headers}, (res) => {
            const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch (e) {}
                resolve({status:res.statusCode, body:parsed});
            });
        });
        req.on('timeout', () => req.destroy(new Error('relay timeout'))); req.on('error', reject);
        if (payload) req.write(payload); req.end();
    });
}

async function pollCommand(config) {
    if (commandBusy || !config.endpoint || !config.writeToken || !config.carId) return;
    commandBusy = true;
    try {
        configureDns();
        const response = await relayRequest(config, 'GET', '/commands', null);
        state.commandError = null;
        writeStatus();
        if (response.status === 204) return;
        if (response.status !== 200 || !response.body || !response.body.id) throw new Error('command relay HTTP ' + response.status);
        const command = response.body;
        let status = 'accepted', result;
        try { result = await executeCommand(command); } catch (e) { status = 'rejected'; result = e.message; }
        await relayRequest(config, 'POST', '/commands/' + encodeURIComponent(command.id), {status, result});
        state.lastCommand = {id:command.id, type:command.type, status, result, completedAt:new Date().toISOString()};
        writeStatus();
    } catch (e) { state.commandError = e.message; writeStatus(); }
    finally { commandBusy = false; }
}

// DDE DID 43C1 is the IBS-measured 12 V system voltage in millivolts. DDE DID
// 50A6 is the environment temperature as uint16 * 0.1 - 273.14 C. The
// request is read-only UDS 22 over BMW's TASU service, the same transport used
// by the diagnostic apps on the head unit. BMW's filtered exterior broadcast
// remains authoritative whenever it is available.
function watchBatteryVoltage(someip) {
    const iface = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(configFile(iface), 'utf8')); }
    catch (e) { state.providers.batteryVoltage = false; state.error = 'battery voltage: no TASU configuration'; writeStatus(); return Promise.resolve(null); }
    return nativeTick(() => someip.buildProxy(cfg, 'SystemFunctionsInternalTasuInst1').then((proxy) => proxy.init().then(() => proxy))).then((proxy) => {
        proxies.push(proxy);
        diagnosticProxy = proxy;
        let available = !!(proxy.isAvailable && proxy.isAvailable());
        state.providers.batteryVoltage = available;
        try { proxy.subscribeToAvailability((value) => { available = !!value; state.providers.batteryVoltage = available; writeStatus(); }); } catch (e) {}
        proxy.subscribe({name:'sendTasuResponse', onReceive:(value) => {
            const frame = bytes(value && (value.udsResponse !== undefined ? value.udsResponse : value));
            if (frame.length < 13) return;
            const targetAddress = frame[6];
            const uds = frame.slice(9);
            if (uds[0] !== 0x62) return;
            if (targetAddress === 0x78) {
                const did = (uds[1] << 8) | uds[2];
                const data = uds.slice(3);
                if (did === 0xD8D7 && data.length >= 11) {
                    const raw = data[10];
                    if (raw !== 0x80) setTelemetry('insideTemperatureC', raw > 127 ? raw - 256 : raw);
                } else if (did === 0xD8DB && data.length >= 28) {
                    const validLevel = (v) => v <= 9 ? v : null;
                    updateClimate({
                        on:data[15] === 0,
                        rearDefrost:data[5] === 1 || data[5] === 2,
                        frontDefrost:data[7] === 1,
                        fanDriver:validLevel(data[16]), fanPassenger:validLevel(data[17]), fanRear:validLevel(data[27]),
                        driverHeat:validLevel(data[19]), passengerHeat:validLevel(data[20]),
                        driverVent:validLevel(data[21]), passengerVent:validLevel(data[22]),
                        rearLeftHeat:validLevel(data[23]), rearRightHeat:validLevel(data[24]),
                        rearLeftVent:validLevel(data[25]), rearRightVent:validLevel(data[26])
                    });
                }
                return;
            }
            if (targetAddress !== 0x12) return;
            for (let i = 1; i + 1 < uds.length;) {
                const did = (uds[i] << 8) | uds[i + 1]; i += 2;
                if (did === 0x43C1 && i + 1 < uds.length) {
                    const voltage = ((uds[i] << 8) | uds[i + 1]) * 0.001; i += 2;
                    if (voltage >= 6 && voltage <= 18) {
                        setTelemetry('batteryVoltage', Math.round(voltage * 100) / 100);
                        state.batteryVoltageSource = 'DDE 43C1 · IBS measured';
                    }
                } else if (did === 0x50A6 && i + 1 < uds.length) {
                    const outside = ((uds[i] << 8) | uds[i + 1]) * 0.1 - 273.14; i += 2;
                    setOutsideDegrees(outside, 'DDE 50A6 · environment temperature', false);
                } else break;
            }
        }}).catch(() => {});
        const request = () => {
            if (!available) return;
            nativeTick(() => proxy.callMethod('sendTasuRequest', {
                sourceAddress:0xF2, targetAddress:0x12, serviceID:0x22, subroutineID:0,
                udsDataLength:4, udsData:Buffer.from([0x43, 0xC1, 0x50, 0xA6]), deadlockTime:0
            }, 5000)).catch((e) => { state.error = 'battery voltage: ' + e.message; writeStatus(); });
        };
        requestIhkaStatus = async () => {
            if (!available || ihkaStatusBusy) return;
            ihkaStatusBusy = true;
            try {
                for (const did of [[0xD8, 0xD7], [0xD8, 0xDB]]) {
                    await nativeTick(() => proxy.callMethod('sendTasuRequest', {
                        sourceAddress:0xF2, targetAddress:0x78, serviceID:0x22, subroutineID:0,
                        udsDataLength:2, udsData:Buffer.from(did), deadlockTime:0
                    }, 5000));
                    // TASU acknowledges the request before the ECU response is
                    // broadcast. Avoid presenting the IHKA with two overlapping
                    // ReadDataByIdentifier requests.
                    await sleep(250);
                }
            } catch (e) {
                state.error = 'IHKA status: ' + e.message; writeStatus();
            } finally { ihkaStatusBusy = false; }
        };
        request(); setInterval(request, DIAGNOSTIC_INTERVAL_MS);
        requestIhkaStatus(); setInterval(requestIhkaStatus, 5000);
        return proxy;
    }).catch((e) => { state.providers.batteryVoltage = false; state.error = 'battery voltage: ' + e.message; writeStatus(); return null; });
}

function upload(config) {
    configureDns();
    if (!config.endpoint || !config.writeToken || !config.carId) {
        state.configured = false; state.error = 'not configured'; writeStatus(); return Promise.resolve(false);
    }
    state.configured = true;
    const target = url.parse(config.endpoint.replace(/\/$/, '') + '/v1/cars/' + encodeURIComponent(config.carId) + '/telemetry');
    if (target.protocol !== 'https:') {
        state.error = 'endpoint must use HTTPS'; writeStatus(); return Promise.resolve(false);
    }
    const payload = Buffer.from(JSON.stringify({
        schema:1, sampledAt:state.lastSampleAt, awake:state.awake !== false,
        telemetry:state.telemetry, climate:state.climate
    }));
    return new Promise((resolve) => {
        const req = https.request({
            protocol:'https:', hostname:target.hostname, port:target.port || 443,
            path:target.path, method:'POST', timeout:12000, lookup:uplinkLookup,
            headers:{'Authorization':'Bearer ' + config.writeToken, 'Content-Type':'application/json',
                'Content-Length':payload.length, 'User-Agent':'BMW-MGU-Remote-Telemetry/0.1'}
        }, (res) => {
            res.resume(); state.lastHttpStatus = res.statusCode;
            if (res.statusCode >= 200 && res.statusCode < 300) {
                state.lastUploadAt = new Date().toISOString(); state.error = null; resolve(true);
            } else { state.error = 'relay returned HTTP ' + res.statusCode; resolve(false); }
            writeStatus();
        });
        req.on('timeout', () => req.destroy(new Error('upload timeout')));
        req.on('error', (e) => { state.error = e.message; writeStatus(); resolve(false); });
        req.end(payload);
    });
}

async function main() {
    if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT);
    if (!fs.existsSync(RUN)) fs.mkdirSync(RUN);
    writeStatus();
    runtimeConfig = readJson(CONFIG, {});
    ensureSomeIp();
    const signalUid = resolveSignalUid();
    state.signalUid = signalUid;
    allowUplinkUid(signalUid);
    try { fs.chownSync(RUN, signalUid, signalUid); } catch (e) {}
    const someip = loadSomeIp();
    const setOutside = (value, source, filtered) => {
        const raw = value && (filtered ? value.temperatureExterior : value.unfilteredTemperatureExterior);
        const degrees = temp(raw);
        if (degrees === null) return;
        setOutsideDegrees(degrees, 'EnvironmentalInformation.' + source, filtered);
    };
    // BMW's SOME/IP ACL is keyed to an installed OAP application's uid. Use
    // Vehicle Health's signal grant, and grant that same uid outbound access
    // through mgu-uplink for the authenticated relay only.
    if (process.getuid && process.getuid() === 0) {
        try { process.setgid(signalUid); process.setuid(signalUid); } catch (e) { throw new Error('cannot drop privileges: ' + e.message); }
    }
    writeStatus();
    await Promise.all([
        watchClimate(someip),
        watch(someip, 'de.bmw.infrastructure.EnvironmentalInformation', 'ExteriorTemperature',
            (v) => setOutside(v, 'ExteriorTemperature', true)),
        watch(someip, 'de.bmw.infrastructure.EnvironmentalInformation', 'unfilteredExteriorTemperature',
            (v) => setOutside(v, 'unfilteredExteriorTemperature', false)),
        watch(someip, 'de.bmw.infotainment.vehicle.CDS', 'statusBattery2',
            (v) => setTelemetry('batteryChargePercent', finite(v && v.conditionBatteryChargingCondition) ? v.conditionBatteryChargingCondition : null)),
        watch(someip, 'de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2',
            (v) => setTelemetry('speedKmh', speed(v && v.speedVehicleCentreOfGravity))),
        watch(someip, 'de.bmw.infotainment.vehicle.TPMS', 'statusTyrePressure', (v) => {
            if (!v) return;
            setTelemetry('tyrePressureBar', {
                frontLeft:pressure(v.actualValuePressureTyreFLH), frontRight:pressure(v.actualValuePressureTyreFRH),
                rearLeft:pressure(v.actualValuePressureTyreRLH), rearRight:pressure(v.actualValuePressureTyreRRH)
            });
        }),
        watchBatteryVoltage(someip)
    ]);
    state.phase = 'running';
    if (Object.keys(state.providers).length) state.error = null;
    writeStatus();
    const tick = () => { if (!stopping) upload(runtimeConfig).catch(() => {}); };
    tick(); setInterval(tick, INTERVAL_MS);
    const commandTick = () => { if (!stopping) pollCommand(runtimeConfig).catch(() => {}); };
    commandTick(); setInterval(commandTick, COMMAND_INTERVAL_MS);
}

function stop() {
    if (stopping) return; stopping = true;
    state.awake = false; writeStatus();
    upload(runtimeConfig).catch(() => {}).then(() => Promise.all(proxies.map((p) => p.shutdown ? p.shutdown().catch(() => {}) : null)))
        .then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
main().catch((e) => { state.phase = 'failed'; state.error = e.message; writeStatus(); process.stderr.write('remote telemetry: ' + e.stack + '\n'); process.exit(1); });
