'use strict';

const FORESIGHT='de.bmw.dass.driverassistanceapplications.TrafficSignDisplayControl';
const SETTINGS='de.bmw.dass.settingsdriverassistancefunctions.SettingsDriverAssistanceFunctions';
const VEHICLE='de.bmw.infotainment.vehicle.Vehicle2';
const FASUS='de.bmw.infotainment.fasus.FASuS';
const RAWLIGHT='de.bmw.environmentalmodel.TrafficLightRecognitionFrontCameraLegacy';
const GONG='de.bmw.infotainment.gp.gongplayer.IGPCommand';
const GPS='de.bmw.infotainment.GPSData';
const BERLIN_POSITION={statusGPSLongitudeCAN:2195741482,statusGPSLatitudeCAN:2336555677};

const EVENTS={
    0:'No traffic-light display', 10:'Light · no prediction', 11:'Light · uncertain',
    12:'RED', 13:'RED + YELLOW', 14:'YELLOW', 15:'GREEN', 16:'GREEN · PULSING',
    17:'GREEN ARROW · UPPER RIGHT', 18:'GREEN ARROW · LOWER RIGHT'
};
const RED=new Set([12,13]);
const GREEN=new Set([15,16,17,18]);
const finite=(n)=>typeof n==='number'&&Number.isFinite(n);

function enumNumber(v){
    if(finite(v))return v;
    if(v&&finite(v.value))return v.value;
    if(v&&finite(v._value))return v._value;
    if(typeof v==='string'){
        const byName={KEINE_ANZEIGE:0,AMPEL_OHNE_PRAEDIKTION:10,AMPEL_UNSICHER:11,AMPEL_ROT:12,
            AMPEL_ROT_GELB:13,AMPEL_GELB:14,AMPEL_GRUEN:15,AMPEL_GRUEN_PULSIEREND:16,
            AMPEL_GRUEN_SCHILD_RECHTS_OBEN:17,AMPEL_GRUEN_SCHILD_RECHTS_UNTEN:18,
            ACTIVATED:2,DEACTIVATED:1,NOT_CONFIGURABLE:0,OPERABLE:2,NOT_OPERABLE:1,NOT_AVAILABLE:0,
            FUNKTION_IN_DIESER_REGION_VERFUEGBAR:0,FUNKTION_IN_DIESER_REGION_NICHT_VERFUEGBAR:1,
            FUNKTION_IN_DIESER_REGION_NUR_BESCHRAENKT_VERFUEGBAR:2,SIGNAL_UNBEFUELLT:3};
        if(Object.prototype.hasOwnProperty.call(byName,v))return byName[v];
        const n=Number(v);if(finite(n))return n;
    }
    return null;
}

class Controller{
    constructor(ctx,changed){
        this.ctx=ctx;this.changed=changed||(()=>{});this.setting=null;this.speed=null;this.foresight=null;
        this.settings={driveOffReminder:null,trafficlightDriveOff:null};
        this.settingConn=null;this.foresightConn=null;this.vehicleConn=null;this.fasusConn=null;this.rawConn=null;this.gongConn=null;
        this.gpsConn=null;this.gpsPosition=null;
        this.fasStatus=null;this.rawLight=null;this.rawLights=new Map();this.rawRedCode=1;this.rawGreenCode=3;
        this.notice='Searching for the raw KAFAS traffic-light camera provider';
        this.busy=false;this.history=[];this.armedAt=0;this.lastAlertAt=0;this.closed=false;this.gongHandle=80;
        this.regionTest={state:'IDLE',startedAt:0,endsAt:0,original:null,before:null,during:null,result:'Not run'};
        this.regionPromise=null;
    }
    configureRaw(red,green){
        const r=Number(red),g=Number(green);
        if(Number.isInteger(r)&&r>=0&&r<15)this.rawRedCode=r;
        if(Number.isInteger(g)&&g>=0&&g<15)this.rawGreenCode=g;
    }
    receiveSetting(name,v){
        if(!v)return;
        const key=name==='settingTrafficlightDriveOff'?'trafficlightDriveOff':'driveOffReminder';
        const previous=this.settings[key];
        const state={value:enumNumber(v.value),availability:enumNumber(v.availability),raw:v,at:Date.now()};
        this.settings[key]=state;
        if(this.ctx.log&&this.ctx.log.info)this.ctx.log.info('OEM setting '+name+': value='+state.value+', availability='+state.availability);
        this.setting=this.settings.trafficlightDriveOff||this.settings.driveOffReminder;
        this.notice=this.setting.availability===2?(this.setting.value===2?'BMW traffic-light drive-off setting is ON':
            this.setting.value===1?'BMW traffic-light drive-off setting is OFF':'BMW drive-off setting is not configurable'):
            this.setting.availability===1?'BMW feature is present but not operable now':'BMW feature is unavailable for this configuration or country';
        if(previous&&(previous.value!==state.value||previous.availability!==state.availability))
            this.record('OEM SETTING',name+': value '+state.value+', availability '+state.availability);
        this.changed();
    }
    receiveSpeed(v){const n=v&&v.speedVehicleCentreOfGravity;if(finite(n)&&n<65535)this.speed=n*0.015625;this.changed();}
    receiveGpsPosition(v){
        if(!v||!finite(v.statusGPSLongitudeCAN)||!finite(v.statusGPSLatitudeCAN))return;
        this.gpsPosition={statusGPSLongitudeCAN:v.statusGPSLongitudeCAN,statusGPSLatitudeCAN:v.statusGPSLatitudeCAN,at:Date.now()};
        this.changed();
    }
    receiveFasStatus(v){
        if(!v)return;
        const pick=(name)=>enumNumber(v[name]);
        this.fasStatus={
            functionUCC:pick('statusfunctionUCC'),
            trafficLight:pick('statusUCCTrafficLight'),
            restart:pick('statusUCCRestartTrafficLight'),
            assistant:pick('statusTrafficLightAssistance'),
            raw:v,at:Date.now()
        };
        const u=this.fasStatus.functionUCC;
        if(u===0)this.notice='BMW FAS reports UCC available in this region';
        else if(u===1)this.notice='BMW FAS explicitly reports UCC unavailable in this region';
        else if(u===2)this.notice='BMW FAS reports UCC only partly available in this region';
        else this.notice='BMW FAS regional UCC status is not populated';
        if(this.ctx.log&&this.ctx.log.info)this.ctx.log.info('FAS UCC regional status='+u+', trafficLight='+this.fasStatus.trafficLight+', restart='+this.fasStatus.restart+', assistant='+this.fasStatus.assistant);
        this.changed();
    }
    receiveForesight(v){
        if(!v)return;const code=enumNumber(v.dispForesightEvent),now=Date.now();
        if(code===null)return;const previous=this.foresight&&this.foresight.code;
        this.foresight={code,label:EVENTS[code]||('Event '+code),raw:v,at:now};
        const stopped=this.speed===null||this.speed<3;
        if(RED.has(code)&&stopped)this.armedAt=now;
        const armed=this.armedAt&&stopped&&now-this.armedAt<600000;
        if(GREEN.has(code)&&armed&&now-this.lastAlertAt>8000){
            this.triggerGreen('BMW DISPLAY','changed from '+EVENTS[previous]+' to '+EVENTS[code]);
        }else if(previous!==null&&previous!==undefined&&previous!==code&&EVENTS[code])this.record(EVENTS[code],'KAFAS display event changed');
        if(this.speed!==null&&this.speed>5)this.armedAt=0;
        this.changed();
    }
    receiveRawLight(v){
        if(!v)return;
        const now=Date.now(),id=enumNumber(v.trafficLightID),color=enumNumber(v.trafficLightColor);
        if(color===null||color===15)return;
        const key=id===null||id===63?'global':String(id),previous=this.rawLights.get(key);
        const light={id,color,status:enumNumber(v.trafficLightStatus),arrow:enumNumber(v.trafficLightArrow),
            direction:enumNumber(v.trafficLightIndicateDirection),quality:enumNumber(v.qualityRecognitionTrafficLight),
            x:enumNumber(v.trafficLightPositionX),y:enumNumber(v.trafficLightPositionY),z:enumNumber(v.trafficLightPositionZ),raw:v,at:now};
        this.rawLights.set(key,light);this.rawLight=light;
        const stopped=this.speed===null||this.speed<3;
        if(color===this.rawRedCode&&stopped){this.armedAt=now;light.armedAt=now;}
        const sameWasRed=previous&&previous.color===this.rawRedCode;
        const recentlyArmed=this.armedAt&&stopped&&now-this.armedAt<600000;
        if(color===this.rawGreenCode&&stopped&&(sameWasRed||recentlyArmed)&&now-this.lastAlertAt>8000){
            this.triggerGreen('RAW KAFAS','camera light '+key+' changed '+(previous?previous.color:'?')+' -> '+color);
        }else if(!previous||previous.color!==color){
            this.record('RAW LIGHT','ID '+key+' color '+color+' status '+light.status+' quality '+light.quality);
        }
        if(this.speed!==null&&this.speed>5)this.armedAt=0;
        this.notice='Raw KAFAS camera feed is live';this.changed();
    }
    triggerGreen(source,detail){
        const now=Date.now();this.lastAlertAt=now;this.armedAt=0;this.record('GREEN LIGHT',source+': '+detail);
        this.playGong().catch((e)=>{if(this.ctx.log&&this.ctx.log.warn)this.ctx.log.warn('green-light gong: '+e.message);});
    }
    async playGong(){
        const c=this.gongConn;if(!c||!c.proxy||!c.available)return;
        this.gongHandle=(this.gongHandle+1)&255;
        await this.ctx.signals.call(c.proxy,'requestGong',{location:0,identifier:208,handle:this.gongHandle,duration:0,type:16,distance:0,angle:0},2500);
    }
    record(title,detail){this.history.unshift({at:Date.now(),title,detail});this.history=this.history.slice(0,10);}
    async openWatch(iface,field,receive){
        const c={proxy:null,available:false};
        try{
            c.proxy=await this.ctx.signals.proxy(iface,'1');
            await this.ctx.signals.onAvailable(c.proxy,(a)=>{c.available=a;this.changed();});
            await this.ctx.signals.on(c.proxy,field,receive,this.ctx.log);
            if(c.proxy.isAvailable&&c.proxy.isAvailable())c.available=true;
        }catch(e){c.error=e.message;this.ctx.log.warn(iface+'.'+field+': '+e.message);}
        return c;
    }
    async start(){
        if(this.ctx.preview||!this.ctx.signals||typeof this.ctx.signals.hasNative!=='function'||!this.ctx.signals.hasNative()){
            this.notice='Preview · native traffic-light setting simulated';return;
        }
        await Promise.all([
            this.openWatch(FORESIGHT,'displayForesight',(v)=>this.receiveForesight(v)).then((c)=>{this.foresightConn=c;}),
            this.openWatch(RAWLIGHT,'RecognitionTrafficLightCamera',(v)=>this.receiveRawLight(v)).then((c)=>{this.rawConn=c;}),
            this.openWatch(GONG,'gongStatusChangeAndConfirmation',()=>{}).then((c)=>{this.gongConn=c;}),
            this.ctx.signals.watch(SETTINGS,'1',{
                settingDriveOffReminder:(v)=>this.receiveSetting('settingDriveOffReminder',v),
                settingTrafficlightDriveOff:(v)=>this.receiveSetting('settingTrafficlightDriveOff',v)
            },this.ctx.log,{pollMs:5000}).then((c)=>{
                this.settingConn=c;
                if(this.ctx.log&&this.ctx.log.info)this.ctx.log.info('OEM settings watch: available='+c.available+(c.error?', error='+c.error:''));
            }),
            this.ctx.signals.watch(VEHICLE,'1',{statusCarSpeed2:(v)=>this.receiveSpeed(v)},this.ctx.log,{pollMs:1000}).then((c)=>{this.vehicleConn=c;})
            ,this.ctx.signals.watch(GPS,'1',{GPSPositionCAN:(v)=>this.receiveGpsPosition(v)},this.ctx.log,{pollMs:1000}).then((c)=>{this.gpsConn=c;})
            ,this.ctx.signals.watch(FASUS,'1',{statusIDriveFASExtended:(v)=>this.receiveFasStatus(v)},this.ctx.log,{pollMs:1000}).then((c)=>{this.fasusConn=c;})
        ]);
        this.changed();
    }
    nativeState(){
        if(this.rawConn&&this.rawConn.available)return {label:'RAW KAFAS LIVE',color:'green'};
        if(this.setting&&this.setting.availability===2&&this.setting.value!==2)return {label:'OEM SETTING OFF',color:'amber'};
        if(this.setting&&this.setting.availability!==2)return {label:'OEM NOT OPERABLE',color:'amber'};
        if(this.foresightConn&&this.foresightConn.available&&this.setting&&this.setting.value===2)return {label:'OEM ACTIVE',color:'green'};
        if(this.foresightConn&&this.foresightConn.available)return {label:'KAFAS CONNECTED',color:'green'};
        return {label:'KAFAS WAITING',color:'amber'};
    }
    async toggle(){
        const c=this.settingConn;
        if(!c||!c.proxy)throw new Error('BMW settings provider is not connected');
        const requested={value:2,availability:2};
        const results=[];
        for(const name of ['settingDriveOffReminder','settingTrafficlightDriveOff']){
            try{
                await this.ctx.signals.set(c.proxy,name,requested,5000);
                results.push(name+' accepted');
                if(this.ctx.log&&this.ctx.log.info)this.ctx.log.info('OEM activation request accepted for '+name);
            }catch(e){
                results.push(name+' rejected: '+e.message);
                if(this.ctx.log&&this.ctx.log.warn)this.ctx.log.warn('OEM activation request '+name+': '+e.message);
            }
        }
        this.notice=results.join(' | ');
        this.record('OEM REQUEST',this.notice);
        this.changed();
    }
    async setGpsPosition(value){
        const c=this.gpsConn;
        if(!c||!c.proxy||!c.available)throw new Error('BMW GPSData provider is not connected');
        await this.ctx.signals.set(c.proxy,'GPSPositionCAN',value,3000);
    }
    async restoreRegionTest(){
        const t=this.regionTest;
        if(!t.original)return;
        for(let i=0;i<3;i++){
            try{await this.setGpsPosition(t.original);}catch(e){if(i===2)throw e;}
            await new Promise((resolve)=>setTimeout(resolve,180));
        }
    }
    async startGermanyTest(){
        if(this.regionTest.state==='RUNNING')throw new Error('Germany simulation is already running');
        if(!finite(this.speed))throw new Error('Wait for a valid vehicle-speed signal');
        if(this.speed>0.5)throw new Error('Start the Germany test only while stationary');
        if(!this.gpsPosition)throw new Error('Wait for the original GPS position');
        if(!this.gpsConn||!this.gpsConn.available)throw new Error('BMW GPSData provider is unavailable');
        const original={statusGPSLongitudeCAN:this.gpsPosition.statusGPSLongitudeCAN,statusGPSLatitudeCAN:this.gpsPosition.statusGPSLatitudeCAN};
        this.regionTest={state:'RUNNING',startedAt:Date.now(),endsAt:0,original,
            before:this.fasStatus&&this.fasStatus.functionUCC,during:null,result:'Injecting Berlin GPS position'};
        await this.setGpsPosition(BERLIN_POSITION);
        this.record('GERMANY TEST','Germany context ON; original GPS saved');this.changed();
        this.regionPromise=this.germanyLoop();
        return 'Germany context ON';
    }
    async germanyLoop(){
        try{
            while(!this.closed&&this.regionTest.state==='RUNNING'){
                await this.setGpsPosition(BERLIN_POSITION);
                const regional=this.fasStatus&&this.fasStatus.functionUCC;
                if(regional!==null&&regional!==undefined)this.regionTest.during=regional;
                this.changed();
                await new Promise((resolve)=>setTimeout(resolve,750));
            }
        }catch(e){
            this.regionTest.result='ERROR: '+e.message;this.regionTest.state='ERROR';this.record('GERMANY TEST',this.regionTest.result);
            try{await this.restoreRegionTest();}catch(e){this.regionTest.result+='; restore failed: '+e.message;}
            this.changed();
        }
    }
    async stopGermanyTest(){
        if(this.regionTest.state!=='RUNNING'&&this.regionTest.state!=='ERROR')return 'Germany context is not active';
        if(this.regionTest.state==='RUNNING'){
            this.regionTest.state='STOPPING';
            if(this.regionPromise)await this.regionPromise;
        }
        const changed=this.regionTest.before!==0&&this.regionTest.during===0;
        this.regionTest.result=changed?'PASS: BMW UCC changed to available in Germany context':
            'NO CHANGE: BMW UCC stayed '+String(this.regionTest.during)+'; GPS alone is not its regional input';
        try{await this.restoreRegionTest();}catch(e){this.regionTest.result+='; restore failed: '+e.message;}
        this.regionTest.state='COMPLETE';this.regionTest.endsAt=Date.now();this.record('GERMANY TEST',this.regionTest.result);this.changed();
        return this.regionTest.result;
    }
    async toggleGermanyTest(){return this.regionTest.state==='RUNNING'?this.stopGermanyTest():this.startGermanyTest();}
    close(){
        this.closed=true;
        const shutdown=()=>[this.settingConn,this.foresightConn,this.vehicleConn,this.fasusConn,this.rawConn,this.gongConn,this.gpsConn].forEach((c)=>{if(c&&c.shutdown)Promise.resolve(c.shutdown()).catch(()=>{});else{const p=c&&c.proxy;if(p&&p.shutdown)Promise.resolve(p.shutdown()).catch(()=>{});}});
        if(this.regionTest.state==='RUNNING'){
            this.regionTest.state='STOPPING';
            Promise.resolve(this.regionPromise).catch(()=>{}).then(()=>this.restoreRegionTest()).catch(()=>{}).finally(shutdown);
        }else shutdown();
    }
}

module.exports={Controller,EVENTS,RED,GREEN,enumNumber,BERLIN_POSITION};
