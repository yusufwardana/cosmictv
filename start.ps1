$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot

# Secrets and stream material must not be readable by other local accounts.
# POSIX modes are ignored on NTFS, so the ACL is the only real control.
# Reapplying an ACL needs elevated privileges, so verify first and only then try to repair.
$allowedIdentities = @($env:USERNAME, 'NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')
foreach ($target in @((Join-Path $appRoot '.env'), (Join-Path $appRoot 'data'), (Join-Path $appRoot 'logs'))) {
    if (!(Test-Path -LiteralPath $target)) { continue }
    $isContainer = (Get-Item -LiteralPath $target).PSIsContainer
    $acl = Get-Acl -LiteralPath $target
    $extra = @($acl.Access | Where-Object {
        $id = $_.IdentityReference.Value
        $id -ne 'NT AUTHORITY\SYSTEM' -and $id -ne 'BUILTIN\ADMINISTRATORS' -and $id -notlike "*\$env:USERNAME"
    })
    if ($acl.Access.Count -gt 0 -and $extra.Count -eq 0) {
        Write-Output "ACL sudah dibatasi: $target"
        continue
    }
    try {
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.Access)) { $null = $acl.RemoveAccessRule($rule) }
        foreach ($identity in $allowedIdentities) {
            if ($isContainer) {
                $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity,
                    [System.Security.AccessControl.FileSystemRights]::FullControl,
                    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
                    [System.Security.AccessControl.PropagationFlags]::None,
                    [System.Security.AccessControl.AccessControlType]::Allow)
            } else {
                $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity,
                    [System.Security.AccessControl.FileSystemRights]::FullControl,
                    [System.Security.AccessControl.InheritanceFlags]::None,
                    [System.Security.AccessControl.PropagationFlags]::None,
                    [System.Security.AccessControl.AccessControlType]::Allow)
            }
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $target -AclObject $acl
        Write-Output "ACL dibatasi: $target"
    } catch {
        Write-Warning "ACL $target perlu diperbaiki manual (jalankan sebagai Administrator): $($_.Exception.Message)"
    }
}

$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$pidFile = Join-Path $appRoot 'server.pid'
if (Test-Path -LiteralPath $pidFile) {
    $savedPid = 0
    if ([int]::TryParse((Get-Content -Raw -LiteralPath $pidFile).Trim(), [ref]$savedPid)) {
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
        if ($existing -and $existing.Name -eq 'node.exe' -and $existing.CommandLine.Contains((Join-Path $appRoot 'server.mjs'))) {
            Write-Output "Server sudah berjalan (PID $savedPid)."
            exit 0
        }
    }
}
$logs = Join-Path $appRoot 'logs'
$null = New-Item -ItemType Directory -Force -Path $logs
$entry = Join-Path $appRoot 'server.mjs'
$process = Start-Process -WindowStyle Hidden -FilePath $nodeExe -ArgumentList @('"' + $entry + '"') -WorkingDirectory $appRoot -RedirectStandardOutput (Join-Path $logs 'server.log') -RedirectStandardError (Join-Path $logs 'error.log') -PassThru
Start-Sleep -Milliseconds 800
$process.Refresh()
if ($process.HasExited) {
    throw "Server gagal dijalankan. Periksa $logs\error.log"
}
Set-Content -LiteralPath $pidFile -Value $process.Id
Write-Output "Server dimulai (PID $($process.Id)). Log: $logs\server.log"
