import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { q } from './db.js';
function secret(){ const s=process.env.JWT_SECRET; if(!s || s.length<32) throw new Error('JWT_SECRET minimal 32 karakter'); return s; }
export async function verifyCredentials(loginId,password){
 const r=await q('SELECT * FROM users WHERE login_id=$1 AND active=true',[loginId]);
 if(!r.rows[0] || !(await bcrypt.compare(password,r.rows[0].password_hash))) return null;
 const u=r.rows[0];
 return {id:u.id,loginId:u.login_id,name:u.display_name,role:u.role,officeId:u.office_id};
}
export async function issueSession(user){
 await q('UPDATE users SET last_login_at=now() WHERE id=$1',[user.id]);
 const token=jwt.sign({sub:user.id,role:user.role,officeId:user.officeId,name:user.name},secret(),{expiresIn:process.env.SESSION_TTL||'12h'});
 return {token,user};
}
export function issueTwoFactorChallenge(user,{setupRequired=false}={}){
 return jwt.sign({sub:user.id,loginId:user.loginId,role:user.role,officeId:user.officeId,name:user.name,purpose:'2fa',setupRequired:!!setupRequired},secret(),{expiresIn:'5m'});
}
export function verifyTwoFactorChallenge(token){
 const p=jwt.verify(token,secret());
 if(p?.purpose!=='2fa'||!p?.sub)throw new Error('Challenge 2FA tidak valid');
 return {id:p.sub,loginId:p.loginId,name:p.name,role:p.role,officeId:p.officeId,setupRequired:!!p.setupRequired};
}
export function requireAuth(req,res,next){
 const raw=req.headers.authorization||''; const token=raw.startsWith('Bearer ')?raw.slice(7):null;
 if(!token) return res.status(401).json({ok:false,error:'Unauthorized'});
 try{ req.user=jwt.verify(token,secret()); next(); }catch{return res.status(401).json({ok:false,error:'Token tidak valid/expired'});}
}
export function requireRole(...roles){ return (req,res,next)=>roles.includes(req.user.role)?next():res.status(403).json({ok:false,error:'Forbidden'}); }
export function officeSql(user, alias='d'){
 if(user.role==='SUPER_ADMIN' || !user.officeId) return {clause:'',params:[]};
 // ADMIN kantor harus dapat melihat PC baru yang belum mendapat kantor agar bisa segera di-assign.
 // Role lain tetap dibatasi hanya ke kantor sendiri.
 if(user.role==='ADMIN') return {clause:` AND (${alias}.office_id=$1 OR ${alias}.office_id IS NULL)`,params:[user.officeId]};
 return {clause:` AND ${alias}.office_id=$1`,params:[user.officeId]};
}
