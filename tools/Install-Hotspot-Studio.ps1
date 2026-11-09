<# Installs Hotspot Studio and its guarded root networking helper. #>
param(
    [string]$Identity = '',
    [ValidatePattern('^[0-9A-Fa-f:.%-]+$')][string]$HostAddress = '192.168.68.114',
    [ValidatePattern('^$|^[0-9A-Fa-f:.%-]+$')][string]$SourceAddress = ''
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not $Identity) {
    $Identity = Join-Path $root 'idrive7-8-ssh-root-main\data\enrollments\WBA7V61020CD61701\id_rsa'
}
$repo = Join-Path $root 'alexp50-bmw-apps\packages'
$files = @('hotspot-studio-helper', 'hotspot_studio') | ForEach-Object {
    $component = $_
    $matches = @(Get-ChildItem -LiteralPath $repo -Filter "$component@*.tgz" -File | Sort-Object {
        if ($_.BaseName -match '@(?<version>\d+\.\d+\.\d+)$') { [version]$Matches.version } else { [version]'0.0.0' }
    } -Descending)
    if ($matches.Count -eq 0) { throw "No package found for $component in $repo" }
    $matches[0].FullName
}
foreach ($path in @($Identity) + $files) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required file not found: $path" }
}

$ssh = (Get-Command ssh -ErrorAction Stop).Source
$scp = (Get-Command scp -ErrorAction Stop).Source
$Identity = (Resolve-Path -LiteralPath $Identity).Path
$target = "root@$HostAddress"
$options = @('-o','BatchMode=yes','-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=NUL',
    '-o','GlobalKnownHostsFile=NUL','-o','IdentitiesOnly=yes','-o','ConnectTimeout=12',
    '-o','LogLevel=ERROR','-i',$Identity)
if ($SourceAddress) { $options += @('-o', "BindAddress=$SourceAddress") }

function Invoke-Car([string]$Command) {
    & $ssh @options $target $Command
    if ($LASTEXITCODE -ne 0) { throw "Car command failed (exit $LASTEXITCODE): $Command" }
}

Write-Host "Connecting to MGU $HostAddress..."
Invoke-Car "test -x /var/opt/mgu-python/current/bin/python3 && test -x /var/opt/mgu-deploy/mgu-deploy.sh && test -s /run/mgu-uplink/lease.json"

foreach ($file in $files) {
    $name = Split-Path -Leaf $file
    Write-Host "Uploading $name..."
    & $scp @options $file "${target}:/tmp/$name"
    if ($LASTEXITCODE -ne 0) { throw "Upload failed: $name" }
}

try {
    foreach ($file in $files) {
        $name = Split-Path -Leaf $file
        Invoke-Car "sh /var/opt/mgu-deploy/mgu-deploy.sh check --artifact '/tmp/$name'"
        Invoke-Car "sh /var/opt/mgu-deploy/mgu-deploy.sh install --artifact '/tmp/$name' --yes"
    }
    Invoke-Car "systemctl restart hotspot-studio-helper.service hotspot-studio-proxy.service && systemctl is-active --quiet hotspot-studio-helper.service && systemctl is-active --quiet hotspot-studio-proxy.service && test -S /run/hotspot-studio/control.sock"
    $versions = $files | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension([IO.Path]::GetFileNameWithoutExtension($_)) }
    Write-Host "Installed and verified: $($versions -join ', ')." -ForegroundColor Green
    Write-Host 'Turn on the BMW hotspot and connect the client. Hotspot Studio will show the HTTP/SOCKS endpoints; Coding Gateway is a separate parked-only session.'
} finally {
    $remoteFiles = ($files | ForEach-Object { "/tmp/$(Split-Path -Leaf $_)" }) -join ' '
    & $ssh @options $target "rm -f $remoteFiles" 2>$null | Out-Null
}
