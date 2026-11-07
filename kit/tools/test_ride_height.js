'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

// Stage the source exactly as the app build does. dist/ is intentionally not committed.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-height-test-'));
fs.mkdirSync(path.join(tmp, 'kit'));
fs.copyFileSync(path.join(ROOT, 'apps', 'ride_height', 'control.js'), path.join(tmp, 'control.js'));
fs.copyFileSync(path.join(ROOT, 'kit', 'runtime', 'diag.js'), path.join(tmp, 'kit', 'diag.js'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const { VdpControl, AXLES, word, sensorValues } = require(path.join(tmp, 'control'));

const floats = (values) => {
    const b = Buffer.alloc(16);
    values.forEach((v, i) => b.writeFloatBE(v / 1000, 4 * i));
    return Array.from(b);
};
assert.deepStrictEqual(word(0xDC11), [0xDC, 0x11]);
assert(Math.abs(sensorValues(floats([2, 3, 4, 5]))[2] - 4) < 0.01);

async function main() {
    const requests = [];
    let safe = false, vdpSpeed = 0, requestedLevel = 8;
    const guard = { check() { if (!safe) throw new Error('unsafe'); } };
    const c = new VdpControl({}, {}, guard);
    c.diag.physical = async (_ecu, sid, bytes) => {
        requests.push([sid].concat(bytes));
        if (sid === 0x2E) {
            const did = (bytes[0] << 8) | bytes[1];
            assert([0xDC11, 0xDB77].includes(did), 'only preset or axle-component writes are allowed');
            if (did === 0xDC11) requestedLevel = bytes[3];
            return [0x6E, bytes[0], bytes[1]];
        }
        if (bytes[0] === 0xF1 && bytes[1] === 0x50) return [0x62, 0xF1, 0x50, 0x0F, 0x1F, 0x50];
        if (bytes[0] === 0xDD && bytes[1] === 0x3A) {
            const b = Buffer.alloc(8); b.writeFloatBE(vdpSpeed, 4);
            return [0x62, 0xDD, 0x3A].concat(Array.from(b));
        }
        if (bytes[0] === 0xD8 && bytes[1] === 0xEC) return [0x62, 0xD8, 0xEC, 0x00, requestedLevel];
        if (bytes[0] === 0xDC && bytes[1] === 0x06) return [0x62, 0xDC, 0x06, 0, 0, 0, 0, 0, 0, 0, 0];
        if (bytes[0] === 0xDC && bytes[1] === 0x05)
            return [0x62, 0xDC, 0x05].concat(floats([2, 3, 4, 5]));
        throw new Error('unexpected diagnostic read');
    };
    await assert.rejects(c.level('Standard'), /unsafe/);
    assert.strictEqual(requests.length, 0, 'unsafe state must never send a request');
    safe = true;
    vdpSpeed = 7.5;
    await assert.rejects(c.level('Standard'), /Vehicle is moving/);
    assert.strictEqual(requests.filter((r) => r[0] === 0x2E).length, 0, 'moving VDP must block writes');
    vdpSpeed = 0;
    assert.strictEqual(await c.level('Standard'), 'Standard');
    assert(requests.some((r) => r.join(',') === [0x2E, 0xDC, 0x11, 0, 8].join(',')));
    assert.strictEqual(await c.level('High'), 'High');
    assert(requests.some((r) => r.join(',') === [0x2E, 0xDC, 0x11, 0, 16].join(',')));
    assert.strictEqual(await c.level('Low'), 'Low');
    assert(requests.some((r) => r.join(',') === [0x2E, 0xDC, 0x11, 0, 2].join(',')));
    assert.strictEqual(AXLES.Front, 0xC6);
    assert.strictEqual(AXLES.Rear, 0xC3);
    const front = await c.axle('Front', 'Fill', 1);
    assert(front.after > 0);
    assert(requests.some((r) => r.join(',') === [0x2E, 0xDB, 0x77, 0, 3, 0, 1, 0, 0xC6].join(',')));
    assert(requests.some((r) => r.join(',') === [0x2E, 0xDB, 0x77, 0, 0, 0, 0, 0, 0xC6].join(',')));
    const rear = await c.axle('Rear', 'Vent', 1);
    assert(rear.after > 0);
    assert(requests.some((r) => r.join(',') === [0x2E, 0xDB, 0x77, 0, 2, 0, 1, 0, 0xC3].join(',')));
    assert(requests.some((r) => r.join(',') === [0x2E, 0xDB, 0x77, 0, 0, 0, 0, 0, 0xC3].join(',')));
    assert(!requests.some((r) => r[0] === 0x2E && r[1] === 0xDB && r[2] === 0x77 &&
        [0xC1, 0xC2, 0xC4, 0xC5].includes(r[8])));
    console.log('VDP presets, aggregate axle DB77 packets, OFF stop, Park gate and write allowlist checks passed.');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
