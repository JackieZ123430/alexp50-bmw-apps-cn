<#
Connects this Windows PC to Hotspot Studio's userspace Internet and ENET
gateway. Run after joining the BMW hotspot and enabling Internet sharing plus
the parked Coding Gateway in Hotspot Studio.
#>
param(
    [ValidateSet('Enable', 'Restore')]
    [string]$Mode = 'Enable',
    [ValidatePattern('^[0-9A-Fa-f:.%-]+$')]
    [string]$GatewayAddress = '172.16.222.97'
)

$ErrorActionPreference = 'Stop'
$stateRoot = Join-Path $env:ProgramData 'BMW-Hotspot-Gateway'
$stateFile = Join-Path $stateRoot 'windows-backup.json'
$internetKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$ediabasFiles = @(
    'C:\Program Files\BMW\ISPI\TRIC\ISTA\EdiabasLib\EdiabasLib.config',
    'C:\Program Files\BMW\ISPI\TRIC\ISTA\Ediabas\BIN\EDIABAS.INI',
    'C:\EC-APPS\EDIABAS\Bin\EDIABAS.INI'
)

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
        '-Mode', $Mode, '-GatewayAddress', $GatewayAddress)
    $process = Start-Process powershell.exe -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    exit $process.ExitCode
}

function Get-RegistryValue([string]$Name) {
    $item = Get-ItemProperty -LiteralPath $internetKey -ErrorAction Stop
    $property = $item.PSObject.Properties[$Name]
    [pscustomobject]@{
        Exists = $null -ne $property
        Value = if ($null -ne $property) { $property.Value } else { $null }
    }
}

function Restore-RegistryValue([string]$Name, $Snapshot, [string]$Type) {
    if ($Snapshot.Exists) {
        New-ItemProperty -LiteralPath $internetKey -Name $Name -Value $Snapshot.Value -PropertyType $Type -Force | Out-Null
    } else {
        Remove-ItemProperty -LiteralPath $internetKey -Name $Name -ErrorAction SilentlyContinue
    }
}

function Notify-ProxyChange {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InternetSettingsNotify {
    [DllImport("wininet.dll", SetLastError=true)]
    public static extern bool InternetSetOption(IntPtr h, int option, IntPtr buffer, int length);
}
'@ -ErrorAction SilentlyContinue
    [InternetSettingsNotify]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
    [InternetSettingsNotify]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
}

if ($Mode -eq 'Restore') {
    if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) {
        throw "No saved Windows configuration exists at $stateFile"
    }
    $saved = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    Restore-RegistryValue ProxyEnable $saved.proxy.ProxyEnable DWord
    Restore-RegistryValue ProxyServer $saved.proxy.ProxyServer String
    Restore-RegistryValue ProxyOverride $saved.proxy.ProxyOverride String
    Restore-RegistryValue AutoConfigURL $saved.proxy.AutoConfigURL String
    Notify-ProxyChange
    if (Test-Path -LiteralPath $saved.winHttpDump -PathType Leaf) {
        & netsh.exe exec $saved.winHttpDump | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not restore the saved WinHTTP configuration.' }
    }
    foreach ($entry in $saved.ediabas) {
        if (Test-Path -LiteralPath $entry.Backup -PathType Leaf) {
            Copy-Item -LiteralPath $entry.Backup -Destination $entry.Path -Force
        }
    }
    Remove-Item -LiteralPath $stateFile -Force
    Write-Host 'Restored the previous Windows proxy and BMW diagnostic configuration.' -ForegroundColor Green
    exit 0
}

$requiredPorts = [ordered]@{
    3128 = 'HTTP Internet proxy (enable Internet sharing in Hotspot Studio)'
    1088 = 'SOCKS5 Internet proxy'
    6801 = 'ENET relay (start a parked Coding Gateway session for this PC)'
}
foreach ($port in $requiredPorts.Keys) {
    if (-not (Test-NetConnection -ComputerName $GatewayAddress -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue)) {
        throw "$($requiredPorts[$port]) is not reachable at ${GatewayAddress}:$port"
    }
}

try {
    $probe = Invoke-WebRequest -UseBasicParsing -Uri 'http://example.com/' -Proxy "http://${GatewayAddress}:3128" -TimeoutSec 12
    if ($probe.StatusCode -lt 200 -or $probe.StatusCode -ge 400) { throw "HTTP $($probe.StatusCode)" }
} catch {
    throw "The Huawei Internet path did not answer through ${GatewayAddress}:3128. In Hotspot Studio, start Internet sharing first. $($_.Exception.Message)"
}

$udp = [Net.Sockets.UdpClient]::new()
try {
    $udp.Client.ReceiveTimeout = 2500
    $payload = [byte[]](0, 0, 0, 0, 0, 0x11)
    $null = $udp.Send($payload, $payload.Length, $GatewayAddress, 6811)
    $remote = [Net.IPEndPoint]::new([Net.IPAddress]::Any, 0)
    $reply = $udp.Receive([ref]$remote)
    $replyText = [Text.Encoding]::ASCII.GetString($reply).Replace([char]0, '')
    if (-not $replyText.Contains('BMWVIN')) { throw 'The reply did not contain a BMW VIN.' }
} catch {
    throw "The guarded ENET relay did not answer at ${GatewayAddress}:6811. Select this laptop in Hotspot Studio and start its parked Coding Gateway session. $($_.Exception.Message)"
} finally {
    $udp.Dispose()
}

New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) {
    $stamp = Get-Date -Format 'yyyyMMddTHHmmss'
    $backupRoot = Join-Path $stateRoot $stamp
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $winHttpDump = Join-Path $backupRoot 'winhttp.txt'
    & netsh.exe winhttp dump | Set-Content -LiteralPath $winHttpDump -Encoding Unicode
    $ediabas = @()
    foreach ($path in $ediabasFiles) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $copy = Join-Path $backupRoot ((Split-Path -Leaf $path) + '-' + $ediabas.Count + '.bak')
        Copy-Item -LiteralPath $path -Destination $copy -Force
        $ediabas += [pscustomobject]@{ Path = $path; Backup = $copy }
    }
    [pscustomobject]@{
        proxy = [pscustomobject]@{
            ProxyEnable = Get-RegistryValue ProxyEnable
            ProxyServer = Get-RegistryValue ProxyServer
            ProxyOverride = Get-RegistryValue ProxyOverride
            AutoConfigURL = Get-RegistryValue AutoConfigURL
        }
        winHttpDump = $winHttpDump
        ediabas = $ediabas
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $stateFile -Encoding UTF8
}

$proxy = "http=${GatewayAddress}:3128;https=${GatewayAddress}:3128"
New-ItemProperty -LiteralPath $internetKey -Name ProxyEnable -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -LiteralPath $internetKey -Name ProxyServer -Value $proxy -PropertyType String -Force | Out-Null
New-ItemProperty -LiteralPath $internetKey -Name ProxyOverride -Value '<local>;localhost;127.*;172.16.*;192.168.*' -PropertyType String -Force | Out-Null
Remove-ItemProperty -LiteralPath $internetKey -Name AutoConfigURL -ErrorAction SilentlyContinue
Notify-ProxyChange
& netsh.exe winhttp set proxy "proxy-server=$proxy" 'bypass-list=<local>;localhost;127.*;172.16.*;192.168.*' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not configure the WinHTTP proxy.' }

$fixIsta = Join-Path $PSScriptRoot 'Fix-ISTA-ENET.ps1'
if (-not (Test-Path -LiteralPath $fixIsta -PathType Leaf)) { throw "Missing $fixIsta" }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fixIsta -GatewayAddress $GatewayAddress
if ($LASTEXITCODE -ne 0) { throw 'Could not point ISTA/EDIABAS at the Hotspot Studio ENET relay.' }

Write-Host 'BMW hotspot gateway enabled for this PC.' -ForegroundColor Green
Write-Host "Internet: HTTP ${GatewayAddress}:3128 | SOCKS5 ${GatewayAddress}:1088"
Write-Host "ISTA/EDIABAS: ENET ${GatewayAddress}:6801"
Write-Host "E-Sys: choose an ENET connection and enter $GatewayAddress as the gateway."
Write-Host "Restore later: powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Mode Restore"
