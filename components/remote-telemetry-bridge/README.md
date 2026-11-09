# Remote telemetry bridge

MGU service for the Parked BMW Android app. While the MGU is awake it reads cabin temperature, exterior temperature, BMW's 12 V charge-condition percentage, IBS-measured 12 V voltage, speed, tyre pressures and IHKA climate state. Changed values are published immediately through `mgu-uplink`, with a five-minute heartbeat to control Cloudflare KV usage.

Version 0.2.20 loads the firmware's globally registered `someip` Node binding and uses the installed Vehicle Health app UID for BMW's signal ACL. It reads DDE and IHKA diagnostics for authoritative voltage, temperature and climate state, registers the same UID with `mgu-uplink`, then resolves the relay through the uplink DNS servers inside the uid-routed process. The cabin sample uses documented IHKA D8D7 data and includes its own source and timestamp. Climate commands are strictly allowlisted and must be confirmed by BMW state readback. Engine-off climate ON/OFF first requests IHKA's parked-climate operation and falls back to the normal front-climate path when O18 refuses Webasto control in an awake accessory/diagnostic session. Seat commands use the firmware's Climate2 operation and the legacy IHKA interface only for state confirmation. This version regenerates the BMW interface cache so engine state is available and parked climate is never selected while the engine is running.

The bridge intentionally omits vehicle location. It drops from root to the installed Vehicle Health app UID before it opens vehicle or internet sockets. The Store grants that UID outbound uplink access only for this component.

Persistent configuration is `/var/opt/remote-telemetry-bridge/config.json`:

```json
{
  "endpoint": "https://your-worker.example.workers.dev",
  "carId": "my-g12",
  "writeToken": "a-long-random-write-token"
}
```

The MGU and LTE stick power down with the car. The cloud retains the final snapshot and the Android app labels it with its age; this service does not keep the vehicle awake.
