import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { q } from './db.js';
function secret(){ const s=process.env.JWT_SECRET; if(!s || s.length<32) throw new Error('JWT_SECRET minimal 32 karakter'); return s; }
export async function login(loginId,password){
 const r=await q('SELECT * FROM users WHERE login_id=$1 AND active=true',[loginId]);
 if(!r.rows[0] || !(await bcrypt.compare(password,r.rows[0].password_hash))) return null;
 const u=r.rows[0]; await q('UPDATE users SET last_login_at=now() WHERE id=$1',[u.id]);
 const token=jwt.sign({sub:u.id,role:u.role,officeId:u.office_id,name:u.display_name},secret(),{expiresIn:'12h'});
 return {token,user:{id:u.id,loginId:u.login_id,name:u.display_name,role:u.role,officeId:u.office_id}};
}
export function requireAuth(req,res,next){
 const raw=req.headers.authorization||''; const token=raw.startsWith('Bearer ')?raw.slice(7):null;
 if(!token) return res.status(401).json({ok:false,error:'Unauthorized'});
 try{ req.user=jwt.verify(token,secret()); next(); }catch{return res.status(401).json({ok:false,error:'Token tidak valid/expired'});}
}
export function requireRole(...roles){ return (req,res,next)=>roles.includes(req.user.role)?next():res.status(403).json({ok:false,error:'Forbidden'}); }
export function officeSql(user, alias='d'){
 if(user.role==='SUPER_ADMIN' || !user.officeId) return {clause:'',params:[]};
 return {clause:` AND ${alias}.office_id=$1`,params:[user.officeId]};
}
