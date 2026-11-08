# Parked BMW telemetry relay

Cloudflare Worker that accepts authenticated snapshots from the MGU and exposes the latest snapshot plus a five-minute history to the Android app. The car has a write-only token; the phone has a separate read-only token.

From the repository root on Windows, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\Setup-Parked-BMW-Cloud.ps1
```

Wrangler opens the Cloudflare login flow if needed. The script creates the KV namespace, generates independent 256-bit car-write and phone-read tokens, deploys the Worker and writes the private result to `parked-bmw-connection.json`. That file is excluded from Git.

With the car awake and reachable, install the bridge using the generated connection file:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\Install-Parked-BMW-Bridge.ps1 -HostAddress 192.168.68.114
```

No location is collected by version 0.1. The retained history contains at most 288 five-minute samples.
