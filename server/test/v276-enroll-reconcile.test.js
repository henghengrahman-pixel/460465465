import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server=fs.readFileSync(new URL('../src/index.js', import.meta.url),'utf8');
const migrate=fs.readFileSync(new URL('../src/migrate.js', import.meta.url),'utf8');
const dash=fs.readFileSync(new URL('../../dashboard/public/app.js', import.meta.url),'utf8');
const installer=fs.readFileSync(new URL('../../PC-INSTALLER/Install-StaffMonitor.ps1', import.meta.url),'utf8');

test('re-enroll timestamp is persisted and exposed for PC BARU',()=>{
  assert.match(migrate,/last_enrolled_at timestamptz/);
  assert.match(server,/last_enrolled_at=now\(\)/);
  assert.match(dash,/last_enrolled_at \|\| d\?\.enrolled_at/);
});

test('installer reconciles even when an old token is still valid',()=>{
  assert.match(installer,/Token lama valid\. Tetap reconcile ke backend/);
  assert.match(installer,/Try-Enroll \$cfg/);
});

test('device list is uncached and dashboard search includes UID and hostname',()=>{
  assert.match(server,/app\.get\('\/api\/devices'[\s\S]*?Cache-Control','no-store'/);
  assert.match(dash,/d\.hostname, d\.device_uid/);
});
