import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const agent=fs.readFileSync('agent/main.go','utf8');
const server=fs.readFileSync('server/src/index.js','utf8');
const migrate=fs.readFileSync('server/src/migrate.js','utf8');
const installer=fs.readFileSync('INSTALL-NOW.cmd','utf8');

test('v1.4.4 separates SYSTEM and interactive user heartbeats',()=>{
  assert.match(migrate,/system_last_seen/);
  assert.match(migrate,/user_last_seen/);
  assert.match(server,/SYSTEM_ONLY/);
  assert.match(server,/user_last_seen=now\(\)/);
  assert.match(server,/system_last_seen=now\(\)/);
});

test('v1.4.4 has stable hardware identity and token recovery',()=>{
  assert.match(agent,/const Version = "1\.4\.4"/);
  assert.match(agent,/machineHardwareUID/);
  assert.match(agent,/refreshTokenFromDisk/);
  assert.match(agent,/heartbeat unauthorized; refreshing token from disk/);
});

test('v1.4.4 installer cleans old startup/processes then installs fresh binary',()=>{
  assert.match(installer,/Removing old startup entries/);
  assert.match(installer,/Stopping every previous StaffMonitorAgent process/);
  assert.match(installer,/Cleaning obsolete binaries/);
  assert.match(installer,/Get-FileHash/);
  assert.match(installer,/StaffMonitorAgent-v%VERSION%\.exe/);
});
