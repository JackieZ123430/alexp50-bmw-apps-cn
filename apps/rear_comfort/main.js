'use strict';

const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { RearControl } = require('./control');

const W = 1600, H = 520;
const PAGES = ['Overview', 'Climate', 'Seats', 'Position', 'Shades', 'Screens'];
const C = { cyan:'#32d6d0', blue:'#52a6ff', green:'#35da86', amber:'#ffb52e', red:'#ff4b55', violet:'#a783ff' };
const finite = (n) => typeof n === 'number' && isFinite(n);
const clean = (v) => String(v == null ? '' : v).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
const short = (v, n) => { const s = clean(v); return s.length > n ? s.slice(0, n - 3) + '...' : s; };
const temp = (v) => finite(v) && v >= 16 && v <= 32 ? v.toFixed(0) + ' C' : '--';
const isScreenOn = (v) => /USER_ON|FULL_ON|ENTERTAINMENT|WELCOME|ICONIC/.test(String(v || ''));

mgu.run({ async start(ctx) {
    let page = 0, selected = 0, side = 'left', notice = '', noticeGood = false, hits = [], actions = [];
    const rear = new RearControl(ctx.signals, ctx.log, () => {});

    function run(label, fn) {
        notice = label + '...'; noticeGood = false;
        Promise.resolve().then(fn).then((message) => {
            notice = message || label + ' accepted'; noticeGood = true;
        }).catch((e) => {
            notice = short(e && e.message || e, 110); noticeGood = false; ctx.log.warn(notice);
        });
    }
    function addAction(label, fn, x, y, w, h) {
        const i = actions.length; actions.push({ label, fn });
        if (x !== undefined) hits.push({ x, y, w, h, fn: () => { selected = i; fn(); } });
        return i;
    }
    function button(cv, t, x, y, w, h, label, fn, color, on) {
        const i = addAction(label, fn, x, y, w, h), focus = i === selected;
        cv.roundRect(x, y, w, h, 9, on ? color : withAlpha(color, focus ? 0.24 : 0.11));
        if (focus) cv.strokeRoundRect(x + 2, y + 2, w - 4, h - 4, 8, 3, '#ffffff');
        cv.text(label, x + w / 2, y + h / 2 + 8, 22, on ? '#071119' : color, { align:'center', font:'bold' });
    }
    function title(cv, t, heading, detail) {
        cv.text(heading, 34, 84, 32, t.text, { font:'bold' });
        cv.text(detail, 34, 113, 19, t.dim);
    }
    function panel(cv, t, x, y, w, h, label, color) {
        cv.roundRect(x, y, w, h, 10, withAlpha(t.text, 0.045));
        cv.fillRect(x, y, 5, h, color);
        cv.text(label.toUpperCase(), x + 20, y + 31, 17, t.dim, { font:'bold' });
    }
    function statusPill(cv, x, y, text, color) {
        cv.roundRect(x, y, 190, 36, 18, withAlpha(color, 0.18));
        cv.text(text, x + 95, y + 25, 16, color, { align:'center', font:'bold' });
    }
    function sideTabs(cv, t) {
        button(cv, t, 1055, 65, 242, 49, 'Rear left', () => { side = 'left'; selected = 0; }, C.blue, side === 'left');
        button(cv, t, 1311, 65, 242, 49, 'Rear right', () => { side = 'right'; selected = 0; }, C.blue, side === 'right');
    }
    function levelRow(cv, t, y, label, value, color, set) {
        cv.text(label, 60, y + 37, 20, t.dim, { font:'bold' });
        [0,1,2,3].forEach((n) => button(cv, t, 330 + n * 175, y, 155, 54, n ? String(n) : 'OFF', () => set(n), color, value === n));
    }
    function overview(cv, t, s) {
        title(cv, t, 'Rear compartment', 'All rear comfort functions from the front display');
        const cards = [
            ['Climate', s.climate.on ? 'ON' : 'OFF', temp(s.climate.left) + ' / ' + temp(s.climate.right), C.cyan, 1],
            ['Rear left seat', 'HEAT ' + s.left.heat + '  VENT ' + s.left.vent, 'Massage ' + s.left.massage, C.blue, 2],
            ['Rear right seat', 'HEAT ' + s.right.heat + '  VENT ' + s.right.vent, 'Massage ' + s.right.massage, C.blue, 2],
            ['Shades', 'LEFT / REAR / RIGHT', 'Individual or all', C.violet, 4],
            ['Rear screens', (isScreenOn(s.screens.left) ? 'ON' : 'OFF') + ' / ' + (isScreenOn(s.screens.right) ? 'ON' : 'OFF'), short(s.screens.focus, 22), C.green, 5]
        ];
        cards.forEach((c, i) => {
            const x = 32 + (i < 3 ? i * 512 : (i - 3) * 768), y = i < 3 ? 140 : 318, w = i < 3 ? 492 : 748, h = 154;
            panel(cv, t, x, y, w, h, c[0], c[3]);
            cv.text(c[1], x + 22, y + 83, i < 3 ? 28 : 32, c[3], { font:'bold' });
            cv.text(c[2], x + 22, y + 125, 19, t.dim);
            addAction(c[0], () => { page = c[4]; selected = 0; }, x, y, w, h);
            if (actions.length - 1 === selected) cv.strokeRoundRect(x + 2, y + 2, w - 4, h - 4, 9, 3, '#ffffff');
        });
    }
    function climate(cv, t, s) {
        title(cv, t, 'Rear climate', 'Independent temperature, rear blower and automatic mode');
        panel(cv, t, 32, 140, 492, 318, 'Rear left zone', C.cyan);
        panel(cv, t, 554, 140, 492, 318, 'Rear right zone', C.cyan);
        panel(cv, t, 1076, 140, 492, 318, 'Airflow', C.blue);
        [['left',32],['right',554]].forEach(([which,x]) => {
            const value = s.climate[which];
            cv.text(temp(value), x + 246, 252, 70, C.cyan, { align:'center', font:'bold' });
            button(cv,t,x+28,330,130,64,'- 1 C',()=>run('Temperature',()=>rear.setClimateTemperature(which,(finite(value)?value:22)-1)),C.cyan,false);
            button(cv,t,x+176,330,130,64,'22 C',()=>run('Temperature',()=>rear.setClimateTemperature(which,22)),C.cyan,value===22);
            button(cv,t,x+324,330,130,64,'+ 1 C',()=>run('Temperature',()=>rear.setClimateTemperature(which,(finite(value)?value:22)+1)),C.cyan,false);
        });
        cv.text('Blower  ' + (finite(s.climate.blower) ? s.climate.blower : '--'), 1104, 218, 34, C.blue, { font:'bold' });
        button(cv,t,1104,250,128,58,'LOWER',()=>run('Blower',()=>rear.setBlower(Math.max(1,(s.climate.blower||1)-1))),C.blue,false);
        button(cv,t,1248,250,128,58,'RAISE',()=>run('Blower',()=>rear.setBlower(Math.min(9,(s.climate.blower||1)+1))),C.blue,false);
        button(cv,t,1392,250,144,58,'AUTO',()=>run('Automatic',()=>rear.setClimateMode(true)),C.green,!!s.climate.auto);
        button(cv,t,1104,332,205,64,'CLIMATE ON',()=>run('Climate on',()=>rear.climatePower(true)),C.green,!!s.climate.on);
        button(cv,t,1327,332,209,64,'CLIMATE OFF',()=>run('Climate off',()=>rear.climatePower(false)),C.red,s.climate.on===false);
    }
    function seats(cv, t, s) {
        title(cv, t, 'Rear seat comfort', 'Heating, ventilation and massage are controlled independently'); sideTabs(cv,t);
        const st = s[side];
        panel(cv,t,32,140,1014,322,(side==='left'?'Left':'Right') + ' rear seat',C.blue);
        levelRow(cv,t,182,'HEATING',st.heat,C.red,(n)=>run('Seat heating',()=>rear.setSeatClimate(side,'heat',n)));
        levelRow(cv,t,256,'VENTILATION',st.vent,C.blue,(n)=>run('Seat ventilation',()=>rear.setSeatClimate(side,'vent',n)));
        levelRow(cv,t,330,'MASSAGE',st.massage,C.violet,(n)=>run('Massage',()=>rear.setMassage(side,n,st.program||1)));
        panel(cv,t,1076,140,492,322,'Massage programme',C.violet);
        cv.text('Programme ' + (st.program || 1), 1106, 216, 32, C.violet, {font:'bold'});
        [1,2,3,4].forEach((n,i)=>button(cv,t,1106+(i%2)*216,252+Math.floor(i/2)*78,196,60,'PROGRAMME '+n,
            ()=>run('Massage programme',()=>rear.setMassage(side,Math.max(1,st.massage||1),n)),C.violet,st.program===n));
    }
    function position(cv,t) {
        title(cv,t,'Rear seat position','Direct short movements from the front display'); sideTabs(cv,t);
        panel(cv,t,32,140,1536,322,(side==='left'?'Left':'Right') + ' rear seat adjustment',C.amber);
        const moves = [
            ['SLIDE FORWARD','seat','SEAT_ADJUSTMENT_HORIZONTAL_FRONT'],['SLIDE BACK','seat','SEAT_ADJUSTMENT_HORIZONTAL_BACK'],
            ['SEAT UP','seat','SEAT_ADJUSTMENT_VERTICAL_UP'],['SEAT DOWN','seat','SEAT_ADJUSTMENT_VERTICAL_DOWN'],
            ['BACKREST UP','seat','SEAT_ADJUSTMENT_BACKREST_ANGLE_FRONT'],['BACKREST BACK','seat','SEAT_ADJUSTMENT_BACKREST_ANGLE_BACK'],
            ['HEADREST UP','seat','SEAT_ADJUSTMENT_HEADREST_UP'],['HEADREST DOWN','seat','SEAT_ADJUSTMENT_HEADREST_DOWN'],
            ['FOOTREST OUT','seat','SEAT_ADJUSTMENT_FOOTREST_SWING_OUT'],['FOOTREST IN','seat','SEAT_ADJUSTMENT_FOOTREST_RETRACT'],
            ['CUSHION LONG','seat','SEAT_ADJUSTMENT_DEPTH_ENLARGE'],['CUSHION SHORT','seat','SEAT_ADJUSTMENT_DEPTH_REDUCE'],
            ['LUMBAR UP','lumbar','LORDOSENTASTER_OBEN'],['LUMBAR DOWN','lumbar','LORDOSENTASTER_UNTEN'],
            ['LUMBAR FIRMER','lumbar','LORDOSENTASTER_VOR'],['LUMBAR SOFTER','lumbar','LORDOSENTASTER_ZURUECK']
        ];
        moves.forEach((m,i)=>{const col=i%4,row=Math.floor(i/4);button(cv,t,58+col*378,164+row*70,348,54,m[0],
            ()=>run(m[0],()=>m[1]==='seat'?rear.moveSeat(side,m[2]):rear.lumbar(side,m[2])),C.amber,false);});
    }
    function shades(cv,t,s) {
        title(cv,t,'Rear sun protection','Move each blind individually or all blinds together');
        const data=[['LEFT DOOR','left',C.blue],['REAR WINDOW','rear',C.violet],['RIGHT DOOR','right',C.blue]];
        data.forEach((d,i)=>{const x=32+i*512;panel(cv,t,x,140,492,210,d[0],d[2]);cv.text(short(s.shades[d[1]]||'READY',24),x+246,232,25,d[2],{align:'center',font:'bold'});button(cv,t,x+38,280,416,56,'MOVE / STOP',()=>run(d[0],()=>rear.shade(d[1],'toggle')),d[2],false);});
        button(cv,t,32,382,752,76,'OPEN ALL SHADES',()=>run('Open all shades',()=>rear.shade('all','open')),C.green,false);
        button(cv,t,816,382,752,76,'CLOSE ALL SHADES',()=>run('Close all shades',()=>rear.shade('all','close')),C.amber,false);
    }
    function screens(cv,t,s) {
        title(cv,t,'Rear entertainment','Select and control either rear display from the front'); sideTabs(cv,t);
        const current = side==='left' ? s.screens.left : s.screens.right, on=isScreenOn(current);
        panel(cv,t,32,140,492,322,(side==='left'?'Left':'Right')+' screen',C.green);
        cv.text(on?'ON':'OFF',278,230,58,on?C.green:C.amber,{align:'center',font:'bold'});
        cv.text(short(current||'Waiting for RSE',31),278,270,18,t.dim,{align:'center'});
        button(cv,t,60,322,204,62,'POWER ON',()=>run('Rear screen',()=>rear.screenPower(side,true)),C.green,on);
        button(cv,t,282,322,214,62,'POWER OFF',()=>run('Rear screen',()=>rear.screenPower(side,false)),C.red,!on);
        button(cv,t,60,400,436,48,'SELECT SCREEN',()=>run('Screen selection',()=>rear.screenFocus(side)),C.blue,String(s.screens.focus).indexOf(side==='left'?'LEFT':'RIGHT')>=0);
        panel(cv,t,554,140,492,322,'Remote control',C.blue);
        const keys=[['UP','direction','UP'],['LEFT','direction','LEFT'],['OK','direction','CENTER'],['RIGHT','direction','RIGHT'],['DOWN','direction','DOWN'],['HOME','command','HOME'],['BACK','command','BACK'],['PLAY','command','PLAY']];
        keys.forEach((k,i)=>{const col=i%3,row=Math.floor(i/3);button(cv,t,578+col*148,184+row*78,132,58,k[0],()=>run('Remote '+k[0],()=>rear.remote(k[1],k[2])),C.blue,false);});
        panel(cv,t,1076,140,492,322,'Display',C.violet);
        const brightness=finite(s.screens.brightness)?s.screens.brightness:50;
        cv.text('Brightness  '+Math.round(brightness)+'%',1106,212,29,C.violet,{font:'bold'});
        button(cv,t,1106,250,205,58,'DIMMER',()=>run('Brightness',()=>rear.screenBrightness(brightness-10)),C.violet,false);
        button(cv,t,1329,250,207,58,'BRIGHTER',()=>run('Brightness',()=>rear.screenBrightness(brightness+10)),C.violet,false);
        button(cv,t,1106,330,205,58,'DISPLAY ON',()=>run('Display on',()=>rear.screenDisplay(true)),C.green,String(s.screens.display)==='ON');
        button(cv,t,1329,330,207,58,'DISPLAY OFF',()=>run('Display off',()=>rear.screenDisplay(false)),C.red,String(s.screens.display)==='OFF');
    }
    async function render() {
        const t=ctx.theme(),cv=ctx.canvas(W,H).clear(t.bg),s=rear.state;hits=[];actions=[];
        [overview,climate,seats,position,shades,screens][page](cv,t,s);
        if(actions.length) selected=Math.max(0,Math.min(selected,actions.length-1)); else selected=0;
        G.frame(cv,t,PAGES,page,[{text:rear.busy?'WORKING':'READY',color:rear.busy?C.amber:C.green},{text:'60 FPS',color:C.cyan}]);
        if(notice)cv.text(short(notice,112),1562,505,17,noticeGood?C.green:C.amber,{align:'right',font:'bold'});
        await ctx.ui.image('MAIN_GFX',cv);
    }
    function next(delta){if(!actions.length)return;selected=(selected+delta+actions.length)%actions.length;}
    ctx.ui.onClick('BTN_PAGE',()=>{page=(page+1)%PAGES.length;selected=0;});
    ctx.ui.onClick('BTN_LEFT',()=>next(-1));
    ctx.ui.onClick('BTN_RIGHT',()=>next(1));
    ctx.ui.onClick('BTN_ACTION',()=>{if(actions[selected])actions[selected].fn();});
    ctx.onTab((i)=>{page=Math.max(0,Math.min(PAGES.length-1,i));selected=0;});
    ctx.onTap((x,y)=>{const h=hits.find((v)=>x>=v.x&&x<v.x+v.w&&y>=v.y&&y<v.y+v.h);if(h)h.fn();});
    ctx.loop('MAIN',60,render);
    await rear.init();
} });
