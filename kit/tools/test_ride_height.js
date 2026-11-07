'use strict';
const assert = require('assert');
const { VdpControl, word, sensorValues } = require('../../dist/ride_height/source/javascript/control');

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
            assert.deepStrictEqual(bytes.slice(0, 2), [0xDC, 0x11], 'only preset ride-level writes are allowed');
            requestedLevel = bytes[3];
            return [0x6E, bytes[0], bytes[1]];
        }
        if (bytes[0] === 0xF1 && bytes[1] === 0x50) return [0x62, 0xF1, 0x50, 0x0F, 0x1F, 0x50];
        if (bytes[0] === 0xDD && bytes[1] === 0x3A) {
            const b = Buffer.alloc(8); b.writeFloatBE(vdpSpeed, 4);
            return [0x62, 0xDD, 0x3A].concat(Array.from(b));
        }
        if (bytes[0] === 0xD8 && bytes[1] === 0xEC) return [0x62, 0xD8, 0xEC, 0x00, requestedLevel];
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
    assert(requests.filter((r) => r[0] === 0x2E).every((r) => r[1] === 0xDC && r[2] === 0x11));
    console.log('VDP preset-control packet, Park gate, direct-speed gate and write allowlist checks passed.');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
