# Remote telemetry bridge

Read-only MGU service for the Parked BMW Android app. While the MGU is awake it reads cabin temperature, exterior temperature, BMW's 12 V charge-condition percentage, speed and tyre pressures over SOME/IP, then publishes an authenticated HTTPS snapshot every 30 seconds through `mgu-uplink`.

Version 0.1.2 loads the firmware's globally registered `someip` Node binding, with the direct native-library path retained only as a compatibility fallback. It also publishes explicit startup phases and gives the Store health check up to 15 seconds for SOME/IP configuration generation and proxy startup.

The bridge intentionally omits vehicle location. It drops from root to uid 65534 before it opens vehicle or internet sockets. The Store grants that uid outbound uplink access only for this component.

Persistent configuration is `/var/opt/remote-telemetry-bridge/config.json`:

```json
{
  "endpoint": "https://your-worker.example.workers.dev",
  "carId": "my-g12",
  "writeToken": "a-long-random-write-token"
}
```

The MGU and LTE stick power down with the car. The cloud retains the final snapshot and the Android app labels it with its age; this service does not keep the vehicle awake.
