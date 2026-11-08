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
const LEASE = '/run/mgu-uplink/lease.json';
const FALLBACK_UID = 65534;
const SIGNAL_APP = 'vehicle_health';
const OAP_UIDS = '/var/opt/public/oap/oap_12201/security/uids.txt';
const UPLINK_UID_FILE = '/var/opt/mgu-uplink/uids.d/remote-telemetry-bridge';
const INTERVAL_MS = 30000;

const state = {
    startedAt: new Date().toISOString(), lastSampleAt: null, lastUploadAt: null,
    lastHttpStatus: null, error: null, configured: false, uplink: false,
    providers: {}, telemetry: {}, awake: true, phase: 'starting', signalUid: null,
    batteryVoltageSource: null, outsideTemperatureSource: null,
    outsideTemperatureSampledAt: null
};
let stopping = false;
const proxies = [];
let runtimeConfig = {};

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
    state.telemetry[name] = value;
    state.lastSampleAt = new Date().toISOString();
    writeStatus();
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
    const marker = path.join(SOMEIP_DIR, '.bridge-config-v4');
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
    const servers = Array.isArray(lease.dns) ? lease.dns.filter((x) => typeof x === 'string') : [];
    if (servers.length) dns.setServers(servers);
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
        let available = !!(proxy.isAvailable && proxy.isAvailable());
        state.providers.batteryVoltage = available;
        try { proxy.subscribeToAvailability((value) => { available = !!value; state.providers.batteryVoltage = available; writeStatus(); }); } catch (e) {}
        proxy.subscribe({name:'sendTasuResponse', onReceive:(value) => {
            const frame = bytes(value && (value.udsResponse !== undefined ? value.udsResponse : value));
            if (frame.length < 13 || frame[6] !== 0x12) return;
            const uds = frame.slice(9);
            if (uds[0] !== 0x62) return;
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
        request(); setInterval(request, INTERVAL_MS);
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
        schema:1, sampledAt:state.lastSampleAt, awake:state.awake !== false, telemetry:state.telemetry
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
        watch(someip, 'de.bmw.infotainment.climate.Climate2', 'statusTemperatureInside',
            (v) => setTelemetry('insideTemperatureC', temp(v && v.temperatureInside))),
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
