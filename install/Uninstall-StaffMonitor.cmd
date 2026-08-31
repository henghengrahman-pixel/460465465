@echo off
setlocal EnableExtensions
fltmc >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:ComSpec -ArgumentList '/d','/c','""%~f0""' -Verb RunAs"
  exit /b
)
set "APPDIR=%ProgramFiles%\StaffMonitor"
for %%T in ("StaffMonitorSystem" "StaffMonitorAgent" "StaffMonitorUser") do (
  schtasks /End /TN %%~T >nul 2>&1
  schtasks /Delete /TN %%~T /F >nul 2>&1
)
reg delete "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" /v "StaffMonitor" /f >nul 2>&1
reg delete "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" /v "StaffMonitor" /f >nul 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue';Get-Process|Where-Object {$_.ProcessName -like 'StaffMonitorAgent*'}|Stop-Process -Force;Start-Sleep -Milliseconds 700;Remove-Item -LiteralPath '%APPDIR%' -Recurse -Force" >nul 2>&1
echo StaffMonitor program files dan startup sudah dihapus.
echo Data device/config tetap disimpan di %%ProgramData%%\StaffMonitor agar reinstall mempertahankan identity/history.
pause
