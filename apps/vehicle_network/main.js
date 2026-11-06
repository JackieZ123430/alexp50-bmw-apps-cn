'use strict';

/** Vehicle Network - read-only view of the root observer's network inventory. */
const fs = require('fs');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const L = require('./logic');

const W = 1600, H = 520;
const PAGES = ['Connect', 'Devices', 'Interfaces', 'Setup'];
const GREEN = '#34d987', CYAN = '#27d8ff', BLUE = '#4c8dff', AMBER = '#ffb52e', RED = '#ff4b55';
const finite = (n) => typeof n === 'number' && isFinite(n);

function demo() {
    const now = Date.now() / 1000;
    return {
        generatedAt: now, observerStartedAt: now - 240,
        access: { carIp: '169.254.202.140', prefix: 16, mask: '255.255.0.0', network: '169.254.0.0/16',
            laptopIp: '169.254.187.226', recommendedIp: '169.254.187.226', interface: 'eth0', inRange: true,
            reason: 'SSH client observed on the MGU access network' },
        devices: [
            { ip:'169.254.187.226', mac:'8a:4d:30:32:14:90', interface:'eth0', role:'Laptop / SSH client', laptop:true, lastSeen:now },
            { ip:'169.254.217.129', mac:'02:00:00:00:00:01', interface:'eth0', role:'Vehicle ENET gateway', gateway:true, lastSeen:now-1 },
            { ip:'160.48.199.93', mac:'02:00:00:00:10:93', interface:'vlan73', role:'Vehicle ECU / SOME-IP provider', someipServices:42, lastSeen:now-2 },
            { ip:'160.48.199.98', mac:'02:00:00:00:10:98', interface:'vlan73', role:'Vehicle ECU / SOME-IP provider', someipServices:16, lastSeen:now-3 },
            { ip:'169.254.202.140', mac:'02:00:00:00:20:14', interface:'eth0', role:'MGU / head unit', local:true, lastSeen:now }
        ],
        interfaces: [
            { name:'eth0', state:'UP', mac:'02:00:00:00:20:14', mtu:1500, addresses:[{family:'inet',address:'169.254.202.140',prefix:16,scope:'global'}] },
            { name:'vlan73', state:'UP', mac:'02:00:00:00:20:14', mtu:1500, addresses:[{family:'inet',address:'160.48.199.92',prefix:24,scope:'global'}] },
            { name:'lo', state:'UNKNOWN', mac:'00:00:00:00:00:00', mtu:65536, addresses:[{family:'inet',address:'127.0.0.1',prefix:8,scope:'host'}] }
        ],
        routes:[{dst:'169.254.0.0/16',dev:'eth0',src:'169.254.202.140'},{dst:'160.48.199.0/24',dev:'vlan73',src:'160.48.199.92'}],
        counters:{frames:18422,arp:81,someipPackets:918,someipProviders:12}
    };
}

mgu.run({ async start(ctx) {
    const { ui, settings, log } = ctx;
    const file = (ctx.spec.config && ctx.spec.config.stateFile) || '/var/opt/vehicle-network-observer/state.json';
    let snapshot = null, error = '', page = 0, rowPage = 0, visible = true, lastRead = 0;
    function load() {
        try { snapshot = JSON.parse(fs.readFileSync(file, 'utf8')); error = ''; }
        catch (e) { error = String(e.message || e); }
        lastRead = Date.now();
    }
    const data = () => settings.get('demo') === 'on' ? demo() : (snapshot || { devices:[], interfaces:[], routes:[], counters:{}, access:{} });
    const color = (t, kind) => kind === 'ok' ? GREEN : kind === 'warn' ? AMBER : kind === 'bad' ? RED : t.dim;
    const field = (cv,t,x,y,label,value,col,w) => {
        cv.roundRect(x,y,w||310,96,10,withAlpha(col||CYAN,0.08)); cv.fillRect(x,y,4,96,col||CYAN);
        cv.text(label.toUpperCase(),x+18,y+28,16,t.dim,{font:'bold'}); cv.text(value || '--',x+18,y+72,31,col||t.text,{font:'bold'});
    };
    function connectPage(cv,t,d) {
        const a=d.access||{}, st=L.status(d,Date.now()), ready=!!a.recommendedIp;
        G.panel(cv,t,24,52,450,460,'Connection');
        cv.text(ready ? (a.inRange ? 'READY' : 'SET LAPTOP IP') : 'WAITING',48,137,49,ready?(a.inRange?GREEN:AMBER):t.dim,{font:'bold'});
        cv.text(st.text+'  ·  snapshot '+st.age,48,178,20,color(t,st.kind),{font:'bold'});
        cv.text('MGU address',48,236,17,t.dim); cv.text(a.carIp||'--',48,276,34,CYAN,{font:'bold'});
        cv.text('Laptop observed',48,327,17,t.dim); cv.text(a.laptopIp||'not seen yet',48,366,30,a.laptopIp?GREEN:t.dim,{font:'bold'});
        cv.text((d.devices||[]).length+' IP devices observed',48,429,22,t.text);
        cv.text((d.counters&&d.counters.someipProviders||0)+' SOME/IP providers',48,464,22,t.text);
        cv.text('Passive inventory grows while the car is awake.',48,498,18,t.dim);
        G.panel(cv,t,494,52,1082,228,'Laptop IPv4 settings');
        field(cv,t,518,103,'IP address',a.recommendedIp||'waiting',ready?GREEN:t.dim,320);
        field(cv,t,858,103,'Subnet mask',a.mask||'--',CYAN,320);
        field(cv,t,1198,103,'Prefix / network',finite(a.prefix)?'/'+a.prefix:'--',BLUE,354);
        cv.text(a.network||'No access network selected yet',520,260,20,t.dim);
        G.panel(cv,t,494,300,1082,212,'Why this is correct');
        cv.text(a.reason||'The observer is waiting for an external access interface or SSH client.',520,354,23,t.text);
        cv.text('Car and laptop must share the network prefix. Leave gateway and DNS empty for direct ENET.',520,398,21,t.dim);
        cv.text(a.inRange?'The currently observed laptop address already matches.':'Use the Setup section for the complete command.',520,456,24,a.inRange?GREEN:AMBER,{font:'bold'});
    }
    function devicesPage(cv,t,d) {
        const all=L.sortedDevices(d.devices), per=6, pages=Math.max(1,Math.ceil(all.length/per)); rowPage%=pages;
        const rows=all.slice(rowPage*per,rowPage*per+per).map(x=>[
            L.shortIp(x.ip,30), x.role||'Network peer', x.interface||'--', x.mac||'--', L.age(x.lastSeen)
        ]);
        cv.text('Observed devices',34,87,34,t.text,{font:'bold'});
        cv.text('Page '+(rowPage+1)+' / '+pages+'  ·  '+all.length+' unique IP addresses',1560,86,19,t.dim,{align:'right'});
        G.table(cv,t,32,112,1536,[{label:'IP address',w:330},{label:'Role',w:500},{label:'Interface',w:180},{label:'MAC address',w:330},{label:'Seen',w:196,align:'right'}],rows,{rowH:51,size:21,empty:'No network traffic observed yet'});
        cv.text('MORE ROWS changes this page. SOME/IP roles come from live service offers; other peers come from ARP/IP traffic.',34,500,18,t.dim);
    }
    function interfacesPage(cv,t,d) {
        const all=(d.interfaces||[]).filter(x=>x.name!=='lo'), per=5, pages=Math.max(1,Math.ceil(all.length/per)); rowPage%=pages;
        const rows=all.slice(rowPage*per,rowPage*per+per).map(x=>{
            const addrs=(x.addresses||[]).filter(a=>a.family==='inet'||a.family==='inet6').map(a=>a.address+'/'+a.prefix).join('  ');
            return [x.name,x.state||'--',L.shortIp(addrs,58),x.mac||'--',String(x.mtu||'--')];
        });
        cv.text('MGU interfaces',34,87,34,t.text,{font:'bold'});
        cv.text('Page '+(rowPage+1)+' / '+pages,1560,86,19,t.dim,{align:'right'});
        G.table(cv,t,32,112,1536,[{label:'Interface',w:220},{label:'State',w:160},{label:'Addresses',w:600},{label:'MAC address',w:360},{label:'MTU',w:196,align:'right'}],rows,{rowH:58,size:22,empty:'Observer has not published interface data'});
        const routes=(d.routes||[]).filter(r=>r.dst!=='default'&&!r.gateway).slice(0,3).map(r=>(r.dst||'default')+' via direct on '+(r.dev||'--')).join('   ·   ');
        cv.text('Routes',34,446,17,t.dim,{font:'bold'}); cv.text(routes||'No routes reported',34,481,20,t.text);
    }
    function setupPage(cv,t,d) {
        const a=d.access||{}, ip=a.recommendedIp||'<IP>', prefix=finite(a.prefix)?a.prefix:'<PREFIX>', mask=a.mask||'<MASK>';
        G.panel(cv,t,24,52,1552,460,'Configure a directly connected laptop');
        cv.text('Windows PowerShell (run as Administrator)',52,103,22,CYAN,{font:'bold'});
        cv.roundRect(52,124,1496,70,8,withAlpha(BLUE,0.10));
        cv.text('New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress '+ip,74,158,20,t.text,{font:'bold'});
        cv.text('-PrefixLength '+prefix,74,185,20,t.text,{font:'bold'});
        cv.text('Windows GUI',52,236,22,CYAN,{font:'bold'});
        cv.text('Ethernet adapter > IPv4 > Manual     Address  '+ip+'     Mask  '+mask,52,274,23,t.text);
        cv.text('Default gateway and DNS: leave blank for a direct ENET cable.',52,308,21,t.dim);
        cv.text('Then connect',52,358,22,CYAN,{font:'bold'});
        cv.text('ssh -i <your-key> root@'+(a.carIp||'<MGU-IP>'),52,397,25,GREEN,{font:'bold'});
        cv.text('If Windows already has another route to the car, bind the source:  ssh -b '+ip+' ... root@'+(a.carIp||'<MGU-IP>'),52,438,20,AMBER);
        cv.text('The adapter alias may be "Ethernet 2" on your laptop. Check it with Get-NetAdapter.',52,486,19,t.dim);
    }
    async function render() {
        if (visible && Date.now()-lastRead>1000) load();
        const t=ctx.theme(),d=data(),cv=ctx.canvas(W,H).clear(t.bg),st=L.status(d,Date.now());
        [connectPage,devicesPage,interfacesPage,setupPage][page](cv,t,d);
        G.frame(cv,t,PAGES,page,[
            {text:settings.get('demo')==='on'?'DEMO':st.text,color:settings.get('demo')==='on'?BLUE:color(t,st.kind)},
            {text:String((d.devices||[]).length)+' DEVICES',color:CYAN}
        ]);
        if(error&&settings.get('demo')!=='on') cv.text('Observer: '+L.shortIp(error,90),1560,501,16,RED,{align:'right'});
        await ui.image('MAIN_GFX',cv);
    }
    ui.onClick('BTN_PAGE',()=>{page=(page+1)%PAGES.length;rowPage=0;});
    ui.onClick('BTN_MORE',()=>{rowPage++;});
    ui.onClick('BTN_REFRESH',()=>{lastRead=0;load();});
    ctx.onTab(i=>{page=i;rowPage=0;});
    ui.onVisible((name,on)=>{if(name==='MAIN'){visible=on;if(on){lastRead=0;load();}}});
    ctx.loop('MAIN',30,render);
    load();
} });
