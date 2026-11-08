import assert from "node:assert/strict";
import worker from "../src/worker.mjs";

class KV {
  constructor() { this.values = new Map(); }
  async put(k, v) { this.values.set(k, v); }
  async get(k, type) { const v = this.values.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; }
}
const env = {TELEMETRY: new KV(), CAR_WRITE_TOKEN: "write-secret", APP_READ_TOKEN: "read-secret"};
const ctx = {waitUntil: (p) => p};
const payload = {schema:1, sampledAt:new Date().toISOString(), awake:true,
  telemetry:{insideTemperatureC:21.5,outsideTemperatureC:7,batteryChargePercent:82,speedKmh:0,
    tyrePressureBar:{frontLeft:2.5,frontRight:2.5,rearLeft:2.7,rearRight:2.7}}};

let response = await worker.fetch(new Request("https://example.test/v1/cars/g12/telemetry", {
  method:"POST", headers:{authorization:"Bearer write-secret", "content-type":"application/json"}, body:JSON.stringify(payload)
}), env, ctx);
assert.equal(response.status, 202);
response = await worker.fetch(new Request("https://example.test/v1/cars/g12/telemetry", {
  headers:{authorization:"Bearer read-secret"}
}), env, ctx);
assert.equal(response.status, 200);
const latest = await response.json();
assert.equal(latest.telemetry.insideTemperatureC, 21.5);
assert.equal(latest.carId, "g12");
response = await worker.fetch(new Request("https://example.test/v1/cars/g12/telemetry"), env, ctx);
assert.equal(response.status, 401);
console.log("Telemetry worker authentication, validation and retained snapshot checks passed.");
