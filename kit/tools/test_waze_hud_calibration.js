'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const Geometry = require(path.resolve(ROOT, '..', 'waze-hud-control', 'geometry'));
const src = fs.readFileSync(path.join(ROOT, 'apps', 'waze_hud', 'main.js'), 'utf8');
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'waze_hud', 'app.json'), 'utf8'));

assert.deepStrictEqual(Geometry.preset('wide'), { canvasW:1000, canvasH:600, x:0, y:0, w:1000, h:600, fit:'fill' });
assert.deepStrictEqual(Geometry.preset('legacy'), { canvasW:800, canvasH:600, x:0, y:0, w:800, h:600, fit:'fill' });
const natural = Geometry.preset('natural');
assert.strictEqual(natural.w, 1000);
assert.strictEqual(natural.h, 441);
assert.strictEqual(natural.y, 80);
const clamped = Geometry.normalize({ canvasW:1000, canvasH:600, x:999, y:-20, w:700, h:300, fit:'custom' });
assert.strictEqual(clamped.x, 300);
assert.strictEqual(clamped.y, 0);
assert.strictEqual(spec.version, '0.3.0');
assert.strictEqual(spec.config.hudCanvas, '1000x600');
assert.strictEqual(spec.config.fullScreenRequired, true);
assert.ok(spec.screens[0].buttons.some((button) => button[0] === 'PRESET_NEXT'));
assert.ok(spec.screens[0].buttons.some((button) => button[0] === 'FIELD_NEXT'));
assert.ok(/ctx\.loop\(\s*['"]MAIN['"]\s*,\s*60/.test(src));
assert.ok(/send\(\s*['"]status['"]/.test(src), 'opening the app reads geometry without restarting projection');
assert.ok(!/ui\.close\(/.test(src), 'calibration app stays visible');

console.log('Waze HUD 1000x600 geometry, aspect presets and full-screen controls passed.');
