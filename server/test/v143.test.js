import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const installer = fs.readFileSync(new URL("../../INSTALL-NOW.cmd", import.meta.url), "utf8");
const agent = fs.readFileSync(new URL("../../agent/main.go", import.meta.url), "utf8");

test("v1.4.4 installer uses versioned side-by-side agent path", () => {
  assert.match(installer, /StaffMonitorAgent-v%VERSION%\.exe/);
  assert.doesNotMatch(installer, /move \/Y .*StaffMonitorAgent\.exe\.new/i);
});

test("v1.4.4 startup entries target current version and survive reboot", () => {
  assert.match(installer, /schtasks \/Create .*\/SC ONSTART/i);
  assert.match(installer, /reg add "%RUNKEY%" \/v "StaffMonitor"/i);
  assert.match(installer, /Final verification/i);
  assert.match(installer, /Get-FileHash/);
});

test("v1.4.4 removes old startup and stops old processes before replacement", () => {
  assert.match(installer, /Removing old startup entries/i);
  assert.match(installer, /Stop-Process -Force/i);
});

test("agent reports v1.4.4", () => {
  assert.match(agent, /const Version = "1\.4\.4"/);
});
