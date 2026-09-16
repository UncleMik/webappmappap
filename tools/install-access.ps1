$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $PSScriptRoot 'preview-runtime'
$configFile = Join-Path $runtime 'access.json'
$taskName = 'WebPril-Access'
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if (-not (Test-Path -LiteralPath $configFile)) {
  $random = New-Object byte[] 15
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  $generator.GetBytes($random); $generator.Dispose()
  $config = [ordered]@{
    username = 'webpril'
    password = ([BitConverter]::ToString($random)).Replace('-', '').ToLowerInvariant()
    port = 5173
    node = (Get-Command node.exe).Source
    cloudflared = (Get-Command cloudflared.exe).Source
    telegramRoot = 'D:\Codex проекты\HotVPN\Hot_TG'
    telegramSender = 'D:\Codex проекты\HotVPN\Hot_TG\.codex\skills\send-hotvpn-telegram\scripts\send-media.mjs'
  }
  [IO.Directory]::CreateDirectory($runtime) | Out-Null
  [IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
}
$acl = Get-Acl -LiteralPath $configFile
if (-not $acl.AreAccessRulesProtected) {
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
  $identity = New-Object Security.Principal.SecurityIdentifier($sid)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')))
}
Set-Acl -LiteralPath $configFile -AclObject $acl
}
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'start-access.ps1') + '"'
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument $arguments -WorkingDirectory $projectRoot
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$mode = 'boot'
try {
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $principal -Force -ErrorAction Stop | Out-Null
} catch {
  $mode = 'user-logon'
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Settings $settings -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $currentUser) -Principal $principal -Force -ErrorAction Stop | Out-Null
}
[IO.File]::WriteAllText((Join-Path $runtime 'startup.json'), (@{mode=$mode;taskName=$taskName;installedAt=(Get-Date).ToString('o')} | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
[pscustomobject]@{taskName=$taskName;startupMode=$mode;credentialsCreated=$true} | ConvertTo-Json
