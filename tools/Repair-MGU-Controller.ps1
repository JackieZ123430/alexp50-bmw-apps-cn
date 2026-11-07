<#
Diagnoses and repairs the shared iDrive-controller bridge used by every app in
this repository.  It changes no ECU coding.  A missing HMI preload needs a
normal head-unit restart; the script prepares that restart and reports it.
#>
param(
    [string]$Identity = '',
    [ValidatePattern('^[0-9A-Fa-f:.%-]+$')]
    [string]$HostAddress = '169.254.202.140'
)

$ErrorActionPreference = 'Stop'
if (-not $Identity) {
    $locations = @(
        $PSScriptRoot,
        (Split-Path -Parent $PSScriptRoot),
        (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
    )
    $bmwRoot = $locations | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'idrive7-8-ssh-root-main') -PathType Container } | Select-Object -First 1
    if (-not $bmwRoot) { throw 'Could not locate the BMW workspace. Pass -Identity with the full SSH key path.' }
    $Identity = Join-Path $bmwRoot 'idrive7-8-ssh-root-main\data\enrollments\WBA7V61020CD61701\id_rsa'
}
if (-not (Test-Path -LiteralPath $Identity -PathType Leaf)) { throw "SSH key not found: $Identity" }
$ssh = (Get-Command ssh -ErrorAction Stop).Source
$Identity = (Resolve-Path -LiteralPath $Identity).Path
$target = "root@$HostAddress"
$options = @(
    '-o','BatchMode=yes','-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=NUL',
    '-o','GlobalKnownHostsFile=NUL','-o','IdentitiesOnly=yes','-o','ConnectTimeout=12',
    '-o','LogLevel=ERROR','-i',$Identity
)
function Invoke-Car([string]$Command, [switch]$AllowFailure) {
    $out = & $ssh @options $target $Command 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $AllowFailure) { throw "Car command failed (exit $code): $Command`n$($out -join "`n")" }
    return ,@($code, ($out -join "`n"))
}

Write-Host "Checking shared iDrive controller bridge on $HostAddress..." -ForegroundColor Cyan
$probe = @'
set +e
echo "hmi=$(systemctl is-active hmi.service 2>/dev/null)"
echo "render=$(systemctl is-active mgu-render.service 2>/dev/null)"
echo "render_alt=$(systemctl is-active idrive7-renderd.service 2>/dev/null)"
echo "gate_guard=$(systemctl is-active mgu-inputgate-guard.service 2>/dev/null)"
echo "gate_check=$(systemctl is-active mgu-inputgate-check.service 2>/dev/null)"
echo "gate_strikes=$(cat /var/opt/mgu-inputgate/strikes 2>/dev/null || echo missing)"
echo "gate_version=$(readlink /var/opt/mgu-inputgate/current 2>/dev/null || echo missing)"
p=$(pidof HmiMain3D 2>/dev/null | cut -d' ' -f1)
echo "hmi_pid=${p:-missing}"
if [ -n "$p" ] && grep -q mgu-inputgate "/proc/$p/maps" 2>/dev/null; then echo gate_loaded=yes; else echo gate_loaded=no; fi
echo "gate_env=$(cat /run/mgu-inputgate.env 2>/dev/null || echo missing)"
echo "gate_dropin=$(test -f /etc/systemd/system/hmi.service.d/zz-mgu-inputgate.conf && echo yes || echo no)"
echo "renderer_conflicts=$(journalctl -u mgu-render -u idrive7-renderd --no-pager -n 120 2>/dev/null | grep -c 'another renderer has it')"
'@
$result = Invoke-Car $probe
$status = @{}
foreach ($line in ($result[1] -split "`r?`n")) {
    $at = $line.IndexOf('=')
    if ($at -gt 0) { $status[$line.Substring(0,$at)] = $line.Substring($at+1) }
}
$status.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Host ("{0}: {1}" -f $_.Name,$_.Value) }

if ($status.gate_version -eq 'missing' -or $status.gate_dropin -ne 'yes') {
    throw 'mgu-inputgate is not installed completely. Update Controller gate from the alexp50/bmw-apps Store source first.'
}

if ($status.gate_loaded -ne 'yes') {
    Write-Host "`nThe HMI did not load mgu-inputgate.so. Resetting its boot guard for the next start..." -ForegroundColor Yellow
    $repair = @'
set -e
D=/var/opt/mgu-inputgate
v=$(readlink "$D/current")
echo 0 > "$D/strikes"
echo "$v" > "$D/strikes.version"
rm -f /run/mgu-inputgate.env
systemctl daemon-reload
sync
'@
    [void](Invoke-Car $repair)
    Write-Host 'Prepared successfully. Restart the head unit once (long press the volume knob or a normal sleep/wake cycle), then run this same command again.' -ForegroundColor Yellow
    exit 2
}

$rendererConflicts = if ($status.ContainsKey('renderer_conflicts')) { [int]$status.renderer_conflicts } else { 0 }
if ($rendererConflicts -gt 0) {
    Write-Host "`nA second renderer previously held the controller event socket. Restarting only the renderer services..." -ForegroundColor Yellow
    [void](Invoke-Car 'systemctl restart idrive7-renderd.service 2>/dev/null || true; systemctl restart mgu-render.service 2>/dev/null || true; sleep 3; systemctl is-active -q mgu-render.service || systemctl is-active -q idrive7-renderd.service')
}

Write-Host "`nController bridge is loaded. Open any AlexP50 app and turn/press the controller; tabs and bottom actions should now take focus." -ForegroundColor Green
Write-Host 'No ECU coding was changed.'
