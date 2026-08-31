import pg from 'pg';
import 'dotenv/config';
const { Pool } = pg;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' && process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : undefined,
  max: 20,
  idleTimeoutMillis: 30000
});
export async function q(text, params=[]) { return pool.query(text, params); }
