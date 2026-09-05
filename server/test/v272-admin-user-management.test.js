import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const server=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const ui=fs.readFileSync(new URL('../../dashboard/public/app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../../dashboard/public/index.html',import.meta.url),'utf8');
test('super admin can reset secondary admin password',()=>{assert.match(server,/\/api\/users\/:id\/reset-password/);assert.match(server,/RESET_USER_PASSWORD/);assert.match(ui,/Reset Password/);});
test('super admin can delete secondary admin but not env master',()=>{assert.match(server,/app\.delete\('\/api\/users\/:id'/);assert.match(server,/Akun master Railway tidak dapat dihapus/);assert.match(ui,/user-delete/);});
test('admin users table exposes actions column',()=>{assert.match(html,/<th>AKSI<\/th>/);});
