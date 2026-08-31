import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const agent=fs.readFileSync('agent/main.go','utf8');
const server=fs.readFileSync('server/src/index.js','utf8');
const ui=fs.readFileSync('dashboard/public/app.js','utf8');
const installer=fs.readFileSync('install/Install-StaffMonitor.ps1','utf8');

test('v2 agent uses watchdog and never stops permanently on enrollment outage',()=>{
  assert.match(agent,/const Version = "2\.0\.0"/);
  assert.match(agent,/watchdogLoop/);
  assert.match(agent,/--watchdog/);
  assert.match(agent,/retrying in 15s/);
  assert.doesNotMatch(agent,/user loop stopped/);
});

test('v2 installation uses ProgramData no-space binary path and clean upgrade',()=>{
  assert.match(installer,/ProgramData/);
  assert.match(installer,/StaffMonitorAgent\.exe/);
  assert.match(installer,/Stop dan copot semua versi lama/);
  assert.match(installer,/HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run/);
  assert.match(installer,/--watchdog/);
  assert.match(installer,/ScheduledTasks API/);
  assert.match(installer,/schtasks fallback/);
  assert.doesNotMatch(installer,/Add-MpPreference|Set-MpPreference|DisableRealtimeMonitoring|ExclusionPath/i);
});

test('v2 keeps user/system heartbeat distinction and longer offline grace',()=>{
  assert.match(server,/SYSTEM_ONLY/);
  assert.match(server,/user_last_seen=now\(\)/);
  assert.match(server,/system_last_seen=now\(\)/);
  assert.match(server,/180 seconds/);
  assert.match(server,/effective_last_seen/);
});

test('v2 dashboard never shows blank app for an active user agent',()=>{
  assert.match(ui,/Windows Desktop/);
  assert.match(ui,/USER AGENT BELUM AKTIF/);
  assert.match(ui,/effective_last_seen/);
});

test('live screen and domain controls remain present',()=>{
  assert.match(server,/live\/start/);
  assert.match(server,/live-frame/);
  assert.match(server,/BLOCK_DOMAINS/);
  assert.match(server,/UNBLOCK_DOMAINS/);
});
