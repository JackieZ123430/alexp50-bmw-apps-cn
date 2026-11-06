'use strict';

const fs = require('fs');
const path = require('path');
const CORNERS = ['Front left', 'Front right', 'Rear left', 'Rear right'];
const MIN_HEIGHT = 400;
const MAX_HEIGHT = 900;
const MIN_DELTA = 0;
const MAX_DELTA = 40;

class HeightPlan {
    constructor(dataDir) {
        this.file = path.join(dataDir, 'ride-height-plan.json');
        this.baselines = CORNERS.map(() => null);
        this.selected = 0;
        this.delta = 0; // Session-only: the requested change resets after an app or car restart.
        try {
            const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (Array.isArray(saved.baselines) && saved.baselines.length === 4) {
                this.baselines = saved.baselines.map(HeightPlan.validHeight);
            } else if (Array.isArray(saved.corners) && saved.corners.length === 4) {
                // Migrate the old measurement planner. Its calibration-entry offsets are not height targets.
                this.baselines = saved.corners.map((corner) => HeightPlan.validHeight(corner.measured));
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }

    static validHeight(value) {
        return Number.isInteger(value) && value >= MIN_HEIGHT && value <= MAX_HEIGHT ? value : null;
    }

    save() {
        const pending = this.file + '.tmp';
        fs.writeFileSync(pending, JSON.stringify({ baselines: this.baselines }, null, 2));
        fs.renameSync(pending, this.file);
    }

    select() { this.selected = (this.selected + 1) % 4; }

    setMeasured(value) {
        if (HeightPlan.validHeight(value) === null) throw new Error('Measurement must be 400–900 mm');
        this.baselines[this.selected] = value;
        this.save();
    }

    measure(delta) {
        const current = this.baselines[this.selected];
        const next = (current === null ? 600 : current) + delta;
        this.setMeasured(next);
    }

    clear() {
        this.baselines[this.selected] = null;
        this.save();
    }

    setDelta(delta) {
        if (!Number.isInteger(delta) || delta < MIN_DELTA || delta > MAX_DELTA) {
            throw new Error('Preview range: 0 to +40 mm from baseline');
        }
        this.delta = delta;
    }

    adjustDelta(step) { this.setDelta(this.delta + step); }

    summary() {
        return CORNERS.map((corner, index) => {
            const mark = index === this.selected ? '> ' : '  ';
            const baseline = this.baselines[index];
            if (baseline === null) return mark + corner + ': enter current physical height';
            const target = baseline + this.delta;
            return mark + corner + ': ' + baseline + ' mm now → ' + target + ' mm target';
        }).join('\n');
    }

    get complete() { return this.baselines.every((value) => value !== null); }
}

module.exports = { HeightPlan, CORNERS, MIN_DELTA, MAX_DELTA };
