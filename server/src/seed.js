import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import 'dotenv/config';

const loginId=String(process.env.ADMIN_ID||'admin').trim();
const envPassword=process.env.ADMIN_PASSWORD;
if(!loginId)throw new Error('ADMIN_ID tidak boleh kosong');

try {
  await pool.query(`INSERT INTO offices(id,name) VALUES(gen_random_uuid(),'KANTOR A'),(gen_random_uuid(),'KANTOR B'),(gen_random_uuid(),'KANTOR C') ON CONFLICT DO NOTHING`);
  const existing=await pool.query('SELECT id FROM users WHERE login_id=$1',[loginId]);
  if(envPassword){
    if(envPassword.length<10)throw new Error('ADMIN_PASSWORD minimal 10 karakter');
    const hash=await bcrypt.hash(envPassword,12);
    await pool.query(`INSERT INTO users(id,login_id,password_hash,display_name,role,active)
      VALUES(gen_random_uuid(),$1,$2,'Super Admin','SUPER_ADMIN',true)
      ON CONFLICT(login_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,role='SUPER_ADMIN',active=true`,[loginId,hash]);
    console.log('Admin env sync complete. Admin ID:',loginId,'Password: synced from ADMIN_PASSWORD');
  }else if(!existing.rows[0]){
    const fallback='ChangeMe123!';const hash=await bcrypt.hash(fallback,12);
    await pool.query(`INSERT INTO users(id,login_id,password_hash,display_name,role,active) VALUES(gen_random_uuid(),$1,$2,'Super Admin','SUPER_ADMIN',true)`,[loginId,hash]);
    console.warn('WARNING: ADMIN_PASSWORD belum diatur. Admin awal memakai password fallback dan harus segera diganti lewat Railway env.');
  }else{
    console.log('Admin env sync skipped: ADMIN_PASSWORD tidak diatur; password database dipertahankan. Admin ID:',loginId);
  }
} finally { await pool.end(); }
