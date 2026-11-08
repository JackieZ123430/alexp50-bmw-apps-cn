<# Installs and configures the read-only MGU telemetry publisher. #>
[CmdletBinding()]
param(
    [string]$Identity = '',
    [ValidatePattern('^[0-9A-Fa-f:.%-]+$')][string]$HostAddress = '192.168.68.114',
    [ValidatePattern('^$|^[0-9A-Fa-f:.%-]+$')][string]$SourceAddress = '',
    [string]$ConnectionFile = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$bmw = Split-Path $repo -Parent
if (-not $Identity) { $Identity = Join-Path $bmw 'idrive7-8-ssh-root-main\data\enrollments\WBA7V61020CD61701\id_rsa' }
if (-not $ConnectionFile) { $ConnectionFile = Join-Path $repo 'cloud\telemetry-worker\parked-bmw-connection.json' }
$artifact = Join-Path $repo 'packages\remote-telemetry-bridge@0.1.0.tgz'
foreach ($path in @($Identity,$ConnectionFile,$artifact)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required file not found: $path" }
}
$connection = Get-Content -LiteralPath $ConnectionFile -Raw | ConvertFrom-Json
if ($connection.endpoint -notmatch '^https://') { throw 'The relay endpoint must use HTTPS.' }
if ([string]::IsNullOrWhiteSpace($connection.writeToken)) { throw 'The connection file has no car write token.' }

$ssh = (Get-Command ssh -ErrorAction Stop).Source
$scp = (Get-Command scp -ErrorAction Stop).Source
$Identity = (Resolve-Path -LiteralPath $Identity).Path
$target = "root@$HostAddress"
$options = @('-o','BatchMode=yes','-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=NUL',
    '-o','GlobalKnownHostsFile=NUL','-o','IdentitiesOnly=yes','-o','ConnectTimeout=12','-o','LogLevel=ERROR','-i',$Identity)
if ($SourceAddress) { $options += @('-o', "BindAddress=$SourceAddress") }
function Invoke-Car([string]$Command) {
    & $ssh @options $target $Command
    if ($LASTEXITCODE -ne 0) { throw "Car command failed (exit $LASTEXITCODE): $Command" }
}

$tempConfig = Join-Path ([IO.Path]::GetTempPath()) ("parked-bmw-" + [guid]::NewGuid().ToString('N') + '.json')
try {
    [ordered]@{endpoint=$connection.endpoint;carId=$connection.carId;writeToken=$connection.writeToken} |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $tempConfig -Encoding utf8
    Write-Host "Connecting to MGU $HostAddress..."
    Invoke-Car 'test -x /var/opt/mgu-deploy/mgu-deploy.sh && test -s /run/mgu-uplink/lease.json'
    & $scp @options $artifact "${target}:/tmp/remote-telemetry-bridge@0.1.0.tgz"
    if ($LASTEXITCODE -ne 0) { throw 'Bridge package upload failed.' }
    & $scp @options $tempConfig "${target}:/tmp/remote-telemetry-config.json"
    if ($LASTEXITCODE -ne 0) { throw 'Bridge configuration upload failed.' }
    Invoke-Car "sh /var/opt/mgu-deploy/mgu-deploy.sh check --artifact '/tmp/remote-telemetry-bridge@0.1.0.tgz'"
    Invoke-Car "sh /var/opt/mgu-deploy/mgu-deploy.sh install --artifact '/tmp/remote-telemetry-bridge@0.1.0.tgz' --yes"
    Invoke-Car "mkdir -p /var/opt/remote-telemetry-bridge && install -m 0600 -o root -g root /tmp/remote-telemetry-config.json /var/opt/remote-telemetry-bridge/config.json && systemctl restart remote-telemetry-bridge.service"
    Start-Sleep -Seconds 4
    Invoke-Car 'systemctl is-active --quiet remote-telemetry-bridge.service && cat /run/remote-telemetry-bridge/status.json'
    Write-Host 'Parked BMW telemetry bridge installed and configured.' -ForegroundColor Green
} finally {
    Remove-Item -LiteralPath $tempConfig -Force -ErrorAction SilentlyContinue
    & $ssh @options $target 'rm -f /tmp/remote-telemetry-bridge@0.1.0.tgz /tmp/remote-telemetry-config.json' 2>$null | Out-Null
}
