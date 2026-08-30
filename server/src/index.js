import 'dotenv/config';
import express from 'express';
import http from 'http';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import crypto from 'crypto';
import { z } from 'zod';
import { q, pool } from './db.js';
import { login, requireAuth, requireRole, officeSql } from './auth.js';

const app=express(); const server=http.createServer(app); const io=new Server(server,{cors:{origin:true,credentials:false}});
app.use(helmet({contentSecurityPolicy:false})); app.use(cors()); app.use(express.json({limit:'512kb'}));
app.use('/api/auth',rateLimit({windowMs:15*60*1000,limit:60}));
app.use(express.static(new URL('../../dashboard/public',import.meta.url).pathname));
const asyncH=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const audit=async(req,action,target,detail={})=>{ try{await q('INSERT INTO audit_logs(user_id,action,target,ip,detail) VALUES($1,$2,$3,$4,$5)',[req.user?.sub||null,action,target,req.ip,detail]);}catch{} };

app.get('/health',asyncH(async(req,res)=>{ const db=await q('SELECT 1 ok'); const c=await q("SELECT count(*)::int n FROM devices WHERE last_seen > now()-interval '90 seconds' AND disabled=false"); res.json({ok:true,api:'OK',database:db.rows[0].ok===1?'OK':'ERROR',realtime:'OK',connectedAgents:c.rows[0].n}); }));
app.post('/api/auth/login',asyncH(async(req,res)=>{ const s=z.object({loginId:z.string().min(1).max(100),password:z.string().min(1).max(200)}).parse(req.body); const out=await login(s.loginId,s.password); if(!out)return res.status(401).json({ok:false,error:'ID atau password salah'}); res.json({ok:true,...out}); }));

function makeToken(){return crypto.randomBytes(32).toString('hex')}
function tokenHash(t){return crypto.createHash('sha256').update(t).digest('hex')}
async function deviceAuth(req,res,next){
 const uid=req.headers['x-device-id']; const token=req.headers['x-device-token'];
 if(!uid||!token)return res.status(401).json({ok:false,error:'Device auth required'});
 const r=await q(`SELECT d.* FROM devices d JOIN device_tokens t ON t.device_id=d.id WHERE d.device_uid=$1 AND t.token_hash=$2 AND t.revoked_at IS NULL AND d.disabled=false ORDER BY t.created_at DESC LIMIT 1`,[String(uid),tokenHash(String(token))]);
 if(!r.rows[0]) return res.status(401).json({ok:false,error:'Device token invalid'}); req.device=r.rows[0]; next();
}
app.post('/api/agent/enroll',asyncH(async(req,res)=>{
 if(req.headers['x-enroll-secret']!==process.env.DEVICE_ENROLL_SECRET)return res.status(401).json({ok:false,error:'Enroll secret invalid'});
 const s=z.object({deviceUid:z.string().min(8).max(200),name:z.string().min(1).max(200),os:z.string().max(200).optional(),agentVersion:z.string().max(50).optional(),officeName:z.string().max(200).optional()}).parse(req.body);
 let officeId=null; if(s.officeName){ const o=await q('SELECT id FROM offices WHERE lower(name)=lower($1)',[s.officeName]); officeId=o.rows[0]?.id||null; }
 const d=await q(`INSERT INTO devices(device_uid,name,os,agent_version,office_id,status,last_seen) VALUES($1,$2,$3,$4,$5,'ONLINE',now())
 ON CONFLICT(device_uid) DO UPDATE SET name=excluded.name,os=excluded.os,agent_version=excluded.agent_version,last_seen=now() RETURNING *`,[s.deviceUid,s.name,s.os||null,s.agentVersion||null,officeId]);
 const token=makeToken(); await q('UPDATE device_tokens SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL',[d.rows[0].id]); await q('INSERT INTO device_tokens(device_id,token_hash) VALUES($1,$2)',[d.rows[0].id,tokenHash(token)]);
 res.json({ok:true,deviceId:d.rows[0].id,deviceToken:token});
}));
app.post('/api/agent/heartbeat',deviceAuth,asyncH(async(req,res)=>{
 const s=z.object({status:z.enum(['ONLINE','ACTIVE','IDLE','LOCKED']).default('ONLINE'),currentApp:z.string().max(300).nullable().optional(),currentTitle:z.string().max(500).nullable().optional(),os:z.string().max(200).optional(),agentVersion:z.string().max(50).optional()}).parse(req.body||{});
 await q('UPDATE devices SET status=$1,current_app=$2,current_title=$3,os=COALESCE($4,os),agent_version=COALESCE($5,agent_version),ip=$6,last_seen=now() WHERE id=$7',[s.status,s.currentApp||null,s.currentTitle||null,s.os||null,s.agentVersion||null,req.ip.replace('::ffff:',''),req.device.id]);
 io.to(`device:${req.device.id}`).emit('device.status',{deviceId:req.device.id,...s,lastSeen:new Date().toISOString()}); io.emit('fleet.changed',{deviceId:req.device.id});
 const cmds=await q("SELECT id,command_type,payload,created_at FROM commands WHERE device_id=$1 AND status='PENDING' ORDER BY created_at LIMIT 10",[req.device.id]);
 if(cmds.rows.length) await q("UPDATE commands SET status='SENT' WHERE id = ANY($1::uuid[])",[cmds.rows.map(x=>x.id)]);
 res.json({ok:true,commands:cmds.rows});
}));
app.post('/api/agent/activity',deviceAuth,asyncH(async(req,res)=>{
 const s=z.object({occurredAt:z.string().datetime().optional(),eventType:z.string().min(1).max(50),appName:z.string().max(300).optional(),processName:z.string().max(300).optional(),windowTitle:z.string().max(500).optional(),durationSeconds:z.number().int().nonnegative().optional()}).parse(req.body);
 const ts=s.occurredAt||new Date().toISOString(); await q('INSERT INTO activity_events(device_id,occurred_at,event_type,app_name,process_name,window_title,duration_seconds) VALUES($1,$2,$3,$4,$5,$6,$7)',[req.device.id,ts,s.eventType,s.appName||null,s.processName||null,s.windowTitle||null,s.durationSeconds||null]);
 await q('UPDATE devices SET current_app=$1,current_title=$2,status=$3,last_seen=now() WHERE id=$4',[s.appName||null,s.windowTitle||null,s.eventType==='IDLE'?'IDLE':s.eventType==='LOCKED'?'LOCKED':'ACTIVE',req.device.id]);
 io.emit('device.activity',{deviceId:req.device.id,...s}); res.json({ok:true});
}));
app.post('/api/agent/commands/:id/ack',deviceAuth,asyncH(async(req,res)=>{ const s=z.object({ok:z.boolean(),result:z.string().max(2000).optional()}).parse(req.body); await q("UPDATE commands SET status=$1,ack_at=now(),result=$2 WHERE id=$3 AND device_id=$4",[s.ok?'ACK':'FAILED',s.result||null,req.params.id,req.device.id]); res.json({ok:true}); }));

app.get('/api/me',requireAuth,(req,res)=>res.json({ok:true,user:req.user}));
app.get('/api/offices',requireAuth,asyncH(async(req,res)=>{ let r;if(req.user.role==='SUPER_ADMIN'||!req.user.officeId)r=await q('SELECT * FROM offices ORDER BY name');else r=await q('SELECT * FROM offices WHERE id=$1',[req.user.officeId]);res.json({ok:true,items:r.rows}); }));
app.get('/api/dashboard',requireAuth,asyncH(async(req,res)=>{
 const o=officeSql(req.user,'d'); const r=await q(`SELECT count(*)::int total,count(*) FILTER(WHERE d.last_seen>now()-interval '75 seconds')::int online,count(*) FILTER(WHERE d.status='ACTIVE' AND d.last_seen>now()-interval '75 seconds')::int active,count(*) FILTER(WHERE d.status='IDLE' AND d.last_seen>now()-interval '75 seconds')::int idle FROM devices d WHERE d.disabled=false ${o.clause}`,o.params); res.json({ok:true,...r.rows[0]});
}));
app.get('/api/devices',requireAuth,asyncH(async(req,res)=>{
 const o=officeSql(req.user,'d'); const r=await q(`SELECT d.*,s.name staff_name,s.staff_code,o.name office_name,dep.name department_name,CASE WHEN d.last_seen<now()-interval '75 seconds' OR d.last_seen IS NULL THEN 'OFFLINE' ELSE d.status END effective_status FROM devices d LEFT JOIN staff s ON s.id=d.staff_id LEFT JOIN offices o ON o.id=d.office_id LEFT JOIN departments dep ON dep.id=s.department_id WHERE d.disabled=false ${o.clause} ORDER BY d.name LIMIT 1000`,o.params); res.json({ok:true,items:r.rows});
}));
app.get('/api/devices/:id/activity',requireAuth,asyncH(async(req,res)=>{ const d=await q('SELECT office_id FROM devices WHERE id=$1',[req.params.id]); if(!d.rows[0])return res.status(404).json({ok:false,error:'Device not found'});if(req.user.role!=='SUPER_ADMIN'&&req.user.officeId&&d.rows[0].office_id!==req.user.officeId)return res.status(403).json({ok:false,error:'Forbidden'}); const r=await q('SELECT * FROM activity_events WHERE device_id=$1 AND occurred_at>now()-interval \'7 days\' ORDER BY occurred_at DESC LIMIT 1000',[req.params.id]);res.json({ok:true,items:r.rows}); }));
app.post('/api/devices/:id/command',requireAuth,requireRole('SUPER_ADMIN','ADMIN','SUPERVISOR'),asyncH(async(req,res)=>{ const s=z.object({type:z.enum(['WARN','CLOSE_APP','SET_POLICY']),payload:z.record(z.string(),z.any()).default({})}).parse(req.body); const d=await q('SELECT office_id,name FROM devices WHERE id=$1',[req.params.id]);if(!d.rows[0])return res.status(404).json({ok:false,error:'Device not found'});if(req.user.role!=='SUPER_ADMIN'&&req.user.officeId&&d.rows[0].office_id!==req.user.officeId)return res.status(403).json({ok:false,error:'Forbidden'});const c=await q('INSERT INTO commands(device_id,command_type,payload,created_by) VALUES($1,$2,$3,$4) RETURNING *',[req.params.id,s.type,s.payload,req.user.sub]);await audit(req,'CREATE_COMMAND',d.rows[0].name,{type:s.type,payload:s.payload});res.json({ok:true,command:c.rows[0]}); }));
app.get('/api/audit',requireAuth,requireRole('SUPER_ADMIN','ADMIN'),asyncH(async(req,res)=>{ const r=await q('SELECT a.*,u.login_id,u.display_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 500');res.json({ok:true,items:r.rows}); }));
app.get('/api/staff',requireAuth,asyncH(async(req,res)=>{ const params=[];let where='';if(req.user.role!=='SUPER_ADMIN'&&req.user.officeId){params.push(req.user.officeId);where='WHERE s.office_id=$1';} const r=await q(`SELECT s.*,o.name office_name,d.name department_name FROM staff s JOIN offices o ON o.id=s.office_id LEFT JOIN departments d ON d.id=s.department_id ${where} ORDER BY s.name`,params);res.json({ok:true,items:r.rows}); }));
app.post('/api/staff',requireAuth,requireRole('SUPER_ADMIN','ADMIN'),asyncH(async(req,res)=>{ const s=z.object({staffCode:z.string().min(1).max(80),name:z.string().min(1).max(200),officeId:z.string().uuid(),departmentId:z.string().uuid().nullable().optional()}).parse(req.body);if(req.user.role!=='SUPER_ADMIN'&&req.user.officeId!==s.officeId)return res.status(403).json({ok:false,error:'Forbidden'});const r=await q('INSERT INTO staff(staff_code,name,office_id,department_id) VALUES($1,$2,$3,$4) RETURNING *',[s.staffCode,s.name,s.officeId,s.departmentId||null]);await audit(req,'CREATE_STAFF',s.staffCode);res.json({ok:true,item:r.rows[0]}); }));
app.post('/api/devices/:id/assign',requireAuth,requireRole('SUPER_ADMIN','ADMIN'),asyncH(async(req,res)=>{ const s=z.object({staffId:z.string().uuid()}).parse(req.body);const st=await q('SELECT * FROM staff WHERE id=$1',[s.staffId]);if(!st.rows[0])return res.status(404).json({ok:false,error:'Staff not found'});if(req.user.role!=='SUPER_ADMIN'&&req.user.officeId!==st.rows[0].office_id)return res.status(403).json({ok:false,error:'Forbidden'});await q('UPDATE devices SET staff_id=$1,office_id=$2 WHERE id=$3',[s.staffId,st.rows[0].office_id,req.params.id]);await audit(req,'ASSIGN_DEVICE',req.params.id,{staffId:s.staffId});res.json({ok:true}); }));
app.get('/api/users',requireAuth,requireRole('SUPER_ADMIN'),asyncH(async(req,res)=>{ const r=await q('SELECT u.id,u.login_id,u.display_name,u.role,u.office_id,u.active,u.created_at,u.last_login_at,o.name office_name FROM users u LEFT JOIN offices o ON o.id=u.office_id ORDER BY u.created_at');res.json({ok:true,items:r.rows}); }));
app.post('/api/users',requireAuth,requireRole('SUPER_ADMIN'),asyncH(async(req,res)=>{ const bcrypt=(await import('bcryptjs')).default; const s=z.object({loginId:z.string().min(3).max(100),password:z.string().min(8).max(200),displayName:z.string().min(1).max(200),role:z.enum(['SUPER_ADMIN','ADMIN','SUPERVISOR','VIEWER']),officeId:z.string().uuid().nullable().optional()}).parse(req.body);const hash=await bcrypt.hash(s.password,12);const r=await q('INSERT INTO users(login_id,password_hash,display_name,role,office_id) VALUES($1,$2,$3,$4,$5) RETURNING id,login_id,display_name,role,office_id,active,created_at',[s.loginId,hash,s.displayName,s.role,s.officeId||null]);await audit(req,'CREATE_USER',s.loginId,{role:s.role});res.json({ok:true,item:r.rows[0]}); }));

io.on('connection',socket=>{ socket.on('watchDevice',id=>{ if(typeof id==='string')socket.join(`device:${id}`); }); });
setInterval(async()=>{ try{const r=await q("UPDATE devices SET status='OFFLINE' WHERE last_seen < now()-interval '75 seconds' AND status<>'OFFLINE' RETURNING id"); if(r.rowCount)io.emit('fleet.changed',{offline:r.rowCount});}catch(e){console.error('offline sweep',e.message)} },30000).unref();
setInterval(async()=>{ try{const days=Math.max(7,Number(process.env.RAW_RETENTION_DAYS||90)); await q(`DELETE FROM activity_events WHERE occurred_at < now() - ($1 || ' days')::interval`,[days]);}catch(e){console.error('retention sweep',e.message)} },6*60*60*1000).unref();
app.use((err,req,res,next)=>{console.error(err);if(err?.name==='ZodError')return res.status(400).json({ok:false,error:'Validation error',detail:err.issues});res.status(500).json({ok:false,error:'Internal server error'});});
const port=Number(process.env.PORT||8080); server.listen(port,'0.0.0.0',()=>console.log(`Staff Monitor listening on :${port}`));
process.on('SIGTERM',async()=>{server.close();await pool.end();process.exit(0)});
