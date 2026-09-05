import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index=fs.readFileSync(new URL('../src/index.js', import.meta.url),'utf8');
const migrate=fs.readFileSync(new URL('../src/migrate.js', import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../../dashboard/public/app.js', import.meta.url),'utf8');

test('delete revokes UID before deleting device so it cannot immediately re-enroll',()=>{
  assert.match(index,/INSERT INTO revoked_devices\(device_uid,reason,revoked_at\).*DELETE FROM devices WHERE id=\$1/s);
  assert.match(index,/reEnrollAllowed:false/);
});

test('revoked UID can still be explicitly reallowed by super admin',()=>{
  assert.match(index,/GET|app\.get\('\/api\/revoked-devices'/);
  assert.match(index,/app\.post\('\/api\/revoked-devices\/reallow'/);
});

test('migration preserves orphan revoked rows instead of auto-clearing them',()=>{
  assert.doesNotMatch(migrate,/DELETE FROM revoked_devices r\s+WHERE NOT EXISTS/);
});

test('dashboard delete now blocks re-enrollment and points to PC Diblokir',()=>{
  assert.match(app,/TIDAK muncul kembali/);
  assert.match(app,/PC Diblokir/);
});
