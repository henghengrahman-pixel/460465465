import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index=fs.readFileSync(new URL('../src/index.js', import.meta.url),'utf8');
const migrate=fs.readFileSync(new URL('../src/migrate.js', import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../../dashboard/public/app.js', import.meta.url),'utf8');

test('migration tracks last enrollment separately from first enrollment',()=>{
  assert.match(migrate,/ADD COLUMN IF NOT EXISTS last_enrolled_at timestamptz/);
  assert.match(migrate,/UPDATE devices SET last_enrolled_at=enrolled_at WHERE last_enrolled_at IS NULL/);
});

test('re-enroll updates last_enrolled_at and resolves final office',()=>{
  assert.match(index,/last_enrolled_at=now\(\)/);
  assert.match(index,/SELECT name FROM offices WHERE id=\$1/);
  assert.match(index,/officeId:d\.rows\[0\]\.office_id\|\|null/);
});

test('re-enroll keeps several active tokens so system and user workers cannot invalidate each other',()=>{
  assert.match(index,/ORDER BY created_at DESC LIMIT 6/);
  assert.doesNotMatch(index,/UPDATE device_tokens SET revoked_at=now\(\) WHERE device_id=\$1 AND revoked_at IS NULL'\],\[d\.rows\[0\]\.id\]\);await q\('INSERT INTO device_tokens/);
});

test('fleet endpoints disable stale cache and search includes hostname and device uid',()=>{
  assert.match(index,/no-store, no-cache, must-revalidate/);
  assert.match(app,/d\.hostname, d\.device_uid/);
  assert.match(app,/d\?\.last_enrolled_at \|\| d\?\.enrolled_at/);
});
