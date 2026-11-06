'use strict';

/**
 * Parking & Clearance: read-only PMA/VDP data and live steering geometry.
 * Diagnostic traffic is restricted to UDS service 0x22 (ReadDataByIdentifier).
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Diag, replyTo } = require('./kit/diag');
const { withAlpha } = require('./kit/canvas');
const { setImage } = require('./kit/record');
const { decodeSteering, steeringQualifierValid, tyrePath } = require('./logic');
const path = require('path');

const W = 1600, H = 520, PMA = 0x2C, VDP = 0x76;
const PAGES = ['Park view', 'Stance', 'Spaces', 'Status'];
const C = { bg: '#0c1017', panel: '#151c26', edge: '#344253', text: '#f4f7fa', dim: '#9ba9ba',
    blue: '#47adff', green: '#2fd27a', amber: '#ffb52e', red: '#ff4b55', tyre: '#d8dee8' };
const SENSOR_DIDS = [
    ['frontOuterLeft', 0xD645], ['frontInnerLeft', 0xD646], ['frontInnerRight', 0xD648],
    ['frontOuterRight', 0xD647], ['rearSideLeft', 0xD64A], ['rearOuterLeft', 0xD64B],
    ['rearInnerLeft', 0xD64C], ['rearInnerRight', 0xD64E], ['rearOuterRight', 0xD64D],
    ['rearSideRight', 0xD64F], ['sideLeft', 0xD65C], ['sideRight', 0xD65E]
];
// BMW G12 LCI dimensions, centimetres: 5,260 x 1,902 mm, 3,210 mm wheelbase.
const G12 = Object.freeze({ length: 526, width: 190.2, wheelbase: 321 });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const word = (n) => [n >> 8, n & 255];
const CAR_IMAGE = 0x47313201;
let hasCarImage = false;
try {
    const a = require('./kit/pack').open(path.join(__dirname, 'assets')).json('g12-citrin.json');
    if (a && a.w === 570 && a.h === 285 && a.rgba) {
        const pixels = Buffer.from(a.rgba, 'base64');
        if (pixels.length === a.w * a.h * 4) { setImage(CAR_IMAGE, a.w, a.h, pixels); hasCarImage = true; }
    }
} catch (e) { /* the simple fallback below remains usable */ }

function s16(n) { return n >= 32768 ? n - 65536 : n; }
function finite(n, lo, hi) { return typeof n === 'number' && isFinite(n) && n >= lo && n <= hi; }
function closest(values) {
    const v = values.filter((x) => finite(x, 20, 250));
    return v.length ? Math.min.apply(null, v) : null;
}

class Reader {
    constructor(signals, log) {
        this.diag = new Diag(signals, log); this.diag.quiet = true; this.diag.busyLog = false;
        this.queue = Promise.resolve();
    }
    async init() { await this.diag.init(); return this; }
    read(ecu, did, timeout) {
        const data = word(did);
        const go = async () => {
            const r = await this.diag.physical(ecu, 0x22, data, timeout || 1800, replyTo(0x22, data),
                { maxRetries: 1, retryBaseMs: 120 });
            if (!r || r[0] !== 0x62 || r[1] !== data[0] || r[2] !== data[1]) return null;
            return r.slice(3);
        };
        const next = this.queue.then(go, go);
        this.queue = next.catch(() => null);
        return next;
    }
}

mgu.run({ async start(ctx) {
    const { ui, settings, log } = ctx;
    const rd = new Reader(ctx.signals, log);
    const live = {
        speed: null, gear: null, steer: null, pdc: null, vdpLevel: null,
        sensors: {}, heights: [null, null, null, null], space: null,
        pmaAt: 0, vdpAt: 0, signalAt: 0, error: ''
    };
    let page = 0, visible = true, polling = false, sensorCursor = 0, loop = null;

    function demo() {
        const t = Date.now() / 1000, s = 45 + 22 * Math.sin(t / 3);
        const sensors = {
            frontOuterLeft: 82, frontInnerLeft: 66, frontInnerRight: 53, frontOuterRight: 72,
            rearSideLeft: 130, rearOuterLeft: 48, rearInnerLeft: 39, rearInnerRight: 44,
            rearOuterRight: 63, rearSideRight: 112, sideLeft: 86, sideRight: 58
        };
        return { speed: 0, gear: 'R', steer: s, pdc: 1, sensors,
            heights: [4.2, 1.1, -2.6, -0.8], vdpLevel: 8,
            space: { left: { length: 610, depth: 235, angle: -1.5 }, right: { length: 558, depth: 219, angle: 2.1 } },
            pmaAt: Date.now(), vdpAt: Date.now(), signalAt: Date.now(), error: '' };
    }
    const data = () => settings.get('demo') === 'on' ? demo() : live;
    function redraw() { render().catch((e) => log.error('Parking render', e)); }

    const pick = (o, key) => o && typeof o[key] === 'number' ? o[key] : null;
    const steerValue = (v) => {
        let raw = pick(v, 'actualValueSteeringAngleDriver');
        if (raw === null) raw = pick(v, 'actualSteeringAngleDriverNoCRC');
        if (raw === null) {
            const k = Object.keys(v || {}).find((x) => /steering.*angle/i.test(x) && typeof v[x] === 'number');
            raw = k ? v[k] : null;
        }
        if (raw === null) return;
        const q = v && (v.qualifierActualValueSteeringAngleDriver !== undefined
            ? v.qualifierActualValueSteeringAngleDriver : v.qualifierSteeringAngleDriver);
        const deg = steeringQualifierValid(q) ? decodeSteering(raw) : null;
        if (deg !== null) { live.steer = deg; live.signalAt = Date.now(); redraw(); }
    };
    await Promise.all([
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const raw = pick(v, 'speedVehicleCentreOfGravity');
                if (finite(raw, 0, 65534)) { live.speed = raw * 0.015625; live.signalAt = Date.now(); }
            }
        }, log, { pollMs: 1000 }),
        ctx.signals.watch('de.bmw.infrastructure.VehicleInformation', '1', {
            statusGearboxDrive: (v) => {
                const x = v && v.statusActualStageDrive;
                live.gear = ({ 1: 'P', 2: 'R', 3: 'N', 4: 'D', P: 'P', R: 'R', N: 'N', D: 'D' })[x] || live.gear;
                live.signalAt = Date.now();
            },
            DataPowerTrain2: (v) => {
                const x = v && v.statusGearSelectionDrive;
                const n = typeof x === 'number' ? x : ({ P: 3, R: 2, N: 1, NP: 4 })[x];
                live.gear = n === 3 ? 'P' : n === 2 ? 'R' : n === 1 ? 'N' : n >= 5 ? 'D' : live.gear;
                live.signalAt = Date.now();
            }
        }, log, { pollMs: 1000 }),
        ctx.signals.watch('de.bmw.chassis.SteeringAngle', '1', {
            ActualSteeringAngleDriver: steerValue,
            actualSteeringAngleDriverNoCRC: steerValue
        }, log, { pollMs: 500 })
    ]);

    function distanceColor(n) {
        if (!finite(n, 20, 250)) return C.edge;
        if (n <= settings.get('criticalDistance')) return C.red;
        if (n <= settings.get('warnDistance')) return C.amber;
        return C.green;
    }
    function value(n, suffix) { return finite(n, -9999, 9999) ? Math.round(n) + (suffix || '') : '--'; }
    function card(cv, x, y, w, h, color) {
        cv.roundRect(x, y, w, h, 10, C.panel); cv.fillRect(x, y, 5, h, color || C.edge);
    }
    function stat(cv, x, y, w, title, n, unit, color) {
        card(cv, x, y, w, 96, color);
        cv.text(title.toUpperCase(), x + 18, y + 29, 18, C.dim, { font: 'bold' });
        cv.text(n === null ? '--' : value(n), x + 18, y + 78, 43, n === null ? C.dim : color, { font: 'bold' });
        if (n !== null && unit) cv.text(unit, x + w - 18, y + 76, 20, C.dim, { align: 'right' });
    }
    function car(cv, d) {
        // Photoreal G12, horizontal by request: the nose points left. Its rendered
        // footprint follows the real G12 LCI length-to-width ratio (5260:1902).
        const x = 468, y = 138, w = 664, h = Math.round(w * G12.width / G12.length);

        // Project two tyre ribbons from the axle in the selected direction. The
        // paired edges and tread marks read as tracks instead of parking-guide rays.
        const road = finite(d.steer, -900, 900) ? G.clamp(d.steer / 15, -35, 35) : 0;
        const reverse = d.gear === 'R', direction = reverse ? 1 : -1;
        const axleX = reverse ? x + w - 105 : x + 105;
        [y + 49, y + h - 49].forEach((wheelY) => {
            const points = tyrePath(axleX, wheelY, direction, road, 10, 25, w * G12.wheelbase / G12.length);
            cv.polyline(points, 12, withAlpha(C.blue, 0.16));
            cv.polyline(points.map((p) => [p[0], p[1] - 6]), 2, withAlpha(C.blue, 0.82));
            cv.polyline(points.map((p) => [p[0], p[1] + 6]), 2, withAlpha(C.blue, 0.82));
            for (let i = 1; i < points.length; i += 2) {
                cv.line(points[i][0], points[i][1] - 5, points[i][0], points[i][1] + 5, 1, withAlpha(C.blue, 0.58));
            }
        });

        if (hasCarImage && cv.image) cv.image(CAR_IMAGE, x, y, w, h);
        else {
            cv.roundRect(x + 20, y + 30, w - 40, h - 60, 80, '#241f1b');
            cv.strokeRoundRect(x + 20, y + 30, w - 40, h - 60, 80, 3, '#826e52');
        }
        const pts = [
            // Six front transducers: the two side-facing sensors sit in the
            // bumper corners, beside the four forward-facing sensors.
            ['sideLeft', x + 35, y - 13],
            ['frontOuterLeft', x - 2, y + 34], ['frontInnerLeft', x - 14, y + 88],
            ['frontInnerRight', x - 14, y + h - 88], ['frontOuterRight', x - 2, y + h - 34],
            ['sideRight', x + 35, y + h + 13],
            ['rearSideLeft', x + w - 58, y - 18], ['rearOuterLeft', x + w + 8, y + 34],
            ['rearInnerLeft', x + w + 16, y + 88], ['rearInnerRight', x + w + 16, y + h - 88],
            ['rearOuterRight', x + w + 8, y + h - 34], ['rearSideRight', x + w - 58, y + h + 18]
        ];
        pts.forEach(([k, px, py]) => {
            const n = d.sensors[k], col = distanceColor(n);
            cv.arc(px, py, 0, 12, 0, 360, '#091018');
            cv.arc(px, py, 12, 18, 0, 360, col);
            if (finite(n, 20, 250)) cv.text(String(Math.round(n)), px, py + 6, 15, '#ffffff', { align: 'center', font: 'bold' });
        });
    }
    function drawPark(cv, d) {
        const front = closest(['frontOuterLeft','frontInnerLeft','frontInnerRight','frontOuterRight'].map((k) => d.sensors[k]));
        const rear = closest(['rearOuterLeft','rearInnerLeft','rearInnerRight','rearOuterRight'].map((k) => d.sensors[k]));
        const left = closest(['frontOuterLeft','rearSideLeft','sideLeft','rearOuterLeft'].map((k) => d.sensors[k]));
        const right = closest(['frontOuterRight','rearSideRight','sideRight','rearOuterRight'].map((k) => d.sensors[k]));
        stat(cv, 24, 78, 250, 'Front nearest', front, 'cm', distanceColor(front));
        stat(cv, 24, 188, 250, 'Left nearest', left, 'cm', distanceColor(left));
        stat(cv, 24, 298, 250, 'Rear nearest', rear, 'cm', distanceColor(rear));
        stat(cv, 1326, 78, 250, 'Right nearest', right, 'cm', distanceColor(right));
        stat(cv, 1326, 188, 250, 'Steering wheel', d.steer === null ? null : Math.abs(d.steer), 'deg ' + (d.steer < 0 ? 'L' : 'R'), C.blue);
        card(cv, 1326, 298, 250, 100, C.blue);
        cv.text('GEAR / SPEED', 1344, 328, 18, C.dim, { font: 'bold' });
        cv.text((d.gear || '--') + '  ' + (d.speed === null ? '--' : d.speed.toFixed(1)), 1344, 378, 39, C.text, { font: 'bold' });
        cv.text('km/h', 1555, 376, 19, C.dim, { align: 'right' });
        car(cv, d);
        const distanceLive = Date.now() - d.pmaAt < 5000 && Object.keys(d.sensors).some((k) => finite(d.sensors[k], 20, 250));
        cv.text(distanceLive ? 'DISTANCE DATA LIVE' : 'DISTANCE DATA WAITING', 1500, 472, 20,
            distanceLive ? C.green : C.dim, { align: 'right', font: 'bold' });
    }
    function drawStance(cv, d) {
        cv.text('Suspension stance', 34, 93, 34, C.text, { font: 'bold' });
        cv.text('Live VDP sensor-relative values. These are not ground-clearance measurements.', 34, 123, 20, C.amber);
        const names = ['Front left', 'Front right', 'Rear left', 'Rear right'];
        const xy = [[34, 151], [809, 151], [34, 302], [809, 302]];
        d.heights.forEach((n, i) => {
            const [x,y] = xy[i]; card(cv, x, y, 757, 132, n === null ? C.edge : C.blue);
            cv.text(names[i].toUpperCase(), x + 22, y + 34, 20, C.dim, { font: 'bold' });
            cv.text(n === null ? '--' : (n >= 0 ? '+' : '') + n.toFixed(1), x + 22, y + 105, 59, C.text, { font: 'bold' });
            cv.text('mm relative', x + 360, y + 100, 22, C.dim);
        });
        const h = d.heights;
        const roll = h.every((n) => n !== null) ? ((h[1] + h[3]) - (h[0] + h[2])) / 2 : null;
        const pitch = h.every((n) => n !== null) ? ((h[2] + h[3]) - (h[0] + h[1])) / 2 : null;
        cv.text('Level ' + ({2:'Low',8:'Standard',16:'High'}[d.vdpLevel] || '--') +
            '   Left/right delta ' + (roll === null ? '--' : roll.toFixed(1) + ' mm') +
            '   Front/rear delta ' + (pitch === null ? '--' : pitch.toFixed(1) + ' mm'),
            34, 490, 22, C.dim);
    }
    function spaceCard(cv, x, title, s) {
        card(cv, x, 146, 748, 284, s ? C.green : C.edge);
        cv.text(title.toUpperCase(), x + 24, 190, 24, C.dim, { font: 'bold' });
        if (!s) { cv.text('No valid space reported', x + 24, 280, 38, C.dim, { font: 'bold' }); return; }
        const margin = s.length - G12.length;
        cv.text(Math.round(s.length) + ' cm', x + 24, 280, 69, margin >= 60 ? C.green : margin >= 30 ? C.amber : C.red, { font: 'bold' });
        cv.text('length', x + 300, 274, 22, C.dim);
        cv.text(Math.round(s.depth) + ' cm deep', x + 24, 347, 31, C.text, { font: 'bold' });
        cv.text((margin >= 0 ? '+' : '') + Math.round(margin) + ' cm vs car  /  entry angle ' + s.angle.toFixed(1) + ' deg',
            x + 24, 401, 22, C.dim);
    }
    function drawSpaces(cv, d) {
        cv.text('Detected parking spaces', 34, 93, 34, C.text, { font: 'bold' });
        cv.text('Reported by PMA while the parking-space scan is active.', 34, 123, 20, C.dim);
        spaceCard(cv, 32, 'Left side', d.space && d.space.left);
        spaceCard(cv, 820, 'Right side', d.space && d.space.right);
        cv.text('G12 LCI: 526.0 x 190.2 cm | wheelbase 321.0 cm. Always verify visually.', 34, 486, 22, C.amber);
    }
    function age(t) { return t ? Math.round((Date.now() - t) / 1000) + ' s ago' : 'never'; }
    function drawStatus(cv, d) {
        cv.text('Data status', 34, 93, 34, C.text, { font: 'bold' });
        const rows = [
            ['PMA parking sensors', d.pmaAt ? 'receiving / ' + age(d.pmaAt) : 'waiting', d.pmaAt ? C.green : C.amber],
            ['VDP suspension stance', d.vdpAt ? 'receiving / ' + age(d.vdpAt) : 'waiting', d.vdpAt ? C.green : C.amber],
            ['Vehicle signals', d.signalAt ? 'receiving / ' + age(d.signalAt) : 'waiting', d.signalAt ? C.green : C.amber],
            ['Steering path', d.steer === null ? 'signal unavailable' : d.steer.toFixed(1) + ' degrees', d.steer === null ? C.amber : C.green],
            ['Last diagnostic note', d.error || 'none', d.error ? C.amber : C.dim]
        ];
        rows.forEach((r, i) => {
            const y = 139 + i * 66; card(cv, 32, y, 1536, 53, r[2]);
            cv.text(r[0], 54, y + 36, 23, C.text, { font: 'bold' });
            cv.text(r[1], 1544, y + 36, 22, r[2], { align: 'right' });
        });
        cv.text('Read only: PMA 0x2C and VDP 0x76, UDS service 0x22 only.', 34, 492, 21, C.dim);
    }
    async function render() {
        const cv = ctx.canvas(W, H).clear(C.bg), d = data();
        if (page === 0) drawPark(cv, d);
        else if (page === 1) drawStance(cv, d);
        else if (page === 2) drawSpaces(cv, d);
        else drawStatus(cv, d);
        G.frame(cv, ctx.theme(), PAGES, page, [{ text: settings.get('demo') === 'on' ? 'DEMO' : 'READ ONLY', color: C.green }]);
        await ui.image('MAIN_GFX', cv);
    }

    function decodeDistance(b) {
        if (!b || !b.length) return null;
        const n = b.length >= 2 ? b.readUInt16BE ? b.readUInt16BE(0) : b[0] * 256 + b[1] : b[0];
        return finite(n, 20, 250) ? n : null;
    }
    async function sensorStep() {
        const [key, did] = SENSOR_DIDS[sensorCursor++ % SENSOR_DIDS.length];
        const b = await rd.read(PMA, did);
        if (b) { live.sensors[key] = decodeDistance(Buffer.from(b)); live.pmaAt = Date.now(); live.error = ''; }
    }
    async function slowPma() {
        const st = await rd.read(PMA, 0xD671);
        if (st && st.length) live.pdc = st[0];
        const b = await rd.read(PMA, 0xD683, 2500);
        if (b && b.length >= 20) {
            const n = []; for (let i = 0; i < 10; i++) n.push(b[i * 2] * 256 + b[i * 2 + 1]);
            const valid = (x) => finite(x, 1, 2000) && x < 65533;
            live.space = {
                left: valid(n[0]) && valid(n[1]) ? { length: n[0], depth: n[1], angle: s16(n[4]) / 10 } : null,
                right: valid(n[5]) && valid(n[6]) ? { length: n[5], depth: n[6], angle: s16(n[9]) / 10 } : null
            };
        }
    }
    async function vdp() {
        const b = await rd.read(VDP, 0xDC05, 2500);
        if (b && b.length >= 16) {
            live.heights = [0,1,2,3].map((i) => {
                const n = Buffer.from(b.slice(i * 4, i * 4 + 4)).readFloatBE(0) * 1000;
                return finite(n, -500, 500) ? n : null;
            }); live.vdpAt = Date.now();
        }
        const l = await rd.read(VDP, 0xD8EC);
        if (l && l.length) live.vdpLevel = l.reduce((n, x) => n * 256 + x, 0);
    }
    async function tick(force) {
        if (polling || settings.get('demo') === 'on' || (!visible && !force)) return;
        polling = true;
        try {
            await sensorStep();
            if (sensorCursor % 12 === 1) await slowPma();
            if (sensorCursor % 24 === 2) await vdp();
        } catch (e) { live.error = String(e.message || e).slice(0, 90); }
        finally { polling = false; redraw(); }
    }

    ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; redraw(); });
    ui.onClick('BTN_REFRESH', () => tick(true));
    ctx.onTab((i) => { page = i; redraw(); });
    ctx.onLayout(redraw);
    ui.onVisible((name, on) => { if (name === 'MAIN') { visible = on; if (on) tick(true); } });
    settings.onChange(redraw);
    await rd.init();
    redraw();
    loop = setInterval(() => tick(false), 180);
    await pause(10);
    tick(true);
} });
