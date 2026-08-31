@echo off
setlocal EnableExtensions
fltmc >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -Verb RunAs -ArgumentList '/c','""%~f0""'"
  exit /b
)
schtasks /End /TN "StaffMonitorSystem" >nul 2>&1
schtasks /Delete /TN "StaffMonitorSystem" /F >nul 2>&1
reg delete "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" /v "StaffMonitor" /f >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$app=[IO.Path]::GetFullPath('%ProgramFiles%\StaffMonitor'); Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath)).StartsWith($app,[StringComparison]::OrdinalIgnoreCase) -and $_.Name -like 'StaffMonitorAgent*.exe' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }" >nul 2>&1
timeout /t 2 /nobreak >nul
rmdir /S /Q "%ProgramFiles%\StaffMonitor" >nul 2>&1
echo Staff Monitor program files and startup entries removed.
echo Device identity/history in %ProgramData%\StaffMonitor was intentionally preserved.
pause
