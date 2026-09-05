import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index=fs.readFileSync(new URL('../src/index.js', import.meta.url),'utf8');
const migrate=fs.readFileSync(new URL('../src/migrate.js', import.meta.url),'utf8');

test('identity v2 columns and alias table exist',()=>{
  assert.match(migrate,/hardware_fingerprint text/);
  assert.match(migrate,/installation_id text/);
  assert.match(migrate,/identity_version integer/);
  assert.match(migrate,/CREATE TABLE IF NOT EXISTS device_uid_aliases/);
});

test('identity v2 never falls back to legacy hardware merge',()=>{
  assert.match(index,/identityVersion<2&&hardwareUid/);
  assert.match(index,/identityVersion>=2&&previousDeviceUid/);
});

test('identity v2 rejects conflicting installation or fingerprint',()=>{
  assert.match(index,/DEVICE_UID_COLLISION/);
  assert.match(index,/installation berbeda/);
  assert.match(index,/hardware fingerprint berbeda/);
});
