import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index=fs.readFileSync(new URL('../src/index.js', import.meta.url),'utf8');
const migrate=fs.readFileSync(new URL('../src/migrate.js', import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../../dashboard/public/app.js', import.meta.url),'utf8');

test('purge removes revoked UID so same PC may enroll again',()=>{
  assert.match(index,/if\(mode==='purge'\).*DELETE FROM revoked_devices WHERE device_uid=\$1.*DELETE FROM devices WHERE id=\$1/s);
  assert.match(index,/reEnrollAllowed:mode==='purge'/);
});

test('revoke still blocks device and preserves explicit reallow',()=>{
  assert.match(index,/INSERT INTO revoked_devices\(device_uid,reason\).*Revoked from dashboard/s);
  assert.match(index,/\/api\/devices\/:id\/reallow/);
  assert.match(index,/\/api\/revoked-devices\/reallow/);
});

test('migration repairs orphan revoked rows from old purge behavior',()=>{
  assert.match(migrate,/DELETE FROM revoked_devices r\s+WHERE NOT EXISTS \(SELECT 1 FROM devices d WHERE d\.device_uid=r\.device_uid\)/s);
});

test('dashboard explains purge vs revoke behavior',()=>{
  assert.match(app,/IZINKAN PC INI ENROLL ULANG/);
  assert.match(app,/NONAKTIFKAN\/REVOKE/);
});
