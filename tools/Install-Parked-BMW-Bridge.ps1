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
$artifact = Get-ChildItem -LiteralPath (Join-Path $repo 'packages') -Filter 'remote-telemetry-bridge@*.tgz' -File |
    ForEach-Object {
        if ($_.BaseName -match '^remote-telemetry-bridge@(?<version>\d+\.\d+\.\d+)$') {
            [pscustomobject]@{ File = $_; Version = [version]$Matches.version }
        }
    } | Sort-Object Version -Descending | Select-Object -First 1
if (-not $artifact) { throw 'No Remote Telemetry Bridge package was found.' }
$artifactPath = $artifact.File.FullName
$artifactName = $artifact.File.Name
foreach ($path in @($Identity,$ConnectionFile,$artifactPath)) {
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
    $carConfigJson = [ordered]@{endpoint=$connection.endpoint;carId=$connection.carId;writeToken=$connection.writeToken} |
        ConvertTo-Json -Compress
    # Windows PowerShell 5.1's -Encoding utf8 adds a BOM. Node 8's JSON.parse
    # does not discard it, so write the MGU config as explicit BOM-free UTF-8.
    [IO.File]::WriteAllText($tempConfig, $carConfigJson, [Text.UTF8Encoding]::new($false))
    Write-Host "Connecting to MGU $HostAddress..."
    Invoke-Car 'test -x /var/opt/mgu-deploy/mgu-deploy.sh && test -s /run/mgu-uplink/lease.json'
    & $scp @options $artifactPath "${target}:/tmp/$artifactName"
    if ($LASTEXITCODE -ne 0) { throw 'Bridge package upload failed.' }
    & $scp @options $tempConfig "${target}:/tmp/remote-telemetry-config.json"
    if ($LASTEXITCODE -ne 0) { throw 'Bridge configuration upload failed.' }
    Invoke-Car "sh /var/opt/mgu-deploy/mgu-deploy.sh check --artifact '/tmp/$artifactName'"
    Invoke-Car "sh /var/opt/mgu-deploy/mgu-deploy.sh install --artifact '/tmp/$artifactName' --yes"
    # This MGU image has BusyBox cp/chmod/chown but no GNU/BSD `install`.
    Invoke-Car "mkdir -p /var/opt/remote-telemetry-bridge && cp /tmp/remote-telemetry-config.json /var/opt/remote-telemetry-bridge/config.json && chown root:root /var/opt/remote-telemetry-bridge/config.json && chmod 0600 /var/opt/remote-telemetry-bridge/config.json && systemctl restart remote-telemetry-bridge.service"
    Start-Sleep -Seconds 4
    Invoke-Car 'systemctl is-active --quiet remote-telemetry-bridge.service && cat /run/remote-telemetry-bridge/status.json'
    Write-Host 'Parked BMW telemetry bridge installed and configured.' -ForegroundColor Green
} finally {
    Remove-Item -LiteralPath $tempConfig -Force -ErrorAction SilentlyContinue
    & $ssh @options $target "rm -f '/tmp/$artifactName' /tmp/remote-telemetry-config.json" 2>$null | Out-Null
}
