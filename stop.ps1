$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'server.pid'
if (!(Test-Path -LiteralPath $pidFile)) { Write-Output 'Tidak ada PID server tersimpan.'; exit 0 }
$savedPid = 0
if (![int]::TryParse((Get-Content -Raw -LiteralPath $pidFile).Trim(), [ref]$savedPid)) { throw 'PID tidak valid.' }
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
$entry = Join-Path $PSScriptRoot 'server.mjs'
if ($process) {
    if ($process.Name -ne 'node.exe' -or !$process.CommandLine.Contains($entry)) { throw 'PID bukan milik server ini; tidak dihentikan.' }
    Stop-Process -Id $savedPid
}
Remove-Item -LiteralPath $pidFile
Write-Output 'Server dihentikan.'
