'use strict';

/* Shared iDrive-controller contract for every AlexP50 app.
 *
 * The apps all use kit/runtime/display.js, so one deterministic test covers the
 * knob, press and tilt routing they ship in their package.  The manifest pass
 * also makes sure every canvas app has at least one controller-reachable action.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { Display, FULL } = require(path.join(ROOT, 'kit', 'runtime', 'display'));

// The app-drawn header is 44 px high.  A smaller crop leaves its lower edge
// under the native title strip and misaligns the tab/controller hit targets.
assert.strictEqual(FULL.src.y, 44, 'full-screen crop must clear the complete app header');
assert.strictEqual(FULL.src.y + FULL.src.h, 520, 'full-screen crop must retain the complete page body');

const apps = fs.readdirSync(path.join(ROOT, 'apps'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

for (const id of apps) {
    const specPath = path.join(ROOT, 'apps', id, 'app.json');
    if (!fs.existsSync(specPath)) continue;
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const canvas = (spec.screens || []).filter((screen) => screen.kind === 'canvas');
    assert(canvas.length > 0, `${id}: no canvas screen`);
    for (const screen of canvas) {
        assert((screen.buttons || []).length > 0,
            `${id}/${screen.name}: no controller-reachable bottom action`);
    }
    const layout = (spec.settings || []).find((setting) => setting.key === 'layout');
    const renderer = (spec.settings || []).find((setting) => setting.key === 'renderer');
    assert(layout && layout.default === 'full', `${id}: full-screen layout is not the default`);
    assert(renderer && renderer.default === 'auto', `${id}: GPU renderer is not the default`);
}

let targetRuns = 0;
const barRuns = [];
const openedTabs = [];
let backed = 0;
const d = Object.create(Display.prototype);
Object.assign(d, {
    ccuLast: null,
    focusKey: null,
    focusTab: null,
    focused: null,
    place: { x: 0, y: 0, w: 1920, h: 720, scale: 1, ox: 0, oy: 0 },
    pageTargets: [{ x: 100, y: 100, w: 200, h: 80, key: 'page-action', run: () => { targetRuns++; } }],
    pageScroll: false,
    onScroll: null,
    tabInfo: { tabs: ['Now', 'Details'], sel: 0, badges: [] },
    sheet: null,
    screen: { name: 'MAIN', settingsTab: true, buttons: [['REFRESH', 'Refresh'], ['BTN_SETTINGS', 'Settings']] },
    ui: { rhmi: { getByName: (id) => ({ emit: (name) => { if (name === 'action') barRuns.push(id); } }) } },
    log: { info() {}, warn() {}, error(e) { throw e; } },
    own: () => true,
    hasSettings: Display.prototype.hasSettings,
    buttons: () => [{ id: 'REFRESH' }, { id: 'BTN_SETTINGS' }],
    _repaint() {},
    _scroll() {},
    _openTab(i) { openedTabs.push(i); },
    _back() { backed++; },
});

const ev = (k, pb = 0, df = 0) => ({
    frontRotaryEncoderOperation: k,
    frontRotaryEncoderPushButton: pb,
    frontRotaryEncoderDeflection: df,
});

// Establish the absolute knob counter, then turn through tab -> tab -> page target -> bar.
d._ccu(ev(100));
d._ccu(ev(101));
assert.strictEqual(d.focusKey, 'tab:0');
d._ccu(ev(102));
assert.strictEqual(d.focusKey, 'tab:1');
d._ccu(ev(103));
assert.strictEqual(d.focusKey, 'tab:2');
d._ccu(ev(104));
assert.strictEqual(d.focusKey, 'tgt:page-action');
d._ccu(ev(104, 1));
assert.strictEqual(targetRuns, 1, 'controller press did not run the page target');
d._ccu(ev(104, 0));
d._ccu(ev(105));
assert.strictEqual(d.focusKey, 'bar:REFRESH');
d._ccu(ev(105, 2));
assert.deepStrictEqual(barRuns, ['REFRESH'], 'long press did not run the bar action');
d._ccu(ev(105, 0));

// A directional push chooses the nearest place; west with no place exits the app.
d.focusKey = 'tab:0';
d._ccu(ev(105, 0, 10));
assert.strictEqual(backed, 1, 'west tilt did not invoke Back');

// Pressing a focused tab opens it.
d.focusKey = 'tab:1'; d.focusTab = 1;
d._ccu(ev(105, 0, 0));
d._ccu(ev(105, 1, 0));
assert.deepStrictEqual(openedTabs, [1]);

console.log(`Controller routing passed for ${apps.length} app manifests, knob, short/long press, tilt, tabs, page targets and bar actions.`);
