'use strict';
const fs = require('fs');
const net = require('net');
const cp = require('child_process');
const Geometry = require('./geometry');

const DIR = '/run/waze-hud-control';
const SOCKET = DIR + '/control.sock';
const WAZE_SOCKET = '/dev/shm/waze-on-cluster/ctl.sock';
const LOCAL_CONF = '/var/opt/waze-on-cluster/waze-on-cluster.local.conf';
const CLUSTER_CONF = '/var/opt/cluster-render/current/cluster-render.conf';
const GEOMETRY_FILE = '/var/opt/waze-hud-control/geometry.json';
let queue = Promise.resolve();
let currentTarget = 'hud';
let geometry = loadGeometry();

function loadGeometry() {
    try { return Geometry.normalize(JSON.parse(fs.readFileSync(GEOMETRY_FILE, 'utf8'))); }
    catch (_) { return Geometry.preset('wide'); }
}

function saveGeometry(value) {
    fs.writeFileSync(GEOMETRY_FILE + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode:0o644 });
    fs.renameSync(GEOMETRY_FILE + '.tmp', GEOMETRY_FILE);
}

function setMapRect(target, value) {
    let config = '';
    try { config = fs.readFileSync(LOCAL_CONF, 'utf8'); } catch (_) {}
    const rect = [value.x, value.y, value.w, value.h].join(',');
    const line = target === 'hud' ? 'map_rect = ' + rect : 'map_rect =';
    const lines = config.split(/\r?\n/).filter((entry) => !/^\s*map_rect\s*=/.test(entry));
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    lines.push(line, '');
    fs.writeFileSync(LOCAL_CONF + '.tmp', lines.join('\n'), { mode:0o644 });
    fs.renameSync(LOCAL_CONF + '.tmp', LOCAL_CONF);
}

function setHudGeometry(value) {
    let config = fs.readFileSync(CLUSTER_CONF, 'utf8');
    const wanted = 'hud_size = ' + value.canvasW + 'x' + value.canvasH;
    const updated = /^\s*hud_size\s*=.*$/m.test(config)
        ? config.replace(/^\s*hud_size\s*=.*$/m, wanted)
        : config.replace(/\s*$/, '\n' + wanted + '\n');
    if (updated === config) return false;
    fs.writeFileSync(CLUSTER_CONF + '.tmp', updated, { mode:0o644 });
    fs.renameSync(CLUSTER_CONF + '.tmp', CLUSTER_CONF);
    return true;
}

function restartRenderer(restartCluster) {
    return new Promise((resolve, reject) => {
        const restartWaze = () => cp.execFile('/bin/systemctl', ['restart', 'waze-on-cluster.service'],
            (error) => error ? reject(error) : resolve());
        if (!restartCluster) return restartWaze();
        cp.execFile('/bin/systemctl', ['restart', 'cluster-render.service'],
            (error) => error ? reject(error) : restartWaze());
    });
}

function waitForSocket(deadline) {
    return new Promise((resolve, reject) => {
        const check = () => {
            if (fs.existsSync(WAZE_SOCKET)) return resolve();
            if (Date.now() >= deadline) return reject(new Error('Waze renderer did not restart'));
            setTimeout(check, 100);
        };
        check();
    });
}

function selectTarget(target) {
    return new Promise((resolve, reject) => {
        let sock;
        try { sock = net.connect(WAZE_SOCKET); }
        catch (error) { reject(error); return; }
        let done = false, buf = '';
        const finish = (error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { sock.end(); } catch (_) {}
            error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => finish(new Error('Waze renderer did not answer')), 3500);
        sock.setEncoding('utf8');
        sock.on('connect', () => {
            try { sock.write(JSON.stringify({ cmd:'start', target }) + '\n'); }
            catch (error) { finish(error); }
        });
        sock.on('data', (chunk) => {
            buf += chunk;
            const lines = buf.split('\n'); buf = lines.pop();
            lines.forEach((line) => {
                try {
                    const msg = JSON.parse(line);
                    if (msg.ev === 'status' && (!msg.target || msg.target === target)) finish();
                } catch (_) {}
            });
        });
        sock.on('error', finish);
    });
}

function reply(state, text) {
    return { ev:'status', state, target:currentTarget, text, geometry };
}

async function apply(target, requestedGeometry) {
    if (target !== 'hud' && target !== 'map') throw new Error('Unsupported Waze target');
    if (requestedGeometry) {
        geometry = Geometry.normalize(requestedGeometry);
        saveGeometry(geometry);
    }
    currentTarget = target;
    const geometryChanged = setHudGeometry(geometry);
    setMapRect(target, geometry);
    await restartRenderer(geometryChanged);
    await waitForSocket(Date.now() + 8000);
    await selectTarget(target);
    return reply('running', target === 'hud'
        ? 'Waze HUD ' + geometry.canvasW + 'x' + geometry.canvasH + ', map ' + geometry.w + 'x' + geometry.h + ' at ' + geometry.x + ',' + geometry.y
        : 'Waze returned to the cluster map');
}

try { fs.unlinkSync(SOCKET); } catch (_) {}
const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n'); buf = lines.pop();
        lines.forEach((line) => {
            let msg;
            try { msg = JSON.parse(line); } catch (_) { return; }
            if (msg.cmd === 'status') {
                sock.write(JSON.stringify(reply('idle', 'Display geometry ready')) + '\n');
                return;
            }
            queue = queue.then(() => apply(msg.target, msg.geometry), () => apply(msg.target, msg.geometry));
            queue.then((result) => sock.write(JSON.stringify(result) + '\n'),
                (error) => sock.write(JSON.stringify(reply('error', String(error.message || error))) + '\n'));
        });
    });
});
server.listen(SOCKET, () => fs.chmodSync(SOCKET, 0o660));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
