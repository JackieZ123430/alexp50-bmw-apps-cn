<#
Repairs a shared ID7 rendering failure where the digital-video surface 0x198
is advertised as visible with a 0x0 buffer.  mgu-render can otherwise yield
every custom app layer to that empty surface, leaving all GPU apps blank.

The repair changes only mgu-render's persistent local configuration and
restarts that service.  It does not restart the HMI or code any ECU.
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
    $bmwRoot = $locations |
        Where-Object { Test-Path -LiteralPath (Join-Path $_ 'idrive7-8-ssh-root-main') -PathType Container } |
        Select-Object -First 1
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

$repair = @'
set -eu
conf=/var/opt/mgu-render/mgu-render.local.conf
mkdir -p "$(dirname "$conf")"
if [ -f "$conf" ] && [ ! -f "${conf}.before-empty-video-fix" ]; then
  cp -p "$conf" "${conf}.before-empty-video-fix"
fi
tmp="${conf}.tmp.$$"
if [ -f "$conf" ]; then
  grep -v '^[[:space:]]*yield_surfaces[[:space:]]*=' "$conf" > "$tmp" || true
else
  : > "$tmp"
fi
printf '%s\n' 'yield_surfaces = 0x197, 0x19d, 0x19f' >> "$tmp"
mv "$tmp" "$conf"
systemctl daemon-reload
systemctl restart mgu-render.service
sleep 3
systemctl is-active --quiet mgu-render.service
if journalctl -u mgu-render.service --since '-10 seconds' --no-pager | grep -q 'watching surface 0x198'; then
  echo 'mgu-render still watches empty digital-video surface 0x198' >&2
  exit 1
fi
echo '--- persistent configuration ---'
cat "$conf"
echo '--- renderer startup ---'
journalctl -u mgu-render.service --since '-10 seconds' --no-pager | grep -E 'watching surface|centre output|listening on' || true
'@

Write-Host "Repairing the shared custom-app renderer on $HostAddress..." -ForegroundColor Cyan
& $ssh @options $target $repair
if ($LASTEXITCODE -ne 0) { throw "Renderer repair failed with exit code $LASTEXITCODE" }
Write-Host 'Shared renderer repaired. Custom apps can now use the full 1920x720 canvas.' -ForegroundColor Green
Write-Host 'No ECU coding or HMI restart was performed.'
