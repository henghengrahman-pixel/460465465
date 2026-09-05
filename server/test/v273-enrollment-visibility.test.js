import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const auth=fs.readFileSync(new URL('../src/auth.js', import.meta.url),'utf8');
const index=fs.readFileSync(new URL('../src/index.js', import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../../dashboard/public/index.html', import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../../dashboard/public/app.js', import.meta.url),'utf8');

test('ADMIN office scope includes unassigned PCs for claiming',()=>{
  assert.match(auth,/user\.role==='ADMIN'.*office_id IS NULL/s);
});

test('ADMIN can access unassigned device while office roles remain scoped',()=>{
  assert.match(index,/user\.role==='ADMIN'&&!officeId/);
});

test('enroll reports created and office assignment state',()=>{
  assert.match(index,/created,deviceId:/);
  assert.match(index,/officeAssigned/);
  assert.match(index,/\[ENROLL\]/);
});

test('dashboard exposes new and unassigned filters',()=>{
  assert.match(html,/PC BARU \(24 JAM\)/);
  assert.match(html,/BELUM ADA KANTOR/);
  assert.match(app,/filter === 'NEW_24H'/);
  assert.match(app,/filter === 'UNASSIGNED_OFFICE'/);
});
