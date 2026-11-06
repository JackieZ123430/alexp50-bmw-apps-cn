'use strict';

const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Reader = require('./reader');
const L = require('./logic');

const W=1600,H=520,PAGES=['Now','History','Consumers','Details'];
const GREEN='#2fd27a',BLUE='#4aafff',AMBER='#ffb52e',CYAN='#35d6d0';
const fmt=(n,d)=>L.finite(n)?n.toFixed(d == null ? 0 : d):'--';
const hex=(n,w)=>L.finite(n)?'0x'+(n>>>0).toString(16).toUpperCase().padStart(w||8,'0'):'--';
const when=(t)=>t?new Date(t).toLocaleTimeString():'--';

mgu.run({ async start(ctx) {
    const {ui,settings}=ctx, reader=new Reader(ctx); let page=0;
    const signal={coolant:null,speed:null,engine:null,at:0};
    await Promise.all([
        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS','1',{
            statusEngineTemperature:(v)=>{const n=v&&v.temperatureEngineDrive;if(L.finite(n)&&n!==255)signal.coolant=n-48;signal.at=Date.now();},
            statusEngineStatus:(v)=>{signal.engine=L.engineRunning(v&&v.statusEngineRunDrive);reader.setEngineRunning(signal.engine);signal.at=Date.now();}
        },ctx.log),
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2','1',{statusCarSpeed2:(v)=>{const n=v&&v.speedVehicleCentreOfGravity;if(L.finite(n)&&n<65535)signal.speed=n*0.015625;signal.at=Date.now();}},ctx.log)
    ]);
    await reader.init();

    function demo() {
        const v={'58B1':0,'58B2':0,'58B3':0,'58B4':0,'58B5':4,'58B7':2,'58B8':0,'58BA':0,'429D':42,'43CA':8500,'43CB':2600,'43CC':1,'43FD':620,'4D12':124,'489A':1,'4D03':4,
            voltage:14.46,batteryCurrent:-13.8,batteryTemp:18.4,generatorCurrent:72,generatorLoad:61.3};
        return { values:v, history:[0,1,2,3,4,5].map((x)=>({at:Date.now()-x*93000,signature:'demo'+x,title:x%3===0?'NO CURRENT INHIBITOR':x%2?'STOP INHIBITED · SYSTEM CONDITION':'STOP INHIBITED · DRIVER CONDITION',active:x%3===0?[]:[{did:x%2?'58B5':'58B4',label:x%2?'Stop inhibited · system condition':'Stop inhibited · driver condition',bits:[x+1]}],voltage:14.3-x*.08,batteryCurrent:-11+x,generatorLoad:55+x})).reverse(), status:'DEMO', lastGood:Date.now(), cycleMs:410 };
    }
    const data=()=>settings.get('demo')==='on'?demo():{
        values:reader.values,
        history:reader.history,
        status:reader.status(),
        lastGood:reader.lastGood,
        cycleMs:reader.cycleMs
    };
    const tone=(t,s)=>s.tone==='green'?GREEN:s.tone==='blue'?BLUE:AMBER;
    function panelValue(cv,t,x,y,w,h,title,value,unit,color,sub){G.panel(cv,t,x,y,w,h,title);cv.text(value,x+24,y+110,55,color||t.text,{font:'bold'});if(unit)cv.text(unit,x+w-24,y+107,23,t.dim,{align:'right'});if(sub)cv.text(sub,x+24,y+h-22,19,t.dim);}
    function nowPage(cv,t,d){
        const complete=L.WORDS.every((x)=>L.finite(d.values[x[0]])),s=L.operatingState(d.values,signal.engine),col=complete?tone(t,s):t.dim; G.panel(cv,t,24,54,850,458,'Current Start/Stop decision');
        cv.text(complete?s.title:'WAITING FOR MSA DATA',52,139,46,col,{font:'bold'}); cv.text(d.status==='LIVE'?'DDE live · read-only':d.status,52,180,22,d.status==='LIVE'?GREEN:t.dim);
        if(complete&&!s.active.length)cv.text(s.running===false?'Engine stopped by MSA; no restart inhibitor is active.':'No active bit in the five BMW MSA decision words.',52,268,26,t.text);
        if(!complete)cv.text('Reading BMW DDE decision channels 58B1–58B5…',52,268,26,t.dim);
        s.active.slice(0,5).forEach((x,i)=>{cv.circle(61,236+i*48,6,col);cv.text(x.label,83,244+i*48,23,t.text);cv.text(x.did+'  bit'+(x.bits.length>1?'s ':' ')+x.bits.join(', '),820,244+i*48,20,t.dim,{align:'right'});});
        panelValue(cv,t,894,54,330,217,'12 V system',fmt(d.values.voltage,2),'V',BLUE,'IBS measured');
        panelValue(cv,t,1244,54,332,217,'Battery flow',fmt(d.values.batteryCurrent,1),'A',BLUE,'signed IBS current');
        panelValue(cv,t,894,291,330,221,'Coolant',fmt(signal.coolant,0),'°C',CYAN,'vehicle signal');
        panelValue(cv,t,1244,291,332,221,'Generator output',fmt(d.values.generatorCurrent,0),'A',GREEN,'DDE measured current');
    }
    function historyPage(cv,t,d){
        G.panel(cv,t,24,54,1552,458,'Last ten observed decision changes');
        const rows=d.history.slice().reverse().slice(0,10).map((e)=>[when(e.at),e.title,(e.active||[]).map((x)=>x.did+' b'+x.bits.join('/')).join(' · ')||'all five words clear',L.finite(e.voltage)?e.voltage.toFixed(2)+' V':'--']);
        G.table(cv,t,48,106,1504,[{label:'Time',w:210},{label:'Decision',w:570},{label:'Active channel / bits',w:520},{label:'Battery',w:204,align:'right'}],rows,{rowH:36,size:20,empty:'No transition recorded yet — history begins when the app first reads the DDE.'});
        cv.text('Stored locally · newest first · identical consecutive states are combined',48,496,18,t.dim);
    }
    function consumersPage(cv,t,d){
        const list=L.consumers(d.values), totals=L.totals(d.values); G.panel(cv,t,24,54,1030,458,'Top available electrical loads');
        if(!list.length)cv.text('Waiting for supported DDE consumer channels…',52,150,25,t.dim);
        list.forEach((x,i)=>{const y=120+i*70,bar=Math.min(700,x.watts/250*700);cv.text(String(i+1),52,y+12,27,t.dim,{font:'bold'});cv.text(x.name,94,y+8,24,t.text,{font:'bold'});cv.text(x.kind,590,y+7,18,x.kind==='DIRECT'?GREEN:AMBER,{font:'bold'});cv.text(x.detail,700,y+7,18,t.dim);cv.fillRect(94,y+25,760,8,t.track);cv.fillRect(94,y+25,bar,8,x.kind==='DIRECT'?BLUE:AMBER);cv.text(fmt(x.watts,0)+' W',1012,y+14,26,t.text,{align:'right',font:'bold'});});
        panelValue(cv,t,1074,54,502,217,'Generator supply',fmt(totals.generatorW,0),'W',GREEN,fmt(d.values.generatorCurrent,0)+' A · '+fmt(d.values.generatorLoad,0)+'% load');
        panelValue(cv,t,1074,291,502,221,'Battery net flow',fmt(totals.batteryW,0),'W',BLUE,fmt(d.values.batteryCurrent,1)+' A · signed IBS value');
        cv.text('DIRECT = measured current × voltage · EST = learned power or duty-based estimate',52,496,18,t.dim);
    }
    function detailsPage(cv,t,d){
        const rows=L.WORDS.map(([did,label])=>[did,label,hex(d.values[did],8),L.bitList(d.values[did]).join(', ')||'none']);
        G.panel(cv,t,24,54,930,458,'BMW MSA decision words');G.table(cv,t,48,108,882,[{label:'DID',w:110},{label:'Channel',w:370},{label:'Raw',w:210},{label:'Set bits',w:192,align:'right'}],rows,{rowH:53,size:20});
        G.panel(cv,t,974,54,602,458,'Link and supporting data');
        const info=[['Overall MSA status',hex(d.values['58B7'],4)],['Safety status',hex(d.values['58B8'],2)],['Check Control',hex(d.values['58BA'],2)],['Compact inhibit',hex(d.values['4D03'],2)],['Climate request',d.values['489A']?'active':'inactive / unknown'],['Battery temperature',fmt(d.values.batteryTemp,1)+' °C'],['Last good read',when(d.lastGood)],['Poll cycle',fmt(d.cycleMs,0)+' ms'],['Diagnostic writes','NONE']];
        G.table(cv,t,998,108,554,[{label:'',w:330},{label:'',w:224,align:'right'}],info,{rowH:35,size:20});
        cv.text('Bit labels are shown exactly; undocumented causes are not guessed.',998,491,17,t.dim);
    }
    async function render(){const d=data(),t=ctx.theme(),cv=ctx.canvas(W,H).clear(t.bg);[nowPage,historyPage,consumersPage,detailsPage][page](cv,t,d);G.frame(cv,t,PAGES,page,[{text:d.status,color:d.status==='LIVE'?GREEN:d.status==='DEMO'?BLUE:t.dim},{text:'READ ONLY',color:GREEN}]);await ui.image('MAIN_GFX',cv);}
    ui.onClick('BTN_PAGE',()=>{page=(page+1)%PAGES.length;}); ui.onClick('BTN_ACTION',()=>{if(reader.diag)reader.diag.wake(0x12);});ctx.onTab((i)=>{page=i;});ctx.loop('MAIN',60,render);
} });
