'use strict';
const net = require('net');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');

const SOCKET = '/run/waze-hud-control/control.sock';
const W = 1600, H = 520;
const FIELDS = ['map width', 'map height', 'horizontal position', 'vertical position'];
const PRESETS = [
    { name:'Fill', geometry:{ canvasW:1000, canvasH:600, x:0, y:0, w:1000, h:600, fit:'fill' } },
    { name:'Balanced', geometry:{ canvasW:1000, canvasH:600, x:0, y:39, w:1000, h:522, fit:'balanced' } },
    { name:'Natural perspective', geometry:{ canvasW:1000, canvasH:600, x:0, y:80, w:1000, h:441, fit:'natural' } },
    { name:'Legacy', geometry:{ canvasW:800, canvasH:600, x:0, y:0, w:800, h:600, fit:'fill' } }
];

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function clamp(value, low, high) { return Math.max(low, Math.min(high, Math.round(value))); }
function normalize(value) {
    const g = copy(value || PRESETS[0].geometry);
    g.canvasW = clamp(Number(g.canvasW) || 1000, 640, 1400);
    g.canvasH = clamp(Number(g.canvasH) || 600, 400, 800);
    g.w = clamp(Number(g.w) || g.canvasW, 320, g.canvasW);
    g.h = clamp(Number(g.h) || g.canvasH, 200, g.canvasH);
    g.x = clamp(Number(g.x) || 0, 0, g.canvasW - g.w);
    g.y = clamp(Number(g.y) || 0, 0, g.canvasH - g.h);
    g.fit = String(g.fit || 'custom');
    return g;
}

mgu.run({
    async start(ctx) {
        const { ui } = ctx;
        let status = 'Ready';
        let target = 'hud';
        let state = 'idle';
        let presetIndex = 0;
        let fieldIndex = 0;
        let geometry = copy(PRESETS[0].geometry);
        let applied = copy(geometry);

        function send(cmd, wanted, requestedGeometry) {
            target = wanted || target;
            if (cmd !== 'status') { state = 'starting'; status = target === 'hud' ? 'Applying HUD geometry' : 'Returning Waze to the cluster'; }
            return new Promise((resolve) => {
                let sock = null, timer = null, done = false, buf = '';
                const finish = (msg) => {
                    if (done) return;
                    done = true;
                    if (timer) clearTimeout(timer);
                    if (msg) {
                        state = msg.state || state;
                        target = msg.target || target;
                        status = msg.text || status;
                        if (msg.geometry) { geometry = normalize(msg.geometry); applied = copy(geometry); }
                    }
                    try { if (sock) sock.end(); } catch (_) {}
                    resolve(msg || {});
                };
                try {
                    sock = net.connect(SOCKET);
                    sock.setEncoding('utf8');
                    sock.on('connect', () => {
                        try { sock.write(JSON.stringify({ cmd, target, geometry:requestedGeometry }) + '\n'); }
                        catch (error) { finish({ state:'error', text:'Could not send display request: ' + (error.code || error.message) }); }
                    });
                    sock.on('data', (chunk) => {
                        buf += chunk;
                        const lines = buf.split('\n'); buf = lines.pop();
                        lines.forEach((line) => { try { const msg = JSON.parse(line); if (msg.ev === 'status') finish(msg); } catch (_) {} });
                    });
                    sock.on('error', (error) => finish({ state:'error', text:'Waze renderer unavailable: ' + (error.code || error.message) }));
                    timer = setTimeout(() => finish({ state:'error', text:'Waze renderer did not answer' }), 15000);
                } catch (error) {
                    finish({ state:'error', text:'Waze renderer unavailable: ' + (error.code || error.message) });
                }
            });
        }

        function choosePreset() {
            presetIndex = (presetIndex + 1) % PRESETS.length;
            geometry = copy(PRESETS[presetIndex].geometry);
            status = PRESETS[presetIndex].name + ' selected - press Project on HUD to apply';
            state = 'pending';
        }
        function adjust(direction) {
            const field = FIELDS[fieldIndex];
            if (field === 'map width') geometry.w = clamp(geometry.w + direction * 20, 320, geometry.canvasW);
            else if (field === 'map height') geometry.h = clamp(geometry.h + direction * 20, 200, geometry.canvasH);
            else if (field === 'horizontal position') geometry.x = clamp(geometry.x + direction * 10, 0, geometry.canvasW - geometry.w);
            else geometry.y = clamp(geometry.y + direction * 10, 0, geometry.canvasH - geometry.h);
            geometry.x = clamp(geometry.x, 0, geometry.canvasW - geometry.w);
            geometry.y = clamp(geometry.y, 0, geometry.canvasH - geometry.h);
            geometry.fit = 'custom';
            status = 'Preview changed - press Project on HUD to apply';
            state = 'pending';
        }
        function centre() {
            geometry.x = Math.round((geometry.canvasW - geometry.w) / 2);
            geometry.y = Math.round((geometry.canvasH - geometry.h) / 2);
            geometry.fit = 'custom'; state = 'pending';
            status = 'Map centred - press Project on HUD to apply';
        }
        function sameGeometry(a, b) {
            return ['canvasW','canvasH','x','y','w','h'].every((key) => a[key] === b[key]);
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            const accent = target === 'hud' ? '#4aafff' : '#ff4b55';
            G.panel(cv, t, 34, 54, 1000, 430, 'HUD geometry preview');
            const bx = 100, by = 103, bw = 870, bh = 330;
            cv.roundRect(bx, by, bw, bh, 18, '#0a1019');
            cv.strokeRoundRect(bx, by, bw, bh, 18, 3, withAlpha('#d9efff', 0.55));
            const scale = Math.min(bw / geometry.canvasW, bh / geometry.canvasH);
            const cw = geometry.canvasW * scale, ch = geometry.canvasH * scale;
            const cx = bx + (bw - cw) / 2, cy = by + (bh - ch) / 2;
            cv.fillRect(cx, cy, cw, ch, '#101a27');
            const rx = cx + geometry.x * scale, ry = cy + geometry.y * scale;
            const rw = geometry.w * scale, rh = geometry.h * scale;
            cv.roundRect(rx, ry, rw, rh, 10, '#0c3038');
            for (let i = 0; i < 6; i++) cv.line(rx + 12, ry + 18 + i * rh / 7, rx + rw - 12, ry + 5 + i * rh / 7, 3, withAlpha('#8fbec8', 0.42));
            cv.polyline([[rx+rw*.10,ry+rh*.83],[rx+rw*.27,ry+rh*.69],[rx+rw*.43,ry+rh*.72],[rx+rw*.60,ry+rh*.48],[rx+rw*.77,ry+rh*.43],[rx+rw*.91,ry+rh*.18]], 10, '#36bfff');
            cv.strokeRoundRect(rx, ry, rw, rh, 10, 3, '#36bfff');
            G.pill(cv, t, bx + 22, by + 18, geometry.canvasW + ' x ' + geometry.canvasH + ' CANVAS', '#4aafff');
            G.pill(cv, t, bx + 270, by + 18, geometry.w + ' x ' + geometry.h + ' MAP AT ' + geometry.x + ',' + geometry.y, '#69ed9a');
            cv.text(geometry.fit === 'natural' ? 'SOURCE ASPECT PRESERVED' : geometry.fit === 'balanced' ? 'BALANCED PERSPECTIVE' : geometry.fit === 'fill' ? 'FILL CANVAS' : 'CUSTOM GEOMETRY', bx + bw / 2, by + bh - 18, 20, t.text, { align:'center', font:'bold' });

            G.panel(cv, t, 1060, 54, 506, 270, 'Display calibration');
            cv.text('Selected', 1094, 110, 18, t.dim);
            cv.text(FIELDS[fieldIndex].toUpperCase(), 1094, 145, 27, '#ffbf4a', { font:'bold' });
            const values = [
                ['Canvas', geometry.canvasW + ' x ' + geometry.canvasH],
                ['Map', geometry.w + ' x ' + geometry.h],
                ['Position', geometry.x + ', ' + geometry.y]
            ];
            values.forEach((row, i) => { cv.text(row[0], 1094, 195 + i * 38, 19, t.dim); cv.text(row[1], 1288, 197 + i * 38, 24, t.text, { font:'num' }); });
            G.panel(cv, t, 1060, 344, 506, 140, 'Projection status');
            const dirty = !sameGeometry(geometry, applied);
            const col = state === 'running' ? '#69ed9a' : state === 'error' ? t.crit : dirty || state === 'pending' ? '#ffbf4a' : t.text;
            cv.circle(1094, 398, 7, col);
            cv.text(dirty ? 'PREVIEW - APPLY HUD' : state.toUpperCase(), 1116, 407, 24, col, { font:'bold' });
            cv.text(status, 1094, 449, 18, t.text, { maxWidth:435 });
            G.frame(cv, t, ['Projection', 'Calibration'], 1, [{ text:'FULL SCREEN', color:'#4aafff' }, { text:'1000 x 600', color:'#69ed9a' }]);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('SHOW_HUD', () => send('start', 'hud', geometry));
        ui.onClick('SHOW_MAP', () => send('start', 'map', geometry));
        ui.onClick('PRESET_NEXT', choosePreset);
        ui.onClick('FIELD_NEXT', () => { fieldIndex = (fieldIndex + 1) % FIELDS.length; status = 'Adjusting ' + FIELDS[fieldIndex]; });
        ui.onClick('VALUE_MINUS', () => adjust(-1));
        ui.onClick('VALUE_PLUS', () => adjust(1));
        ui.onClick('CENTER', centre);
        ui.onClick('REFRESH', () => send('status', target));
        ui.onVisible((name, on) => { if (name === 'MAIN' && on) send('status', target); });
        ctx.loop('MAIN', 60, render);
    }
});
