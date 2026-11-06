'use strict';

/** xDrive Studio - a read-only view of signals already present on the car. */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { withAlpha } = require('./kit/canvas');
const { setImage } = require('./kit/record');
const { wheelValues, signed16, splitValid, steeringQualifierValid, decodeSteering } = require('./logic');
const path = require('path');

const W = 1600, H = 520, PAGES = ['Torque split', 'Wheel slip', 'Dynamics', 'Data status'];
const BLUE = '#4aafff', CYAN = '#35d6d0', GREEN = '#2fd27a', AMBER = '#ffb52e';
const G12_IMAGE = 0x58444731;
let hasG12Image = false;
try {
    const a = require('./kit/pack').open(path.join(__dirname, 'assets')).json('g12-citrin-top.json');
    if (a && a.w === 232 && a.h === 408 && a.rgba) {
        const pixels = Buffer.from(a.rgba, 'base64');
        if (pixels.length === a.w * a.h * 4) { setImage(G12_IMAGE, a.w, a.h, pixels); hasG12Image = true; }
    }
} catch (e) { /* keep the restrained fallback below */ }
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const finite = (n) => typeof n === 'number' && isFinite(n);
const age = (t) => !t ? 'never' : Math.max(0, Math.round((Date.now() - t) / 1000)) + ' s ago';
const stage = (x) => ({ 1: 'P', 2: 'R', 3: 'N', 4: 'D', P: 'P', R: 'R', N: 'N', D: 'D' })[x];

mgu.run({ async start(ctx) {
    const { ui, settings, log } = ctx;
    const car = new Car(ctx, ['rpm', 'speed', 'accel', 'gear', 'torque']);
    const cfg = Object.assign({ lmvAddress: 0x19, lmvDid: 'DB32', gearRatios: [] }, ctx.spec.config || {});
    const live = { splitRear: null, splitAt: 0, lmvFront: null, lmvAt: 0, lmvError: '', awd: null, awdQual: null,
        wheels: null, wheelsAt: 0, steer: null, yaw: null, dsc: null, signalsAt: 0 };
    let page = 0, visible = true, diag = null, polling = false, forceRead = false;

    const touch = () => { live.signalsAt = Date.now(); };
    const steer = (v) => {
        let raw = v && (v.actualValueSteeringAngleDriver !== undefined ? v.actualValueSteeringAngleDriver : v.actualSteeringAngleDriverNoCRC);
        if (!finite(raw)) return;
        const q = v && (v.qualifierActualValueSteeringAngleDriver !== undefined
            ? v.qualifierActualValueSteeringAngleDriver : v.qualifierSteeringAngleDriver);
        const deg = steeringQualifierValid(q) ? decodeSteering(raw) : null;
        if (deg !== null) { live.steer = deg; touch(); }
    };
    await Promise.all([
        ctx.signals.watch('de.bmw.infrastructure.analytics.BasicDataSet', '1', { basicDataSet: (v) => {
            const raw = v && v.valueDistributionLongitudinalTorqueRearAxisFrontAxis;
            const q = v && v.qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis;
            if (finite(raw) && raw > 0 && raw < 10001 && splitValid(q)) { live.splitRear = raw * 0.01; live.splitAt = Date.now(); touch(); }
        } }, log),
        ctx.signals.watch('de.bmw.infotainment.misc.MDrive', '1', { statusMSystem: (v) => {
            live.awd = v && v.statusAllWheelSetup; live.awdQual = v && v.qualifierFunctionAllWheel; touch();
        } }, log),
        ctx.signals.watch('de.bmw.powertrain.Powertrain', '1', { ActualValueRPMWheel: (v) => {
            const w = wheelValues(v); if (w) { live.wheels = w; live.wheelsAt = Date.now(); touch(); }
        } }, log),
        ctx.signals.watch('de.bmw.chassis.SteeringAngle', '1', { ActualSteeringAngleDriver: steer, actualSteeringAngleDriverNoCRC: steer }, log),
        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS2', '1', { statusYawVelocityVehicle: (v) => {
            const raw = v && v.yawVelocityVehicle; if (finite(raw) && raw !== 65535) { live.yaw = raw * 0.005 - 163.84; touch(); }
        } }, log),
        ctx.signals.watch('de.bmw.chassis.VehicleStabilizationManagement', '1', { StabilizationManagement: (v) => { live.dsc = v || null; touch(); } }, log),
    ]);

    async function initDiag() {
        if (diag) return diag;
        diag = new ReadOnlyDiag(ctx.signals, log, { gapMs: 140, silentAfter: 8 });
        await diag.init(); return diag;
    }
    async function readLmv() {
        if (polling || settings.get('demo') === 'on') return;
        polling = true;
        try {
            const d = await initDiag(), did = parseInt(cfg.lmvDid, 16);
            d.wake(cfg.lmvAddress);
            const r = await d.read(cfg.lmvAddress, did, 1800);
            if (r && r[0] === 0x62 && r[1] === (did >> 8) && r[2] === (did & 255) && r.length >= 5) {
                live.lmvFront = signed16((r[3] << 8) | r[4]) * 0.25; live.lmvAt = Date.now(); live.lmvError = '';
            } else live.lmvError = r && r[0] === 0x7F ? 'LMV refused DID ' + cfg.lmvDid : 'LMV did not answer';
        } catch (e) { live.lmvError = String(e.message || e); }
        polling = false;
    }
    setInterval(() => { if (visible && (forceRead || Date.now() - live.lmvAt > 1800)) { forceRead = false; readLmv(); } }, 400);

    function demo() {
        const x = Date.now() / 1000, rear = 62 + 24 * Math.sin(x * 0.55), slip = 1.8 * Math.sin(x * 1.2);
        return { car: { rpm: 2450, speed: 78, gear: 5, stage: 'D', torque: 410, gLong: 0.13, gLat: 0.22 },
            rear, source: 'BMW torque-distribution signal', frontNm: 245, wheels: [100 - slip, 100 + slip, 100 - slip * 0.3, 100 + slip * 0.3],
            mode: '4WD', steer: 18, yaw: 3.7, demo: true };
    }
    function data() {
        if (settings.get('demo') === 'on') return demo();
        const c = car.data(), now = Date.now();
        let rear = null, source = null;
        if (finite(live.splitRear) && now - live.splitAt < 10000) { rear = clamp(live.splitRear, 0, 100); source = 'BMW torque-distribution signal'; }
        else if (live.awd === '_2WD') { rear = 100; source = '2WD mode'; }
        else if (finite(live.lmvFront) && now - live.lmvAt < 5000) {
            const ratio = cfg.gearRatios[(c.gear || 0) - 1], input = finite(c.torque) && ratio ? c.torque * ratio : null;
            if (live.lmvFront <= 5) { rear = 100; source = 'transfer-case clutch open'; }
            else if (input > 50) { rear = 100 - clamp(live.lmvFront / input * 100, 0, 100); source = 'transfer-case estimate'; }
            else source = 'transfer-case torque only';
        }
        const modes = { _4WD_STANDARD: '4WD', _4WD_ALTERNATIV: '4WD Sport', _2WD: '2WD', AWDSAND: 'Sand' };
        return { car: c, rear, source, frontNm: live.lmvFront, wheels: live.wheels, mode: modes[live.awd] || '--',
            steer: live.steer, yaw: live.yaw, dsc: live.dsc, demo: false };
    }

    function carGraphic(cv, t, d) {
        const x = 684, y = 55, w = 232, h = 408;
        const frontY = 168, rearY = 372, cx = 800;
        const rear = finite(d.rear) ? d.rear : null, front = finite(rear) ? 100 - rear : null;
        const wheels = normalizedWheels(d);

        cv.roundRect(620, 48, 360, 424, 30, withAlpha(t.track, 0.42));
        cv.strokeRoundRect(620, 48, 360, 424, 30, 2, withAlpha(t.tick, 0.72));
        cv.line(cx, frontY, cx, rearY, 12, withAlpha(t.tick, 0.35));
        cv.line(cx, frontY, cx, 270, 6, withAlpha(CYAN, finite(front) ? 0.85 : 0.25));
        cv.line(cx, 270, cx, rearY, 6, withAlpha(BLUE, finite(rear) ? 0.90 : 0.25));
        cv.line(646, frontY, 954, frontY, 8, withAlpha(CYAN, finite(front) ? 0.85 : 0.25));
        cv.line(646, rearY, 954, rearY, 8, withAlpha(BLUE, finite(rear) ? 0.90 : 0.25));
        cv.arc(cx, 270, 10, 22, 0, 360, finite(rear) ? BLUE : t.tick);

        if (hasG12Image && cv.image) cv.image(G12_IMAGE, x, y, w, h);
        else {
            cv.roundRect(x + 27, y + 5, w - 54, h - 10, 74, '#211d1b');
            cv.strokeRoundRect(x + 27, y + 5, w - 54, h - 10, 74, 3, '#806d58');
        }

        [[662, frontY], [938, frontY], [662, rearY], [938, rearY]].forEach(([wx, wy], i) => {
            const hot = wheels && finite(wheels[i]) ? clamp(Math.abs(wheels[i] - 100) / 5, 0, 1) : 0;
            const color = hot > 0.45 ? AMBER : i < 2 ? CYAN : BLUE;
            cv.arc(wx, wy, 10, 18, 0, 360, withAlpha(color, 0.95));
            cv.arc(wx, wy, 0, 8, 0, 360, t.bg);
        });
        cv.text('FRONT' + (finite(front) ? '  ' + Math.round(front) + '%' : ''), 640, 92, 17, CYAN, { font: 'bold' });
        cv.text('REAR' + (finite(rear) ? '  ' + Math.round(rear) + '%' : ''), 960, 449, 17, BLUE, { align: 'right', font: 'bold' });
        cv.text('CITRIN G12', 960, 92, 15, t.dim, { align: 'right', font: 'bold' });
    }
    function splitPage(cv, t, d) {
        const rear = d.rear, front = finite(rear) ? 100 - rear : null;
        G.panel(cv, t, 24, 44, 430, 468, 'Live torque distribution');
        G.readout(cv, t, 48, 118, { label: 'Front axle', value: front, unit: '%', decimals: 0, size: 72, color: CYAN });
        G.bar(cv, t, 48, 204, 382, 72, { label: 'Front', value: front, unit: '%', ramp: 'cold' });
        G.readout(cv, t, 48, 338, { label: 'Rear axle', value: rear, unit: '%', decimals: 0, size: 72, color: BLUE });
        G.bar(cv, t, 48, 424, 382, 72, { label: 'Rear', value: rear, unit: '%', ramp: 'hot' });
        carGraphic(cv, t, d);
        G.panel(cv, t, 1146, 44, 430, 468, 'Driveline');
        const rows = [
            ['Mode', d.mode], ['Source', d.source || 'waiting for data'],
            ['Front axle torque', finite(d.frontNm) ? d.frontNm.toFixed(0) + ' Nm' : '--'],
            ['Engine torque', finite(d.car.torque) ? d.car.torque.toFixed(0) + ' Nm' : '--'],
            ['Gear', (d.car.stage || '') + (d.car.gear > 0 ? d.car.gear : '')],
            ['Speed', finite(d.car.speed) ? d.car.speed.toFixed(1) + ' km/h' : '--']
        ];
        G.table(cv, t, 1170, 100, 382, [{ label: '', w: 185 }, { label: '', w: 197, align: 'right' }], rows, { rowH: 58, size: 23 });
    }
    function normalizedWheels(d) {
        if (!d.wheels || !d.wheels.every(finite)) return null;
        if (d.demo) return d.wheels;
        const avg = d.wheels.reduce((a, b) => a + b, 0) / 4;
        return avg > 0 ? d.wheels.map((v) => v / avg * 100) : null;
    }
    function slipPage(cv, t, d) {
        const w = normalizedWheels(d), labels = ['Front left', 'Front right', 'Rear left', 'Rear right'];
        cv.text('Wheel-speed balance', 34, 89, 34, t.text, { font: 'bold' });
        cv.text('Each wheel is shown as deviation from the four-wheel average. This avoids assuming an unverified raw scaling.', 34, 121, 20, t.dim);
        const xy = [[34, 150], [810, 150], [34, 312], [810, 312]];
        labels.forEach((name, i) => {
            const [x, y] = xy[i], dev = w ? w[i] - 100 : null, col = !finite(dev) ? t.dim : Math.abs(dev) > 5 ? t.crit : Math.abs(dev) > 2 ? t.warn : GREEN;
            G.panel(cv, t, x, y, 756, 140, name);
            G.readout(cv, t, x + 24, y + 58, { label: 'Difference', value: dev, unit: '%', decimals: 1, size: 55, color: col });
            G.bar(cv, t, x + 320, y + 62, 410, 58, { label: 'Relative speed', value: w ? w[i] : null, min: 90, max: 110, unit: '%', ramp: 'hot' });
        });
        cv.text('Large differences can also come from steering geometry, tyre-size differences or wheel lift—not only wheelspin.', 34, 498, 20, t.warn);
    }
    function dynamicsPage(cv, t, d) {
        G.panel(cv, t, 24, 44, 700, 468, 'Vehicle motion');
        G.gmeter(cv, t, 250, 285, 178, { lat: d.car.gLat, long: d.car.gLong, max: 1.2 });
        G.stat(cv, t, 410, 95, 286, 160, { label: 'Yaw rate', value: d.yaw, unit: 'deg/s', decimals: 1, color: BLUE });
        G.stat(cv, t, 410, 277, 286, 160, { label: 'Steering wheel', value: d.steer, unit: 'deg', decimals: 0, color: CYAN });
        G.panel(cv, t, 744, 44, 832, 468, 'xDrive context');
        const rear = d.rear;
        const rows = [
            ['Drive mode', d.mode], ['Torque source', d.source || '--'],
            ['Front / rear', finite(rear) ? Math.round(100 - rear) + ' / ' + Math.round(rear) + ' %' : '--'],
            ['Speed / gear', (finite(d.car.speed) ? d.car.speed.toFixed(1) + ' km/h' : '--') + '  ·  ' + ((d.car.stage || '') + (d.car.gear > 0 ? d.car.gear : ''))],
            ['Longitudinal g', finite(d.car.gLong) ? d.car.gLong.toFixed(2) + ' g' : '--'],
            ['Lateral g', finite(d.car.gLat) ? d.car.gLat.toFixed(2) + ' g' : '--']
        ];
        G.table(cv, t, 770, 105, 780, [{ label: '', w: 330 }, { label: '', w: 450, align: 'right' }], rows, { rowH: 59, size: 25 });
    }
    function statusPage(cv, t, d) {
        const rows = [
            ['BMW torque-distribution signal', live.splitAt ? 'last update ' + age(live.splitAt) : 'waiting', live.splitAt ? GREEN : t.warn],
            ['LMV transfer-case DID ' + cfg.lmvDid, live.lmvAt ? (finite(live.lmvFront) ? live.lmvFront.toFixed(1) + ' Nm · ' : '') + age(live.lmvAt) : live.lmvError || 'waiting', live.lmvAt ? GREEN : t.warn],
            ['Four wheel-speed signals', live.wheelsAt ? 'last update ' + age(live.wheelsAt) : 'waiting', live.wheelsAt ? GREEN : t.warn],
            ['Vehicle motion signals', live.signalsAt ? 'last update ' + age(live.signalsAt) : 'waiting', live.signalsAt ? GREEN : t.warn],
            ['Mode / qualifier', String(live.awd || '--') + ' / ' + String(live.awdQual || '--'), t.dim]
        ];
        cv.text('Data status', 34, 91, 34, t.text, { font: 'bold' });
        rows.forEach((r, i) => {
            const y = 126 + i * 70; cv.roundRect(32, y, 1536, 56, 9, withAlpha(r[2], 0.10)); cv.fillRect(32, y + 8, 5, 40, r[2]);
            cv.text(r[0], 55, y + 37, 23, t.text, { font: 'bold' }); cv.text(r[1], 1542, y + 37, 21, r[2], { align: 'right' });
        });
        cv.text('Read only: vehicle signals plus UDS 22 DB32 from the transfer case. No coding, actuator or drivetrain command.', 34, 498, 20, t.dim);
    }
    async function render() {
        const t = ctx.theme(), d = data(), cv = ctx.canvas(W, H).clear(t.bg);
        [splitPage, slipPage, dynamicsPage, statusPage][page](cv, t, d);
        G.header(cv, t, 0, 0, W, 44, 'xDrive Studio', PAGES, page,
            [{ text: d.demo ? 'DEMO' : (d.source ? 'LIVE' : 'WAITING'), color: d.demo ? BLUE : d.source ? GREEN : AMBER }], true, true);
        await ui.image('MAIN_GFX', cv);
    }
    ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; });
    ui.onClick('BTN_REFRESH', () => { forceRead = true; });
    ctx.onTab((i) => { page = i; });
    ui.onVisible((name, on) => { if (name === 'MAIN') { visible = on; if (on) forceRead = true; } });
    ctx.loop('MAIN', 60, render);
    forceRead = true;
} });
