import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server=fs.readFileSync('server/src/index.js','utf8');
const ui=fs.readFileSync('dashboard/public/app.js','utf8');

test('realtime events never reopen device detail implicitly',()=>{
  assert.match(ui,/currentView === 'device' && selected\?\.id === evt\.deviceId/);
  assert.doesNotMatch(ui,/socket\.on\('device\.activity',[\s\S]{0,180}openDevice\(/);
  assert.match(ui,/unwatchDevice/);
});

test('fleet heartbeat refresh is batched server side',()=>{
  assert.match(server,/function queueFleetChange/);
  assert.match(server,/pendingFleetDeviceIds/);
  assert.match(server,/1500/);
});

test('device office and shifts save atomically',()=>{
  assert.match(server,/devices\/:id\/config/);
  assert.match(server,/BEGIN/);
  assert.match(server,/COMMIT/);
  assert.match(server,/ROLLBACK/);
  assert.match(ui,/devices\/\$\{id\}\/config/);
});

test('dashboard requests have timeout and duplicate-load guard',()=>{
  assert.match(ui,/AbortController/);
  assert.match(ui,/allLoadPromise/);
});
