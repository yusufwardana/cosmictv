$ErrorActionPreference = 'Stop'
try {
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Jalankan skrip ini melalui PowerShell sebagai Administrator.'
}
$ruleName = 'DopamineTV-Playlist-LAN-8787'
$existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
if (!$existing) {
    New-NetFirewallRule -Name $ruleName -DisplayName 'COSMIC TV Playlist API (LAN only)' -Direction Inbound -Protocol TCP -LocalPort 8787 -RemoteAddress LocalSubnet -Profile Any -Action Allow | Out-Null
}
Write-Output 'Firewall LAN aktif untuk TCP 8787, hanya RemoteAddress LocalSubnet.'
@{ success = $true; message = 'TCP 8787 dibuka untuk LocalSubnet.' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'logs\lan-setup.json')
} catch {
    @{ success = $false; message = $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'logs\lan-setup.json')
    exit 1
}
