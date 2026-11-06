'use strict';
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { TurnLearner } = require('./turns');
const { DriveHud } = require('./hud');

const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const BODY = 'de.bmw.body.Light';
const W = 1600, H = 520;
const C = { bg: '#0d1119', panel: '#1b2431', text: '#f3f6f9', dim: '#aebdca',
    blue: '#4cb5ff', green: '#56d89a', amber: '#ffb84c', red: '#ef6a67' };
function modeOf(raw) { return raw && raw.actualValueModeDrivingExperience || null; }
function sportMode(mode) { return mode === 'SPORT_DYNAMIC' || mode === 'SPORT_EXPERT' ||
    mode === 'SPORT_INDIVIDUAL' || mode === 1 || mode === 2 || mode === 3; }
const value = (x, unit) => typeof x === 'number' && isFinite(x) ? Math.round(x) + unit : '--';
const short = (x, n) => String(x || '').length > n ? String(x).slice(0, n - 3) + '...' : String(x || '');

mgu.run({ async start(ctx) {
    const ui = ctx.ui, settings = ctx.settings, car = new Car(ctx, ['rpm', 'speed', 'temps', 'gear']);
    let mode = null, bodyAvailable = false, bodyError = '', closed = false, page = 0;
    let notice = '', hits = [], hud;
    const turns = new TurnLearner(ctx.dataDir, () => { update(); redraw(); }, ctx.log);
    hud = new DriveHud(ctx, redraw);

    function state() {
        const d = car.data();
        return Object.assign({}, d, {
            enabled: settings.get('enabled'), turns: settings.get('turns'), sport: settings.get('sport'),
            warmup: settings.get('warmup'), redline: settings.get('redline'), shift: settings.get('shift'),
            warmOil: settings.get('warmOil'), warmCoolant: settings.get('warmCoolant'),
            brightness: settings.get('brightness'), isSport: sportMode(mode), turn: turns.side,
            turnReady: turns.ready(), oilKnown: typeof d.oil === 'number' && isFinite(d.oil),
            coolantKnown: typeof d.coolant === 'number' && isFinite(d.coolant),
            engineRunning: typeof d.rpm === 'number' && d.rpm > 300
        });
    }
    function update() { if (!closed) hud.apply(state()); }
    function redraw() { if (!closed) render().catch((e) => ctx.log.error('Drive HUD screen', e)); }
    async function act(fn) {
        try { await fn(); notice = ''; } catch (e) { notice = e.message; ctx.log.warn(e); }
        update(); redraw();
    }
    function tile(cv, x, y, w, h, label, number, unit, color) {
        cv.roundRect(x, y, w, h, 10, C.panel);
        cv.fillRect(x, y, 5, h, color || C.blue);
        cv.text(label.toUpperCase(), x + 20, y + 38, 21, C.dim, { font: 'bold' });
        cv.text(String(number), x + 20, y + 108, 60, C.text, { font: 'bold' });
        if (unit) cv.text(unit, x + w - 24, y + 108, 22, C.dim, { align: 'right' });
    }
    function button(cv, x, y, w, h, label, fn, active, color) {
        cv.roundRect(x, y, w, h, 9, active ? (color || C.blue) : C.panel);
        cv.text(label, x + w / 2, y + h / 2 + 9, 25, active ? C.bg : C.text,
            { align: 'center', font: 'bold' });
        hits.push({ x, y, w, h, fn });
    }
    function overview(cv, s) {
        cv.text('Drive HUD', 34, 83, 36, C.text, { font: 'bold' });
        cv.text('Transparent HUD layer; BMW warnings retain priority.', 34, 114, 21, C.dim);
        cv.roundRect(32, 134, 1536, 60, 9, C.panel);
        cv.fillRect(32, 134, 5, 60, hud.state.indexOf('refused') >= 0 ? C.red : C.green);
        cv.text(short(hud.state, 96), 52, 173, 26, hud.state.indexOf('refused') >= 0 ? C.red : C.text,
            { font: 'bold' });
        const gear = s.stage === 'P' || s.stage === 'R' || s.stage === 'N' ? s.stage : s.gear || '--';
        [['Mode', short(mode || 'waiting', 15), '', C.blue], ['RPM', value(s.rpm, ''), 'rpm', C.red],
            ['Gear', gear, '', C.green], ['Oil', value(s.oil, ''), '°C', C.amber],
            ['Coolant', value(s.coolant, ''), '°C', C.blue]].forEach((v, i) =>
            tile(cv, 32 + i * 311, 213, 295, 132, v[0], v[1], v[2], v[3]));
        button(cv, 32, 365, 470, 68, settings.get('enabled') ? 'Disable Drive HUD' : 'Enable Drive HUD',
            () => act(() => settings.set('enabled', !settings.get('enabled'))), settings.get('enabled'), C.green);
        button(cv, 518, 365, 470, 68, 'Parked HUD test (10 sec)', () => act(() => {
            const speed = car.data().speed;
            if (!(typeof speed === 'number' && speed < 1)) throw new Error('Live vehicle speed must be zero');
            hud.test(10000);
        }));
        button(cv, 1004, 365, 564, 68, 'Learn turn indicators', () => { page = 1; redraw(); });
        cv.text('Sport: RPM / gear / shift lights    Cold engine: warm-up    All modes: learned turn arrows',
            34, 478, 22, C.dim);
    }
    function calibration(cv) {
        cv.text('Turn-signal calibration', 34, 83, 36, C.text, { font: 'bold' });
        cv.text('Keep the car parked. Learn Neutral, then arm Left and Right and move the stalk.',
            34, 114, 21, C.dim);
        cv.roundRect(32, 134, 1536, 99, 9, C.panel);
        cv.fillRect(32, 134, 5, 99, bodyAvailable ? C.green : C.amber);
        cv.text(bodyAvailable ? 'Steering-column provider live' :
            (bodyError ? 'Steering-column provider unavailable' : 'Waiting for steering-column provider'),
            53, 175, 27, bodyAvailable ? C.green : C.amber, { font: 'bold' });
        cv.text(short(turns.message || 'Operate the stalk after arming a direction.', 105),
            53, 215, 22, C.text);
        const labels = [['Neutral', 'neutral', () => turns.learnNeutral()],
            ['Arm Left', 'left', () => turns.arm('left')],
            ['Arm Right', 'right', () => turns.arm('right')]];
        labels.forEach((v, i) => button(cv, 32 + i * 388, 258, 372, 68, v[0],
            () => act(v[2]), !!turns.values[v[1]], C.green));
        button(cv, 1196, 258, 372, 68, 'Clear calibration', () => act(() => turns.clear()));
        cv.text('Neutral: ' + (turns.values.neutral ? 'learned' : 'missing') +
            '     Left: ' + (turns.values.left ? 'learned' : 'missing') +
            '     Right: ' + (turns.values.right ? 'learned' : 'missing'),
            34, 380, 28, turns.ready() ? C.green : C.amber, { font: 'bold' });
        cv.text('Current indicator: ' + (turns.side < 0 ? 'LEFT' : turns.side > 0 ? 'RIGHT' : 'neutral / unknown'),
            34, 425, 24, C.text);
        cv.text('The iDrive Settings button opens the dashboard settings page.', 34, 478, 22, C.dim);
    }
    function dashboardSettings(cv) {
        cv.text('Drive HUD settings', 34, 83, 36, C.text, { font: 'bold' });
        cv.text('Select a setting to change its value. Changes are saved on this head unit.',
            34, 114, 21, C.dim);
        const keys = ['enabled', 'turns', 'sport', 'warmup', 'redline', 'shift',
            'warmOil', 'warmCoolant', 'turnHold', 'brightness'];
        keys.forEach((key, i) => {
            const setting = settings.schema.find((s) => s.key === key);
            const current = settings.get(key);
            const label = setting.label + ': ' + (typeof current === 'boolean' ?
                (current ? 'On' : 'Off') : current + (setting.unit ? ' ' + setting.unit : ''));
            button(cv, 32 + (i % 2) * 776, 134 + Math.floor(i / 2) * 68,
                760, 59, label, () => act(() => settings.cycle(key)),
                typeof current === 'boolean' && current, C.green);
        });
        cv.text('Open Turn signals to calibrate the stalk. Run the HUD test only while parked.',
            34, 502, 20, C.dim);
    }
    async function render() {
        const cv = ctx.canvas(W, H).clear(C.bg), s = state();
        hits = [];
        if (page === 0) overview(cv, s);
        else if (page === 1) calibration(cv);
        else dashboardSettings(cv);
        if (notice) cv.text(short(notice, 80), 1560, 510, 20, C.red, { align: 'right' });
        G.frame(cv, ctx.theme(), ['Overview', 'Turn signals', 'Settings'], page,
            [{ text: settings.get('enabled') ? 'ENABLED' : 'OFF', color: settings.get('enabled') ? C.green : C.amber }]);
        await ui.image('MAIN_GFX', cv);
    }
    ui.onClick('BTN_ENABLE', () => act(() => settings.set('enabled', !settings.get('enabled'))));
    ui.onClick('BTN_PAGE', () => { page = (page + 1) % 3; redraw(); });
    ui.onClick('BTN_SETTINGS', () => { page = 2; redraw(); });
    ui.onClick('BTN_ACTION', () => page === 0 ? act(() => {
        const speed = car.data().speed;
        if (!(typeof speed === 'number' && speed < 1)) throw new Error('Live vehicle speed must be zero');
        hud.test(10000);
    }) : act(() => turns.learnNeutral()));
    ctx.onTab((i) => { page = i; redraw(); });
    ctx.onTap((x, y) => {
        const hit = hits.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
        if (hit) hit.fn();
    });
    settings.onChange(() => { update(); redraw(); });
    car.onSample(() => { update(); redraw(); });
    ctx.onLayout(redraw);
    ui.onVisible((name, visible) => { if (name === 'MAIN' && visible) redraw(); });
    async function openField(key, iface, field, receive, notificationOnly) {
        try {
            const proxy = await ctx.signals.proxy(iface, '1');
            await ctx.signals.onAvailable(proxy, (available) => { if (key === 'body') bodyAvailable = available; redraw(); });
            await ctx.signals.on(proxy, field, receive, ctx.log);
            if (!notificationOnly && proxy.getValue) try { receive(await proxy.getValue(field, 2000)); }
            catch (e) { ctx.log.warn(field + ': ' + e.message); }
            return proxy;
        } catch (e) { if (key === 'body') bodyError = e.message; ctx.log.warn(iface + '.' + field + ': ' + e.message); redraw(); return null; }
    }
    const proxies = await Promise.all([
        openField('mode', FES, 'statusFESVehicleDynamicSwitchHMI', (raw) => { mode = modeOf(raw); update(); redraw(); }, false),
        openField('body', BODY, 'IndicatorSteeringColumnComplete', (raw) => { turns.receive(raw, settings.get('turnHold')); update(); redraw(); }, true)
    ]);
    const close = () => {
        if (closed) return; closed = true; turns.close(); hud.close();
        proxies.forEach((p) => { if (p && p.shutdown) Promise.resolve(p.shutdown()).catch(() => {}); });
    };
    if (ctx.app && ctx.app.on) ctx.app.on('shutdown', close);
    process.once('exit', close);
    update(); redraw();
} });

module.exports = { modeOf, sportMode };
