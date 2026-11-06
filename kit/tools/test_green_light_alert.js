'use strict';
const assert=require('assert');
const path=require('path');
const {Controller,enumNumber}=require(path.resolve(__dirname,'..','..','apps','green_light_alert','controller'));

assert.strictEqual(enumNumber('AMPEL_ROT'),12);
assert.strictEqual(enumNumber('AMPEL_GRUEN'),15);
assert.strictEqual(enumNumber({value:2}),2);

const writes=[];
const ctx={preview:false,log:{warn:()=>{},info:()=>{}},signals:{set:async(_p,n,v)=>writes.push([n,v])}};
const c=new Controller(ctx,()=>{});
c.foresightConn={available:true,proxy:{}};
c.speed=0;
c.receiveForesight({dispForesightEvent:12});
c.receiveForesight({dispForesightEvent:15});
assert.strictEqual(c.history[0].title,'GREEN LIGHT');
assert.ok(c.lastAlertAt>0);
c.receiveForesight({dispForesightEvent:14});
c.receiveForesight({dispForesightEvent:15});
assert.strictEqual(c.history.filter((e)=>e.title==='GREEN LIGHT').length,1,'yellow to green must not create an alert');

const c2=new Controller(ctx,()=>{});
c2.foresightConn={available:true,proxy:{}};
c2.speed=0;
c2.receiveForesight({dispForesightEvent:12});
c2.receiveForesight({dispForesightEvent:11});
c2.receiveForesight({dispForesightEvent:15});
assert.strictEqual(c2.history[0].title,'GREEN LIGHT','an intermediate uncertain event must not disarm a recognised red light');
c2.receiveSetting('settingTrafficlightDriveOff',{value:'ACTIVATED',availability:'OPERABLE'});
assert.strictEqual(c2.setting.value,2);
assert.strictEqual(c2.nativeState().label,'OEM ACTIVE');

const c3=new Controller(ctx,()=>{});
c3.rawConn={available:true,proxy:{}};
c3.speed=0;
c3.configureRaw(1,3);
c3.receiveRawLight({trafficLightID:7,trafficLightColor:1,trafficLightStatus:1,qualityRecognitionTrafficLight:1});
c3.receiveRawLight({trafficLightID:7,trafficLightColor:3,trafficLightStatus:1,qualityRecognitionTrafficLight:1});
assert.strictEqual(c3.history[0].title,'GREEN LIGHT','raw camera red-to-green transition must create an alert');
assert.strictEqual(c3.nativeState().label,'RAW KAFAS LIVE');

(async()=>{
    c.receiveSetting('settingTrafficlightDriveOff',{value:'ACTIVATED',availability:'OPERABLE'});
    c.settingConn={proxy:{}};
    await c.toggle();
    assert.strictEqual(writes.length,2);
    assert.strictEqual(writes[0][1].value,2);
    assert.ok(c.notice.indexOf('settingDriveOffReminder accepted')===0);
    assert.strictEqual(c.nativeState().label,'OEM ACTIVE');
    console.log('Green Light Alert transition filter and KAFAS provider-state checks passed.');
})().catch((e)=>{console.error(e);process.exit(1);});
