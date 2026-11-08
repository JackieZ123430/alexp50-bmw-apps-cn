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
const LEASE = '/run/mgu-uplink/lease.json';
const UID = 65534;
const INTERVAL_MS = 30000;

const state = {
    startedAt: new Date().toISOString(), lastSampleAt: null, lastUploadAt: null,
    lastHttpStatus: null, error: null, configured: false, uplink: false,
    providers: {}, telemetry: {}, awake: true
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
function writeStatus() { try { atomicJson(STATUS, state); } catch (e) {} }
function finite(v) { return typeof v === 'number' && isFinite(v); }
function temp(raw) { return finite(raw) && raw !== 255 ? Math.round((raw * 0.5 - 40) * 10) / 10 : null; }
function speed(raw) { return finite(raw) && raw !== 65535 ? Math.round(raw * 0.015625 * 10) / 10 : null; }
function pressure(raw) { return finite(raw) && raw < 65532 ? Math.round(raw) / 10 : null; }

function setTelemetry(name, value) {
    if (value === null || value === undefined) return;
    state.telemetry[name] = value;
    state.lastSampleAt = new Date().toISOString();
    writeStatus();
}

function ensureSomeIp() {
    const marker = path.join(SOMEIP_DIR, 'de_bmw_infotainment_climate_Climate2.json');
    if (fs.existsSync(marker)) return;
    if (!fs.existsSync(SOMEIP_DIR)) fs.mkdirSync(SOMEIP_DIR);
    child.execFileSync('/usr/bin/node', [path.join(__dirname, 'generate-someip.js'), SOMEIP_DIR], {stdio:'inherit'});
}

function configureDns() {
    const lease = readJson(LEASE, {});
    const servers = Array.isArray(lease.dns) ? lease.dns.filter((x) => typeof x === 'string') : [];
    if (servers.length) dns.setServers(servers);
    state.uplink = !!lease.interface;
}

function configFile(iface) { return path.join(SOMEIP_DIR, iface.replace(/\./g, '_') + '.json'); }
function watch(someip, iface, field, receive) {
    const cfg = JSON.parse(fs.readFileSync(configFile(iface), 'utf8'));
    return someip.buildProxy(cfg, '1').then((proxy) => proxy.init().then(() => {
        proxies.push(proxy);
        state.providers[iface] = false;
        proxy.subscribeToAvailability((available) => {
            state.providers[iface] = !!available;
            if (available && cfg.fields && cfg.fields[field] && cfg.fields[field].getter) {
                proxy.getValue(field, 3000).then(receive).catch(() => {});
            }
            writeStatus();
        });
        proxy.subscribe({name:field, onReceive:receive}).catch(() => {});
        setInterval(() => {
            if (state.providers[iface] && cfg.fields && cfg.fields[field] && cfg.fields[field].getter) {
                proxy.getValue(field, 3000).then(receive).catch(() => {});
            }
        }, 15000);
    })).catch((e) => { state.providers[iface] = false; state.error = iface + ': ' + e.message; writeStatus(); });
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
            path:target.path, method:'POST', timeout:12000,
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
    runtimeConfig = readJson(CONFIG, {});
    ensureSomeIp();
    try { fs.chownSync(RUN, UID, UID); } catch (e) {}
    const someip = require('/usr/lib/someip.node');
    if (process.getuid && process.getuid() === 0) {
        try { process.setgid(UID); process.setuid(UID); } catch (e) { throw new Error('cannot drop privileges: ' + e.message); }
    }
    writeStatus();
    await Promise.all([
        watch(someip, 'de.bmw.infotainment.climate.Climate2', 'statusTemperatureInside',
            (v) => setTelemetry('insideTemperatureC', temp(v && v.temperatureInside))),
        watch(someip, 'de.bmw.infrastructure.EnvironmentalInformation', 'ExteriorTemperature',
            (v) => setTelemetry('outsideTemperatureC', temp(v && v.temperatureExterior))),
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
        })
    ]);
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
main().catch((e) => { state.error = e.message; writeStatus(); process.stderr.write('remote telemetry: ' + e.stack + '\n'); process.exit(1); });
