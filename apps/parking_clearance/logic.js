'use strict';

const VALID_STEERING_QUALIFIERS = [1, 2, 9, 10];

function steeringQualifierValid(q) {
    if (q === undefined || q === null || q === '') return true;
    if (typeof q === 'number') return VALID_STEERING_QUALIFIERS.indexOf(q) >= 0;
    const s = String(q).toUpperCase();
    return s.indexOf('UNGUELTIG') < 0 && s.indexOf('GUELTIG') >= 0;
}

// BMW SDK steeringAngleConverter: raw * 0.04395 - 1440.11 degrees.
function decodeSteering(raw) {
    if (typeof raw !== 'number' || !isFinite(raw) || raw < 3 || raw > 65532) return null;
    const deg = raw * 0.04395 - 1440.11;
    return deg >= -900 && deg <= 900 ? deg : null;
}

function tyrePath(startX, startY, direction, roadDeg, steps, stepPx, wheelbasePx) {
    steps = steps || 10; stepPx = stepPx || 25; wheelbasePx = wheelbasePx || 405;
    const road = Math.max(-35, Math.min(35, Number(roadDeg) || 0));
    const curve = Math.tan(road * Math.PI / 180) / (2 * wheelbasePx);
    const reverseSense = direction < 0 ? 1 : -1;
    const out = [];
    for (let i = 0; i <= steps; i++) {
        const s = i * stepPx;
        out.push([startX + direction * s, startY + curve * s * s * reverseSense]);
    }
    return out;
}

module.exports = { decodeSteering, steeringQualifierValid, tyrePath };
