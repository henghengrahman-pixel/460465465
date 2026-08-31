import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import 'dotenv/config';
const loginId=process.env.ADMIN_ID || 'admin';
const password=process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const hash=await bcrypt.hash(password,12);
try {
  await pool.query(`INSERT INTO offices(name) VALUES('KANTOR A'),('KANTOR B'),('KANTOR C') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO users(login_id,password_hash,display_name,role)
    VALUES($1,$2,'Super Admin','SUPER_ADMIN') ON CONFLICT(login_id) DO NOTHING`,[loginId,hash]);
  console.log('Seed complete. Admin ID:', loginId);
} finally { await pool.end(); }
