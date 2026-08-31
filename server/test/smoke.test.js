import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('dashboard assets exist',()=>{for(const p of ['dashboard/public/index.html','dashboard/public/app.js','dashboard/public/style.css'])assert.ok(fs.existsSync(p),p)});
test('agent source exists',()=>assert.ok(fs.existsSync('agent/main.go')));
test('multi office and shift assignment migration exists',()=>{const s=fs.readFileSync('server/src/migrate.js','utf8');assert.match(s,/device_shift_assignments/);assert.match(s,/PAGI/);assert.match(s,/MALAM/)});
test('office and device management UI exists',()=>{const h=fs.readFileSync('dashboard/public/index.html','utf8');assert.match(h,/Manajemen Kantor/);assert.match(h,/SHIFT PAGI/);assert.match(h,/SHIFT MALAM/)});
