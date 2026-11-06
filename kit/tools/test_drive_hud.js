'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stalkSignature, TurnLearner } = require('../../apps/drive_hud_full/turns');
const { DriveHud, HUD_FS } = require('../../apps/drive_hud_full/hud');

assert.strictEqual(stalkSignature({ operationColumnStalks: 0 }), '0');
assert.strictEqual(stalkSignature({ nested: { operation_ColumnStalks: 'LEFT' } }), '"LEFT"');
assert.strictEqual(stalkSignature({ unrelated: 1 }), null);
assert(HUD_FS.indexOf('u_turn') >= 0 && HUD_FS.indexOf('exclusive') < 0);
assert(HUD_FS.indexOf('float blink=0.42+0.58') >= 0);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-hud-'));
let changed = 0;
const t = new TurnLearner(dir, () => changed++, { warn() {} });
t.receive({ operationColumnStalks: 0 }, 0.02); t.learnNeutral();
t.arm('left'); t.receive({ operationColumnStalks: 8 }, 0.02);
t.receive({ operationColumnStalks: 0 }, 0.02);
t.arm('right'); t.receive({ operationColumnStalks: 1 }, 0.02);
assert.strictEqual(t.ready(), true);
assert.strictEqual(t.side, 1);
t.receive({ operationColumnStalks: 4 }, 0.02);
assert.strictEqual(t.side, -1);
t.receive({ operationColumnStalks: 2 }, 0.02);
assert.strictEqual(t.side, 1);
t.clearSide();

class MockClient {
    constructor() { this.events = {}; this.calls = []; this.targets = 'hud:800x480'; }
    on(name, fn) { this.events[name] = fn; }
    effect(opts) { this.effectOpts = opts; return 1; }
    connect() { this.events.ready(); }
    set(ref, opts) { this.calls.push(['set', ref, opts]); }
    uniform(ref, name, values) { this.calls.push(['uniform', ref, name, values]); }
    close() { this.closed = true; }
}
const hud = new DriveHud({ log: { warn() {} } }, () => {}, MockClient);
hud.apply({ enabled: true, sport: true, isSport: true, warmup: true, turns: true, turnReady: true, turn: -1,
    rpm: 4200, redline: 5000, shift: 4300, gear: 4, stage: 'D', engineRunning: true,
    oilKnown: true, oil: 55, warmOil: 80, coolantKnown: true, coolant: 68, warmCoolant: 75, brightness: 80 });
assert.strictEqual(hud.cr.effectOpts.target, 'hud');
assert.strictEqual(hud.cr.effectOpts.exclusive, false);
assert.strictEqual(hud.cr.effectOpts.contend, false);
const uniform = (name) => hud.cr.calls.filter((x) => x[0] === 'uniform' && x[2] === name).slice(-1)[0][3][0];
assert.strictEqual(uniform('u_turn'), -1);
assert.strictEqual(uniform('u_sport'), 1);
assert.strictEqual(uniform('u_warm'), 1);
assert.strictEqual(uniform('u_gear'), 4);
assert(Math.abs(uniform('u_rpm') - 0.84) < 0.001);
hud.close(); t.close(); fs.rmSync(dir, { recursive: true, force: true });
assert(changed > 0);
console.log('Drive HUD calibration, context, safety and renderer-client checks passed.');
