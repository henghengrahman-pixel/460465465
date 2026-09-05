import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index=fs.readFileSync(new URL('../src/index.js', import.meta.url),'utf8');
const migrate=fs.readFileSync(new URL('../src/migrate.js', import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../../dashboard/public/index.html', import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../../dashboard/public/app.js', import.meta.url),'utf8');

test('agent updates hostname but does not overwrite admin device name',()=>{
  assert.match(migrate,/ADD COLUMN IF NOT EXISTS hostname text/);
  assert.match(index,/UPDATE devices SET hostname=\$2,os=\$3/);
  assert.doesNotMatch(index,/UPDATE devices SET name=\$2,os=\$3,agent_version/);
});

test('new enrollment stores both initial display name and hostname',()=>{
  assert.match(index,/INSERT INTO devices\(id,device_uid,hardware_uid,name,hostname,os/);
});

test('super admin has blocked-device UI with explicit reallow',()=>{
  assert.match(html,/data-view="revoked"/);
  assert.match(html,/id="revokedRows"/);
  assert.match(app,/IZINKAN LAGI/);
  assert.match(app,/\/api\/revoked-devices\/reallow/);
});
