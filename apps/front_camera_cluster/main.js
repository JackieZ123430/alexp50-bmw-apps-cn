'use strict';
const net = require('net');
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');

const SOCKET = '/run/front-camera-cluster/control.sock';
const W = 1600, H = 520;
const MAX_SPEED = 15;

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        const car = new Car(ctx, ['speed']);
        let status = 'Ready';
        let state = 'stopped';
        let source = 'night';
        let detail = 'Select Night Vision or the parking camera';
        let lastStop = 0;

        const speed = () => car.data().speed;
        function send(cmd, wantedSource) {
            return new Promise((resolve) => {
                let sock = null, timer = null;
                let buf = '', done = false;
                const finish = (reply) => {
                    if (done) return;
                    done = true;
                    if (timer) clearTimeout(timer);
                    if (reply) {
                        state = reply.state || state;
                        source = reply.source || source;
                        status = reply.text || reply.state || status;
                        detail = reply.detail || detail;
                    }
                    try { if (sock) sock.end(); } catch (_) {}
                    resolve(reply || {});
                };
                try {
                    sock = net.connect(SOCKET);
                    sock.setEncoding('utf8');
                    sock.on('connect', () => {
                        try { sock.write(JSON.stringify({ cmd, source: wantedSource }) + '\n'); }
                        catch (e) { finish({ state:'error', text:'Could not send camera request', detail:e.code || e.message }); }
                    });
                    sock.on('data', (chunk) => {
                        buf += chunk;
                        const lines = buf.split('\n'); buf = lines.pop();
                        lines.forEach((line) => {
                            try { const msg = JSON.parse(line); if (msg.ev === 'status') finish(msg); } catch (_) {}
                        });
                    });
                    sock.on('error', (e) => finish({ state:'error', text:'Native camera service unavailable', detail:e.code || e.message }));
                    timer = setTimeout(() => finish({ state:'error', text:'Native camera service did not answer', detail:'Check the helper service after installation' }), 3500);
                } catch (e) {
                    finish({ state:'error', text:'Native camera service unavailable', detail:e.code || e.message });
                }
            });
        }

        function request(wanted) {
            const v = speed();
            if (typeof v !== 'number') {
                state = 'error'; status = 'Projection refused'; detail = 'No live vehicle-speed signal'; return;
            }
            if (v > MAX_SPEED) {
                state = 'error'; status = 'Projection refused above ' + MAX_SPEED + ' km/h'; detail = 'Stop the car before starting a camera feed'; return;
            }
            source = wanted; state = 'starting';
            status = wanted === 'night' ? 'Night Vision armed' : 'Parking camera armed';
            detail = wanted === 'night'
                ? 'The cluster is ready. Press the physical Night Vision button if the feed is not already active.'
                : 'The cluster is ready. Press the physical parking-camera button if the feed is not already active.';
            // Keep the app visible so the native helper's result remains visible.
            send('start', wanted);
        }

        function cameraGraphic(cv, t) {
            const active = state === 'running', waiting = state === 'waiting' || state === 'starting';
            const accent = source === 'night' ? '#ffd75a' : '#4aafff';
            const x = 66, y = 80, w = 760, h = 390;
            cv.roundRect(x, y, w, h, 20, '#080b10');
            cv.strokeRoundRect(x, y, w, h, 20, 3, active ? accent : withAlpha(accent, 0.55));
            // thermal horizon and road
            cv.fillRect(x + 3, y + 3, w - 6, 155, source === 'night' ? '#11100c' : '#101923');
            for (let i = 0; i < 7; i++) {
                const yy = y + 170 + i * 31;
                const half = 62 + i * 35;
                cv.line(x + w / 2 - half, yy, x + w / 2 - half - 12, yy + 25, 3, withAlpha(accent, 0.42));
                cv.line(x + w / 2 + half, yy, x + w / 2 + half + 12, yy + 25, 3, withAlpha(accent, 0.42));
            }
            if (source === 'night') {
                // bright thermal silhouettes
                [[250,128,30],[484,105,24],[606,142,19]].forEach((p, i) => {
                    cv.circle(x + p[0], y + p[1], p[2] / 2, '#fff6bd');
                    cv.roundRect(x + p[0] - p[2] / 2, y + p[1] + p[2] / 2, p[2], 68 - i * 8, 10, '#ffcf4b');
                });
            } else {
                [0,1,2,3,4].forEach((i) => cv.arc(x + w / 2, y + 315, 90 + i * 42, 95 + i * 42, 292, 428, withAlpha(accent, 0.9 - i * 0.12)));
            }
            G.pill(cv, t, x + 22, y + 20, source === 'night' ? 'BMW NIGHT VISION' : 'BMW PARKING CAMERA', accent);
            cv.text(active ? 'LIVE IN CLUSTER' : waiting ? 'WAITING FOR NATIVE FEED' : 'READY', x + 28, y + h - 28, 26,
                active ? '#69ed9a' : waiting ? '#ffbf4a' : t.dim, { font:'bold' });
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            cameraGraphic(cv, t);
            G.panel(cv, t, 856, 54, 720, 220, 'Projection status');
            const stateColor = state === 'running' ? '#69ed9a' : state === 'error' ? t.crit : state === 'waiting' || state === 'starting' ? t.warn : t.text;
            cv.text(status, 892, 132, 38, stateColor, { font:'bold' });
            cv.text(detail, 892, 176, 22, t.text, { maxWidth:640 });
            const v = speed();
            cv.text('Vehicle speed', 892, 244, 18, t.dim);
            cv.text(typeof v === 'number' ? v.toFixed(1) + ' km/h' : '--', 1088, 246, 27, t.text, { font:'num' });
            G.panel(cv, t, 856, 294, 720, 190, 'Native sources');
            const rows = [
                ['Night Vision', 'Thermal camera · default'],
                ['Parking camera', 'BMW protected camera surface'],
                ['Safety limit', 'Start below ' + MAX_SPEED + ' km/h · automatic stop above limit']
            ];
            rows.forEach((r, i) => {
                cv.circle(886, 342 + i * 47, 5, i === 0 ? '#ffd75a' : i === 1 ? '#4aafff' : t.dim);
                cv.text(r[0], 904, 350 + i * 47, 21, t.text, { font:'bold' });
                cv.text(r[1], 1115, 350 + i * 47, 19, t.dim);
            });
            G.frame(cv, t, ['Camera'], 0, [{ text:'FULL SCREEN', color:'#4aafff' }, { text:'60 FPS UI', color:'#69ed9a' }]);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_NIGHT', () => request('night'));
        ui.onClick('BTN_PARK', () => request('parking'));
        ui.onClick('BTN_STOP', () => send('stop', source));
        ui.onClick('BTN_REFRESH', () => send('status', source));
        car.onSample(() => {
            const v = speed();
            if (typeof v === 'number' && v > MAX_SPEED && Date.now() - lastStop > 3000) {
                lastStop = Date.now(); send('stop', source);
            }
        });
        ui.onVisible((name, on) => { if (name === 'MAIN' && on) send('status', source); });
        ctx.loop('MAIN', 60, render);
    }
});
