# Stops every HomeBase dev process started from this repo (hub, connector, Metro/web, Electron). The emulator is left alone.
$root = (Resolve-Path "$PSScriptRoot\..").Path
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='electron.exe'" |
  Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$root*" -or $_.CommandLine -like "*homebase*apps*") } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; "stopped $($_.Name) $($_.ProcessId)" } catch {} }
foreach ($port in 8787, 8081) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop; "stopped pid $($_.OwningProcess) on port $port" } catch {}
  }
}
