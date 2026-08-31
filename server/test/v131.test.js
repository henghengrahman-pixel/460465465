import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('batch domain commands enabled',()=>{const s=fs.readFileSync('server/src/index.js','utf8');assert.match(s,/BLOCK_DOMAINS/);assert.match(s,/UNBLOCK_DOMAINS/);});
test('installer upgrade handles locked agent',()=>{const s=fs.readFileSync('installer-bootstrap/main.go','utf8');assert.match(s,/stopOldAgent/);assert.match(s,/Disable/);assert.match(s,/replaceAgent/);assert.match(s,/waitAgentStopped/);});
test('dashboard accepts many domains',()=>{const h=fs.readFileSync('dashboard/public/index.html','utf8');const j=fs.readFileSync('dashboard/public/app.js','utf8');assert.match(h,/textarea id="domainInput"/);assert.match(j,/parseDomains/);assert.match(j,/500/);});
