import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../../', import.meta.url);
const agent = fs.readFileSync(new URL('agent/main.go', root), 'utf8');
const installer = fs.readFileSync(new URL('INSTALL-NOW.cmd', root), 'utf8');

test('current agent version and user token reload are present', () => {
  assert.match(agent, /const Version = "1\.4\.4"/);
  assert.match(agent, /refreshTokenFromDisk/);
  assert.match(agent, /DeviceToken/);
});

test('installer resolves local agent without fragile relative parent path', () => {
  assert.match(installer, /set "SRC=%~dp0StaffMonitorAgent\.exe"/);
  assert.match(installer, /set "SRC=%~dp0dist\\StaffMonitorAgent\.exe"/);
  assert.doesNotMatch(installer, /\.\.\\dist\\StaffMonitorAgent\.exe/);
});

test('installer persists both boot worker and user live-screen startup', () => {
  assert.match(installer, /\/SC ONSTART \/RU SYSTEM/);
  assert.match(installer, /CurrentVersion\\Run/);
  assert.match(installer, /--user/);
  assert.match(installer, /--system/);
});

test('installer does not abort on temporary Railway health failure', () => {
  assert.match(installer, /Instalasi tetap lanjut/);
  assert.doesNotMatch(installer, /Installation stopped/);
});
