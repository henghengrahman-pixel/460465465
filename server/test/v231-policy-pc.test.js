import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const server=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const migrate=fs.readFileSync(new URL('../src/migrate.js',import.meta.url),'utf8');
const ui=fs.readFileSync(new URL('../../dashboard/public/app.js',import.meta.url),'utf8');

test('web policy JSONB save is explicit and per-PC target exists',()=>{
  assert.match(server,/JSON\.stringify\(domains\)/);
  assert.match(server,/raw\.startsWith\('PC:'\)/);
  assert.match(server,/p\.scope_key='PC:'\|\|\$1::text/);
  assert.match(ui,/PC:\$\{d\.id\}/);
});

test('legacy shift rows are deduplicated before unique compatibility index',()=>{
  assert.match(migrate,/DELETE FROM device_shift_assignments a USING device_shift_assignments b/);
  assert.match(migrate,/CREATE UNIQUE INDEX IF NOT EXISTS uq_device_shift_assignments_device_shift/);
});
