'use strict';
const finite = (n) => typeof n === 'number' && isFinite(n);
const tempC = (raw) => finite(raw) && raw !== 255 ? raw - 48 : null;
const tyreP = (raw) => finite(raw) && raw < 65532 ? raw * 0.1 : null;
const tyreT = (raw) => finite(raw) && raw !== 65535 && raw - 40 >= -40 && raw - 40 <= 150 ? raw - 40 : null;
function decodeDid(id, r) {
    if (!r || r[0] !== 0x62 || r.length < 5) return null;
    const u16 = (r[3] << 8) | r[4];
    if (id === 0x44BE) return u16 * 0.01525902;
    if (id === 0x44BD) return u16 * 0.01525902;
    if (id === 0x4C78) return u16 * 10;
    return null;
}
module.exports = { decodeDid, tyreP, tyreT, tempC };
