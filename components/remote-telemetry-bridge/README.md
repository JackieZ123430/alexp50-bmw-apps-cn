# Remote telemetry bridge

Read-only MGU service for the Parked BMW Android app. While the MGU is awake it reads cabin temperature, exterior temperature, BMW's 12 V charge-condition percentage, IBS-measured 12 V voltage, speed and tyre pressures, then publishes an authenticated HTTPS snapshot every 30 seconds through `mgu-uplink`.

Version 0.1.8 loads the firmware's globally registered `someip` Node binding and uses the installed Vehicle Health app UID for BMW's signal ACL. It reads voltage and an immediate outside-temperature snapshot through BMW's read-only TASU transport from DDE DIDs `43C1` and `5512`, registers the same UID with `mgu-uplink`, then resolves the relay through the uplink DNS servers inside the uid-routed process, avoiding conflicts when ENET and the Internet uplink use overlapping IPv4 subnets.

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
