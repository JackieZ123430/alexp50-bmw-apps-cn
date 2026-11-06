'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./catalog');
const D = require('./dpf');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Reader {
    constructor(ctx) {
        this.ctx = ctx;
        this.records = {};
        this.history = [];
        this.sgbd = '';
        this.checked = false;
        this.visible = false;
        this.running = false;
        this.busy = false;
        this.current = '';
        this.lastGood = 0;
        this.lastError = '';
        this.attempts = {};
        this.wanted = [];
        this.cursor = 0;
        this.lastSave = 0;
        this.snapshotFile = path.join(ctx.dataDir, 'dpf-snapshot.json');
        try {
            const old = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'));
            if (old && old.records) Object.keys(old.records).forEach((id) => {
                if (C.records[id] && old.records[id] && D.finite(old.records[id].value)) {
                    this.records[id] = Object.assign({}, old.records[id], { cached: true });
                }
            });
            // Format 1 history was sampled from 44B9, which is not the useful soot channel on D83.
            if (old.format >= 2 && Array.isArray(old.history)) {
                this.history = old.history.filter((p) => p && D.finite(p.t) && D.finite(p.soot)).slice(-600);
            }
        } catch (e) { /* first run, or an incomplete prior snapshot */ }
    }

    async init() {
        this.diag = new ReadOnlyDiag(this.ctx.signals, this.ctx.log, { gapMs: 120, silentAfter: 8 });
        await this.diag.init();
        this.running = true;
        this.pump().catch((e) => this.ctx.log.error('DPF reader: ' + e));
    }

    setVisible(on) {
        this.visible = !!on;
        if (on && this.diag) this.diag.wake(0x12);
        if (!on && this.diag) this.diag.cancel();
    }

    setWanted(ids) {
        this.wanted = Array.from(new Set((ids || []).filter((id) => C.records[id])));
        if (this.cursor >= this.wanted.length) this.cursor = 0;
    }

    refresh() {
        this.attempts = {};
        this.cursor = 0;
        if (this.diag) this.diag.wake(0x12);
    }

    async identify() {
        this.current = 'F150';
        this.attempts.F150 = Date.now();
        const uds = await this.diag.read(0x12, 0xF150, 1800);
        if (uds && uds.length >= 6 && uds[0] === 0x62 && uds[1] === 0xF1 && uds[2] === 0x50) {
            this.sgbd = Buffer.from(uds.slice(3, 6)).toString('hex').toUpperCase();
            this.checked = true;
            this.lastGood = Date.now();
            this.lastError = this.supported ? '' : 'Unsupported DDE variant ' + this.sgbd;
            this.ctx.log.info('DDE identification ' + this.sgbd + ' (' + (C.variants[this.sgbd] || 'unknown') + '), supported=' + this.supported);
        } else {
            this.lastError = uds && uds[0] === 0x7F ? 'F150: NRC ' + Number(uds[2]).toString(16).toUpperCase() : 'DDE did not answer identification';
        }
        this.current = '';
    }

    async read(did) {
        did = String(did).toUpperCase();
        if (!C.records[did] || !/^[0-9A-F]{4}$/.test(did)) throw new Error('Not an allowed DPF read identifier');
        if (!this.supported) return;
        this.current = did;
        this.attempts[did] = Date.now();
        const uds = await this.diag.read(0x12, parseInt(did, 16), 1800);
        const got = D.decode(did, uds);
        if (got.ok) {
            const rec = { ok: true, value: got.value, raw: got.raw, bytes: got.bytes, at: Date.now(), cached: false };
            this.records[did] = rec;
            this.lastGood = rec.at;
            this.lastError = '';
            if (did === '44BE') {
                const last = this.history[this.history.length - 1];
                if (!last || rec.at - last.t >= 5000) this.history.push({ t: rec.at, soot: rec.value });
                const cutoff = Date.now() - 20 * 60000;
                this.history = this.history.filter((p) => p.t >= cutoff).slice(-600);
            }
        } else {
            const error = !uds ? 'No response' : uds[0] === 0x7F ? 'NRC ' + Number(uds[2]).toString(16).toUpperCase() : got.error;
            this.lastError = did + ': ' + error;
            if (this.records[did] && this.records[did].ok) this.records[did].error = error;
            else this.records[did] = { ok: false, error, value: null, at: 0, cached: false };
        }
        this.current = '';
    }

    save() {
        try {
            const tmp = this.snapshotFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify({ format: 2, sootDid: '44BE', sgbd: this.sgbd, savedAt: Date.now(), records: this.records, history: this.history }));
            fs.renameSync(tmp, this.snapshotFile);
            this.lastSave = Date.now();
        } catch (e) { this.ctx.log.warn('DPF snapshot: ' + e); }
    }

    async pump() {
        while (this.running) {
            const active = this.visible && this.ctx.settings.get('demo') !== 'on';
            if (!active || !this.diag || !this.diag.available || !this.diag.ready) { await sleep(250); continue; }
            if (!this.checked) {
                if (!this.attempts.F150 || Date.now() - this.attempts.F150 > 5000) {
                    this.busy = true;
                    try { await this.identify(); } catch (e) { this.lastError = String(e.message || e); }
                    finally { this.busy = false; this.current = ''; }
                }
                await sleep(500);
                continue;
            }
            if (!this.supported) { await sleep(1000); continue; }
            const now = Date.now();
            const liveMs = Math.max(1, Number(this.ctx.settings.get('liveInterval')) || 2) * 1000;
            const due = this.nextDue(now, liveMs);
            if (!due) { await sleep(200); continue; }
            this.busy = true;
            try { await this.read(due); } catch (e) { this.lastError = String(e.message || e); this.attempts[due] = Date.now(); }
            finally { this.busy = false; this.current = ''; }
            if (Date.now() - this.lastSave > 10000) this.save();
            await sleep(120);
        }
    }

    get verified() { return !!C.variants[this.sgbd]; }
    get supported() { return this.verified || (!!this.sgbd && this.ctx.settings.get('variantPolicy') === 'compatible'); }
    get variantName() { return C.variants[this.sgbd] || (this.sgbd ? 'Unverified DDE' : 'Unknown DDE'); }

    /** Fair round-robin selection: a short live interval must not starve later DIDs. */
    nextDue(now, liveMs) {
        const n = this.wanted.length;
        for (let i = 0; i < n; i++) {
            const index = (this.cursor + i) % n;
            const did = this.wanted[index];
            const interval = C.records[did].live ? liveMs : 30000;
            if (now - (this.attempts[did] || 0) >= interval) {
                this.cursor = (index + 1) % n;
                return did;
            }
        }
        return null;
    }

    value(primary, fallback) {
        const a = this.records[primary];
        if (a && a.ok && D.finite(a.value)) return a.value;
        const b = fallback && this.records[fallback];
        return b && b.ok && D.finite(b.value) ? b.value : null;
    }

    status() {
        if (!this.diag || !this.diag.available) return 'NO LINK';
        if (!this.checked) return 'IDENTIFYING';
        if (!this.supported) return 'OTHER DDE';
        if (!this.lastGood || Date.now() - this.lastGood > 12000) return 'LINK STALE';
        return this.verified ? 'LIVE' : 'LIVE · UNVERIFIED';
    }
}

module.exports = Reader;
