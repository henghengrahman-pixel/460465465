import { pool } from './db.js';
const sql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Self-repair untuk database Railway yang berasal dari versi lama.
-- CREATE TABLE IF NOT EXISTS tidak memperbaiki default/kolom pada tabel yang sudah ada,
-- jadi semua UUID primary key penting dipastikan memiliki default kembali.
CREATE TABLE IF NOT EXISTS offices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE offices ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS departments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), office_id uuid NOT NULL REFERENCES offices(id) ON DELETE CASCADE, name text NOT NULL,
 UNIQUE(office_id,name)
);
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), login_id text NOT NULL UNIQUE, password_hash text NOT NULL,
 display_name text NOT NULL, role text NOT NULL CHECK(role IN ('SUPER_ADMIN','ADMIN','SUPERVISOR','VIEWER')),
 office_id uuid REFERENCES offices(id) ON DELETE SET NULL, active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz
);
CREATE TABLE IF NOT EXISTS staff (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), staff_code text NOT NULL UNIQUE, name text NOT NULL,
 office_id uuid NOT NULL REFERENCES offices(id) ON DELETE RESTRICT,
 department_id uuid REFERENCES departments(id) ON DELETE SET NULL, active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_uid text NOT NULL UNIQUE, name text NOT NULL,
 staff_id uuid REFERENCES staff(id) ON DELETE SET NULL, office_id uuid REFERENCES offices(id) ON DELETE SET NULL,
 os text, ip inet, agent_version text, status text NOT NULL DEFAULT 'OFFLINE' CHECK(status IN ('ONLINE','ACTIVE','IDLE','LOCKED','OFFLINE')),
 current_app text, current_title text, last_seen timestamptz, enrolled_at timestamptz NOT NULL DEFAULT now(), disabled boolean NOT NULL DEFAULT false
);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hardware_uid text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hostname text;
UPDATE devices SET hostname=name WHERE hostname IS NULL OR btrim(hostname)='';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_enrolled_at timestamptz;
UPDATE devices SET last_enrolled_at=enrolled_at WHERE last_enrolled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_devices_last_enrolled_at ON devices(last_enrolled_at DESC);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS system_last_seen timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS user_last_seen timestamptz;
CREATE INDEX IF NOT EXISTS idx_devices_hardware_uid ON devices(hardware_uid) WHERE hardware_uid IS NOT NULL;
CREATE TABLE IF NOT EXISTS device_shift_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 shift text NOT NULL CHECK(shift IN ('PAGI','MALAM')),
 staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(device_id,shift)
);
CREATE INDEX IF NOT EXISTS idx_device_shift_staff ON device_shift_assignments(staff_id);
DELETE FROM device_shift_assignments a USING device_shift_assignments b
 WHERE a.device_id=b.device_id AND a.shift=b.shift AND a.ctid < b.ctid;
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_shift_assignments_device_shift ON device_shift_assignments(device_id,shift);
CREATE TABLE IF NOT EXISTS revoked_devices (
 device_uid text PRIMARY KEY, reason text, revoked_at timestamptz NOT NULL DEFAULT now()
);
-- v2.7.5: revoked_devices sengaja berdiri sendiri dari devices.
-- UID yang dihapus dari dashboard harus tetap berada di sini agar agent yang masih hidup
-- tidak dapat mendaftarkan dirinya kembali sampai SUPER_ADMIN memilih IZINKAN LAGI.
CREATE TABLE IF NOT EXISTS device_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 token_hash text NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_device ON device_tokens(device_id);
CREATE TABLE IF NOT EXISTS activity_events (
 id bigserial PRIMARY KEY, device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 occurred_at timestamptz NOT NULL, event_type text NOT NULL, app_name text, process_name text, window_title text,
 duration_seconds integer, meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_activity_device_time ON activity_events(device_id, occurred_at DESC);
CREATE TABLE IF NOT EXISTS commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 command_type text NOT NULL,
 payload jsonb NOT NULL DEFAULT '{}'::jsonb, status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENT','ACK','FAILED')),
 created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), ack_at timestamptz, result text
);
ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_command_type_check;
ALTER TABLE commands ADD CONSTRAINT commands_command_type_check CHECK(command_type IN ('WARN','CLOSE_APP','SET_POLICY','BLOCK_DOMAIN','UNBLOCK_DOMAIN','BLOCK_DOMAINS','UNBLOCK_DOMAINS'));
CREATE INDEX IF NOT EXISTS idx_commands_device_status ON commands(device_id,status,created_at);
CREATE TABLE IF NOT EXISTS live_sessions (
 device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE, active boolean NOT NULL DEFAULT false, requested_by uuid REFERENCES users(id) ON DELETE SET NULL, updated_at timestamptz NOT NULL DEFAULT now(), session_id text, expires_at timestamptz
);
ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS session_id text;
ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE TABLE IF NOT EXISTS policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), office_id uuid REFERENCES offices(id) ON DELETE CASCADE,
 department_id uuid REFERENCES departments(id) ON DELETE CASCADE, name text NOT NULL,
 blocked_processes jsonb NOT NULL DEFAULT '[]'::jsonb, warn_processes jsonb NOT NULL DEFAULT '[]'::jsonb,
 enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS web_policies (
 scope_key text PRIMARY KEY,
 office_id uuid REFERENCES offices(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false,
 blocked_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
 version bigint NOT NULL DEFAULT 1,
 updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS web_policy_staff_exceptions (
 scope_key text NOT NULL REFERENCES web_policies(scope_key) ON DELETE CASCADE,
 staff_id uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(scope_key,staff_id)
);
CREATE INDEX IF NOT EXISTS idx_web_policy_exceptions_staff ON web_policy_staff_exceptions(staff_id);


ALTER TABLE devices ADD COLUMN IF NOT EXISTS current_domain text;
CREATE TABLE IF NOT EXISTS office_telegram_configs (
 office_id uuid PRIMARY KEY REFERENCES offices(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false,
 bot_token_enc text,
 chat_id text,
 cooldown_seconds integer NOT NULL DEFAULT 600 CHECK(cooldown_seconds BETWEEN 60 AND 86400),
 watch_domains jsonb NOT NULL DEFAULT '["youtube.com","facebook.com","tiktok.com","instagram.com"]'::jsonb,
 updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telegram_alert_events (
 id bigserial PRIMARY KEY,
 office_id uuid NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
 device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
 domain text NOT NULL,
 app_name text,
 window_title text,
 occurred_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENT','FAILED')),
 sent_at timestamptz,
 telegram_message_id text,
 error text
);
CREATE INDEX IF NOT EXISTS idx_telegram_alert_office_time ON telegram_alert_events(office_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_telegram_alert_dedupe ON telegram_alert_events(device_id,domain,sent_at DESC) WHERE status='SENT';

CREATE TABLE IF NOT EXISTS alerts (
 id bigserial PRIMARY KEY, device_id uuid REFERENCES devices(id) ON DELETE CASCADE, severity text NOT NULL DEFAULT 'warning',
 type text NOT NULL, message text NOT NULL, resolved boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id bigserial PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE SET NULL, action text NOT NULL, target text,
 ip inet, detail jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);


-- Compatibility repair: pastikan default UUID tetap ada pada schema lama.
ALTER TABLE offices ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE departments ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE users ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE staff ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE devices ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE device_shift_assignments ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE device_tokens ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE commands ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE policies ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- Kolom compatibility yang mungkin belum ada pada database versi lama.
ALTER TABLE device_shift_assignments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE offices ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS disabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
`;
try { await pool.query(sql); console.log('Migration complete'); } finally { await pool.end(); }
