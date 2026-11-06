'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const P = require(path.join(ROOT, 'apps', 'parking_clearance', 'logic'));

assert.ok(Math.abs(P.decodeSteering(32767)) < 0.01, 'encoded steering centre is zero');
assert.ok(P.decodeSteering(15222) < -770 && P.decodeSteering(15222) > -772, 'BMW offset is applied');
assert.strictEqual(P.decodeSteering(65535), null, 'reserved steering value is rejected');
assert.ok(P.steeringQualifierValid(2) && P.steeringQualifierValid(10));
assert.ok(!P.steeringQualifierValid(3) && !P.steeringQualifierValid('SIGNALWERT_IST_UNGUELTIG'));

const straight = P.tyrePath(500, 200, -1, 0, 10, 25, 405);
assert.ok(straight.every((p) => p[1] === 200), 'straight steering makes straight tracks');
const leftA = P.tyrePath(500, 150, -1, -25, 10, 25, 405);
const leftB = P.tyrePath(500, 250, -1, -25, 10, 25, 405);
assert.ok(leftA[10][1] < leftA[0][1], 'turn direction bends both tracks coherently');
assert.ok(Math.abs((leftB[10][1] - leftA[10][1]) - 100) < 0.001, 'parallel tyre spacing is preserved');

const src = fs.readFileSync(path.join(ROOT, 'apps', 'parking_clearance', 'main.js'), 'utf8');
assert.ok(/cv\.polyline\(points/.test(src) && /tread marks/.test(src), 'paired tyre ribbons are rendered');
assert.ok(!/\.physical\([^\n]+0x(?:2E|2F|31)|\.functional\(/i.test(src), 'parking app stays read only');
console.log('Parking & Clearance steering and tyre-track checks passed.');
