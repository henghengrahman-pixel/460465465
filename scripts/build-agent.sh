#!/usr/bin/env sh
set -eu
mkdir -p dist
cd agent
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -H=windowsgui" -o ../dist/StaffMonitorAgent.exe .
echo "Built dist/StaffMonitorAgent.exe"
