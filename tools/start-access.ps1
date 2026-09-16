$ErrorActionPreference = 'Stop'
$instance = New-Object System.Threading.Mutex($false, 'Global\WebPrilAccess')
try { $owned = $instance.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { $instance.Dispose(); exit }
$projectRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'preview-runtime/access.json') -Raw | ConvertFrom-Json
Set-Location -LiteralPath $projectRoot
# Keep Windows awake while this service runs; the display may still turn off.
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class WebPrilPower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'
[void][WebPrilPower]::SetThreadExecutionState([uint32]2147483649)
try {
  while ($true) {
    $worker = Start-Process -FilePath $config.node -ArgumentList ('"' + (Join-Path $PSScriptRoot 'access-supervisor.cjs') + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    $worker.WaitForExit()
    Start-Sleep -Seconds 10
  }
} finally {
  if ($worker -and -not $worker.HasExited) { Stop-Process -Id $worker.Id -Force -ErrorAction SilentlyContinue }
  [void][WebPrilPower]::SetThreadExecutionState([uint32]2147483648)
  $instance.ReleaseMutex(); $instance.Dispose()
}
