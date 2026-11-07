'use strict';

const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { VdpControl, ParkGuard } = require('./control');
const { HeightPlan, CORNERS } = require('./plan');
const W = 1600, H = 520, VDP = 0x76;
const C = { bg: '#0d1119', panel: '#1b2431', edge: '#354456', text: '#f3f6f9',
    dim: '#aebdca', blue: '#4cb5ff', green: '#56d89a', amber: '#ffb84c', red: '#ef6a67' };
const pages = ['Targets', 'Measurements', 'Presets', 'Axles', 'Vehicle'];
const signed = (n) => (n > 0 ? '+' : '') + n;

mgu.run({ async start(ctx) {
    const plan = new HeightPlan(ctx.dataDir);
    const guard = new ParkGuard(ctx.signals, ctx.log);
    const control = new VdpControl(ctx.signals, ctx.log, guard);
    let page = 0, notice = '', identity = 'Checking VDP', level = 'Not read';
    let live = [null, null, null, null], updated = 0, polling = false, hits = [], pulseSeconds = 3;

    async function operate(label, fn) {
        if (control.busy) return;
        notice = label + ' in progress'; redraw();
        try {
            const result = await fn();
            notice = label + ' accepted' + (result && result.before !== undefined ?
                ' • sensor ' + signed(result.before.toFixed(1)) + ' → ' + signed(result.after.toFixed(1)) + ' mm' : '');
        } catch (e) { notice = e.message; ctx.log.warn('VDP control: ' + e.message); }
        redraw(); poll();
    }

    function redraw() { render().catch((e) => ctx.log.error('Ride Height render', e)); }
    function action(fn) { try { fn(); notice = ''; } catch (e) { notice = e.message; } redraw(); }
    function button(cv, x, y, w, h, label, fn, active, color) {
        cv.roundRect(x, y, w, h, 9, active ? (color || C.blue) : C.panel);
        cv.text(label, x + w / 2, y + h / 2 + 9, 25, active ? C.bg : C.text,
            { align: 'center', font: 'bold' });
        hits.push({ x, y, w, h, fn });
    }
    function card(cv, x, y, w, h, color) {
        cv.roundRect(x, y, w, h, 11, C.panel);
        cv.fillRect(x, y, 5, h, color || C.edge);
    }
    function headline(cv, title, subtitle) {
        cv.text(title, 34, 83, 36, C.text, { font: 'bold' });
        cv.text(subtitle, 34, 114, 20, C.dim);
    }
    function corners(cv, y, editing) {
        const gap = 16, x0 = 32, cw = (W - x0 * 2 - gap * 3) / 4, ch = editing ? 162 : 168;
        CORNERS.forEach((name, i) => {
            const x = x0 + i * (cw + gap), selected = plan.selected === i, base = plan.baselines[i];
            card(cv, x, y, cw, ch, selected ? C.blue : C.edge);
            cv.text(name.toUpperCase(), x + 20, y + 37, 22, selected ? C.blue : C.dim, { font: 'bold' });
            cv.text(base === null ? '--' : String(base), x + 20, y + 102, 62,
                base === null ? C.amber : C.text, { font: 'bold' });
            cv.text('mm measured', x + 206, y + 100, 19, C.dim);
            cv.text(editing ? (selected ? 'SELECTED CORNER' : 'TAP TO SELECT') :
                (base === null ? 'Enter measurement' : 'Preview ' + (base + plan.delta) + ' mm'),
                x + 20, y + 144, 23, base === null ? C.amber : editing ? C.blue : C.green,
                { font: 'bold' });
            hits.push({ x, y, w: cw, h: ch, fn: () => action(() => { plan.selected = i; page = 1; }) });
        });
    }
    function drawTargets(cv) {
        headline(cv, 'Ride height targets', 'Measured rim flange to fender lip at all four corners');
        corners(cv, 134, false);
        cv.text('CHANGE FROM YOUR MEASURED BASELINE', 34, 341, 20, C.dim, { font: 'bold' });
        [[0, 'Current  0 mm'], [20, 'Factory approx. +20 mm'],
            [40, 'Raised approx. +40 mm']].forEach(([value, label], i) =>
            button(cv, 32 + i * 521, 357, 500, 62, label,
                () => action(() => plan.setDelta(value)), plan.delta === value,
                value > 0 ? C.green : C.blue));
        cv.text(plan.complete ? 'Selected preview: ' + signed(plan.delta) +
            ' mm. Current calibration remains unchanged.' :
            'Enter all four current measurements before relying on target numbers.',
            34, 456, 23, plan.complete ? C.text : C.amber, { font: 'bold' });
        cv.text('Targets are previews. Control offers the VDP Low, Standard and High presets.',
            34, 492, 21, C.amber, { font: 'bold' });
    }
    function drawMeasurements(cv) {
        headline(cv, 'Current physical measurements',
            'Measure on level ground, from each rim’s bottom lip to the fender lip.');
        corners(cv, 134, true);
        cv.text('EDIT ' + CORNERS[plan.selected].toUpperCase(), 34, 339, 21, C.blue, { font: 'bold' });
        [['-10', -10], ['-1', -1], ['+1', 1], ['+10', 10]].forEach(([label, step], i) =>
            button(cv, 32 + i * 263, 358, 247, 61, label,
                () => action(() => plan.measure(step))));
        button(cv, 1098, 358, 225, 61, 'Set 700', () => action(() => plan.setMeasured(700)));
        button(cv, 1339, 358, 225, 61, 'Clear', () => action(() => plan.clear()), false, C.red);
        cv.text('Measurements are saved. The selected target resets when this app restarts.',
            34, 466, 23, C.dim);
        cv.text('Bar controls: next page • next corner • -1 mm • +1 mm', 34, 496, 20, C.dim);
    }
    function drawPresets(cv) {
        headline(cv, 'VDP ride level control', 'BMW Low / Standard / High requests. Physical millimetres vary by car.');
        card(cv, 32, 139, 1536, 224, C.blue);
        cv.text('CURRENT VDP LEVEL', 58, 183, 23, C.dim, { font: 'bold' });
        cv.text(level, 58, 251, 47, C.text, { font: 'bold' });
        cv.text('Safety: ' + guard.status, 58, 323, 23, C.dim);
        [['Low', C.blue], ['Standard', C.green], ['High', C.amber]].forEach(([name, color], i) =>
            button(cv, 32 + i * 516, 382, 500, 68, 'Request ' + name,
                () => operate(name, () => control.level(name)), false, color));
        cv.text('Preset requests are temporary VDP level controls. Calibration is unchanged.',
            34, 493, 21, C.amber);
    }
    function drawAxles(cv) {
        headline(cv, 'Direct air-spring control',
            'VDP component actuation: both front struts or both rear struts together.');
        [['Front', 0, C.blue], ['Rear', 786, C.green]].forEach(([axle, offset, color]) => {
            card(cv, 32 + offset, 139, 750, 235, color);
            cv.text(axle.toUpperCase() + ' AXLE', 56 + offset, 181, 23, C.dim, { font: 'bold' });
            const indexes = axle === 'Front' ? [0, 1] : [2, 3];
            const values = indexes.map((i) => live[i]);
            const average = values.every((v) => v !== null) ? (values[0] + values[1]) / 2 : null;
            cv.text(average === null ? '--' : signed(average.toFixed(1)) + ' mm',
                56 + offset, 237, 43, C.text, { font: 'bold' });
            cv.text('relative sensor average', 56 + offset, 270, 19, C.dim);
            button(cv, 56 + offset, 297, 330, 58, 'Vent ' + pulseSeconds + ' s',
                () => operate(axle + ' vent', () => control.axle(axle, 'Vent', pulseSeconds)), false, C.amber);
            button(cv, 405 + offset, 297, 351, 58, 'Fill ' + pulseSeconds + ' s',
                () => operate(axle + ' fill', () => control.axle(axle, 'Fill', pulseSeconds)), false, C.green);
        });
        cv.text('COMMAND DURATION', 34, 413, 19, C.dim, { font: 'bold' });
        button(cv, 250, 388, 160, 58, '-1 s', () => action(() => {
            pulseSeconds = Math.max(1, pulseSeconds - 1);
        }));
        cv.text(String(pulseSeconds) + ' seconds', 500, 428, 30, C.text, { font: 'bold', align: 'center' });
        button(cv, 590, 388, 160, 58, '+1 s', () => action(() => {
            pulseSeconds = Math.min(30, pulseSeconds + 1);
        }));
        cv.text('No action-count lockout. VDP timer plus explicit OFF stop every command.',
            790, 426, 21, C.amber, { font: 'bold' });
        cv.text('Use on level ground. Park and live VDP speed are checked immediately before actuation.',
            34, 493, 20, C.dim);
    }
    function drawVehicle(cv) {
        headline(cv, 'Vehicle status', 'Live VDP suspension data at diagnostic address 0x76');
        card(cv, 32, 139, 740, 220, C.blue);
        cv.text('CONTROLLER', 54, 180, 23, C.dim, { font: 'bold' });
        cv.text(identity, 54, 235, 30, C.text, { font: 'bold' });
        cv.text('SELECTED LEVEL', 54, 294, 22, C.dim, { font: 'bold' });
        cv.text(level, 54, 338, 32, C.green, { font: 'bold' });
        card(cv, 788, 139, 780, 220, C.green);
        cv.text('HEIGHT SENSOR VALUES', 810, 180, 23, C.dim, { font: 'bold' });
        CORNERS.forEach((name, i) => {
            const x = 810 + Math.floor(i / 2) * 375, y = 235 + (i % 2) * 87;
            cv.text(name, x, y, 22, C.dim);
            cv.text(live[i] === null ? '--' : signed(live[i].toFixed(1)) + ' mm',
                x, y + 37, 30, live[i] === null ? C.amber : C.text, { font: 'bold' });
        });
        cv.text('Sensor values are relative, not physical rim-to-fender measurements.',
            34, 404, 23, C.amber);
        cv.text('Updated ' + (updated ? new Date(updated).toLocaleTimeString() : 'never') +
            ' • ' + (control.diag.p ? 'Diagnostic link ready' : 'Diagnostic link unavailable'),
            34, 450, 22, C.dim);
        button(cv, 1310, 431, 256, 62, 'Refresh', () => poll());
        cv.text('Control requires fresh Park and speed signals. Sensor values are relative.', 34, 495, 20, C.dim);
    }
    async function render() {
        const cv = ctx.canvas(W, H).clear(C.bg);
        hits = [];
        if (page === 0) drawTargets(cv);
        else if (page === 1) drawMeasurements(cv);
        else if (page === 2) drawPresets(cv);
        else if (page === 3) drawAxles(cv);
        else drawVehicle(cv);
        if (notice) cv.text(notice.slice(0, 108), 34, 456, 21, C.red, { font: 'bold' });
        G.frame(cv, ctx.theme(), pages, page, [{ text: control.busy ? 'VDP BUSY' : 'PARK ONLY', color: C.amber }]);
        await ctx.ui.image('MAIN_GFX', cv);
    }
    function nextPage() { page = (page + 1) % pages.length; redraw(); }
    function adjust(step) {
        if (page === 1) action(() => plan.measure(step));
        else if (page === 0) action(() => plan.adjustDelta(step));
        else if (page === 3) action(() => { pulseSeconds = Math.max(1, Math.min(30, pulseSeconds + step)); });
        else if (page === 4) poll();
    }
    ctx.ui.onClick('BTN_PAGE', nextPage);
    ctx.ui.onClick('BTN_SELECT', () => { if (page === 1) action(() => plan.select()); else nextPage(); });
    ctx.ui.onClick('BTN_MINUS', () => adjust(-1));
    ctx.ui.onClick('BTN_PLUS', () => adjust(1));
    ctx.onTab((i) => { page = i; redraw(); });
    ctx.onTap((x, y) => {
        const hit = hits.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
        if (hit) hit.fn();
    });
    ctx.onLayout(redraw);
    ctx.ui.onVisible((name, visible) => { if (name === 'MAIN' && visible) redraw(); });

    async function poll() {
        if (!control.diag.p || polling || control.busy) return;
        polling = true;
        try {
            const [id, lvl, values] = await Promise.all([
                control.read(0xF150), control.read(0xD8EC), control.read(0xDC05)
            ]);
            if (id) identity = 'VDP_G11 • ' + id.slice(0, 3).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
            if (lvl) {
                const code = lvl.reduce((n, b) => n * 256 + b, 0);
                level = ({ 2: 'Low', 8: 'Standard', 16: 'High' })[code] || 'Unknown (' + code + ')';
            }
            if (values && values.length >= 16)
                live = [0, 1, 2, 3].map((i) => {
                    const b = Buffer.from(values.slice(i * 4, i * 4 + 4));
                    const v = b.readFloatBE(0) * 1000;
                    return Number.isFinite(v) && Math.abs(v) < 500 ? v : null;
                });
            updated = Date.now();
        } catch (e) { ctx.log.warn('VDP read: ' + e.message); }
        finally { polling = false; redraw(); }
    }
    redraw();
    await Promise.all([control.init(), guard.init()]);
    poll();
    setInterval(poll, 10000);
} });
