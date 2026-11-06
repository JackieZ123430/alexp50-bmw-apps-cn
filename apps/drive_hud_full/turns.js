'use strict';
const fs = require('fs');
const path = require('path');

function scalar(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
    return null;
}

function stalkSignature(raw) {
    if (!raw || typeof raw !== 'object') return scalar(raw);
    let answer = null;
    function walk(value) {
        if (answer !== null || !value || typeof value !== 'object') return;
        Object.keys(value).sort().forEach((key) => {
            if (answer !== null) return;
            const normalized = key.toLowerCase().replace(/[_-]/g, '');
            if (normalized.indexOf('operationcolumnstalks') >= 0 || normalized.indexOf('operationturnindicator') >= 0)
                answer = scalar(value[key]);
            else if (value[key] && typeof value[key] === 'object') walk(value[key]);
        });
    }
    walk(raw);
    return answer;
}

class TurnLearner {
    constructor(dataDir, changed, log) {
        this.file = path.join(dataDir, 'turn-signals.json');
        this.changed = changed || (() => {}); this.log = log || { warn() {} };
        this.values = { neutral: null, left: null, right: null };
        this.current = null; this.lastLogged = null; this.side = 0; this.armSide = null; this.armUntil = 0;
        this.neutralPending = false; this.minUntil = 0; this.timer = null; this.message = '';
        try {
            const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            ['neutral', 'left', 'right'].forEach((k) => { if (typeof saved[k] === 'string') this.values[k] = saved[k]; });
        } catch (e) { if (e.code !== 'ENOENT') this.message = 'Saved calibration could not be read'; }
    }
    ready() { return !!(this.values.neutral && this.values.left && this.values.right &&
        this.values.neutral !== this.values.left && this.values.neutral !== this.values.right && this.values.left !== this.values.right); }
    numeric(sig) {
        try { const value = JSON.parse(sig); return Number.isInteger(value) ? value : null; } catch (e) { return null; }
    }
    sameDirection(sig, learned) {
        if (sig === learned) return true;
        const value = this.numeric(sig), reference = this.numeric(learned);
        if (value === null || reference === null || value <= 0 || reference <= 0) return false;
        /* G-series stalks report two phases for each direction: the right
           detents use bits 0/1 (1, 2) and the left detents bits 2/3 (4, 8).
           Calibration may observe either phase, so accept its partner. */
        const right = (n) => (n & 0x03) !== 0 && (n & 0x0c) === 0;
        const left = (n) => (n & 0x0c) !== 0 && (n & 0x03) === 0;
        return (right(value) && right(reference)) || (left(value) && left(reference));
    }
    sideFor(sig) {
        if (this.sameDirection(sig, this.values.left)) return -1;
        if (this.sameDirection(sig, this.values.right)) return 1;
        return 0;
    }
    save() {
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2)); fs.renameSync(tmp, this.file);
    }
    learnNeutral() {
        if (this.current === null) throw new Error('No steering-column signal has been received yet');
        this.values.neutral = this.current; this.save(); this.message = 'Neutral learned. Arm Left, then operate the left indicator.'; this.changed();
    }
    arm(side) {
        if (side !== 'left' && side !== 'right') throw new Error('Unknown side');
        if (!this.values.neutral) throw new Error('Learn Neutral first with the indicator stalk at rest');
        this.armSide = side; this.armUntil = Date.now() + 30000;
        this.message = 'Armed for ' + side.toUpperCase() + ': operate that indicator within 30 seconds'; this.changed();
        clearTimeout(this.armTimer);
        this.armTimer = setTimeout(() => {
            if (this.armSide === side && Date.now() >= this.armUntil) { this.armSide = null; this.message = side + ' learning timed out'; this.changed(); }
        }, 30200);
    }
    receive(raw, holdSeconds) {
        const sig = stalkSignature(raw);
        if (sig === null) return;
        this.current = sig;
        if (sig !== this.lastLogged) {
            this.lastLogged = sig;
            const decoded = this.sideFor(sig);
            if (this.log.info) this.log.info('turn stalk raw ' + sig +
                (decoded < 0 ? ' -> LEFT' : decoded > 0 ? ' -> RIGHT' : sig === this.values.neutral ? ' -> neutral' : ' -> unknown'));
        }
        const now = Date.now();
        if (this.armSide && now <= this.armUntil && sig !== this.values.neutral) {
            const side = this.armSide; this.values[side] = sig; this.armSide = null; this.save();
            this.message = side[0].toUpperCase() + side.slice(1) + ' learned' + (this.ready() ? ' — calibration complete' : '');
        }
        const decoded = this.sideFor(sig);
        if (decoded) this.activate(decoded, holdSeconds);
        else if (sig === this.values.neutral) {
            if (this.side && now < this.minUntil) { this.neutralPending = true; this.scheduleClear(this.minUntil - now); }
            else this.clearSide();
        }
        this.changed();
    }
    activate(side, holdSeconds) {
        this.side = side; this.neutralPending = false;
        this.minUntil = Date.now() + Math.max(1000, Number(holdSeconds || 3.5) * 1000);
        clearTimeout(this.timer); this.timer = null;
    }
    scheduleClear(ms) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { if (this.neutralPending && Date.now() >= this.minUntil) { this.clearSide(); this.changed(); } }, Math.max(10, ms + 20));
    }
    clearSide() { clearTimeout(this.timer); this.timer = null; this.side = 0; this.neutralPending = false; }
    clear() {
        this.values = { neutral: null, left: null, right: null }; this.armSide = null; this.clearSide(); this.save();
        this.message = 'Calibration cleared'; this.changed();
    }
    status() {
        const yes = (x) => this.values[x] ? 'learned' : 'missing';
        return (this.message ? this.message + '\n' : '') + 'Neutral ' + yes('neutral') + ' | Left ' + yes('left') + ' | Right ' + yes('right') +
            ' | Current ' + (this.side < 0 ? 'LEFT' : this.side > 0 ? 'RIGHT' : 'neutral / unknown') +
            ' | Raw ' + (this.current === null ? 'waiting' : this.current);
    }
    close() { clearTimeout(this.timer); clearTimeout(this.armTimer); }
}

module.exports = { stalkSignature, TurnLearner };
