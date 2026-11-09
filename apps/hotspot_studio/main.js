'use strict';

const net = require('net');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const ParkGuard = require('./guard');

const W = 1600, H = 520;
const PAGES = ['Internet', 'Clients', 'Coding', 'Details'];
const C = { green:'#34d987', cyan:'#27d8ff', blue:'#4c8dff', amber:'#ffb52e', red:'#ff4b55' };
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
const short = (v, n) => { const s = String(v || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

mgu.run({ async start(ctx) {
    const socketPath = (ctx.spec.config && ctx.spec.config.socket) || '/run/hotspot-studio/control.sock';
    const guard = new ParkGuard(ctx.signals, ctx.log);
    let page = 0, state = null, selected = 0, notice = '', busy = false, polling = false, visible = true, lastPoll = 0;
    let hits = [];

    function send(message) {
        return new Promise((resolve, reject) => {
            let sock, buffer = '', done = false;
            const timer = setTimeout(() => finish(new Error('Hotspot helper did not answer')), 4000);
            function finish(error, value) {
                if (done) return; done = true; clearTimeout(timer);
                try { if (sock) sock.end(); } catch (_) {}
                if (error) reject(error); else resolve(value);
            }
            try {
                sock = net.connect(socketPath);
                sock.setEncoding('utf8');
                sock.on('connect', () => sock.write(JSON.stringify(message) + '\n'));
                sock.on('data', (chunk) => {
                    buffer += chunk;
                    if (buffer.indexOf('\n') < 0) return;
                    try {
                        const reply = JSON.parse(buffer.split('\n')[0]);
                        if (!reply.ok) finish(new Error(reply.error || 'Hotspot request failed'));
                        else finish(null, reply.state);
                    } catch (e) { finish(e); }
                });
                sock.on('error', (e) => finish(new Error('Hotspot helper unavailable: ' + (e.code || e.message))));
            } catch (e) { finish(e); }
        });
    }

    async function request(message, success) {
        if (busy) return;
        busy = true; notice = 'Working…';
        try { state = await send(message); notice = success || 'Done'; }
        catch (e) { notice = e.message; ctx.log.warn(e.message); }
        finally { busy = false; lastPoll = Date.now(); }
    }
    async function poll() {
        if (busy || polling) return;
        polling = true;
        try { state = await send({ action:'status' }); notice = state.error || ''; }
        catch (e) { notice = e.message; }
        finally { lastPoll = Date.now(); polling = false; }
    }
    const clients = () => state && state.hotspot && state.hotspot.clients || [];
    const selectedClient = () => { const list = clients(); if (!list.length) return null; selected %= list.length; return list[selected]; };
    const mode = () => state && state.mode || 'off';
    const modeColor = () => mode() === 'coding' ? C.amber : mode() === 'internet' ? C.green : C.red;

    function button(cv, x, y, w, h, label, fn, color, active) {
        cv.roundRect(x, y, w, h, 9, active ? color : withAlpha(color, 0.13));
        cv.text(label, x + w / 2, y + h / 2 + 9, 24, active ? '#0b1119' : color, { align:'center', font:'bold' });
        hits.push({ x, y, w, h, fn });
    }
    function field(cv, t, x, y, w, label, value, color, detail) {
        cv.roundRect(x, y, w, 145, 10, withAlpha(color, 0.08)); cv.fillRect(x, y, 5, 145, color);
        cv.text(label.toUpperCase(), x + 20, y + 33, 17, t.dim, { font:'bold' });
        cv.text(short(value || '--', 30), x + 20, y + 83, 34, color, { font:'bold' });
        cv.text(short(detail || '', 44), x + 20, y + 121, 18, t.dim);
    }
    function internetPage(cv, t) {
        const up = state && state.uplink || {}, hot = state && state.hotspot || {};
        cv.text('BMW hotspot Internet and ENET gateway', 34, 87, 34, t.text, { font:'bold' });
        cv.text('Huawei Internet uses explicit proxies; Coding Gateway relays one client to ENET.', 34, 119, 20, t.dim);
        field(cv, t, 32, 143, 500, 'LTE uplink', up.state === 'online' ? 'ONLINE' : String(up.state || 'OFFLINE').toUpperCase(),
            up.state === 'online' ? C.green : C.amber, (up.interface || 'no interface') + '  •  ' + (up.address || 'no lease'));
        field(cv, t, 550, 143, 500, 'BMW hotspot', hot.interface ? 'READY' : 'NOT FOUND', hot.interface ? C.cyan : C.amber,
            (hot.interface || 'turn hotspot on') + '  •  ' + (hot.network || 'waiting for network'));
        field(cv, t, 1068, 143, 500, 'Sharing mode', mode().toUpperCase(), modeColor(), clients().length + ' connected client' + (clients().length === 1 ? '' : 's'));
        button(cv, 32, 326, 752, 75, 'Start Internet gateway', () => request({action:'internet',enabled:true}, 'Internet gateway enabled'), C.green, mode() !== 'off');
        button(cv, 816, 326, 752, 75, 'Stop all sharing', () => request({action:'off'}, 'All sharing stopped'), C.red, mode() === 'off');
        const proxy = state && state.proxy || {};
        const ready = 'HTTP ' + (proxy.address || hot.address || '--') + ':' + (proxy.httpPort || 3128) +
            '  •  SOCKS5 :' + (proxy.socksPort || 1088);
        cv.text(state && state.error ? short(clean(state.error), 116) : ready, 34, 453, 22,
            state && state.error ? C.red : t.dim, { font:state && state.error ? 'bold' : undefined });
    }
    function clientsPage(cv, t) {
        const list = clients();
        cv.text('BMW hotspot clients', 34, 87, 34, t.text, { font:'bold' });
        cv.text('Select the one laptop allowed to reach the ZGW during a Coding Gateway session.', 34, 119, 20, t.dim);
        if (!list.length) {
            G.panel(cv, t, 32, 143, 1536, 280, 'No clients detected');
            cv.text('Join the BMW built-in hotspot from the coding laptop, then press Refresh.', 64, 232, 29, C.amber, { font:'bold' });
            cv.text('The helper identifies clients from the hotspot interface neighbour table.', 64, 284, 22, t.dim);
        } else {
            list.slice(0, 5).forEach((peer, i) => {
                const y = 143 + i * 60, chosen = i === selected;
                cv.roundRect(32, y, 1536, 52, 8, chosen ? withAlpha(C.blue, 0.24) : withAlpha(t.text, 0.04));
                cv.fillRect(32, y, 6, 52, chosen ? C.blue : t.edge);
                cv.text(chosen ? 'SELECTED' : 'CLIENT ' + (i + 1), 58, y + 33, 18, chosen ? C.blue : t.dim, { font:'bold' });
                cv.text(peer.ip, 300, y + 34, 25, t.text, { font:'bold' });
                cv.text(peer.mac || '--', 770, y + 33, 21, t.dim);
                cv.text(peer.interface || '--', 1518, y + 33, 20, t.dim, { align:'right' });
                hits.push({ x:32, y, w:1536, h:52, fn:()=>{ selected=i; } });
            });
        }
        button(cv, 32, 456, 1536, 52, 'Select next client', () => { if (list.length) selected = (selected + 1) % list.length; }, C.blue, false);
    }
    function codingPage(cv, t) {
        const peer = selectedClient(), coding = state && state.coding;
        const remaining = coding ? Math.max(0, Math.ceil((coding.expiresAt - Date.now() / 1000) / 60)) : 0;
        cv.text('Guarded Coding Gateway', 34, 87, 34, t.text, { font:'bold' });
        cv.text('One hotspot client receives ENET discovery and TCP/6801 relay. The session closes automatically.', 34, 119, 20, t.dim);
        G.panel(cv, t, 32, 143, 745, 260, 'Authorized client');
        cv.text(peer ? peer.ip : 'No client selected', 60, 224, 42, peer ? C.cyan : C.amber, { font:'bold' });
        cv.text(peer ? peer.mac : 'Connect the laptop to BMW hotspot', 60, 266, 22, t.dim);
        cv.text(guard.status, 60, 335, 24, guard.parked ? C.green : C.amber, { font:'bold' });
        G.panel(cv, t, 793, 143, 775, 260, 'Vehicle gateway');
        const proxy = state && state.proxy || {}, hot = state && state.hotspot || {};
        cv.text(proxy.address || hot.address || '--', 821, 224, 42, C.blue, { font:'bold' });
        cv.text('ISTA/E-Sys target  •  vehicle ZGW ' + (state && state.vehicle && state.vehicle.zgw || '--'), 821, 266, 22, t.dim);
        cv.text(coding ? 'ACTIVE  •  ' + remaining + ' min remaining' : 'CLOSED', 821, 335, 27, coding ? C.amber : C.green, { font:'bold' });
        if (coding) button(cv, 32, 426, 1536, 72, 'Close Coding Gateway now', () => request({action:'coding-off'}, 'Coding Gateway closed'), C.red, true);
        else button(cv, 32, 426, 1536, 72, 'Open for ' + ctx.settings.display('codingMinutes'), () => {
            if (!guard.parked) { notice = guard.status; return; }
            if (!peer) { notice = 'Select a connected hotspot client'; return; }
            request({action:'coding',client:peer.ip,minutes:Number(ctx.settings.get('codingMinutes')),parked:true}, 'Coding Gateway opened');
        }, C.amber, false);
    }
    function detailsPage(cv, t) {
        const up = state && state.uplink || {}, hot = state && state.hotspot || {}, veh = state && state.vehicle || {};
        cv.text('Connection details', 34, 87, 34, t.text, { font:'bold' });
        const rows = [
            ['LTE uplink', up.interface || '--', up.address || '--', up.device || up.state || '--'],
            ['BMW hotspot', hot.interface || '--', hot.address || '--', hot.network || '--'],
            ['Vehicle ENET', veh.interface || '--', veh.source || '--', 'ZGW ' + (veh.zgw || '--')],
            ['Internet proxy', (state && state.proxy && state.proxy.address || '--') + ':' + (state && state.proxy && state.proxy.httpPort || 3128),
                'SOCKS5 :' + (state && state.proxy && state.proxy.socksPort || 1088), state && state.rulesActive ? 'ACTIVE' : 'INACTIVE']
        ];
        G.table(cv, t, 32, 130, 1536,
            [{label:'Path',w:280},{label:'Interface / state',w:350},{label:'Address',w:390},{label:'Detail',w:516}],
            rows, {rowH:66,size:22,empty:'Waiting for helper'});
        cv.text('Coding target: ' + (state && state.proxy && state.proxy.address || '--') + '. Discovery and TCP/6801 are relayed only for the selected client.', 34, 449, 21, C.amber, { font:'bold' });
        cv.text('No ECU is recoded. No kernel forwarding, bridge or NAT rule is used.', 34, 487, 20, t.dim);
    }
    async function render() {
        if (visible && Date.now() - lastPoll > 1000) poll();
        const t = ctx.theme(), cv = ctx.canvas(W,H).clear(t.bg); hits = [];
        [internetPage, clientsPage, codingPage, detailsPage][page](cv,t);
        G.frame(cv,t,PAGES,page,[{text:mode().toUpperCase(),color:modeColor()},{text:'60 FPS',color:C.cyan}]);
        if (notice) cv.text(short(clean(notice), 116), 1565, 505, 17, notice.indexOf('enabled') >= 0 || notice === 'Done' ? C.green : C.amber, {align:'right'});
        await ctx.ui.image('MAIN_GFX',cv);
    }
    function nextClient() { const list=clients(); if(list.length) selected=(selected+1)%list.length; }
    function primary() {
        if (page === 0) request(mode()==='off'?{action:'internet',enabled:true}:{action:'off'});
        else if (page === 1) nextClient();
        else if (page === 2) {
            if (state && state.coding) request({action:'coding-off'});
            else {
                const peer=selectedClient();
                if(!guard.parked) notice=guard.status;
                else if(!peer) notice='Select a connected hotspot client';
                else request({action:'coding',client:peer.ip,minutes:Number(ctx.settings.get('codingMinutes')),parked:true});
            }
        } else poll();
    }
    ctx.ui.onClick('BTN_PAGE',()=>{page=(page+1)%PAGES.length;});
    ctx.ui.onClick('BTN_ACTION',primary);
    ctx.ui.onClick('BTN_CLIENT',nextClient);
    ctx.ui.onClick('BTN_REFRESH',poll);
    ctx.onTab((i)=>{page=i;});
    ctx.onTap((x,y)=>{const hit=hits.find((h)=>x>=h.x&&x<h.x+h.w&&y>=h.y&&y<h.y+h.h);if(hit)hit.fn();});
    ctx.ui.onVisible((name,on)=>{if(name==='MAIN'){visible=on;if(on)poll();}});
    ctx.loop('MAIN',60,render);
    await guard.init();
    await poll();
} });
