'use strict';

/* BMW's generator is loaded from the head unit at install/start time. */
const fs = require('fs');
const path = require('path');
const APPMGMT = '/usr/lib/oap-mainapp/src/AppManagement/AppManagement.js';

function loadFromFirmware(name) {
    const text = fs.readFileSync(APPMGMT, 'utf8');
    const match = new RegExp('"someip-interfaces-generator/' + name + '(?:\\.js)?":(\\d+)').exec(text);
    if (!match) throw new Error(name + ' not found in ' + APPMGMT);
    const tail = /,\{\},\[\d+\]\)\s*;?\s*$/;
    if (!tail.test(text)) throw new Error('unexpected AppManagement bundle format');
    const bundleRequire = new Function('require', 'return ' + text.replace(tail, ',{},[])'))(require);
    return bundleRequire(match[1]);
}

function main() {
    const root = __dirname;
    const out = process.argv[2];
    if (!out) throw new Error('output directory required');
    const db = JSON.parse(fs.readFileSync('/etc/oap/someip/someip-interfaces.json', 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'someip-manifest.json'), 'utf8'));
    if (!fs.existsSync(out)) fs.mkdirSync(out);
    const generator = loadFromFirmware('IFConfigGenerator');
    const generated = [];
    const errors = {};
    Object.keys(manifest.proxies || {}).forEach((id) => {
        try {
            const one = {proxies:{}, providers:{}};
            one.proxies[id] = manifest.proxies[id];
            const configs = generator.generate(db, one);
            Object.keys(configs).forEach((configId) => {
                fs.writeFileSync(path.join(out, configId.replace(/\./g, '_') + '.json'), JSON.stringify(configs[configId]));
                generated.push(configId);
            });
        } catch (e) {
            errors[id] = e.message;
            process.stderr.write('skipping unsupported telemetry interface ' + id + ': ' + e.message + '\n');
        }
    });
    fs.writeFileSync(path.join(out, 'generation-status.json'), JSON.stringify({generated:generated, errors:errors}, null, 2));
    if (!generated.length) throw new Error('none of the telemetry interfaces could be generated');
    process.stdout.write('generated ' + generated.length + ' telemetry interface configs\n');
}

if (require.main === module) {
    try { main(); } catch (e) { process.stderr.write('remote telemetry config: ' + e.message + '\n'); process.exit(1); }
}
