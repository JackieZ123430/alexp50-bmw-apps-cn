'use strict';

const mgu=require('./kit/mgu');
const G=require('./kit/gauges');
const {Controller,EVENTS}=require('./controller');
const W=1600,H=520,PAGES=['Status','Events','Details'];
const GREEN='#32e875',RED='#ff3658',AMBER='#ffb52e',CYAN='#35d6d0',BLUE='#4aafff';
const fmt=(n,d)=>typeof n==='number'&&Number.isFinite(n)?n.toFixed(d==null?0:d):'--';
const when=(n)=>n?new Date(n).toLocaleTimeString():'--';
const settingValue=(s)=>!s?'NO DATA':s.value===2?'ACTIVATED (2)':s.value===1?'DEACTIVATED (1)':s.value===0?'NOT CONFIGURABLE (0)':String(s.value);
const settingAvailability=(s)=>!s?'NO DATA':s.availability===2?'OPERABLE (2)':s.availability===1?'NOT OPERABLE (1)':s.availability===0?'NOT AVAILABLE (0)':String(s.availability);
const uccRegion=(n)=>n===0?'AVAILABLE (0)':n===1?'UNAVAILABLE (1)':n===2?'LIMITED (2)':n===3?'NO SIGNAL (3)':'NO DATA';

mgu.run({async start(ctx){
    const {ui,settings}=ctx;let page=0,notice='';const C=new Controller(ctx,()=>{});
    C.configureRaw(settings.get('rawRedCode'),settings.get('rawGreenCode'));await C.start();
    function demo(){C.settingConn={available:true};C.setting={value:2,availability:2,at:Date.now()};C.speed=0;C.foresight={code:12,label:'RED',at:Date.now()};}
    const useDemo=()=>settings.get('demo')==='on'||ctx.preview;
    function panelValue(cv,t,x,y,w,h,title,value,unit,color,sub){G.panel(cv,t,x,y,w,h,title);cv.text(value,x+24,y+110,58,color||t.text,{font:'bold'});if(unit)cv.text(unit,x+w-24,y+107,22,t.dim,{align:'right'});if(sub)cv.text(sub,x+24,y+h-23,19,t.dim);}
    function light(cv,t,x,y,code){
        const lit=code===12||code===13?0:code===14?1:(code>=15&&code<=18)?2:-1;
        cv.roundRect(x,y,170,390,45,'#111820');
        [[RED,'#43131d'],[AMBER,'#453313'],[GREEN,'#113e26']].forEach((a,i)=>{cv.circle(x+85,y+74+i*122,43,i===lit?a[0]:a[1]);cv.circle(x+85,y+74+i*122,31,i===lit?a[0]:a[1]);});
    }
    function statusPage(cv,t){
        const ns=C.nativeState(),ncol=ns.color==='green'?GREEN:ns.color==='amber'?AMBER:t.dim;
        G.panel(cv,t,24,54,790,458,'BMW traffic-light drive-off reminder');
        cv.text(ns.label,54,146,58,ncol,{font:'bold'});
        cv.text(C.notice,54,194,22,t.text);
        cv.text('Configured in iDrive: Display traffic-light phases ON · Drive-off reminder EARLY.',54,254,24,t.dim);
        const rawLive=C.rawConn&&C.rawConn.available;
        cv.text(rawLive?'Raw KAFAS camera connected; regional UCC gate bypassed':C.foresightConn&&C.foresightConn.available?'OEM display bus connected; raw camera is not advertising':'Waiting for a KAFAS traffic-light provider',54,310,25,rawLive?GREEN:t.dim,{font:'bold'});
        cv.text('Raw colour calibration: red '+C.rawRedCode+' / green '+C.rawGreenCode,54,448,19,t.dim);
        cv.text('Alert requires a red-to-green transition below 3 km/h.',54,482,19,t.dim);
        G.panel(cv,t,834,54,466,458,'KAFAS traffic light');
        const raw=C.rawLight,rawCode=raw&&raw.color===C.rawRedCode?12:raw&&raw.color===C.rawGreenCode?15:-1;
        light(cv,t,868,100,raw?rawCode:(C.foresight?C.foresight.code:-1));
        cv.text(raw?('RAW COLOR '+raw.color):(C.foresight?C.foresight.label:'WAITING'),1068,160,34,raw&&raw.color===C.rawGreenCode?GREEN:raw&&raw.color===C.rawRedCode?RED:t.text,{font:'bold'});
        cv.text(raw?'Direct front-camera object':'Validated BMW display signal',1068,198,19,t.dim);
        cv.text('Updated '+(raw?when(raw.at):C.foresight?when(C.foresight.at):'--'),1068,233,19,t.dim);
        panelValue(cv,t,1320,54,256,217,'Vehicle speed',fmt(C.speed,1),'km/h',BLUE,'alert requires standstill');
        panelValue(cv,t,1320,291,256,221,'Last green',C.lastAlertAt?when(C.lastAlertAt):'--','',GREEN,'red to green transition');
    }
    function eventsPage(cv,t){
        G.panel(cv,t,24,54,1552,458,'Last ten observed traffic-light and setting events');
        const rows=C.history.map((e)=>[when(e.at),e.title,e.detail]);
        G.table(cv,t,48,108,1504,[{label:'Time',w:220},{label:'Event',w:420},{label:'Detail',w:864}],rows,{rowH:38,size:21,empty:'No transition recorded yet. Events begin when KAFAS publishes a traffic-light display state.'});
        cv.text('A green transition is recorded only after a red state while the car is below 3 km/h.',48,495,18,t.dim);
    }
    function detailsPage(cv,t){
        G.panel(cv,t,24,54,730,458,'Native provider');
        const a=C.foresightConn&&C.foresightConn.available?'AVAILABLE':'WAITING';
        const drive=C.settings.driveOffReminder,traffic=C.settings.trafficlightDriveOff;
        const rows=[['Raw camera provider',C.rawConn&&C.rawConn.available?'AVAILABLE':'WAITING'],['UCC regional decision',uccRegion(C.fasStatus&&C.fasStatus.functionUCC)],['UCC traffic-light status',uccRegion(C.fasStatus&&C.fasStatus.trafficLight)],['DriveOff availability',settingAvailability(drive)],['TrafficLight availability',settingAvailability(traffic)],['FAS provider',C.fasusConn&&C.fasusConn.available?'AVAILABLE':'WAITING']];
        G.table(cv,t,48,112,682,[{label:'BMW settings signal',w:330},{label:'Live result',w:352,align:'right'}],rows,{rowH:52,size:20});
        G.panel(cv,t,774,54,802,458,'KAFAS camera signal (read only)');
        const camera=C.rawLight||{};
        const rows2=[['Raw ID / colour',C.rawLight?camera.id+' / '+camera.color:'--'],['Status / quality',C.rawLight?camera.status+' / '+camera.quality:'--'],['Direction / arrow',C.rawLight?camera.direction+' / '+camera.arrow:'--'],['Speed',fmt(C.speed,2)+' km/h'],['Armed after red',C.armedAt?when(C.armedAt):'--'],['Last green transition',C.lastAlertAt?when(C.lastAlertAt):'--']];
        G.table(cv,t,798,112,754,[{label:'',w:380},{label:'',w:374,align:'right'}],rows2,{rowH:52,size:22});
        cv.text(C.rawLight?'Source: TrafficLightRecognitionFrontCameraLegacy':'Fallback: BMW TrafficSignDisplayControl.DisplayForesight',798,490,18,t.dim);
    }
    async function render(){
        if(useDemo()&&!C.setting)demo();const t=ctx.theme(),cv=ctx.canvas(W,H).clear(t.bg);
        [statusPage,eventsPage,detailsPage][page](cv,t);
        const ns=C.nativeState();G.frame(cv,t,PAGES,page,[{text:ns.label,color:ns.color==='green'?GREEN:ns.color==='amber'?AMBER:t.dim},{text:'KAFAS',color:CYAN}]);
        if(Date.now()-C.lastAlertAt<3500){cv.fillRect(0,0,W,H,'#08351caa');cv.text('GREEN LIGHT',W/2,H/2+20,86,GREEN,{align:'center',font:'bold'});}
        if(notice){cv.roundRect(430,416,740,70,18,'#171f29ee');cv.text(notice,800,460,23,t.text,{align:'center'});}
        await ui.image('MAIN_GFX',cv);
    }
    ui.onClick('BTN_PAGE',()=>{page=(page+1)%PAGES.length;});
    ui.onClick('BTN_ACTION',async()=>{notice='';try{await C.toggle();}catch(e){notice=e.message;setTimeout(()=>{notice='';},4500);}});
    ctx.onTab((i)=>{page=Math.max(0,Math.min(PAGES.length-1,i));});ctx.loop('MAIN',60,render);
}});
