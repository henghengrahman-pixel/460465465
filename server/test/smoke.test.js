import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('dashboard assets exist',()=>{for(const p of ['dashboard/public/index.html','dashboard/public/app.js','dashboard/public/style.css'])assert.ok(fs.existsSync(p),p)});
test('agent source exists',()=>assert.ok(fs.existsSync('agent/main.go')));
