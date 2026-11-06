'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./logic');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const GROUPS = [
    [0x58B1,0x58B2,0x58B3,0x58B4,0x58B5],
    [0x58B7,0x58B8,0x58BA,0x43B9,0x43C0,0x43C1,0x489A,0x4D03],
    [0x43FE,0x43CC,0x43FD,0x4A98,0x48F9,0x4D0B,0x56E3]
];

class Reader {
    constructor(ctx) {
        this.ctx = ctx; this.bytes = {}; this.values = {}; this.history = []; this.lastGood = 0;
        this.lastError = ''; this.busy = false; this.running = false; this.cycleMs = 0; this.format = 1;
        this.engineRunning = null;
        this.file = path.join(ctx.dataDir, 'start-stop-history.json');
        try {
            const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (saved && saved.format >= 2 && Array.isArray(saved.history)) this.history = saved.history.slice(-10);
        } catch (e) { /* first use */ }
    }
    setEngineRunning(on) {
        if (typeof on !== 'boolean' || on === this.engineRunning) return;
        this.engineRunning = on; this.snapshot();
    }
    async init() {
        this.diag = new ReadOnlyDiag(this.ctx.signals, this.ctx.log, { gapMs: 80, busyMs: 80, silentAfter: 10 });
        await this.diag.init(); this.running = true; this.pump().catch((e) => { this.lastError = String(e.message || e); });
    }
    async one(did) {
        const r = await this.diag.read(0x12, did, 1700);
        if (!r || r[0] !== 0x62 || ((r[1] << 8) | r[2]) !== did) return null;
        const id = did.toString(16).toUpperCase().padStart(4, '0'), n = L.LENGTHS[id];
        return n && r.length >= 3 + n ? r.slice(3, 3 + n) : null;
    }
    async group(dids) {
        const reply = await this.diag.readMany(0x12, dids, 1900), split = L.splitReply(reply, dids);
        if (split) return split;
        const out = {};
        for (const did of dids) {
            const b = await this.one(did); if (b) out[did.toString(16).toUpperCase().padStart(4, '0')] = b;
        }
        return out;
    }
    snapshot() {
        if (!L.WORDS.every((x) => L.finite(this.values[x[0]]))) return;
        const s = L.operatingState(this.values, this.engineRunning), now = Date.now(), last = this.history[this.history.length - 1];
        if (!last || last.signature !== s.signature) {
            this.history.push({ at: now, signature: s.signature, title: s.title,
                active: s.active.map((x) => ({ did:x.did, label:x.label, bits:x.bits })),
                voltage: this.values.voltage, batteryCurrent: this.values.batteryCurrent,
                batteryTemp: this.values.batteryTemp, generatorCurrent: this.values.generatorCurrent });
            this.history = this.history.slice(-10); this.save();
        }
    }
    save() {
        try { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ format:2, savedAt:Date.now(), history:this.history })); fs.renameSync(tmp, this.file); }
        catch (e) { this.ctx.log.warn('Start/Stop history: ' + e); }
    }
    async pump() {
        while (this.running) {
            if (this.ctx.settings.get('demo') === 'on' || !this.diag.available || !this.diag.ready) { await sleep(300); continue; }
            this.busy = true; const started = Date.now(); let got = 0;
            try {
                this.diag.wake(0x12);
                for (const group of GROUPS) {
                    const data = await this.group(group); Object.keys(data).forEach((id) => { this.bytes[id] = data[id]; got++; });
                }
                if (got) { this.values = L.decode(this.bytes); this.lastGood = Date.now(); this.lastError = ''; this.snapshot(); }
                else this.lastError = 'DDE did not answer';
            } catch (e) { this.lastError = String(e.message || e); }
            this.cycleMs = Date.now() - started; this.busy = false;
            await sleep(250);
        }
    }
    status() {
        if (!this.diag || !this.diag.available) return 'NO LINK';
        if (!this.lastGood) return this.busy ? 'READING' : 'WAITING';
        return Date.now() - this.lastGood < 8000 ? 'LIVE' : 'STALE';
    }
}
module.exports = Reader;
