'use strict';
const path = require('path');

const HUD_FS = `#version 100
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform float u_time;
uniform float u_visible;
uniform float u_sport;
uniform float u_rpm;
uniform float u_shift;
uniform float u_gear;
uniform float u_warm;
uniform float u_oil;
uniform float u_coolant;
uniform float u_turn;
uniform float u_test;
uniform float u_alpha;

float box(vec2 p, vec2 c, vec2 h) { vec2 d = abs(p-c)-h; return 1.0-step(0.0,max(d.x,d.y)); }
float disc(vec2 p, vec2 c, float r) { return 1.0-step(r,length(p-c)); }
float arrow(vec2 p, float side) {
    p.x = side < 0.0 ? p.x : 1.0-p.x;
    /* Keep the arrows inside the G12 HUD's clearly visible optical centre.
       The first version put their tips at the extreme edges of the canvas. */
    float stem = box(p,vec2(0.37,0.56),vec2(0.105,0.055));
    vec2 q=p-vec2(0.22,0.56);
    float head = step(abs(q.y),0.16-q.x*0.78)*step(-0.045,q.x)*step(q.x,0.18);
    return max(stem,head);
}
float segment(vec2 p, float s) {
    if (s<0.5) return box(p,vec2(0.50,0.08),vec2(0.25,0.045));
    if (s<1.5) return box(p,vec2(0.77,0.30),vec2(0.045,0.20));
    if (s<2.5) return box(p,vec2(0.77,0.70),vec2(0.045,0.20));
    if (s<3.5) return box(p,vec2(0.50,0.92),vec2(0.25,0.045));
    if (s<4.5) return box(p,vec2(0.23,0.70),vec2(0.045,0.20));
    if (s<5.5) return box(p,vec2(0.23,0.30),vec2(0.045,0.20));
    return box(p,vec2(0.50,0.50),vec2(0.25,0.045));
}
float enabled(float code,float s) {
    if (code<0.5) return (s==0.0||s==1.0||s==2.0||s==3.0||s==4.0||s==5.0)?1.0:0.0;
    if (code<1.5) return (s==1.0||s==2.0)?1.0:0.0;
    if (code<2.5) return (s==0.0||s==1.0||s==3.0||s==4.0||s==6.0)?1.0:0.0;
    if (code<3.5) return (s==0.0||s==1.0||s==2.0||s==3.0||s==6.0)?1.0:0.0;
    if (code<4.5) return (s==1.0||s==2.0||s==5.0||s==6.0)?1.0:0.0;
    if (code<5.5) return (s==0.0||s==2.0||s==3.0||s==5.0||s==6.0)?1.0:0.0;
    if (code<6.5) return (s==0.0||s==2.0||s==3.0||s==4.0||s==5.0||s==6.0)?1.0:0.0;
    if (code<7.5) return (s==0.0||s==1.0||s==2.0)?1.0:0.0;
    if (code<8.5) return 1.0;
    if (code<9.5) return (s==0.0||s==1.0||s==2.0||s==3.0||s==5.0||s==6.0)?1.0:0.0;
    if (code<10.5) return (s==0.0||s==1.0||s==4.0||s==5.0||s==6.0)?1.0:0.0; /* P */
    if (code<11.5) return (s==1.0||s==2.0||s==4.0||s==5.0||s==6.0)?1.0:0.0; /* R-ish */
    return (s==1.0||s==2.0||s==4.0||s==5.0)?1.0:0.0; /* N */
}
float glyph(vec2 p,float code) { float m=0.0; for(int i=0;i<7;i++){float s=float(i);m=max(m,segment(p,s)*enabled(code,s));}return m; }
void over(inout vec4 dst, vec3 rgb, float a) { a=clamp(a,0.0,1.0); dst.rgb=mix(dst.rgb,rgb,a); dst.a=max(dst.a,a); }
void main(){
    vec4 c=vec4(0.0); vec2 p=v_uv;
    if(u_visible<0.5){gl_FragColor=c;return;}
    if(u_sport>0.5||u_test>0.5){
        float track=box(p,vec2(0.50,0.12),vec2(0.38,0.024)); over(c,vec3(0.10,0.13,0.16),track*0.72*u_alpha);
        float fill=track*step(p.x,0.12+0.76*clamp(u_rpm,0.0,1.0));
        vec3 rc=mix(vec3(0.10,0.75,1.0),vec3(1.0,0.08,0.03),smoothstep(u_shift,1.0,u_rpm)); over(c,rc,fill*u_alpha);
        for(int i=0;i<9;i++){float x=0.18+float(i)*0.08;float on=step(x,0.12+0.76*u_rpm);vec3 lc=float(i)<5.0?vec3(0.1,1.0,0.35):float(i)<7.0?vec3(1.0,0.75,0.05):vec3(1.0,0.05,0.03);over(c,lc,disc(p,vec2(x,0.20),0.012)*on*u_alpha);}
        vec2 gp=(p-vec2(0.50,0.50))/vec2(0.15,0.25)+0.5; over(c,vec3(0.92,0.96,1.0),glyph(gp,u_gear)*u_alpha);
    }
    if(u_warm>0.5||u_test>0.5){
        float a=box(p,vec2(0.38,0.88),vec2(0.13,0.018));float b=box(p,vec2(0.62,0.88),vec2(0.13,0.018));
        over(c,vec3(0.08,0.11,0.15),(a+b)*0.72*u_alpha);
        over(c,mix(vec3(0.05,0.45,1.0),vec3(0.1,1.0,0.4),u_oil),a*step(p.x,0.25+0.26*u_oil)*u_alpha);
        over(c,mix(vec3(0.05,0.75,1.0),vec3(0.1,1.0,0.4),u_coolant),b*step(p.x,0.49+0.26*u_coolant)*u_alpha);
    }
    /* Pulse bright/dim instead of completely off: a short stalk event is
       always visible, while the pulse still follows the indicator rhythm. */
    float blink=0.42+0.58*step(0.48,fract(u_time*1.45));
    if(u_turn< -0.5||u_test>0.5) over(c,vec3(0.18,1.0,0.25),arrow(p,-1.0)*u_alpha*blink);
    if(u_turn> 0.5||u_test>0.5) over(c,vec3(0.18,1.0,0.25),arrow(p, 1.0)*u_alpha*blink);
    gl_FragColor=c;
}`;

function clientModule() {
    const places = [
        '/var/opt/cluster-render/current/cluster_render_client.js',
        path.resolve(__dirname, '../../../idrive-apps/native/cluster-render/js/cluster_render_client.js')
    ];
    for (const file of places) { try { return require(file); } catch (e) { /* next */ } }
    return null;
}

class DriveHud {
    constructor(ctx, changed, Client) {
        this.ctx = ctx; this.changed = changed || (() => {}); this.Client = Client || (clientModule() || {}).ClusterRender;
        this.connected = false; this.layer = 0; this.layerFailed = false; this.state = 'renderer not installed / not connected'; this.testUntil = 0; this.last = {};
        if (!this.Client) return;
        this.cr = new this.Client('drive_hud_full');
        this.layer = this.cr.effect({ target: 'hud', klass: 'content', z: 10, x: 0, y: 0, w: 800, h: 480,
            visible: false, exclusive: false, contend: false, fs: HUD_FS, time: true });
        this.cr.on('ready', () => { this.connected = true; this.state = this.cr.targets.indexOf('hud:') >= 0 ? 'HUD renderer ready' : 'renderer has no HUD target'; this.changed(); this.apply(this.last); });
        this.cr.on('disconnected', () => { this.connected = false; this.state = 'HUD renderer disconnected; retrying'; this.changed(); });
        this.cr.on('layer', (ref, state, reason) => { if (ref === this.layer) { this.state = 'HUD layer ' + state + (reason ? ': ' + reason : ''); this.changed(); } });
        this.cr.on('target', (target, state, holder, reason) => { if (target === 'hud') { this.state = 'HUD ' + state + (holder && holder !== 'none' ? ' (BMW/other content has priority)' : '') + (reason ? ': ' + reason : ''); this.changed(); } });
        this.cr.on('refused', (op, ref, reason) => {
            if (op === 'layer' && ref === this.layer) this.layerFailed = true;
            if (!this.layerFailed || op === 'layer') this.state = 'HUD ' + op + ' refused: ' + reason;
            if (this.ctx.log && this.ctx.log.warn) this.ctx.log.warn('cluster-render refused ' + op + ' ' + ref + ': ' + reason);
            this.changed();
        });
        this.cr.connect();
    }
    gearCode(data) {
        if (data.stage === 'P') return 10;
        if (data.stage === 'R' || data.gear === -1) return 11;
        if (data.stage === 'N') return 12;
        return data.gear >= 1 && data.gear <= 9 ? data.gear : 0;
    }
    test(ms) { this.testUntil = Date.now() + (ms || 10000); clearTimeout(this.testTimer); this.testTimer = setTimeout(() => { this.testUntil = 0; this.apply(this.last); this.changed(); }, ms || 10000); this.apply(this.last); }
    apply(s) {
        this.last = Object.assign({}, s || {});
        if (!this.cr || !this.layer) return;
        const finite = (value, fallback) => {
            const number = Number(value);
            return isFinite(number) ? number : fallback;
        };
        const test = Date.now() < this.testUntil;
        const enabled = !!s.enabled || test;
        const sport = !!s.sport && !!s.isSport;
        const warm = !!s.warmup && !!s.engineRunning && ((s.oilKnown && s.oil < s.warmOil) || (s.coolantKnown && s.coolant < s.warmCoolant));
        const turn = s.turns && s.turnReady ? finite(s.turn, 0) : 0;
        const visible = enabled && (test || sport || warm || turn !== 0);
        const redline = Math.max(1000, finite(s.redline, 5000));
        const rpm = Math.max(0, Math.min(1, finite(s.rpm, 0) / redline));
        const shift = Math.max(0.1, Math.min(1, finite(s.shift, redline * 0.86) / redline));
        const progress = (v, target) => Math.max(0, Math.min(1, (finite(v, 30) - 30) / Math.max(1, finite(target, 90) - 30)));
        const values = {
            u_visible: visible ? 1 : 0, u_sport: sport ? 1 : 0, u_rpm: test ? 0.82 : rpm, u_shift: shift,
            u_gear: test ? 7 : this.gearCode(s), u_warm: warm ? 1 : 0,
            u_oil: test ? 0.55 : progress(s.oil, s.warmOil), u_coolant: test ? 0.72 : progress(s.coolant, s.warmCoolant),
            u_turn: turn, u_test: test ? 1 : 0, u_alpha: Math.max(0.2, Math.min(1, finite(s.brightness, 80) / 100))
        };
        this.cr.set(this.layer, { visible: visible });
        Object.keys(values).forEach((k) => { if (this.uniforms && this.uniforms[k] === values[k]) return; this.cr.uniform(this.layer, k, [values[k]]); });
        this.uniforms = values;
    }
    close() { clearTimeout(this.testTimer); if (this.cr) this.cr.close(); }
}

module.exports = { DriveHud, HUD_FS };
