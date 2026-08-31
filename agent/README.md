# Windows Agent

Agent mengirim heartbeat tiap 20 detik dan event saat foreground application berubah. Agent tidak merekam ketikan, password, cookie, isi clipboard, atau isi file.

Build Windows:

```bash
cd agent
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o ../dist/StaffMonitorAgent.exe .
```

Environment saat instalasi pertama:
- STAFFMON_SERVER=https://domain-railway-anda
- STAFFMON_ENROLL_SECRET=secret yang sama dengan Railway
- STAFFMON_OFFICE=KANTOR A

Setelah enrollment, token device disimpan di `%PROGRAMDATA%\\StaffMonitor\\config.json`.
