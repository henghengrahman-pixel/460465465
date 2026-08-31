import { pool } from './db.js';
const sql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
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
CREATE TABLE IF NOT EXISTS device_shift_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
 shift text NOT NULL CHECK(shift IN ('PAGI','MALAM')),
 staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(device_id,shift)
);
CREATE INDEX IF NOT EXISTS idx_device_shift_staff ON device_shift_assignments(staff_id);
CREATE TABLE IF NOT EXISTS revoked_devices (
 device_uid text PRIMARY KEY, reason text, revoked_at timestamptz NOT NULL DEFAULT now()
);
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
ALTER TABLE commands ADD CONSTRAINT commands_command_type_check CHECK(command_type IN ('WARN','CLOSE_APP','SET_POLICY','BLOCK_DOMAIN','UNBLOCK_DOMAIN'));
CREATE INDEX IF NOT EXISTS idx_commands_device_status ON commands(device_id,status,created_at);
CREATE TABLE IF NOT EXISTS live_sessions (
 device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE, active boolean NOT NULL DEFAULT false, requested_by uuid REFERENCES users(id) ON DELETE SET NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), office_id uuid REFERENCES offices(id) ON DELETE CASCADE,
 department_id uuid REFERENCES departments(id) ON DELETE CASCADE, name text NOT NULL,
 blocked_processes jsonb NOT NULL DEFAULT '[]'::jsonb, warn_processes jsonb NOT NULL DEFAULT '[]'::jsonb,
 enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS alerts (
 id bigserial PRIMARY KEY, device_id uuid REFERENCES devices(id) ON DELETE CASCADE, severity text NOT NULL DEFAULT 'warning',
 type text NOT NULL, message text NOT NULL, resolved boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id bigserial PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE SET NULL, action text NOT NULL, target text,
 ip inet, detail jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
`;
try { await pool.query(sql); console.log('Migration complete'); } finally { await pool.end(); }
