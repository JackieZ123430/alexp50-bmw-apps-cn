const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}
});

async function sameSecret(supplied, expected) {
  if (!supplied || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(supplied)),
    crypto.subtle.digest("SHA-256", enc.encode(expected))
  ]);
  const av = new Uint8Array(a), bv = new Uint8Array(b);
  let different = av.length ^ bv.length;
  for (let i = 0; i < Math.min(av.length, bv.length); i++) different |= av[i] ^ bv[i];
  return different === 0;
}

function bearer(request) {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function validSnapshot(body) {
  if (!body || body.schema !== 1 || typeof body.telemetry !== "object" || Array.isArray(body.telemetry)) return false;
  const t = body.telemetry;
  const numberOrNull = (v) => v == null || (typeof v === "number" && Number.isFinite(v));
  if (!numberOrNull(t.insideTemperatureC) || !numberOrNull(t.outsideTemperatureC) ||
      !numberOrNull(t.batteryChargePercent) || !numberOrNull(t.speedKmh)) return false;
  if (t.insideTemperatureC != null && (t.insideTemperatureC < -50 || t.insideTemperatureC > 100)) return false;
  if (t.batteryChargePercent != null && (t.batteryChargePercent < 0 || t.batteryChargePercent > 150)) return false;
  return true;
}

async function appendHistory(env, carId, snapshot) {
  const key = `history:${carId}`;
  const old = await env.TELEMETRY.get(key, "json") || [];
  const last = old.length ? Date.parse(old[old.length - 1].serverReceivedAt) : 0;
  if (Date.now() - last < 5 * 60 * 1000) return;
  old.push(snapshot);
  await env.TELEMETRY.put(key, JSON.stringify(old.slice(-288)));
}

export default {
  async fetch(request, env, ctx) {
    const target = new URL(request.url);
    if (target.pathname === "/health") return json({ok: true, service: "parked-bmw-telemetry"});
    const match = /^\/v1\/cars\/([A-Za-z0-9_-]{1,48})\/(telemetry|history)$/.exec(target.pathname);
    if (!match) return json({error: "not found"}, 404);
    const carId = match[1], resource = match[2], token = bearer(request);

    if (request.method === "POST" && resource === "telemetry") {
      if (!await sameSecret(token, env.CAR_WRITE_TOKEN)) return json({error: "unauthorized"}, 401);
      const length = Number(request.headers.get("content-length") || 0);
      if (length > 16384) return json({error: "payload too large"}, 413);
      let body;
      try { body = await request.json(); } catch (_) { return json({error: "invalid JSON"}, 400); }
      if (!validSnapshot(body)) return json({error: "invalid telemetry snapshot"}, 422);
      const snapshot = {...body, carId, serverReceivedAt: new Date().toISOString()};
      await env.TELEMETRY.put(`latest:${carId}`, JSON.stringify(snapshot));
      ctx.waitUntil(appendHistory(env, carId, snapshot));
      return json({ok: true, serverReceivedAt: snapshot.serverReceivedAt}, 202);
    }

    if (request.method === "GET") {
      if (!await sameSecret(token, env.APP_READ_TOKEN)) return json({error: "unauthorized"}, 401);
      const key = resource === "history" ? `history:${carId}` : `latest:${carId}`;
      const value = await env.TELEMETRY.get(key, "json");
      if (!value) return json({error: "no telemetry received"}, 404);
      return json(value);
    }
    return json({error: "method not allowed"}, 405);
  }
};
