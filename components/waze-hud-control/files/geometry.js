'use strict';

const DEFAULT = { canvasW:1000, canvasH:600, x:0, y:0, w:1000, h:600, fit:'fill' };
const FITS = ['fill', 'balanced', 'natural', 'custom'];

function integer(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : fallback;
}
function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }

function fitRect(canvasW, canvasH, fit) {
    if (fit === 'natural') {
        const h = Math.max(200, Math.min(canvasH, Math.round(canvasW * 480 / 1088)));
        return { x:0, y:Math.round((canvasH - h) / 2), w:canvasW, h:h };
    }
    if (fit === 'balanced') {
        const h = Math.max(240, Math.min(canvasH, Math.round(canvasH * 0.87)));
        return { x:0, y:Math.round((canvasH - h) / 2), w:canvasW, h:h };
    }
    return { x:0, y:0, w:canvasW, h:canvasH };
}

function normalize(input) {
    input = input || {};
    const canvasW = clamp(integer(input.canvasW, DEFAULT.canvasW), 640, 1400);
    const canvasH = clamp(integer(input.canvasH, DEFAULT.canvasH), 400, 800);
    const fit = FITS.indexOf(input.fit) >= 0 ? input.fit : DEFAULT.fit;
    const base = fitRect(canvasW, canvasH, fit);
    const w = clamp(integer(input.w, base.w), 320, canvasW);
    const h = clamp(integer(input.h, base.h), 200, canvasH);
    const x = clamp(integer(input.x, base.x), 0, canvasW - w);
    const y = clamp(integer(input.y, base.y), 0, canvasH - h);
    return { canvasW, canvasH, x, y, w, h, fit };
}

function preset(name) {
    if (name === 'legacy') return normalize({ canvasW:800, canvasH:600, x:0, y:0, w:800, h:600, fit:'fill' });
    if (name === 'balanced') return normalize({ canvasW:1000, canvasH:600, fit:'balanced' });
    if (name === 'natural') return normalize({ canvasW:1000, canvasH:600, fit:'natural' });
    return normalize(DEFAULT);
}

module.exports = { DEFAULT, FITS, fitRect, normalize, preset };
