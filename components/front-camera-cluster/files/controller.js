'use strict';

const fs = require('fs');
const net = require('net');
const cp = require('child_process');

const DIR = '/run/front-camera-cluster';
const SOCK = DIR + '/control.sock';
const LOG = DIR + '/controller.log';
const IVI = '/usr/bin/ivi-control';
const SOURCE_FILE = '/var/opt/front-camera-cluster-helper/current/sources.json';
const DEFAULT_SOURCES = {
    // This MGU generation routes protected native camera video through dasvideo.
    // The BMW selector chooses Night Vision or a parking view; this helper mirrors
    // the protected plane without decoding, copying or exposing its pixels.
    night: { surface: '408', process: /\/(dasvideo|nightvision|nivi|nve)\b/i, crop: [0, 80, 1712, 640] },
    parking: { surface: '408', process: /\/dasvideo\b/i, crop: [0, 80, 1712, 640] }
};
const TARGETS = [
    { screen: '5', layer: '65010' }, // ic1
    { screen: '8', layer: '65011' }  // ic2
];

let state = 'stopped';
let detail = 'Native camera projection stopped';
let timeout = null;
let monitor = null;
let projected = false;
let sourceName = 'night';
let sourceSurface = '408';
let sourceCrop = DEFAULT_SOURCES.night.crop.slice();

function log(line) {
    try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n'); } catch (_) {}
}

function ivi(args, allowFailure) {
    const result = cp.spawnSync(IVI, args, {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { XDG_RUNTIME_DIR: '/run/wayland' })
    });
    if (result.status !== 0 && !allowFailure) {
        throw new Error('ivi-control ' + args.join(' ') + ': ' + String(result.stderr || result.stdout || 'failed').trim());
    }
    return String(result.stdout || '');
}

function screenLayers(screen) {
    const match = ivi(['screen', screen]).match(/layers:[ \t]*([^\r\n]*)/);
    return match ? match[1].trim().split(/\s+/).filter(Boolean) : [];
}

function sourceSpec(name) {
    const base = DEFAULT_SOURCES[name] || DEFAULT_SOURCES.night;
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'))[name] || {}; } catch (_) {}
    const crop = Array.isArray(saved.crop) && saved.crop.length === 4 ? saved.crop.map(Number) : base.crop.slice();
    return { surface: String(saved.surface || base.surface), process: base.process, crop };
}

function surfaceInfo(id) { return ivi(['surface', String(id)], true); }

function discoverSurface(spec) {
    let out = surfaceInfo(spec.surface);
    if (spec.process.test(out)) return { id: spec.surface, info: out };
    // Surface ids are normally stable, but may move after a BMW software update.
    // Camera/video planes on this unit occupy this bounded range; probe only when
    // the configured id stopped matching.
    for (let id = 320; id <= 520; id++) {
        out = surfaceInfo(id);
        if (spec.process.test(out)) return { id: String(id), info: out };
    }
    return null;
}

function removeProjection() {
    TARGETS.forEach((target) => {
        try {
            const remaining = screenLayers(target.screen).filter((id) => id !== target.layer);
            ivi(['screen', target.screen, 'renderorder'].concat(remaining), true);
        } catch (e) { log('restore screen ' + target.screen + ': ' + e.message); }
        ivi(['layer', target.layer, 'destroy'], true);
    });
    projected = false;
}

function cameraVisible() {
    try { return /visibility:\s*1\b/.test(surfaceInfo(sourceSurface)); }
    catch (_) { return false; }
}

function stop(reason) {
    clearTimeout(timeout); timeout = null;
    clearInterval(monitor); monitor = null;
    removeProjection();
    state = 'stopped';
    detail = reason || 'Native camera projection stopped';
    log(detail);
}

function createProjection(target) {
    ivi(['layer', target.layer, 'destroy'], true);
    ivi(['layer', target.layer, 'create', '1920', '720']);
    ivi(['layer', target.layer, 'srcrect'].concat(sourceCrop.map(String)));
    ivi(['layer', target.layer, 'dstrect', '0', '0', '360', '208']);
    ivi(['layer', target.layer, 'visibility', '1']);
    // Attach only while the protected native source is visible. This preserves
    // BMW's own source selection and prevents mirroring the ordinary HMI plane.
    ivi(['layer', target.layer, 'add', sourceSurface]);
    ivi(['screen', target.screen, 'add', target.layer]);
}

function projectionAttached(target) {
    try {
        return screenLayers(target.screen).indexOf(target.layer) !== -1 &&
            new RegExp('surfaces:[ \\t]*.*\\b' + sourceSurface + '\\b').test(ivi(['layer', target.layer]));
    } catch (_) { return false; }
}

function ensureProjection() {
    if (TARGETS.every(projectionAttached)) { projected = true; return true; }
    removeProjection();
    TARGETS.forEach(createProjection);
    projected = TARGETS.every(projectionAttached);
    return projected;
}

function start(requestedSource) {
    stop('Restarting native camera projection');
    sourceName = requestedSource === 'parking' ? 'parking' : 'night';
    const spec = sourceSpec(sourceName), found = discoverSurface(spec);
    if (!found) {
        throw new Error('BMW protected ' + (sourceName === 'night' ? 'Night Vision' : 'parking-camera') + ' surface is unavailable');
    }
    sourceSurface = found.id;
    sourceCrop = spec.crop;
    log('source ' + sourceName + ': surface ' + sourceSurface + ', crop ' + sourceCrop.join(','));
    const label = sourceName === 'night' ? 'BMW Night Vision' : 'BMW parking camera';
    const visibleNow = cameraVisible();
    if (visibleNow) ensureProjection();
    state = visibleNow && projected ? 'running' : 'waiting';
    detail = state === 'running' ? label + ' is live in the cluster'
        : 'Projection ready - press the physical ' + (sourceName === 'night' ? 'Night Vision' : 'parking-camera') + ' button';
    monitor = setInterval(() => {
        const visible = cameraVisible();
        if (visible && !projected) ensureProjection();
        else if (!visible && projected) removeProjection();
        const next = visible && projected ? 'running' : 'waiting';
        if (next !== state) {
            state = next;
            detail = visible ? label + ' is live in the cluster' : label + ' closed - waiting for its native feed';
            log(detail);
        }
    }, 100);
    timeout = setTimeout(() => stop(label + ' projection stopped after 10 minutes'), 10 * 60 * 1000);
    log(detail);
}

function reply(sock) {
    sock.write(JSON.stringify({
        ev: 'status', state, source: sourceName, surface: Number(sourceSurface), text: detail,
        detail: 'Protected native surface ' + sourceSurface + ' · IC1 + IC2', native: true
    }) + '\n');
}

try { fs.unlinkSync(SOCK); } catch (_) {}
removeProjection();
const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n'); buf = lines.pop();
        lines.forEach((line) => {
            let msg;
            try { msg = JSON.parse(line); } catch (_) { return; }
            try {
                if (msg.cmd === 'start') start(msg.source);
                else if (msg.cmd === 'stop') stop();
                reply(sock);
            } catch (e) {
                stop('Native camera projection error');
                state = 'error'; detail = 'Projection error: ' + e.message;
                log(detail); reply(sock);
            }
        });
    });
});
server.listen(SOCK, () => { fs.chmodSync(SOCK, 0o660); });
process.on('SIGTERM', () => { stop(); server.close(() => process.exit(0)); });
