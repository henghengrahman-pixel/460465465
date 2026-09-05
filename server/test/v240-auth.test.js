import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { verifyTotp } from '../src/totp.js';

const server=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const seed=fs.readFileSync(new URL('../src/seed.js',import.meta.url),'utf8');
const ui=fs.readFileSync(new URL('../../dashboard/public/app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../../dashboard/public/index.html',import.meta.url),'utf8');

test('TOTP verifier accepts a deterministic RFC-style 6 digit code',()=>{
  // Base32("12345678901234567890")
  const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(verifyTotp(secret,'287082',{window:0,now:59_000}),true);
  assert.equal(verifyTotp(secret,'000000',{window:0,now:59_000}),false);
});

test('admin password is synchronized from Railway env',()=>{
  assert.match(seed,/ADMIN_PASSWORD/);
  assert.match(seed,/ON CONFLICT\(login_id\) DO UPDATE SET password_hash=EXCLUDED\.password_hash/);
});

test('2FA challenge and verify routes are present',()=>{
  assert.match(server,/twoFactorRequired/);
  assert.match(server,/\/api\/auth\/2fa\/verify/);
  assert.match(ui,/twoFactorChallenge/);
  assert.match(html,/Kode Authenticator/);
});
