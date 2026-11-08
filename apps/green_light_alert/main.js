'use strict';

const mgu=require('./kit/mgu');
const G=require('./kit/gauges');
const {Controller}=require('./controller');
const W=1600,H=520,PAGES=['Status','Events','Regional gate','Signal chain'];
const GREEN='#32e875',RED='#ff3658',AMBER='#ffb52e',CYAN='#35d6d0',BLUE='#4aafff';
const fmt=(n,d)=>typeof n==='number'&&Number.isFinite(n)?n.toFixed(d==null?0:d):'--';
const when=(n)=>n?new Date(n).toLocaleTimeString():'--';
const settingValue=(s)=>!s?'NO DATA':s.value===2?'ACTIVATED (2)':s.value===1?'DEACTIVATED (1)':s.value===0?'NOT CONFIGURABLE (0)':String(s.value);
const settingAvailability=(s)=>!s?'NO DATA':s.availability===2?'OPERABLE (2)':s.availability===1?'NOT OPERABLE (1)':s.availability===0?'NOT AVAILABLE (0)':String(s.availability);
const displayCountry=(n)=>n===0?'AVAILABLE (0)':n===1?'RESTRICTED (1)':n===2?'NOT AVAILABLE (2)':'NO DATA';
const uccRegion=(n)=>n===0?'AVAILABLE (0)':n===1?'UNAVAILABLE (1)':n===2?'LIMITED (2)':n===3?'NO SIGNAL (3)':'NO DATA';

mgu.run({async start(ctx){
    const {ui,settings}=ctx;let page=0,notice='';const C=new Controller(ctx,()=>{});
    C.configureRaw(settings.get('rawRedCode'),settings.get('rawGreenCode'));await C.start();
    function demo(){
        C.settingConn={available:true};C.foresightConn={available:true};C.fasusConn={available:true};C.countryConn={available:true};
        C.adasCountry={code:'ROU',at:Date.now()};C.displayStatusUcc={value:2,at:Date.now()};
        C.settings.driveOffReminder={value:2,availability:0};C.settings.trafficlightDriveOff={value:2,availability:0};
        C.setting=C.settings.trafficlightDriveOff;C.fasStatus={functionUCC:1,trafficLight:3,restart:3,stopSign:3,assistant:3,at:Date.now()};
        C.speed=0;C.foresight={code:12,label:'RED',at:Date.now()};C.updateNotice();
    }
    const useDemo=()=>settings.get('demo')==='on'||ctx.preview;
    function panelValue(cv,t,x,y,w,h,title,value,unit,color,sub){G.panel(cv,t,x,y,w,h,title);cv.text(value,x+24,y+110,58,color||t.text,{font:'bold'});if(unit)cv.text(unit,x+w-24,y+107,22,t.dim,{align:'right'});if(sub)cv.text(sub,x+24,y+h-23,19,t.dim);}
    function light(cv,t,x,y,code){
        const lit=code===12||code===13?0:code===14?1:(code>=15&&code<=18)?2:-1;
        cv.roundRect(x,y,170,390,45,'#111820');
        [[RED,'#43131d'],[AMBER,'#453313'],[GREEN,'#113e26']].forEach((a,i)=>{cv.circle(x+85,y+74+i*122,43,i===lit?a[0]:a[1]);cv.circle(x+85,y+74+i*122,31,i===lit?a[0]:a[1]);});
    }
    function statusPage(cv,t){
        const ns=C.nativeState(),ncol=ns.color==='green'?GREEN:ns.color==='amber'?AMBER:ns.color==='red'?RED:t.dim;
        G.panel(cv,t,24,54,790,458,'BMW traffic-light drive-off reminder');
        cv.text(ns.label,54,146,58,ncol,{font:'bold'});
        cv.text(C.notice,54,194,21,t.text);
        cv.text('Configured in iDrive: traffic-light phases ON / drive-off reminder EARLY.',54,254,23,t.dim);
        const rawLive=C.rawConn&&C.rawConn.available;
        cv.text(rawLive?'Raw KAFAS camera connected':C.foresightConn&&C.foresightConn.available?'OEM display bus connected; raw camera is not advertising':'Waiting for a KAFAS traffic-light provider',54,310,25,rawLive?GREEN:t.dim,{font:'bold'});
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
        G.panel(cv,t,24,54,1552,458,'Last ten observed traffic-light and regional events');
        const rows=C.history.map((e)=>[when(e.at),e.title,e.detail]);
        G.table(cv,t,48,108,1504,[{label:'Time',w:220},{label:'Event',w:420},{label:'Detail',w:864}],rows,{rowH:38,size:21,empty:'No event recorded yet. Events begin when BMW providers publish state.'});
        cv.text('The app records the decision chain without changing GPS, navigation or ECU coding.',48,495,18,t.dim);
    }
    function regionalPage(cv,t){
        const d=C.regionalDiagnosis(),color=d.level==='ok'?GREEN:d.level==='blocked'?RED:d.level==='limited'?AMBER:t.text;
        G.panel(cv,t,24,54,980,458,'Romania availability decision');
        cv.text(d.title,54,142,48,color,{font:'bold'});
        cv.text(d.detail,54,192,22,t.text);
        const rows=[
            ['ADAS map country',C.adasCountry?C.adasCountry.code:'NO DATA'],
            ['Country-display decision',displayCountry(C.displayStatusUcc&&C.displayStatusUcc.value)],
            ['FAS regional decision',uccRegion(C.fasStatus&&C.fasStatus.functionUCC)],
            ['Drive-off setting',settingAvailability(C.settings.driveOffReminder)],
            ['Traffic-light setting',settingAvailability(C.settings.trafficlightDriveOff)]
        ];
        G.table(cv,t,54,248,920,[{label:'Input',w:420},{label:'Live result',w:500,align:'right'}],rows,{rowH:45,size:21});
        G.panel(cv,t,1024,54,552,458,'What this proves');
        cv.text('1',1052,130,30,CYAN,{font:'bold'});cv.text('Map/e-horizon identifies the country.',1090,130,20,t.text);
        cv.text('2',1052,196,30,CYAN,{font:'bold'});cv.text('Settings provider applies country policy.',1090,196,20,t.text);
        cv.text('3',1052,262,30,CYAN,{font:'bold'});cv.text('FAS publishes the final UCC decision.',1090,262,20,t.text);
        cv.text('The previous Berlin GPS demo did not alter the',1052,350,19,t.dim);
        cv.text('ADAS country input and has been removed.',1052,380,19,t.dim);
        cv.text('No location spoofing. No ECU coding.',1052,458,21,GREEN,{font:'bold'});
    }
    function chainPage(cv,t){
        G.panel(cv,t,24,54,760,458,'Driver-assistance settings');
        const rows=[
            ['Drive-off reminder',settingValue(C.settings.driveOffReminder),settingAvailability(C.settings.driveOffReminder)],
            ['Traffic-light drive-off',settingValue(C.settings.trafficlightDriveOff),settingAvailability(C.settings.trafficlightDriveOff)],
            ['Traffic-light braking',settingValue(C.settings.trafficlightBraking),settingAvailability(C.settings.trafficlightBraking)],
            ['Stop-sign braking',settingValue(C.settings.stopSignBraking),settingAvailability(C.settings.stopSignBraking)],
            ['Urban Cruise Control',settingValue(C.settings.urbanCruiseControlMode),settingAvailability(C.settings.urbanCruiseControlMode)]
        ];
        G.table(cv,t,48,108,712,[{label:'Setting',w:270},{label:'Value',w:210},{label:'Availability',w:232,align:'right'}],rows,{rowH:62,size:18});
        G.panel(cv,t,804,54,772,458,'FAS and KAFAS providers');
        const f=C.fasStatus||{};
        const rows2=[
            ['FAS UCC region',uccRegion(f.functionUCC)],
            ['FAS traffic light',uccRegion(f.trafficLight)],
            ['FAS restart',uccRegion(f.restart)],
            ['FAS assistant',uccRegion(f.assistant)],
            ['Raw KAFAS camera',C.rawConn&&C.rawConn.available?'AVAILABLE':'WAITING'],
            ['Validated display bus',C.foresightConn&&C.foresightConn.available?'AVAILABLE':'WAITING']
        ];
        G.table(cv,t,828,108,724,[{label:'Provider',w:340},{label:'Live result',w:384,align:'right'}],rows2,{rowH:52,size:20});
        cv.text('REQUEST OEM ON only asks BMW settings to enable their own feature.',828,492,17,t.dim);
    }
    async function render(){
        if(useDemo()&&!C.setting)demo();const t=ctx.theme(),cv=ctx.canvas(W,H).clear(t.bg);
        [statusPage,eventsPage,regionalPage,chainPage][page](cv,t);
        const ns=C.nativeState();G.frame(cv,t,PAGES,page,[{text:ns.label,color:ns.color==='green'?GREEN:ns.color==='amber'?AMBER:ns.color==='red'?RED:t.dim},{text:'READ ONLY',color:CYAN}]);
        if(Date.now()-C.lastAlertAt<3500){cv.fillRect(0,0,W,H,'#08351caa');cv.text('GREEN LIGHT',W/2,H/2+20,86,GREEN,{align:'center',font:'bold'});}
        if(notice){cv.roundRect(430,416,740,70,18,'#171f29ee');cv.text(notice,800,460,23,t.text,{align:'center'});}
        await ui.image('MAIN_GFX',cv);
    }
    ui.onClick('BTN_PAGE',()=>{page=(page+1)%PAGES.length;});
    ui.onClick('BTN_ACTION',async()=>{notice='';try{await C.toggle();notice=C.notice;}catch(e){notice=e.message;}setTimeout(()=>{notice='';},6500);});
    if(ctx.app&&ctx.app.on)ctx.app.on('shutdown',()=>C.close());
    ctx.onTab((i)=>{page=Math.max(0,Math.min(PAGES.length-1,i));});ctx.loop('MAIN',60,render);
}});
