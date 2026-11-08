'use strict';
const fs = require('fs');
const file = '/run/remote-telemetry-bridge/status.json';
try {
    const status = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!status.startedAt) throw new Error('missing startedAt');
    process.stdout.write('remote telemetry bridge: ' + (status.configured ? 'configured' : 'waiting for configuration') + '\n');
} catch (e) {
    process.stderr.write('remote telemetry bridge check: ' + e.message + '\n');
    process.exit(1);
}
