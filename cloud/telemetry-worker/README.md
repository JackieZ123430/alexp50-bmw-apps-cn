# Parked BMW telemetry relay

Cloudflare Worker that accepts authenticated snapshots from the MGU, exposes the latest snapshot plus a five-minute history, and carries short-lived climate commands. The car has a write/execute token; the phone has separate read and command tokens.

From the repository root on Windows, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\Setup-Parked-BMW-Cloud.ps1
```

Wrangler opens the Cloudflare login flow if needed. The script creates the KV namespace, generates independent 256-bit car-write and phone-read tokens, deploys the Worker and writes the private result to `parked-bmw-connection.json`. That file is excluded from Git.

With the car awake and reachable, install the bridge using the generated connection file:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\Install-Parked-BMW-Bridge.ps1 -HostAddress 192.168.68.114
```

Commands are strictly allowlisted, expire after two minutes and retain their car-side result. No location is collected. Telemetry history contains at most 288 five-minute samples.
