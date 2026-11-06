'use strict';

const finite = (n) => typeof n === 'number' && isFinite(n);
const clean = (s) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, '').trim();
const shortIp = (s, n) => { s = clean(s); return s.length > (n || 34) ? s.slice(0, (n || 34) - 1) + '…' : s; };
const age = (stamp, now) => {
    if (!finite(stamp)) return '--';
    const sec = Math.max(0, Math.round(((now || Date.now() / 1000) - stamp)));
    if (sec < 2) return 'now';
    if (sec < 60) return sec + ' s';
    if (sec < 3600) return Math.floor(sec / 60) + ' min';
    return Math.floor(sec / 3600) + ' h';
};
const roleRank = (d) => d.laptop ? 0 : d.gateway ? 1 : d.local ? 2 : d.someipServices ? 3 : 4;
function sortedDevices(devices) {
    return (devices || []).slice().sort((a, b) => roleRank(a) - roleRank(b) ||
        (b.lastSeen || 0) - (a.lastSeen || 0) || clean(a.ip).localeCompare(clean(b.ip)));
}
function status(snapshot, nowMs) {
    const at = snapshot && snapshot.generatedAt;
    if (!finite(at)) return { text: 'OBSERVER OFFLINE', kind: 'bad', age: '--' };
    const seconds = Math.max(0, nowMs / 1000 - at);
    return seconds < 8 ? { text: 'LIVE', kind: 'ok', age: age(at, nowMs / 1000) } :
        seconds < 40 ? { text: 'UPDATING', kind: 'warn', age: age(at, nowMs / 1000) } :
            { text: 'STALE', kind: 'bad', age: age(at, nowMs / 1000) };
}
module.exports = { age, clean, shortIp, sortedDevices, status };
