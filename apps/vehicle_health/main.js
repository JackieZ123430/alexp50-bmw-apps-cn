'use strict';

/** Vehicle Health Center - read-only health summary. */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Diag, parseDtcReply, replyTo } = require('./kit/diag');
const { withAlpha } = require('./kit/canvas');
const { decodeDid, tyreP, tyreT, tempC } = require('./logic');

const W = 1600, H = 520, PAGES = ['Summary', 'Tyres', 'Service', 'Faults'];
const GREEN = '#2fd27a', BLUE = '#4aafff', AMBER = '#ffb52e', RED = '#ff4b55';
const finite = (n) => typeof n === 'number' && isFinite(n);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const walk = (v, fn) => { if (!v || typeof v !== 'object') return; if (Array.isArray(v)) return v.forEach((x) => walk(x, fn)); fn(v); Object.keys(v).forEach((k) => walk(v[k], fn)); };
const find = (v, key) => { let got = null; walk(v, (o) => { if (!got && Object.prototype.hasOwnProperty.call(o, key)) got = o; }); return got; };
const text = (s) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, '').trim();
const oilLevel = (x) => ({
    MOTOROELSTAND_UNTER_MINIMUM: 'Below minimum', MOTOROELSTAND_AM_MINIMUM: 'At minimum', MOTOROELSTAND_1_4: '1/4',
    MOTOROELSTAND_2_4: '2/4', MOTOROELSTAND_3_4: '3/4', MOTOROELSTAND_4_4: 'Full', MOTOROELSTAND_5_4: 'Above full',
    MOTOROELSTAND_UEBERFUELLT: 'Overfilled', MOTOROELSTAND_OK: 'OK', SERVICEFUNKTION_AKTIV: 'Measuring',
    0: 'Below minimum', 1: 'At minimum', 2: '1/4', 3: '2/4', 4: '3/4', 5: 'Full', 6: 'Above full', 7: 'Overfilled', 13: 'OK', 14: 'Measuring'
})[x] || null;
const DPF_VARIANTS = new Set(['0F1F70','0F1F80','0F1F90','0F1FA0','0F1FE8','0F1FF0','0F1FF4','0F1FF8','0F2670','0F2674','0F2678','0F267C']);

mgu.run({ async start(ctx) {
    const { ui, settings, log } = ctx;
    const state = {
        coolant: null, oilTemp: null, running: null, battery: null, oilLevel: null, speed: null, outside: null,
        tank: null, range: null, pressure: [null,null,null,null], target: [null,null,null,null], tyreTemp: [null,null,null,null],
        service: [], serviceSummary: null, checkControl: new Map(),
        dtc: { at: 0, units: 0, faults: 0, active: 0, pending: 0, error: '' },
        dpf: { variant: '', soot: null, ash: null, remaining: null, at: 0, error: '' }, signalAt: 0
    };
    let page = 0, visible = true, diag = null, diagReady = null, queue = Promise.resolve(), scanning = false, dpfBusy = false, opened = false;
    const touch = () => { state.signalAt = Date.now(); };

    await Promise.all([
        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
            statusEngineTemperature: (v) => { state.coolant = tempC(v && v.temperatureEngineDrive); state.oilTemp = tempC(v && v.temperatureEngineOilDrive); touch(); },
            statusEngineStatus: (v) => { state.running = v && v.statusEngineRunDrive; touch(); },
            statusBattery2: (v) => { const n = v && v.conditionBatteryChargingCondition; if (finite(n) && n <= 150) state.battery = n; touch(); }
        }, log),
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusOilDipstick2: (v) => { state.oilLevel = oilLevel(v && v.fluidLevelEngineOilRelative); touch(); },
            statusCarSpeed2: (v) => { const n = v && v.speedVehicleCentreOfGravity; if (finite(n) && n < 65535) state.speed = n * 0.015625; touch(); }
        }, log),
        ctx.signals.watch('de.bmw.infotainment.vehicle.TPMS', '1', {
            statusTyrePressure: (v) => { state.pressure = ['FLH','FRH','RLH','RRH'].map((k) => tyreP(v && v['actualValuePressureTyre' + k])); touch(); },
            statusTargetTyrePressure: (v) => { state.target = ['FLH','FRH','RLH','RRH'].map((k) => tyreP(v && v['targetPressureTyre' + k])); touch(); },
            statusTyreTemperature: (v) => { state.tyreTemp = ['FLH','FRH','RLH','RRH'].map((k) => tyreT(v && v['actualValueTemperatureTyre' + k])); touch(); }
        }, log, { pollMs: 500 }),
        ctx.signals.watch('de.bmw.infotainment.KombiIF', '1', { statusRangeTankStatus: (v) => {
            if (finite(v && v.fluidLevelFuelTank) && v.fluidLevelFuelTank < 255) state.tank = v.fluidLevelFuelTank;
            if (finite(v && v.range) && v.range < 4095) state.range = v.range; touch();
        } }, log, { pollMs: 1000 }),
        ctx.signals.watch('de.bmw.infrastructure.EnvironmentalInformation', '1', { ExteriorTemperature: (v) => {
            const n = v && v.temperatureExterior; if (finite(n) && n !== 255) state.outside = n * 0.5 - 40; touch();
        } }, log),
        ctx.signals.watch('de.bmw.infotainment.KombiInterface_2', '1', {
            cbsDataServiceList: (v) => {
                const arr = Array.isArray(v) ? v : (v && (v.cbsDataServiceList || v.value)) || [];
                state.service = arr.map((e) => { const s = find(e, 'cBSIdentifier') || {}; return {
                    id: s.cBSIdentifier, color: typeof s.cBSColor === 'number' ? s.cBSColor : ({ RED:1,YELLOW:2,GREEN:3,ORANGE:4 }[s.cBSColor] || 0),
                    name: text(s.cBSServcieName || s.cBSServiceName), distance: text(s.cBSServiceWay), date: text(s.cBSServiceDate)
                }; }).filter((x) => x.name); touch();
            },
            cbsDataSBA: (v) => { const s = find(v, 'cBSDataSBAText') || {}; state.serviceSummary = { name: text(s.cBSDataSBAText), distance: text(s.cBSDataSBADistance), date: text(s.cBSDataSBADate) }; touch(); }
        }, log, { pollMs: 5000 }),
        ctx.signals.watch('de.bmw.infotainment.checkcontrol.CheckControlMaster', '1', { basicList: (v) => {
            const seen = new Map(); walk(v, (o) => { if (o.ccmId === undefined) return; const on = o.activeState === 'AKTIV' || o.activeState === 0; if (on) seen.set(o.ccmId, { ecu:o.requestorDiagAddr, reason:String(o.reason || '') }); });
            state.checkControl = seen; touch();
        } }, log)
    ]);

    function getDiag() {
        if (!diagReady) diagReady = (async () => { diag = new Diag(ctx.signals, log); diag.quiet = true; await diag.init(); return diag; })();
        return diagReady;
    }
    function serialized(fn) { const next = queue.then(fn, fn); queue = next.catch(() => null); return next; }
    async function scanFaults() {
        if (scanning || settings.get('demo') === 'on') return;
        scanning = true; state.dtc.error = '';
        try {
            await serialized(async () => {
                const d = await getDiag(); if (!d.available) throw new Error('diagnostic link unavailable');
                const replies = await d.functional(0x19, [0x02, 0x0C], { idleMs: 3500, maxMs: 18000 });
                let faults = 0, active = 0, pending = 0;
                replies.forEach((uds) => parseDtcReply(uds, [0x02,0x0C]).dtcs.forEach((x) => { faults++; if (x.status & 0x81) active++; else if (x.status & 0x0C) pending++; }));
                state.dtc = { at: Date.now(), units: replies.size, faults, active, pending, error: replies.size ? '' : 'No control unit answered' };
            });
        } catch (e) { state.dtc.error = String(e.message || e); }
        scanning = false;
    }
    async function readDpf() {
        if (dpfBusy || settings.get('demo') === 'on') return;
        dpfBusy = true;
        try {
            await serialized(async () => {
                const d = await getDiag(); if (!d.available) throw new Error('diagnostic link unavailable');
                const ecu = Number(ctx.spec.config.ddeAddress) || 0x12;
                if (!state.dpf.variant) {
                    const r = await d.physical(ecu, 0x22, [0xF1,0x50], 2200, replyTo(0x22,[0xF1,0x50]));
                    if (!r || r[0] !== 0x62 || r.length < 6) throw new Error('DDE identification unavailable');
                    state.dpf.variant = r.slice(3,6).map((n) => n.toString(16).toUpperCase().padStart(2,'0')).join('');
                    if (!DPF_VARIANTS.has(state.dpf.variant)) throw new Error('DPF layout unverified for DDE ' + state.dpf.variant);
                }
                for (const [id,key] of [[0x44BE,'soot'],[0x44BD,'ash'],[0x4C78,'remaining']]) {
                    const bytes = [id >> 8, id & 255], r = await d.physical(ecu, 0x22, bytes, 2200, replyTo(0x22,bytes));
                    const n = decodeDid(id, r); if (finite(n)) state.dpf[key] = n;
                }
                state.dpf.at = Date.now(); state.dpf.error = '';
            });
        } catch (e) { state.dpf.error = String(e.message || e); }
        dpfBusy = false;
    }
    setInterval(() => { if (visible && Date.now() - state.dpf.at > 2000) readDpf(); }, 250);

    function demoData() {
        return { coolant:91, oilTemp:96, battery:78, oilLevel:'OK', outside:12, tank:54, range:680,
            pressure:[2.4,2.4,2.5,2.5], target:[2.4,2.4,2.5,2.5], tyreTemp:[18,18,19,19],
            service:[{name:'Engine oil',color:3,distance:'12 000 km',date:'09/2027'},{name:'Brake fluid',color:2,distance:'',date:'11/2026'}],
            serviceSummary:{name:'Engine oil',distance:'12 000 km',date:'09/2027'}, checkControl:new Map(),
            dtc:{at:Date.now(),units:31,faults:0,active:0,pending:0,error:''}, dpf:{variant:'0F1FE8',soot:12.7,ash:24.4,remaining:148000,at:Date.now(),error:''}, signalAt:Date.now(), demo:true };
    }
    const data = () => settings.get('demo') === 'on' ? demoData() : state;
    const temp = (c) => finite(c) ? settings.get('tempUnit') === 'F' ? c * 9 / 5 + 32 : c : null;
    const tempUnit = () => settings.get('tempUnit') === 'F' ? '°F' : '°C';
    function tyreSeverity(d, i) {
        const p = d.pressure[i], target = d.target[i];
        if (!finite(p) || !finite(target) || target <= 0) return 'unknown';
        const delta = p - target;
        return delta < -0.35 || delta > 0.6 ? 'crit' : delta < -0.18 || delta > 0.35 ? 'warn' : 'ok';
    }
    function issues(d) {
        const out = [];
        if (/Below minimum|Overfilled/.test(d.oilLevel || '')) out.push({ sev:'crit', text:'Engine oil: ' + d.oilLevel });
        else if (/At minimum/.test(d.oilLevel || '')) out.push({ sev:'warn', text:'Engine oil at minimum' });
        d.pressure.forEach((p,i) => { const s=tyreSeverity(d,i); if(s==='crit'||s==='warn') out.push({sev:s,text:['FL','FR','RL','RR'][i]+' tyre '+(finite(p)?p.toFixed(1)+' bar':'no data')}); });
        if (finite(d.coolant) && d.coolant > 115) out.push({sev:d.coolant>122?'crit':'warn',text:'Coolant '+d.coolant.toFixed(0)+' °C'});
        if (finite(d.oilTemp) && d.oilTemp > 135) out.push({sev:d.oilTemp>145?'crit':'warn',text:'Oil '+d.oilTemp.toFixed(0)+' °C'});
        if (finite(d.battery) && d.battery < 45) out.push({sev:d.battery<30?'crit':'warn',text:'12 V battery '+d.battery.toFixed(0)+'%'});
        d.service.forEach((s) => { if(s.color===1||s.color===2||s.color===4) out.push({sev:s.color===1?'crit':'warn',text:s.name+(s.distance?' '+s.distance:'')}); });
        if (d.checkControl.size) out.push({sev:'warn',text:d.checkControl.size+' active Check Control message'+(d.checkControl.size===1?'':'s')});
        if (d.dtc.active) out.push({sev:'crit',text:d.dtc.active+' active fault'+(d.dtc.active===1?'':'s')});
        else if (d.dtc.pending) out.push({sev:'warn',text:d.dtc.pending+' pending/stored fault'+(d.dtc.pending===1?'':'s')});
        return out;
    }
    const colorOf = (t, sev) => sev === 'crit' ? t.crit : sev === 'warn' ? t.warn : sev === 'ok' ? GREEN : t.dim;
    function summaryCard(cv,t,x,y,w,h,title,value,sub,sev){ G.panel(cv,t,x,y,w,h,title); cv.text(value,x+22,y+91,49,colorOf(t,sev),{font:'bold'}); cv.text(sub||'',x+22,y+h-22,19,t.dim); }
    function overview(cv,t,d){
        const is=issues(d), crit=is.filter(x=>x.sev==='crit').length, warn=is.filter(x=>x.sev==='warn').length;
        const status=crit?'CHECK NOW':warn?'ATTENTION':'ALL GOOD', sev=crit?'crit':warn?'warn':'ok';
        G.panel(cv,t,24,52,410,460,'Overall status'); cv.text(status,48,143,54,colorOf(t,sev),{font:'bold'});
        cv.text(crit+' critical  ·  '+warn+' attention',48,187,22,t.dim);
        const shown=is.slice(0,5); if(!shown.length) cv.text('No issue detected in the data currently available.',48,260,24,GREEN);
        shown.forEach((x,i)=>{ cv.circle(58,238+i*47,6,colorOf(t,x.sev)); cv.text(x.text,80,246+i*47,21,t.text); });
        summaryCard(cv,t,454,52,356,214,'Engine',finite(d.coolant)?temp(d.coolant).toFixed(0)+tempUnit():'--',d.oilLevel?'Oil level '+d.oilLevel:'oil level waiting',finite(d.coolant)&&d.coolant>115?'warn':'ok');
        const tyreBad=d.pressure.map((_,i)=>tyreSeverity(d,i)).filter(x=>x==='warn'||x==='crit');
        summaryCard(cv,t,830,52,356,214,'Tyres',tyreBad.length?tyreBad.length+' need attention':'OK',d.pressure.every(finite)?d.pressure.map(x=>x.toFixed(1)).join(' / ')+' bar':'waiting for all four',tyreBad.includes('crit')?'crit':tyreBad.length?'warn':'ok');
        const due=d.service.filter(x=>x.color===1||x.color===2||x.color===4).length;
        summaryCard(cv,t,1206,52,370,214,'Service',due?due+' due soon':'OK',d.serviceSummary?[d.serviceSummary.name,d.serviceSummary.distance||d.serviceSummary.date].filter(Boolean).join(' · '):'waiting for CBS',due?'warn':'ok');
        summaryCard(cv,t,454,286,356,226,'12 V battery',finite(d.battery)?d.battery.toFixed(0)+'%':'--','car-reported charge condition',finite(d.battery)&&d.battery<45?'warn':'ok');
        summaryCard(cv,t,830,286,356,226,'Current faults',d.dtc.at?String(d.dtc.faults):'--',d.dtc.at?d.dtc.units+' control units answered':scanning?'scanning…':'not scanned',d.dtc.active?'crit':d.dtc.pending?'warn':d.dtc.at?'ok':'unknown');
        summaryCard(cv,t,1206,286,370,226,'DPF',finite(d.dpf.soot)?d.dpf.soot.toFixed(1)+' g':'--',finite(d.dpf.remaining)?Math.round(d.dpf.remaining/1000)+'k km CBS remaining':d.dpf.error||'waiting for DDE',finite(d.dpf.soot)&&d.dpf.soot>35?'warn':'ok');
    }
    function tyresPage(cv,t,d){
        const names=['Front left','Front right','Rear left','Rear right'], xy=[[24,58],[806,58],[24,286],[806,286]];
        names.forEach((name,i)=>{ const [x,y]=xy[i], sev=tyreSeverity(d,i), col=colorOf(t,sev); G.panel(cv,t,x,y,770,210,name);
            G.readout(cv,t,x+24,y+67,{label:'Pressure',value:d.pressure[i],unit:'bar',decimals:1,size:61,color:col});
            G.readout(cv,t,x+310,y+67,{label:'Target',value:d.target[i],unit:'bar',decimals:1,size:49,color:BLUE});
            G.readout(cv,t,x+560,y+67,{label:'Temperature',value:temp(d.tyreTemp[i]),unit:tempUnit(),decimals:0,size:43,color:finite(d.tyreTemp[i])?GREEN:t.dim});
            const delta=finite(d.pressure[i])&&finite(d.target[i])?d.pressure[i]-d.target[i]:null;
            cv.text(finite(delta)?(delta>=0?'+':'')+delta.toFixed(1)+' bar from target':'waiting for pressure and target',x+24,y+188,21,col);
        });
    }
    function servicePage(cv,t,d){
        cv.text('Condition Based Service',34,92,34,t.text,{font:'bold'});
        const rows=d.service.slice(0,7).map(s=>[s.name,s.distance||'--',s.date||'--',s.color===1?'DUE':s.color===2||s.color===4?'SOON':s.color===3?'OK':'--']);
        G.table(cv,t,40,132,1520,[{label:'Item',w:580},{label:'Distance',w:330,align:'right'},{label:'Date',w:330,align:'right'},{label:'Status',w:280,align:'right'}],rows,{rowH:48,size:24,empty:'Waiting for the instrument cluster service list'});
        const s=d.serviceSummary; cv.text(s?[s.name,s.distance||s.date].filter(Boolean).join(' · '):'The list is read from the same CBS provider used by iDrive.',40,500,21,t.dim);
    }
    function diagnosticsPage(cv,t,d){
        const cards=[['Current faults',d.dtc.at?String(d.dtc.faults):'--',d.dtc.at?d.dtc.units+' units answered':scanning?'Scanning…':d.dtc.error||'Not scanned',d.dtc.active?'crit':d.dtc.pending?'warn':d.dtc.at?'ok':'unknown'],
            ['Active Check Control',String(d.checkControl.size),d.checkControl.size?'message(s) currently active':'none reported',d.checkControl.size?'warn':'ok'],
            ['DPF soot',finite(d.dpf.soot)?d.dpf.soot.toFixed(1):'--',finite(d.dpf.soot)?'g · DDE '+d.dpf.variant:d.dpf.error||'waiting','ok'],
            ['DPF ash',finite(d.dpf.ash)?d.dpf.ash.toFixed(1):'--',finite(d.dpf.ash)?'g · does not burn away':'waiting','unknown']];
        cards.forEach((c,i)=>summaryCard(cv,t,24+i*388,58,370,198,c[0],c[1],c[2],c[3]));
        G.panel(cv,t,24,276,1552,236,'Read-only diagnostic status');
        const rows=[['Last fault scan',d.dtc.at?new Date(d.dtc.at).toLocaleTimeString():'not run'],['Active / pending',d.dtc.active+' / '+d.dtc.pending],['DPF CBS remaining',finite(d.dpf.remaining)?Math.round(d.dpf.remaining)+' km':'--'],['Data source','SOME/IP vehicle providers + UDS 19/22 reads'],['Writes','None — no clear, reset, coding or actuator commands']];
        G.table(cv,t,48,326,1504,[{label:'',w:500},{label:'',w:1004,align:'right'}],rows,{rowH:35,size:22});
    }
    async function render(){ const t=ctx.theme(),d=data(),cv=ctx.canvas(W,H).clear(t.bg); [overview,tyresPage,servicePage,diagnosticsPage][page](cv,t,d);
        const is=issues(d),sev=is.some(x=>x.sev==='crit')?'crit':is.length?'warn':'ok';
        G.frame(cv,t,PAGES,page,[{text:d.demo?'DEMO':scanning?'SCANNING':sev==='crit'?'CHECK':sev==='warn'?'ATTENTION':'GOOD',color:d.demo?BLUE:colorOf(t,sev)}]);
        await ui.image('MAIN_GFX',cv); }
    ui.onClick('BTN_PAGE',()=>{page=(page+1)%PAGES.length;});
    ui.onClick('BTN_SCAN',()=>scanFaults());
    ctx.onTab((i)=>{page=i;});
    ui.onVisible((name,on)=>{ if(name!=='MAIN')return; visible=on; if(on&&!opened){opened=true;readDpf();if(settings.get('autoScan'))setTimeout(scanFaults,2500);} });
    ctx.loop('MAIN',60,render);
} });
