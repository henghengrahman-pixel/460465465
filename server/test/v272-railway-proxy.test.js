import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const server=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
test('Railway reverse proxy is trusted as exactly one hop',()=>{
  assert.match(server,/app\.set\('trust proxy',\s*1\)/);
  assert.doesNotMatch(server,/app\.set\('trust proxy',\s*true\)/);
});
test('auth limiter emits modern headers and disables legacy headers',()=>{
  assert.match(server,/standardHeaders:'draft-8'/);
  assert.match(server,/legacyHeaders:false/);
});
