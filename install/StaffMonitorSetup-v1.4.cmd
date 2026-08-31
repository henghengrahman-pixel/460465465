@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
set "APPDIR=%ProgramFiles%\StaffMonitor"
set "DATADIR=%ProgramData%\StaffMonitor"
set "AGENT=%APPDIR%\StaffMonitorAgent.exe"
set "SRC=%~dp0..\dist\StaffMonitorAgent.exe"
set "SERVER=https://460465465-production.up.railway.app"
set "SECRET=cb455b612af9265b8fd084d11ba5516beb8c55efcdd4cac1"
set "TASK=StaffMonitorSystem"

echo =====================================================
echo STAFF MONITOR v1.4 - INSTALL / UPDATE
echo =====================================================
echo This installs a company monitoring agent, startup entry,
echo and a SYSTEM worker for approved device policy commands.
echo.

fltmc >nul 2>&1
if errorlevel 1 (
  echo Requesting Administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -Verb RunAs -ArgumentList '/c','""%~f0""'"
  exit /b
)

if not exist "%SRC%" (
  echo [ERROR] Agent binary not found:
  echo %SRC%
  pause
  exit /b 2
)

echo [1/8] Checking server...
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 12 '%SERVER%/health'; if($r.StatusCode -lt 200 -or $r.StatusCode -ge 300){exit 1} } catch { exit 1 }"
if errorlevel 1 (
  echo [ERROR] Railway server cannot be reached. Installation stopped.
  pause
  exit /b 3
)

echo [2/8] Stopping previous agent...
schtasks /End /TN "%TASK%" >nul 2>&1
schtasks /Change /TN "%TASK%" /Disable >nul 2>&1
taskkill /IM StaffMonitorAgent.exe /F /T >nul 2>&1
for /L %%I in (1,1,20) do (
  tasklist /FI "IMAGENAME eq StaffMonitorAgent.exe" /NH | find /I "StaffMonitorAgent.exe" >nul
  if errorlevel 1 goto agent_stopped
  timeout /t 1 /nobreak >nul
)
echo [ERROR] Previous agent is still running. Restart Windows and run this setup again.
pause
exit /b 4

:agent_stopped
echo [3/8] Installing agent...
if not exist "%APPDIR%" mkdir "%APPDIR%"
copy /Y "%SRC%" "%AGENT%.new" >nul
if errorlevel 1 goto copy_error
if exist "%AGENT%" del /F /Q "%AGENT%.old" >nul 2>&1
if exist "%AGENT%" move /Y "%AGENT%" "%AGENT%.old" >nul 2>&1
move /Y "%AGENT%.new" "%AGENT%" >nul
if errorlevel 1 goto copy_error
del /F /Q "%AGENT%.old" >nul 2>&1

echo [4/8] Preserving device identity and updating config...
if not exist "%DATADIR%" mkdir "%DATADIR%"
powershell -NoProfile -Command ^
  "$p='%DATADIR%\config.json'; try{$c=if(Test-Path $p){Get-Content -Raw $p|ConvertFrom-Json}else{New-Object PSObject}}catch{$c=New-Object PSObject}; if(-not $c.deviceUid){$c|Add-Member NoteProperty deviceUid ([guid]::NewGuid().ToString('N')) -Force}; $c|Add-Member NoteProperty serverUrl '%SERVER%' -Force; $c|Add-Member NoteProperty enrollSecret '%SECRET%' -Force; if(-not $c.officeName){$c|Add-Member NoteProperty officeName 'UNASSIGNED' -Force}; $c|Add-Member NoteProperty heartbeatSeconds 20 -Force; $c|ConvertTo-Json -Depth 8|Set-Content -Encoding UTF8 $p"
if errorlevel 1 (
  echo [ERROR] Could not write configuration.
  pause
  exit /b 6
)

echo [5/8] Registering user-session startup for activity + Live Screen...
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" /v "StaffMonitor" /t REG_SZ /d "\"%AGENT%\" --user" /f >nul
if errorlevel 1 (
  echo [ERROR] Could not register Windows startup.
  pause
  exit /b 7
)

echo [6/8] Registering SYSTEM worker for approved device-policy commands...
schtasks /Create /TN "%TASK%" /SC ONSTART /RU SYSTEM /RL HIGHEST /TR "\"%AGENT%\" --system" /F >nul
if errorlevel 1 (
  echo [ERROR] Could not create Windows startup task.
  pause
  exit /b 8
)
schtasks /Change /TN "%TASK%" /Enable >nul 2>&1

echo [7/8] Starting agent...
start "" "%AGENT%" --user
timeout /t 5 /nobreak >nul
schtasks /Run /TN "%TASK%" >nul 2>&1
timeout /t 3 /nobreak >nul

echo [8/8] Checking enrollment...
powershell -NoProfile -Command "$p='%DATADIR%\config.json'; try{$c=Get-Content -Raw $p|ConvertFrom-Json; if([string]::IsNullOrWhiteSpace($c.deviceToken)){exit 1}else{exit 0}}catch{exit 1}"
if errorlevel 1 (
  echo.
  echo [WARNING] Agent is installed but enrollment has not completed yet.
  echo Check DEVICE_ENROLL_SECRET on Railway and then restart this PC.
  echo Log: %DATADIR%\logs\agent-user.log
  pause
  exit /b 9
)

echo.
echo =====================================================
echo INSTALLATION / UPDATE SUCCESSFUL
ECHO Device identity and history were preserved.
echo Live Screen becomes available while a Windows user is logged in.
echo =====================================================
pause
exit /b 0

:copy_error
echo [ERROR] Could not replace StaffMonitorAgent.exe.
echo The previous process may still be locking the file.
if exist "%AGENT%.old" if not exist "%AGENT%" move /Y "%AGENT%.old" "%AGENT%" >nul 2>&1
pause
exit /b 5
