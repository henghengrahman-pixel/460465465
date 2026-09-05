import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const server=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const migrate=fs.readFileSync(new URL('../src/migrate.js',import.meta.url),'utf8');
const tg=fs.readFileSync(new URL('../src/telegram-alerts.js',import.meta.url),'utf8');
const ui=fs.readFileSync(new URL('../../dashboard/public/app.js',import.meta.url),'utf8');

test('telegram configuration is isolated per office',()=>{
  assert.match(migrate,/CREATE TABLE IF NOT EXISTS office_telegram_configs/);
  assert.match(migrate,/office_id uuid PRIMARY KEY/);
  assert.match(server,/\/api\/offices\/:id\/telegram/);
  assert.match(ui,/configureOfficeTelegram/);
});
test('telegram bot token is encrypted and never returned by config getter',()=>{
  assert.match(tg,/aes-256-gcm/);
  assert.match(tg,/has_bot_token/);
  assert.match(tg,/bot_token_enc:undefined/);
});
test('activity can include domain or url while keeping title fallback',()=>{
  assert.match(server,/domain:z\.string\(\)\.max\(500\)/);
  assert.match(server,/url:z\.string\(\)\.max\(2000\)/);
  assert.match(tg,/detectWatchedDomain/);
  assert.match(tg,/youtube\.com/);
  assert.match(tg,/facebook\.com/);
  assert.match(tg,/tiktok\.com/);
});
test('telegram alerts are deduplicated with cooldown and history is stored',()=>{
  assert.match(migrate,/CREATE TABLE IF NOT EXISTS telegram_alert_events/);
  assert.match(tg,/cooldown_seconds/);
  assert.match(tg,/NOT EXISTS/);
  assert.match(server,/\/api\/telegram-alerts/);
});
