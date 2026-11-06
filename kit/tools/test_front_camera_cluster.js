'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'apps', 'front_camera_cluster', 'main.js'), 'utf8');
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'front_camera_cluster', 'app.json'), 'utf8'));

assert.strictEqual(spec.version, '0.2.1');
assert.strictEqual(spec.config.fullScreenRequired, true);
assert.deepStrictEqual(spec.settings.find((x) => x.key === 'layout').options, [['full', 'Full screen']]);
assert.deepStrictEqual(spec.settings.find((x) => x.key === 'renderer').options, [['auto', 'GPU 60 fps']]);
assert.ok(/ctx\.loop\(\s*['"]MAIN['"]\s*,\s*60/.test(src), 'camera dashboard requests 60 fps');
assert.ok(!/ui\.close\(\s*['"]MAIN['"]/.test(src), 'camera selection must never close its own screen');
assert.ok(/sock\.on\(\s*['"]error['"]/.test(src), 'socket errors are handled');
assert.ok(/catch \(e\)[\s\S]*Native camera service unavailable/.test(src), 'synchronous socket failures are handled');
assert.ok(/send\(\s*['"]start['"]\s*,\s*wanted\s*\)/.test(src), 'both camera choices request the native helper');

console.log('Night Vision Cluster full-screen, 60 fps and crash-safety checks passed.');
