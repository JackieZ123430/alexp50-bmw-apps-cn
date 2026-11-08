<# Deploys the private telemetry relay and creates separate car/phone tokens. #>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$worker = Join-Path (Split-Path $PSScriptRoot -Parent) 'cloud\telemetry-worker'
$config = Join-Path $worker 'wrangler.toml'
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw "Missing $config" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required on this PC.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required on this PC.' }

Push-Location $worker
try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }

    $toml = Get-Content -LiteralPath $config -Raw
    if ($toml -notmatch '(?m)^\s*binding\s*=\s*"TELEMETRY"') {
        Write-Host 'Creating the private Cloudflare KV namespace...'
        npx wrangler kv namespace create TELEMETRY --binding TELEMETRY --update-config
        if ($LASTEXITCODE -ne 0) { throw 'Cloudflare KV creation failed.' }
    }

    $writeToken = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
    $readToken = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
    $writeToken | npx wrangler secret put CAR_WRITE_TOKEN
    if ($LASTEXITCODE -ne 0) { throw 'Uploading the car write token failed.' }
    $readToken | npx wrangler secret put APP_READ_TOKEN
    if ($LASTEXITCODE -ne 0) { throw 'Uploading the Android read token failed.' }

    $deploy = (& npx wrangler deploy 2>&1 | Tee-Object -Variable deployOutput | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Cloudflare deployment failed.`n$deploy" }
    Write-Host $deploy
    $match = [regex]::Match($deploy, 'https://[A-Za-z0-9.-]+\.workers\.dev')
    if (-not $match.Success) { throw 'Relay deployed, but its workers.dev URL was not found in Wrangler output.' }

    $connection = [ordered]@{
        endpoint = $match.Value.TrimEnd('/')
        carId = 'my-g12'
        writeToken = $writeToken
        readToken = $readToken
        createdAt = [DateTime]::UtcNow.ToString('o')
    }
    $connectionPath = Join-Path $worker 'parked-bmw-connection.json'
    $connection | ConvertTo-Json | Set-Content -LiteralPath $connectionPath -Encoding utf8
    Write-Host "Private connection file written to $connectionPath" -ForegroundColor Green
    Write-Host 'Keep this file private. The write token goes only to the car; the read token goes only to the Android app.'
} finally {
    Pop-Location
}
