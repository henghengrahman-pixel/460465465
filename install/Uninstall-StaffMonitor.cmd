@echo off
setlocal
fltmc >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -Verb RunAs -ArgumentList '/c','""%~f0""'"
  exit /b
)
schtasks /End /TN "StaffMonitorSystem" >nul 2>&1
schtasks /Delete /TN "StaffMonitorSystem" /F >nul 2>&1
taskkill /IM StaffMonitorAgent.exe /F /T >nul 2>&1
reg delete "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" /v "StaffMonitor" /f >nul 2>&1
rmdir /S /Q "%ProgramFiles%\StaffMonitor" >nul 2>&1
echo Staff Monitor program files and startup entries removed.
echo Device identity/history in %ProgramData%\StaffMonitor was intentionally preserved.
pause
