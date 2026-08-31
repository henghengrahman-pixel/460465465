import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('v1.3 live screen backend exists',()=>{const s=fs.readFileSync('server/src/index.js','utf8');assert.match(s,/live\/start/);assert.match(s,/live-frame/);assert.match(s,/live\/frame/)});
test('v1.3 domain policy and device revoke exist',()=>{const s=fs.readFileSync('server/src/index.js','utf8');assert.match(s,/BLOCK_DOMAIN/);assert.match(s,/revoked_devices/);assert.match(s,/app\.delete\('\/api\/devices\/:id'/)});
test('v1.3 boot worker exists',()=>{const s=fs.readFileSync('INSTALL-NOW.cmd','utf8');assert.match(s,/StaffMonitorSystem/);assert.match(s,/ONSTART/);assert.match(s,/SYSTEM/)});
test('v1.3 live screen dashboard exists',()=>{const h=fs.readFileSync('dashboard/public/index.html','utf8');assert.match(h,/LIVE SCREEN/);assert.match(h,/Block Domain/);assert.match(h,/HAPUS DEVICE/)});
