'use strict';
const fs = require('fs');
const file = process.env.REMOTE_TELEMETRY_STATUS || '/run/remote-telemetry-bridge/status.json';
const timeout = Number(process.env.REMOTE_TELEMETRY_CHECK_MS || 15000);
const deadline = Date.now() + (isFinite(timeout) && timeout >= 0 ? timeout : 15000);

function check() {
    try {
        const status = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!status.startedAt) throw new Error('missing startedAt');
        if (status.phase === 'failed') throw new Error(status.error || 'service startup failed');
        if (status.phase !== 'running') throw new Error('service is ' + (status.phase || 'starting'));
        process.stdout.write('remote telemetry bridge: ' + (status.configured ? 'configured' : 'running; waiting for configuration') + '\n');
        return;
    } catch (e) {
        if (Date.now() < deadline) { setTimeout(check, 250); return; }
        process.stderr.write('remote telemetry bridge check: ' + e.message + '\n');
        process.exit(1);
    }
}

check();
