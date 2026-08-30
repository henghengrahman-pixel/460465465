#define MyAppName "Staff Monitor Agent"
#define MyAppVersion "1.3.0"
#define MyAppExeName "StaffMonitorAgent.exe"
[Setup]
AppId={{8FCF6CB0-B0F1-4C02-94B8-C61C8902D73E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\StaffMonitor
PrivilegesRequired=admin
OutputDir=..\dist
OutputBaseFilename=StaffMonitorSetup
Compression=lzma2
SolidCompression=yes
[Files]
Source: "..\dist\StaffMonitorAgent.exe"; DestDir: "{app}"; Flags: ignoreversion
[Registry]
Root: HKLM; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "StaffMonitor"; ValueData: """{app}\StaffMonitorAgent.exe"""; Flags: uninsdeletevalue
[Run]
Filename: "{app}\StaffMonitorAgent.exe"; Description: "Jalankan Staff Monitor Agent"; Flags: nowait postinstall skipifsilent
