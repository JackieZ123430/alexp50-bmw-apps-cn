'use strict';

const FORESIGHT='de.bmw.dass.driverassistanceapplications.TrafficSignDisplayControl';
const SETTINGS='de.bmw.dass.settingsdriverassistancefunctions.SettingsDriverAssistanceFunctions';
const VEHICLE='de.bmw.infotainment.vehicle.Vehicle2';
const FASUS='de.bmw.infotainment.fasus.FASuS';
const RAWLIGHT='de.bmw.environmentalmodel.TrafficLightRecognitionFrontCameraLegacy';
const GONG='de.bmw.infotainment.gp.gongplayer.IGPCommand';
const ADAS_COUNTRY='de.bmw.infotainment.navigation.externalize.adasng.CCP';

const EVENTS={
    0:'No traffic-light display',10:'Light - no prediction',11:'Light - uncertain',
    12:'RED',13:'RED + YELLOW',14:'YELLOW',15:'GREEN',16:'GREEN - PULSING',
    17:'GREEN ARROW - UPPER RIGHT',18:'GREEN ARROW - LOWER RIGHT'
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
            FUNCTION_AVAILABLE_IN_YOUR_COUNTRY:0,FUNCTION_RESTRICTED_AVAILABLE_IN_YOUR_COUNTRY:1,
            FUNCTION_NOT_AVAILABLE_IN_YOUR_COUNTRY:2,
            FUNKTION_IN_DIESER_REGION_VERFUEGBAR:0,FUNKTION_IN_DIESER_REGION_NICHT_VERFUEGBAR:1,
            FUNKTION_IN_DIESER_REGION_NUR_BESCHRAENKT_VERFUEGBAR:2,SIGNAL_UNBEFUELLT:3};
        if(Object.prototype.hasOwnProperty.call(byName,v))return byName[v];
        const n=Number(v);if(finite(n))return n;
    }
    return null;
}

function textValue(v){
    if(v===null||v===undefined)return null;
    if(Buffer.isBuffer(v))return v.toString('utf8').replace(/\0+$/,'').trim();
    if(typeof v==='string')return v.replace(/\0+$/,'').trim();
    if(v&&Object.prototype.hasOwnProperty.call(v,'value'))return textValue(v.value);
    if(v&&Object.prototype.hasOwnProperty.call(v,'countryCode'))return textValue(v.countryCode);
    return String(v);
}

class Controller{
    constructor(ctx,changed){
        this.ctx=ctx;this.changed=changed||(()=>{});this.setting=null;this.speed=null;this.foresight=null;
        this.settings={driveOffReminder:null,trafficlightDriveOff:null,trafficlightBraking:null,stopSignBraking:null,urbanCruiseControlMode:null};
        this.settingConn=null;this.foresightConn=null;this.vehicleConn=null;this.fasusConn=null;this.rawConn=null;this.gongConn=null;this.countryConn=null;
        this.fasStatus=null;this.displayStatusUcc=null;this.adasCountry=null;this.rawLight=null;this.rawLights=new Map();this.rawRedCode=1;this.rawGreenCode=3;
        this.notice='Searching for the raw KAFAS traffic-light camera provider';
        this.busy=false;this.history=[];this.armedAt=0;this.lastAlertAt=0;this.closed=false;this.gongHandle=80;
    }
    configureRaw(red,green){
        const r=Number(red),g=Number(green);
        if(Number.isInteger(r)&&r>=0&&r<15)this.rawRedCode=r;
        if(Number.isInteger(g)&&g>=0&&g<15)this.rawGreenCode=g;
    }
    settingKey(name){
        const keys={settingDriveOffReminder:'driveOffReminder',settingTrafficlightDriveOff:'trafficlightDriveOff',
            settingTrafficlightBraking:'trafficlightBraking',settingStopSignBraking:'stopSignBraking',
            settingUrbanCruiseControlMode:'urbanCruiseControlMode'};
        return keys[name]||name;
    }
    receiveSetting(name,v){
        if(!v)return;
        const key=this.settingKey(name),previous=this.settings[key];
        const state={value:enumNumber(v.value),availability:enumNumber(v.availability),
            availabilityDeactivated:enumNumber(v.availabilityDeactivated),raw:v,at:Date.now()};
        this.settings[key]=state;
        if(this.ctx.log&&this.ctx.log.info)this.ctx.log.info('OEM setting '+name+': value='+state.value+', availability='+state.availability);
        this.setting=this.settings.trafficlightDriveOff||this.settings.driveOffReminder;
        if(previous&&(previous.value!==state.value||previous.availability!==state.availability))
            this.record('OEM SETTING',name+': value '+state.value+', availability '+state.availability);
        this.updateNotice();this.changed();
    }
    receiveDisplayStatusUcc(v){
        const value=enumNumber(v);
        if(value===null)return;
        const previous=this.displayStatusUcc;
        this.displayStatusUcc={value,raw:v,at:Date.now()};
        if(!previous||previous.value!==value)this.record('COUNTRY DISPLAY','Urban Cruise Control country status '+value);
        this.updateNotice();this.changed();
    }
    receiveCountry(v){
        const code=textValue(v);
        if(!code)return;
        const previous=this.adasCountry&&this.adasCountry.code;
        this.adasCountry={code,raw:v,at:Date.now()};
        if(previous!==code)this.record('ADAS COUNTRY','Map country changed '+(previous||'--')+' -> '+code);
        this.updateNotice();this.changed();
    }
    receiveSpeed(v){const n=v&&v.speedVehicleCentreOfGravity;if(finite(n)&&n<65535)this.speed=n*0.015625;this.changed();}
    receiveFasStatus(v){
        if(!v)return;
        const pick=(name)=>enumNumber(v[name]);
        this.fasStatus={functionUCC:pick('statusfunctionUCC'),trafficLight:pick('statusUCCTrafficLight'),
            restart:pick('statusUCCRestartTrafficLight'),stopSign:pick('statusUCCStopSign'),
            assistant:pick('statusTrafficLightAssistance'),raw:v,at:Date.now()};
        if(this.ctx.log&&this.ctx.log.info)this.ctx.log.info('FAS UCC regional status='+this.fasStatus.functionUCC+', trafficLight='+this.fasStatus.trafficLight+', restart='+this.fasStatus.restart+', assistant='+this.fasStatus.assistant);
        this.updateNotice();this.changed();
    }
    regionalDiagnosis(){
        const fas=this.fasStatus&&this.fasStatus.functionUCC;
        const display=this.displayStatusUcc&&this.displayStatusUcc.value;
        const setting=this.settings.trafficlightDriveOff||this.settings.driveOffReminder;
        const availability=setting&&setting.availability;
        if(fas===0&&this.settingConn&&this.settingConn.available===false)
            return {level:'blocked',title:'NATIVE SETTINGS PROVIDER ABSENT',detail:'Romania passes the FAS region gate, but BMW service 0x3055 is not offered. Native UCC activation cannot complete on this vehicle software/production cohort.'};
        if(fas===0&&display===0)return {level:'ok',title:'REGION ACCEPTED',detail:'BMW FAS and the country-display provider both allow UCC here.'};
        if(display===2&&fas===1)return {level:'blocked',title:'COUNTRY GATE CONFIRMED',detail:'BMW country eligibility and FAS both reject this region. This is downstream of the all-country FDL masks.'};
        if(display===0&&fas===1)return {level:'blocked',title:'FAS / ECU GATE',detail:'The country-display provider allows the country, but FAS still rejects UCC. Check SAS/VIP presence and synchronized coding.'};
        if(display===1)return {level:'limited',title:'COUNTRY SUPPORT LIMITED',detail:'BMW marks UCC as restricted in this country; individual subfunctions decide what remains usable.'};
        if(availability===0)return {level:'blocked',title:'SETTING PROVIDER REJECTS FEATURE',detail:'The traffic-light setting exists in the catalog but is unavailable in the current vehicle configuration.'};
        if(availability===1)return {level:'limited',title:'FEATURE PRESENT, NOT OPERABLE',detail:'The setting provider recognizes it but currently refuses operation.'};
        if(fas===1)return {level:'blocked',title:'FAS REGION REJECTED',detail:'FAS explicitly reports UCC unavailable in the current region.'};
        return {level:'waiting',title:'WAITING FOR REGIONAL INPUTS',detail:'Open this page after the car is awake and navigation has identified the current country.'};
    }
    updateNotice(){
        const d=this.regionalDiagnosis();
        if(d.level!=='waiting'){this.notice=d.detail;return;}
        if(this.rawConn&&this.rawConn.available)this.notice='Raw KAFAS camera feed is live';
        else this.notice=d.detail;
    }
    receiveForesight(v){
        if(!v)return;const code=enumNumber(v.dispForesightEvent),now=Date.now();
        if(code===null)return;const previous=this.foresight&&this.foresight.code;
        this.foresight={code,label:EVENTS[code]||('Event '+code),raw:v,at:now};
        const stopped=this.speed===null||this.speed<3;
        if(RED.has(code)&&stopped)this.armedAt=now;
        const armed=this.armedAt&&stopped&&now-this.armedAt<600000;
        if(GREEN.has(code)&&armed&&now-this.lastAlertAt>8000)this.triggerGreen('BMW DISPLAY','changed from '+EVENTS[previous]+' to '+EVENTS[code]);
        else if(previous!==null&&previous!==undefined&&previous!==code&&EVENTS[code])this.record(EVENTS[code],'KAFAS display event changed');
        if(this.speed!==null&&this.speed>5)this.armedAt=0;this.changed();
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
        if(color===this.rawGreenCode&&stopped&&(sameWasRed||recentlyArmed)&&now-this.lastAlertAt>8000)
            this.triggerGreen('RAW KAFAS','camera light '+key+' changed '+(previous?previous.color:'?')+' -> '+color);
        else if(!previous||previous.color!==color)this.record('RAW LIGHT','ID '+key+' color '+color+' status '+light.status+' quality '+light.quality);
        if(this.speed!==null&&this.speed>5)this.armedAt=0;this.updateNotice();this.changed();
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
            this.notice='Preview - regional inputs simulated';return;
        }
        await Promise.all([
            this.openWatch(FORESIGHT,'displayForesight',(v)=>this.receiveForesight(v)).then((c)=>{this.foresightConn=c;}),
            this.openWatch(RAWLIGHT,'RecognitionTrafficLightCamera',(v)=>this.receiveRawLight(v)).then((c)=>{this.rawConn=c;}),
            this.openWatch(GONG,'gongStatusChangeAndConfirmation',()=>{}).then((c)=>{this.gongConn=c;}),
            this.ctx.signals.watch(SETTINGS,'1',{
                displayStatusUrbanCruiseControl:(v)=>this.receiveDisplayStatusUcc(v),
                settingDriveOffReminder:(v)=>this.receiveSetting('settingDriveOffReminder',v),
                settingTrafficlightDriveOff:(v)=>this.receiveSetting('settingTrafficlightDriveOff',v),
                settingTrafficlightBraking:(v)=>this.receiveSetting('settingTrafficlightBraking',v),
                settingStopSignBraking:(v)=>this.receiveSetting('settingStopSignBraking',v),
                settingUrbanCruiseControlMode:(v)=>this.receiveSetting('settingUrbanCruiseControlMode',v)
            },this.ctx.log,{pollMs:5000}).then((c)=>{this.settingConn=c;}),
            this.ctx.signals.watch(VEHICLE,'1',{statusCarSpeed2:(v)=>this.receiveSpeed(v)},this.ctx.log,{pollMs:1000}).then((c)=>{this.vehicleConn=c;}),
            this.ctx.signals.watch(ADAS_COUNTRY,'1',{countryCode:(v)=>this.receiveCountry(v)},this.ctx.log,{pollMs:3000}).then((c)=>{this.countryConn=c;}),
            this.ctx.signals.watch(FASUS,'1',{statusIDriveFASExtended:(v)=>this.receiveFasStatus(v)},this.ctx.log,{pollMs:1000}).then((c)=>{this.fasusConn=c;})
        ]);
        this.updateNotice();this.changed();
    }
    nativeState(){
        if(this.rawConn&&this.rawConn.available)return {label:'RAW KAFAS LIVE',color:'green'};
        const d=this.regionalDiagnosis();
        if(d.level==='blocked')return {label:'REGION BLOCKED',color:'red'};
        if(d.level==='limited')return {label:'REGION LIMITED',color:'amber'};
        if(d.level==='ok')return {label:'REGION ACCEPTED',color:'green'};
        if(this.setting&&this.setting.availability===2&&this.setting.value!==2)return {label:'OEM SETTING OFF',color:'amber'};
        if(this.foresightConn&&this.foresightConn.available)return {label:'KAFAS CONNECTED',color:'green'};
        return {label:'KAFAS WAITING',color:'amber'};
    }
    async toggle(){
        const c=this.settingConn;if(!c||!c.proxy)throw new Error('BMW settings provider is not connected');
        const requested={value:2,availability:2},results=[];
        for(const name of ['settingDriveOffReminder','settingTrafficlightDriveOff']){
            try{await this.ctx.signals.set(c.proxy,name,requested,5000);results.push(name+' accepted');}
            catch(e){results.push(name+' rejected: '+e.message);}
        }
        this.notice=results.join(' | ');this.record('OEM REQUEST',this.notice);this.changed();
    }
    close(){
        this.closed=true;
        [this.settingConn,this.foresightConn,this.vehicleConn,this.fasusConn,this.rawConn,this.gongConn,this.countryConn].forEach((c)=>{
            if(c&&c.shutdown)Promise.resolve(c.shutdown()).catch(()=>{});
            else{const p=c&&c.proxy;if(p&&p.shutdown)Promise.resolve(p.shutdown()).catch(()=>{});}
        });
    }
}

module.exports={Controller,EVENTS,RED,GREEN,enumNumber,textValue};
