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
import { verifyCredentials, issueSession, issueTwoFactorChallenge, verifyTwoFactorChallenge, requireAuth, requireRole, officeSql } from './auth.js';
import { getTwoFactorConfig, verifyTotp, confirmDataDirTwoFactor, makeOtpAuthUri } from './totp.js';
import { encryptSecret, getOfficeTelegramConfig, processTelegramActivity, testOfficeTelegram } from './telegram-alerts.js';

const app=express(); const server=http.createServer(app); const io=new Server(server,{cors:{origin:true,credentials:false}});
// Railway terminates TLS and forwards requests through one reverse-proxy hop.
// Trust exactly one hop so req.ip / express-rate-limit use the real client IP
// without enabling the permissive `trust proxy = true` configuration.
app.set('trust proxy', 1);
app.use(helmet({contentSecurityPolicy:false})); app.use(cors()); app.use(express.json({limit:'5mb'}));
app.use('/api/auth',rateLimit({windowMs:15*60*1000,limit:60,standardHeaders:'draft-8',legacyHeaders:false}));
app.use(express.static(new URL('../../dashboard/public',import.meta.url).pathname));
const asyncH=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const audit=async(req,action,target,detail={})=>{try{await q('INSERT INTO audit_logs(user_id,action,target,ip,detail) VALUES($1,$2,$3,$4,$5)',[req.user?.sub||null,action,target,req.ip,detail]);}catch{}};
const canOffice=(user,officeId)=>user.role==='SUPER_ADMIN'||!user.officeId||user.officeId===officeId||(user.role==='ADMIN'&&!officeId);
const liveFrames=new Map();
let fleetChangeTimer=null;
const pendingFleetDeviceIds=new Set();
function queueFleetChange(deviceId){
  if(deviceId)pendingFleetDeviceIds.add(deviceId);
  if(fleetChangeTimer)return;
  fleetChangeTimer=setTimeout(()=>{
    fleetChangeTimer=null;
    const deviceIds=[...pendingFleetDeviceIds];
    pendingFleetDeviceIds.clear();
    io.emit('fleet.changed',{deviceIds});
  },1500);
  fleetChangeTimer.unref?.();
}

function normalizeDomains(input){
  const values=Array.isArray(input)?input:[];
  const out=[];const seen=new Set();
  for(const raw of values){
    let v=String(raw||'').trim().toLowerCase();
    if(!v)continue;
    v=v.replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0].split(':')[0].replace(/^\.+|\.+$/g,'');
    if(!v||v.length>253||!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v))continue;
    if(!seen.has(v)){seen.add(v);out.push(v);}
  }
  return out;
}
function resolvePolicyScope(user,requested){
  const raw=String(requested||'ALL');
  if(raw.startsWith('PC:'))return {scopeKey:raw,officeId:null,deviceId:raw.slice(3)};
  if(user.role==='SUPER_ADMIN'){
    if(raw==='ALL')return {scopeKey:'ALL',officeId:null,deviceId:null};
    return {scopeKey:raw,officeId:raw,deviceId:null};
  }
  if(!user.officeId)throw Object.assign(new Error('Admin tidak memiliki kantor'),{statusCode:400});
  if(raw==='ALL')return {scopeKey:String(user.officeId),officeId:String(user.officeId),deviceId:null};
  return {scopeKey:raw,officeId:String(user.officeId),deviceId:null};
}
async function validatePolicyScopeAccess(user,scope){
  if(scope.deviceId){
    if(!/^[0-9a-f-]{36}$/i.test(scope.deviceId))throw Object.assign(new Error('Target PC tidak valid'),{statusCode:400});
    const d=await q('SELECT id,name,office_id FROM devices WHERE id=$1 AND disabled=false',[scope.deviceId]);
    if(!d.rows[0])throw Object.assign(new Error('PC target tidak ditemukan'),{statusCode:404});
    if(!canOffice(user,d.rows[0].office_id))throw Object.assign(new Error('Tidak boleh mengatur PC dari kantor lain'),{statusCode:403});
    return d.rows[0];
  }
  if(scope.officeId){const o=await q('SELECT id,name FROM offices WHERE id=$1 AND active=true',[scope.officeId]);if(!o.rows[0])throw Object.assign(new Error('Kantor tidak aktif/tidak ditemukan'),{statusCode:400});return o.rows[0];}
  return null;
}
async function policySnapshot(user,requestedScope){
  const scope=resolvePolicyScope(user,requestedScope);
  await validatePolicyScopeAccess(user,scope);
  const [pr,er]=await Promise.all([
    q('SELECT * FROM web_policies WHERE scope_key=$1',[scope.scopeKey]),
    q('SELECT e.staff_id,s.name,s.staff_code,s.office_id FROM web_policy_staff_exceptions e JOIN staff s ON s.id=e.staff_id WHERE e.scope_key=$1 ORDER BY s.name',[scope.scopeKey])
  ]);
  const policy=pr.rows[0]||{scope_key:scope.scopeKey,office_id:scope.officeId,enabled:false,blocked_domains:[],version:0,updated_at:null};
  return {scope,policy,exceptions:er.rows};
}
async function policyTargets(scopeKey,officeId,exceptionStaffIds=[],deviceId=null){
  const params=[];let where="d.disabled=false";
  if(deviceId){params.push(deviceId);where+=` AND d.id=$${params.length}`;}
  else if(officeId){params.push(officeId);where+=` AND d.office_id=$${params.length}`;}
  params.push(exceptionStaffIds);
  const exParam=params.length;
  const r=await q(`SELECT d.id,d.name,d.office_id,
    EXISTS(SELECT 1 FROM device_shift_assignments x WHERE x.device_id=d.id AND x.staff_id = ANY($${exParam}::uuid[])) exempt
    FROM devices d WHERE ${where} ORDER BY d.name`,params);
  return r.rows;
}
async function fanoutWebPolicy({scopeKey,officeId,deviceId,enabled,domains,exceptionStaffIds,version,userId}){
  const targets=await policyTargets(scopeKey,officeId,exceptionStaffIds,deviceId);
  if(!targets.length)return {total:0,blocked:0,exempt:0,queued:0};
  const client=await pool.connect();let queued=0,blocked=0,exempt=0;
  try{
    await client.query('BEGIN');
    for(const d of targets){
      const bypass=!!d.exempt;
      if(bypass)exempt++; else if(enabled)blocked++;
      const payload={blockedDomains:(enabled&&!bypass)?domains:[],persistent:true,closeBrowser:false,policyVersion:version,policyScope:scopeKey,exempt:bypass,source:'GLOBAL_WEB_POLICY'};
      await client.query(`DELETE FROM commands WHERE device_id=$1 AND command_type='SET_POLICY' AND status IN ('PENDING','SENT') AND payload->>'source'='GLOBAL_WEB_POLICY'`,[d.id]);
      await client.query("INSERT INTO commands(id,device_id,command_type,payload,created_by) VALUES(gen_random_uuid(),$1,'SET_POLICY',$2,$3)",[d.id,payload,userId]);
      queued++;
    }
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  return {total:targets.length,blocked,exempt,queued};
}

app.get('/health',asyncH(async(req,res)=>{const db=await q('SELECT 1 ok');const c=await q("SELECT count(*)::int n FROM devices WHERE (COALESCE(user_last_seen,last_seen)>now()-interval '180 seconds' OR system_last_seen>now()-interval '180 seconds') AND disabled=false");res.json({ok:true,api:'OK',database:db.rows[0].ok===1?'OK':'ERROR',realtime:'OK',connectedAgents:c.rows[0].n});}));
app.post('/api/auth/login',asyncH(async(req,res)=>{
 const s=z.object({loginId:z.string().min(1).max(100),password:z.string().min(1).max(200)}).parse(req.body);
 const user=await verifyCredentials(s.loginId,s.password);if(!user)return res.status(401).json({ok:false,error:'ID atau password salah'});
 const adminId=String(process.env.ADMIN_ID||'admin');
 const enforce2fa=user.loginId===adminId;
 const cfg=enforce2fa?getTwoFactorConfig():{enabled:false};
 if(!cfg.enabled)return res.json({ok:true,...await issueSession(user)});
 const challengeToken=issueTwoFactorChallenge(user,{setupRequired:!cfg.configured});
 const payload={ok:true,twoFactorRequired:true,setupRequired:!cfg.configured,challengeToken};
 if(!cfg.configured&&cfg.source==='data-dir'){payload.setupSecret=cfg.secret;payload.otpauthUri=makeOtpAuthUri({secret:cfg.secret,account:user.loginId,issuer:process.env.ADMIN_2FA_ISSUER||'Staff Monitor 8008'});}
 res.json(payload);
}));
app.post('/api/auth/2fa/verify',asyncH(async(req,res)=>{
 const s=z.object({challengeToken:z.string().min(20),code:z.string().regex(/^\d{6}$/)}).parse(req.body);
 let user;try{user=verifyTwoFactorChallenge(s.challengeToken);}catch{return res.status(401).json({ok:false,error:'Sesi verifikasi 2FA habis. Login ulang.'});}
 const cfg=getTwoFactorConfig();if(!cfg.enabled)return res.status(409).json({ok:false,error:'2FA sedang dinonaktifkan. Login ulang.'});
 if(!verifyTotp(cfg.secret,s.code))return res.status(401).json({ok:false,error:'Kode 2FA salah atau sudah kedaluwarsa'});
 if(user.setupRequired&&cfg.source==='data-dir'&&!cfg.configured)confirmDataDirTwoFactor(cfg.secret);
 res.json({ok:true,...await issueSession(user)});
}));

function makeToken(){return crypto.randomBytes(32).toString('hex')}
function tokenHash(t){return crypto.createHash('sha256').update(t).digest('hex')}
async function deviceAuth(req,res,next){
 const uid=req.headers['x-device-id'],token=req.headers['x-device-token'];if(!uid||!token)return res.status(401).json({ok:false,error:'Device auth required'});
 const r=await q(`SELECT d.* FROM devices d JOIN device_tokens t ON t.device_id=d.id WHERE d.device_uid=$1 AND t.token_hash=$2 AND t.revoked_at IS NULL AND d.disabled=false ORDER BY t.created_at DESC LIMIT 1`,[String(uid),tokenHash(String(token))]);
 if(!r.rows[0])return res.status(401).json({ok:false,error:'Device token invalid'});req.device=r.rows[0];next();
}
app.post('/api/agent/enroll',asyncH(async(req,res)=>{
 const enrollSecret=String(process.env.DEVICE_ENROLL_SECRET||'');
 if(!enrollSecret||req.headers['x-enroll-secret']!==enrollSecret)return res.status(401).json({ok:false,error:'Enroll secret invalid / DEVICE_ENROLL_SECRET belum dikonfigurasi'});
 const s=z.object({
   deviceUid:z.string().trim().min(8).max(200),
   hardwareUid:z.union([z.string().max(200),z.null()]).optional(),
   hardwareFingerprint:z.union([z.string().max(200),z.null()]).optional(),
   installationId:z.union([z.string().max(200),z.null()]).optional(),
   previousDeviceUid:z.union([z.string().max(200),z.null()]).optional(),
   identityVersion:z.number().int().min(1).max(10).optional(),
   name:z.string().trim().min(1).max(200),os:z.string().max(200).optional(),agentVersion:z.string().max(50).optional(),officeName:z.string().max(200).optional()
 }).parse(req.body||{});
 const hardwareUid=typeof s.hardwareUid==='string'&&s.hardwareUid.trim().length>=8?s.hardwareUid.trim():null;
 const hardwareFingerprint=typeof s.hardwareFingerprint==='string'&&s.hardwareFingerprint.trim().length>=8?s.hardwareFingerprint.trim():hardwareUid;
 const installationId=typeof s.installationId==='string'&&s.installationId.trim().length>=8?s.installationId.trim():null;
 const previousDeviceUid=typeof s.previousDeviceUid==='string'&&s.previousDeviceUid.trim().length>=8?s.previousDeviceUid.trim():null;
 const identityVersion=Number(s.identityVersion||1);
 const requestedOffice=String(s.officeName||'').trim();
 let officeId=null;let resolvedOfficeName=null;
 if(requestedOffice && requestedOffice.toUpperCase()!=='UNASSIGNED'){
   const o=await q('SELECT id,name FROM offices WHERE lower(name)=lower($1) AND active=true',[requestedOffice]);
   officeId=o.rows[0]?.id||null;resolvedOfficeName=o.rows[0]?.name||null;
 }
 const revoked=await q('SELECT 1 FROM revoked_devices WHERE device_uid=$1',[s.deviceUid]);
 if(revoked.rows[0])return res.status(403).json({ok:false,error:'Device revoked',code:'DEVICE_REVOKED'});

 let existing=await q('SELECT id,device_uid,name,office_id,hardware_uid,hardware_fingerprint,installation_id,identity_version FROM devices WHERE device_uid=$1',[s.deviceUid]);
 let migratedFrom=null;

 // Migrasi aman dari identity v1 -> v2. Ini menyelesaikan kasus beberapa PC lama memakai UID sama.
 // PC pertama yang upgrade mengambil row/history lama; PC berikutnya dengan previous UID yang sama
 // akan membuat row baru karena alias lama sudah dipindahkan dari kolom devices.device_uid.
 if(!existing.rows[0]&&identityVersion>=2&&previousDeviceUid&&previousDeviceUid!==s.deviceUid){
   const prev=await q('SELECT id,device_uid,name,office_id,hardware_uid,hardware_fingerprint,installation_id,identity_version FROM devices WHERE device_uid=$1',[previousDeviceUid]);
   if(prev.rows[0] && Number(prev.rows[0].identity_version||1)<2){
     const collision=await q('SELECT id FROM devices WHERE device_uid=$1',[s.deviceUid]);
     if(!collision.rows[0]){
       await q('INSERT INTO device_uid_aliases(alias_uid,device_id) VALUES($1,$2) ON CONFLICT(alias_uid) DO NOTHING',[previousDeviceUid,prev.rows[0].id]);
       await q('UPDATE devices SET device_uid=$1 WHERE id=$2',[s.deviceUid,prev.rows[0].id]);
       migratedFrom=previousDeviceUid;
       existing=await q('SELECT id,device_uid,name,office_id,hardware_uid,hardware_fingerprint,installation_id,identity_version FROM devices WHERE id=$1',[prev.rows[0].id]);
     }
   }
 }

 // Legacy fallback hanya untuk agent v1. Identity v2 TIDAK boleh merge berdasarkan hardwareUid,
 // sebab machine clones dapat memiliki identifier lama yang sama.
 if(!existing.rows[0]&&identityVersion<2&&hardwareUid){
   const byHardware=await q('SELECT id,device_uid,name,office_id,hardware_uid,hardware_fingerprint,installation_id,identity_version FROM devices WHERE hardware_uid=$1 AND disabled=false ORDER BY COALESCE(last_enrolled_at,enrolled_at) DESC LIMIT 2',[hardwareUid]);
   if(byHardware.rows.length===1)existing=byHardware;
 }

 // Proteksi collision identity v2: UID yang sama tidak boleh diam-diam dipakai installationId/fingerprint berbeda.
 if(existing.rows[0]&&identityVersion>=2){
   const e=existing.rows[0];
   if(e.installation_id && installationId && e.installation_id!==installationId){
     return res.status(409).json({ok:false,error:'Device UID collision: installation berbeda',code:'DEVICE_UID_COLLISION',deviceUid:s.deviceUid});
   }
   if(e.hardware_fingerprint && hardwareFingerprint && e.hardware_fingerprint!==hardwareFingerprint){
     return res.status(409).json({ok:false,error:'Device UID collision: hardware fingerprint berbeda',code:'DEVICE_UID_COLLISION',deviceUid:s.deviceUid});
   }
 }

 const created=!existing.rows[0];
 let d;
 if(existing.rows[0]){
   d=await q(`UPDATE devices SET hostname=$2,os=$3,agent_version=$4,office_id=COALESCE(office_id,$5),
         hardware_uid=COALESCE($6,hardware_uid),hardware_fingerprint=COALESCE($7,hardware_fingerprint),
         installation_id=COALESCE($8,installation_id),identity_version=GREATEST(identity_version,$9),
         system_last_seen=now(),last_enrolled_at=now(),disabled=false
     WHERE id=$1 RETURNING *`,
     [existing.rows[0].id,s.name,s.os||null,s.agentVersion||null,officeId,hardwareUid,hardwareFingerprint,installationId,identityVersion]);
 }else{
   d=await q(`INSERT INTO devices(id,device_uid,hardware_uid,name,hostname,os,agent_version,office_id,status,system_last_seen,last_enrolled_at,hardware_fingerprint,installation_id,identity_version)
     VALUES(gen_random_uuid(),$1,$2,$3,$3,$4,$5,$6,'ONLINE',now(),now(),$7,$8,$9) RETURNING *`,
     [s.deviceUid,hardwareUid,s.name,s.os||null,s.agentVersion||null,officeId,hardwareFingerprint,installationId,identityVersion]);
 }
 const token=makeToken();
 await q('INSERT INTO device_tokens(id,device_id,token_hash) VALUES(gen_random_uuid(),$1,$2)',[d.rows[0].id,tokenHash(token)]);
 await q(`UPDATE device_tokens SET revoked_at=now()
          WHERE device_id=$1 AND revoked_at IS NULL AND id NOT IN (
            SELECT id FROM device_tokens WHERE device_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 6
          )`,[d.rows[0].id]);
 const officeAssigned=!!d.rows[0].office_id;
 if(officeAssigned){
   const finalOffice=await q('SELECT name FROM offices WHERE id=$1',[d.rows[0].office_id]);
   resolvedOfficeName=finalOffice.rows[0]?.name||null;
 }
 console.log('[ENROLL]',JSON.stringify({deviceId:d.rows[0].id,deviceUid:d.rows[0].device_uid,previousDeviceUid:migratedFrom,identityVersion:d.rows[0].identity_version,hostname:d.rows[0].hostname,name:d.rows[0].name,created,officeAssigned,officeId:d.rows[0].office_id||null,requestedOffice:requestedOffice||null,resolvedOfficeName}));
 queueFleetChange(d.rows[0].id);
 res.set('Cache-Control','no-store').json({ok:true,created,deviceId:d.rows[0].id,deviceUid:d.rows[0].device_uid,deviceToken:token,migratedFrom,identityVersion:d.rows[0].identity_version,officeAssigned,officeId:d.rows[0].office_id||null,officeName:resolvedOfficeName,lastEnrolledAt:d.rows[0].last_enrolled_at,warning:officeAssigned?null:'PC terdaftar tetapi belum mendapat kantor. Tampil di filter BELUM ADA KANTOR / PC BARU.'});
}));
app.post('/api/agent/system-heartbeat',deviceAuth,asyncH(async(req,res)=>{const x=z.object({os:z.string().max(200).optional(),agentVersion:z.string().max(50).optional()}).parse(req.body||{});await q(`UPDATE devices SET os=COALESCE($1,os),agent_version=COALESCE($2,agent_version),ip=$3,system_last_seen=now() WHERE id=$4`,[x.os||null,x.agentVersion||null,req.ip.replace('::ffff:',''),req.device.id]);queueFleetChange(req.device.id);res.json({ok:true});}));
app.post('/api/agent/heartbeat',deviceAuth,asyncH(async(req,res)=>{
 const s=z.object({status:z.enum(['ONLINE','ACTIVE','IDLE','LOCKED']).default('ONLINE'),currentApp:z.string().max(300).nullable().optional(),currentTitle:z.string().max(500).nullable().optional(),domain:z.string().max(500).nullable().optional(),url:z.string().max(2000).nullable().optional(),os:z.string().max(200).optional(),agentVersion:z.string().max(50).optional()}).parse(req.body||{});
 await q('UPDATE devices SET status=$1,current_app=$2,current_title=$3,current_domain=$4,os=COALESCE($5,os),agent_version=COALESCE($6,agent_version),ip=$7,last_seen=now(),user_last_seen=now() WHERE id=$8',[s.status,s.currentApp||null,s.currentTitle||null,s.domain||null,s.os||null,s.agentVersion||null,req.ip.replace('::ffff:',''),req.device.id]);
 processTelegramActivity({deviceId:req.device.id,domain:s.domain,url:s.url,title:s.currentTitle,app:s.currentApp,occurredAt:new Date().toISOString()}).catch(e=>console.error('[TELEGRAM ACTIVITY]',e.message));
 io.to(`device:${req.device.id}`).emit('device.status',{deviceId:req.device.id,...s,lastSeen:new Date().toISOString()});queueFleetChange(req.device.id);
 const cmds=await q("SELECT id,command_type,payload,created_at FROM commands WHERE device_id=$1 AND status='PENDING' ORDER BY created_at LIMIT 10",[req.device.id]);
 if(cmds.rows.length)await q("UPDATE commands SET status='SENT' WHERE id = ANY($1::uuid[])",[cmds.rows.map(x=>x.id)]);
 const pol=await q(`SELECT p.scope_key,p.enabled,p.blocked_domains,p.version,
   EXISTS(SELECT 1 FROM web_policy_staff_exceptions e JOIN device_shift_assignments a ON a.staff_id=e.staff_id WHERE e.scope_key=p.scope_key AND a.device_id=$1) exempt
   FROM web_policies p WHERE p.scope_key IN ('PC:'||$1::text,'ALL',COALESCE($2::text,'')) ORDER BY CASE WHEN p.scope_key='PC:'||$1::text THEN 0 WHEN p.scope_key=$2::text THEN 1 ELSE 2 END LIMIT 1`,[req.device.id,req.device.office_id]);
 const prow=pol.rows[0];
 const webPolicy=prow?{enabled:!!prow.enabled&&!prow.exempt,blockedDomains:(prow.enabled&&!prow.exempt)?prow.blocked_domains:[],persistent:true,closeBrowser:false,version:Number(prow.version||0),scope:prow.scope_key,exempt:!!prow.exempt}:null;
 res.json({ok:true,commands:cmds.rows,webPolicy});
}));
app.post('/api/agent/activity',deviceAuth,asyncH(async(req,res)=>{
 const s=z.object({occurredAt:z.string().datetime().optional(),eventType:z.string().min(1).max(50),appName:z.string().max(300).optional(),processName:z.string().max(300).optional(),windowTitle:z.string().max(500).optional(),domain:z.string().max(500).nullable().optional(),url:z.string().max(2000).nullable().optional(),durationSeconds:z.number().int().nonnegative().optional()}).parse(req.body);
 const ts=s.occurredAt||new Date().toISOString();await q('INSERT INTO activity_events(device_id,occurred_at,event_type,app_name,process_name,window_title,duration_seconds,meta) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[req.device.id,ts,s.eventType,s.appName||null,s.processName||null,s.windowTitle||null,s.durationSeconds||null,{domain:s.domain||null,url:s.url||null}]);await q('UPDATE devices SET current_app=$1,current_title=$2,current_domain=$3,status=$4,last_seen=now(),user_last_seen=now() WHERE id=$5',[s.appName||null,s.windowTitle||null,s.domain||null,s.eventType==='IDLE'?'IDLE':s.eventType==='LOCKED'?'LOCKED':'ACTIVE',req.device.id]);io.emit('device.activity',{deviceId:req.device.id,...s});processTelegramActivity({deviceId:req.device.id,domain:s.domain,url:s.url,title:s.windowTitle,app:s.appName,occurredAt:ts}).catch(e=>console.error('[TELEGRAM ACTIVITY]',e.message));res.json({ok:true});
}));
app.post('/api/agent/commands/:id/ack',deviceAuth,asyncH(async(req,res)=>{const s=z.object({ok:z.boolean(),result:z.string().max(2000).optional()}).parse(req.body);await q('UPDATE commands SET status=$1,ack_at=now(),result=$2 WHERE id=$3 AND device_id=$4',[s.ok?'ACK':'FAILED',s.result||null,req.params.id,req.device.id]);res.json({ok:true});}));
app.get('/api/agent/commands',deviceAuth,asyncH(async(req,res)=>{const cmds=await q("SELECT id,command_type,payload,created_at FROM commands WHERE device_id=$1 AND status='PENDING' ORDER BY created_at LIMIT 10",[req.device.id]);
 if(cmds.rows.length)await q("UPDATE commands SET status='SENT' WHERE id = ANY($1::uuid[])",[cmds.rows.map(x=>x.id)]);
 const pol=await q(`SELECT p.scope_key,p.enabled,p.blocked_domains,p.version,
   EXISTS(SELECT 1 FROM web_policy_staff_exceptions e JOIN device_shift_assignments a ON a.staff_id=e.staff_id WHERE e.scope_key=p.scope_key AND a.device_id=$1) exempt
   FROM web_policies p WHERE p.scope_key IN ('PC:'||$1::text,'ALL',COALESCE($2::text,'')) ORDER BY CASE WHEN p.scope_key='PC:'||$1::text THEN 0 WHEN p.scope_key=$2::text THEN 1 ELSE 2 END LIMIT 1`,[req.device.id,req.device.office_id]);
 const prow=pol.rows[0];
 const webPolicy=prow?{enabled:!!prow.enabled&&!prow.exempt,blockedDomains:(prow.enabled&&!prow.exempt)?prow.blocked_domains:[],persistent:true,closeBrowser:false,version:Number(prow.version||0),scope:prow.scope_key,exempt:!!prow.exempt}:null;
 res.json({ok:true,commands:cmds.rows,webPolicy});}));
app.get('/api/agent/live-state',deviceAuth,asyncH(async(req,res)=>{const r=await q(`SELECT active,session_id,expires_at FROM live_sessions WHERE device_id=$1`,[req.device.id]);const row=r.rows[0];const active=!!row?.active&&!!row?.session_id&&(!row.expires_at||new Date(row.expires_at).getTime()>Date.now());if(row?.active&&!active)await q('UPDATE live_sessions SET active=false WHERE device_id=$1',[req.device.id]);res.set('Cache-Control','no-store').json({ok:true,active,sessionId:active?row.session_id:null,intervalMs:900,expiresAt:active?row.expires_at:null});}));
app.post('/api/agent/live-frame',deviceAuth,asyncH(async(req,res)=>{const x=z.object({sessionId:z.string().min(8).max(100),jpegBase64:z.string().min(100).max(4800000),width:z.number().int().positive().max(10000),height:z.number().int().positive().max(10000),capturedAt:z.string().optional()}).parse(req.body);const state=await q(`SELECT active,session_id,expires_at FROM live_sessions WHERE device_id=$1`,[req.device.id]);const row=state.rows[0];const valid=!!row?.active&&row.session_id===x.sessionId&&(!row.expires_at||new Date(row.expires_at).getTime()>Date.now());if(!valid)return res.status(409).json({ok:false,error:'Live view inactive or session changed'});liveFrames.set(req.device.id,{...x,receivedAt:Date.now()});res.json({ok:true});}));

app.get('/api/me',requireAuth,(req,res)=>res.json({ok:true,user:req.user}));
app.get('/api/offices',requireAuth,asyncH(async(req,res)=>{let r;if(req.user.role==='SUPER_ADMIN'||!req.user.officeId)r=await q('SELECT * FROM offices ORDER BY active DESC,name');else r=await q('SELECT * FROM offices WHERE id=$1',[req.user.officeId]);res.json({ok:true,items:r.rows});}));
app.post('/api/offices',requireAuth,requireRole('SUPER_ADMIN'),asyncH(async(req,res)=>{const s=z.object({name:z.string().trim().min(2).max(100)}).parse(req.body);const r=await q('INSERT INTO offices(id,name) VALUES(gen_random_uuid(),$1) RETURNING *',[s.name]);await audit(req,'CREATE_OFFICE',s.name);res.json({ok:true,item:r.rows[0]});}));
app.patch('/api/offices/:id',requireAuth,requireRole('SUPER_ADMIN'),asyncH(async(req,res)=>{const s=z.object({name:z.string().trim().min(2).max(100).optional(),active:z.boolean().optional()}).parse(req.body);const old=await q('SELECT * FROM offices WHERE id=$1',[req.params.id]);if(!old.rows[0])return res.status(404).json({ok:false,error:'Kantor tidak ditemukan'});const r=await q('UPDATE offices SET name=COALESCE($1,name),active=COALESCE($2,active) WHERE id=$3 RETURNING *',[s.name??null,s.active??null,req.params.id]);await audit(req,'UPDATE_OFFICE',old.rows[0].name,{before:old.rows[0],after:r.rows[0]});res.json({ok:true,item:r.rows[0]});}));
app.get('/api/offices/:id/telegram',requireAuth,requireRole('SUPER_ADMIN','ADMIN'),asyncH(async(req,res)=>{
 const o=await q('SELECT id,name FROM offices WHERE id=$1',[req.params.id]);if(!o.rows[0])return res.status(404).json({ok:false,error:'Kantor tidak ditemukan'});if(!canOffice(req.user,o.rows[0].id))return res.status(403).json({ok:false,error:'Forbidden'});
 res.set('Cache-Control','no-store').json({ok:true,office:o.rows[0],config:await getOfficeTelegramConfig(o.rows[0].id)});
}));
app.put('/api/offices/:id/telegram',requireAuth,requireRole('SUPER_ADMIN','ADMIN'),asyncH(async(req,res)=>{
 const o=await q('SELECT id,name FROM offices WHERE id=$1',[req.params.id]);if(!o.rows[0])return res.status(404).json({ok:false,error:'Kantor tidak ditemukan'});if(!canOffice(req.user,o.rows[0].id))return res.status(403).json({ok:false,error:'Forbidden'});
 const b=z.object({enabled:z.boolean(),botToken:z.string().max(300).optional().default(''),chatId:z.string().trim().max(120),cooldownSeconds:z.number().int().min(60).max(86400),watchDomains:z.array(z.string().max(500)).min(1).max(100)}).parse(req.body||{});
 const domains=normalizeDomains(b.watchDomains);if(!domains.length)return res.status(400).json({ok:false,error:'Minimal satu domain pantauan valid'});
 const current=await q('SELECT bot_token_enc FROM office_telegram_configs WHERE office_id=$1',[o.rows[0].id]);let enc=current.rows[0]?.bot_token_enc||null;if(b.botToken.trim())enc=encryptSecret(b.botToken.trim());
 if(b.enabled&&(!enc||!b.chatId))return res.status(400).json({ok:false,error:'Bot Token dan Chat/Group ID wajib diisi saat Telegram Alert aktif'});
 await q(`INSERT INTO office_telegram_configs(office_id,enabled,bot_token_enc,chat_id,cooldown_seconds,watch_domains,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,now()) ON CONFLICT(office_id) DO UPDATE SET enabled=excluded.enabled,bot_token_enc=excluded.bot_token_enc,chat_id=excluded.chat_id,cooldown_seconds=excluded.cooldown_seconds,watch_domains=excluded.watch_domains,updated_by=excluded.updated_by,updated_at=now()`,[o.rows[0].id,b.enabled,enc,b.chatId||null,b.cooldownSeconds,JSON.stringify(domains),req.user.sub]);
 await audit(req,'UPDATE_TELEGRAM_ALERT',o.rows[0].name,{enabled:b.enabled,chatId:b.chatId,cooldownSeconds:b.cooldownSeconds,watchDomains:domains,tokenChanged:!!b.botToken.trim()});res.json({ok:true,config:await getOfficeTelegramConfig(o.rows[0].id)});
}));
app.post('/api/offices/:id/telegram/test',requireAuth,requireRole('SUPER_ADMIN','ADMIN'),asyncH(async(req,res)=>{const o=await q('SELECT id,name FROM offices WHERE id=$1',[req.params.id]);if(!o.rows[0])return res.status(404).json({ok:false,error:'Kantor tidak ditemukan'});if(!canOffice(req.user,o.rows[0].id))return res.status(403).json({ok:false,error:'Forbidden'});await testOfficeTelegram(o.rows[0].id);await audit(req,'TEST_TELEGRAM_ALERT',o.rows[0].name);res.json({ok:true});}));
app.get('/api/telegram-alerts',requireAuth,requireRole('SUPER_ADMIN','ADMIN','SUPERVISOR'),asyncH(async(req,res)=>{const params=[];let where='';if(req.user.role!=='SUPER_ADMIN'&&req.user.officeId){params.push(req.user.officeId);where='WHERE e.office_id=$1';}const r=await q(`SELECT e.id,e.domain,e.app_name,e.window_title,e.occurred_at,e.status,e.sent_at,e.error,o.name office_name,d.name device_name FROM telegram_alert_events e JOIN offices o ON o.id=e.office_id LEFT JOIN devices d ON d.id=e.device_id ${where} ORDER BY e.occurred_at DESC LIMIT 300`,params);res.set('Cache-Control','no-store').json({ok:true,items:r.rows});}));


app.get('/api/dashboard',requireAuth,asyncH(async(req,res)=>{const o=officeSql(req.user,'d');const r=await q(`SELECT count(*)::int total,count(*) FILTER(WHERE COALESCE(d.user_last_seen,d.last_seen)>now()-interval '180 seconds' OR d.system_last_seen>now()-interval '180 seconds')::int online,count(*) FILTER(WHERE d.status='ACTIVE' AND COALESCE(d.user_last_seen,d.last_seen)>now()-interval '180 seconds')::int active,count(*) FILTER(WHERE d.status='IDLE' AND COALESCE(d.user_last_seen,d.last_seen)>now()-interval '180 seconds')::int idle FROM devices d WHERE d.disabled=false ${o.clause}`,o.params);res.json({ok:true,...r.rows[0]});}));
const deviceSelect=`SELECT d.*,o.name office_name,
 mp.staff_id morning_staff_id,ms.name morning_staff_name,ms.staff_code morning_staff_code,
 np.staff_id night_staff_id,ns.name night_staff_name,ns.staff_code night_staff_code,
 CASE WHEN COALESCE(d.user_last_seen,d.last_seen)>now()-interval '180 seconds' THEN d.status WHEN d.system_last_seen>now()-interval '180 seconds' THEN 'SYSTEM_ONLY' ELSE 'OFFLINE' END effective_status,
 GREATEST(COALESCE(d.user_last_seen,d.last_seen), d.system_last_seen) effective_last_seen
 FROM devices d LEFT JOIN offices o ON o.id=d.office_id
 LEFT JOIN device_shift_assignments mp ON mp.device_id=d.id AND mp.shift='PAGI' LEFT JOIN staff ms ON ms.id=mp.staff_id
 LEFT JOIN device_shift_assignments np ON np.device_id=d.id AND np.shift='MALAM' LEFT JOIN staff ns ON ns.id=np.staff_id`;

function fleetStats(items){
 const total=items.length;let online=0,active=0,idle=0;
 for(const d of items){if(d.effective_status!=='OFFLINE')online++;if(d.effective_status==='ACTIVE')active++;if(d.effective_status==='IDLE')idle++;}
 return {total,online,active,idle};
}
async function getFleet(user){
 const o=officeSql(user,'d');
 const r=await q(`${deviceSelect} WHERE d.disabled=false ${o.clause} ORDER BY COALESCE(d.last_enrolled_at,d.enrolled_at) DESC,d.name LIMIT 2000`,o.params);
 return r.rows;
}
app.get('/api/fleet',requireAuth,asyncH(async(req,res)=>{const devices=await getFleet(req.user);res.set('Cache-Control','no-store').json({ok:true,devices,stats:fleetStats(devices)});}));
app.get('/api/bootstrap',requireAuth,asyncH(async(req,res)=>{
 const officePromise=(req.user.role==='SUPER_ADMIN'||!req.user.officeId)?q('SELECT * FROM offices ORDER BY active DESC,name'):q('SELECT * FROM offices WHERE id=$1',[req.user.officeId]);
 const staffParams=[];let staffWhere='';if(req.user.role!=='SUPER_ADMIN'&&req.user.officeId){staffParams.push(req.user.officeId);staffWhere='WHERE s.office_id=$1';}
 const staffPromise=q(`SELECT s.*,o.name office_name,d.name department_name FROM staff s JOIN offices o ON o.id=s.office_id LEFT JOIN departments d ON d.id=s.department_id ${staffWhere} ORDER BY s.active DESC,s.name`,staffParams);
 const [officeR,staffR,devices]=await Promise.all([officePromise,staffPromise,getFleet(req.user)]);
 res.set('Cache-Control','no-store').json({ok:true,user:req.user,offices:officeR.rows,staff:staffR.rows,devices,stats:fleetStats(devices)});
}));
app.get('/api/devices',requireAuth,asyncH(async(req,res)=>{
 const o=officeSql(req.user,'d');
 const r=await q(`${deviceSelect} WHERE d.disabled=false ${o.clause} ORDER BY COALESCE(d.last_enrolled_at,d.enrolled_at) DESC,d.name LIMIT 2000`,o.params);
 res.set('Cache-Control','no-store, no-cache, must-revalidate').json({ok:true,items:r.rows});
}));
app.get('/api/devices/:id',requireAuth,asyncH(async(req,res)=>{const r=await q(`${deviceSelect} WHERE d.id=$1`,[req.params.id]);if(!r.rows[0])return res.status(404).json({ok:false,error:'Device tidak ditemukan'});if(!canOffice(req.user,r.rows[0].office_id))return res.status(403).json({ok:false,error:'Forbidden'});res.json({ok:true,item:r.rows[0]});}));
app.patch('/api/devices/:id',requireAuth,requireRole('SUPER_ADMIN','ADMIN'),asyncH(async(req,res)=>{const s=z.object({name:z.string().trim().min(1).max(200).optional(),officeId:z.string().uuid().nullable().optional()}).parse(req.body);const d=await q('SELECT * FROM devices WHERE id=$1',[req.params.id]);if(!d.rows[0])return res.status(404).json({ok:false,error:'Device tidak ditemukan'});const targetOffice=s.officeId===undefined?d.rows[0].office_id:s.officeId;if(targetOffice&&!canOffice(req.user,targetOffice))return res.status(403).json({ok:false,error:'Forbidden'});if(s.officeId){const o=await q('SELECT id FROM offices WHERE id=$1 AND active=true',[s.officeId]);if(!o.rows[0])return res.status(400).json({ok:false,error:'Kantor tidak aktif/tidak ditemukan'});}const r=await q('UPDATE devices SET name=COALESCE($1,name),office_id=$2 WHERE id=$3 RETURNING *',[s.name??null,targetOffice,req.params.id]);if(s.officeId!==undefined&&s.officeId!==d.rows[0].office_id){await q('DELETE FROM device_shift_assignments WHERE device_id=$1',[req.params.id]);await q('UPDATE devices SET staff_id=NULL WHERE id=$1',[req.params.id]);}await audit(req,'UPDATE_DEVICE',d.rows[0].name,{name:r.rows[0].name,officeId:targetOffice});io.emit('fleet.changed',{deviceId:req.params.id});res.json({ok:true,item:r.rows[0]});}));
app.put('/api/devices/:id/shifts',requireAuth,requireRole('SUPER_ADMIN','ADMIN'),asyncH(async(req,res)=>{const s=z.object({morningStaffId:z.string().uuid().nullable(),nightStaffId:z.string().uuid().nullable()}).parse(req.body);const d=await q('SELECT * FROM devices WHERE id=$1',[req.params.id]);if(!d.rows[0])return res.status(404).json({ok:false,error:'Device tidak ditemukan'});if(d.rows[0].office_id&&!canOffice(req.user,d.rows[0].office_id))return res.status(403).json({ok:false,error:'Forbidden'});for(const [shift,id] of [['PAGI',s.morningStaffId],['MALAM',s.nightStaffId]]){if(id){const st=await q('SELECT id,office_id,active FROM staff WHERE id=$1',[id]);if(!st.rows[0]||!st.rows[0].active)return res.status(400).json({ok:false,error:`Staff ${shift} tidak valid`});if(d.rows[0].office_id&&st.rows[0].office_id!==d.rows[0].office_id)return res.status(400).json({ok:false,error:`Staff ${shift} harus dari kantor yang sama dengan PC`});await q(`INSERT INTO device_shift_assignments(id,device_id,shift,staff_id,updated_at) VALUES(gen_random_uuid(),$1::uuid,$2,$3::uuid,now()) ON CONFLICT(device_id,shift) DO UPDATE SET staff_id=excluded.staff_id,updated_at=now()`,[req.params.id,shift,id]);}else{await q('DELETE FROM device_shift_assignments WHERE device_id=$1::uuid AND shift=$2',[req.params.id,shift]);}}await q('UPDATE devices SET staff_id=COALESCE($1::uuid,$2::uuid) WHERE id=$3::uuid',[s.morningStaffId,s.nightStaffId,req.params.id]);await audit(req,'ASSIGN_DEVICE_SHIFTS',d.rows[0].name,{morningStaffId:s.morningStaffId,nightStaffId:s.nightStaffId});io.emit('fleet.changed',{deviceId:req.params.id});res.json({ok:true});}));

app.put('/api/devices/:id/config',requireAuth,requireRole('SUPER_ADMIN','ADMIN'),asyncH(async(req,res)=>{
 const s=z.object({name:z.string().trim().min(1).max(200),officeId:z.string().uuid().nullable(),morningStaffId:z.string().uuid().nullable(),nightStaffId:z.string().uuid().nullable()}).parse(req.body);
 const client=await pool.connect();let old;
 try{
  await client.query('BEGIN');
  const d=await client.query('SELECT * FROM devices WHERE id=$1 FOR UPDATE',[req.params.id]);old=d.rows[0];
  if(!old){await client.query('ROLLBACK');return res.status(404).json({ok:false,error:'Device tidak ditemukan'});}
  if(old.office_id&&!canOffice(req.user,old.office_id)){await client.query('ROLLBACK');return res.status(403).json({ok:false,error:'Forbidden'});}
  if(s.officeId&&!canOffice(req.user,s.officeId)){await client.query('ROLLBACK');return res.status(403).json({ok:false,error:'Forbidden'});}
  if(s.officeId){const o=await client.query('SELECT id FROM offices WHERE id=$1 AND active=true',[s.officeId]);if(!o.rows[0]){await client.query('ROLLBACK');return res.status(400).json({ok:false,error:'Kantor tidak aktif/tidak ditemukan'});}}
  if(!s.officeId&&(s.morningStaffId||s.nightStaffId)){await client.query('ROLLBACK');return res.status(400).json({ok:false,error:'Pilih kantor terlebih dahulu sebelum memilih staff shift'});}
  for(const [shift,id] of [['PAGI',s.morningStaffId],['MALAM',s.nightStaffId]]){
   if(!id)continue;
   const st=await client.query('SELECT id,office_id,active FROM staff WHERE id=$1',[id]);
   if(!st.rows[0]||!st.rows[0].active){await client.query('ROLLBACK');return res.status(400).json({ok:false,error:`Staff ${shift} tidak valid/nonaktif`});}
   if(st.rows[0].office_id!==s.officeId){await client.query('ROLLBACK');return res.status(400).json({ok:false,error:`Staff ${shift} harus dari kantor yang sama dengan PC`});}
  }
  await client.query('UPDATE devices SET name=$1,office_id=$2::uuid,staff_id=COALESCE($3::uuid,$4::uuid) WHERE id=$5::uuid',[s.name,s.officeId,s.morningStaffId,s.nightStaffId,req.params.id]);
  for(const [shift,id] of [['PAGI',s.morningStaffId],['MALAM',s.nightStaffId]]){
   if(id)await client.query(`INSERT INTO device_shift_assignments(id,device_id,shift,staff_id,updated_at) VALUES(gen_random_uuid(),$1::uuid,$2,$3::uuid,now()) ON CONFLICT(device_id,shift) DO UPDATE SET staff_id=excluded.staff_id,updated_at=now()`,[req.params.id,shift,id]);
   else await client.query('DELETE FROM device_shift_assignments WHERE device_id=$1::uuid AND shift=$2',[req.params.id,shift]);
  }
  await client.query('COMMIT');
 }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
 await audit(req,'UPDATE_DEVICE_CONFIG',old.name,{name:s.name,officeId:s.officeId,morningStaffId:s.morningStaffId,nightStaffId:s.nightStaffId});
 io.emit('fleet.changed',{deviceIds:[req.params.id],configChanged:true});
 res.json({ok:true});
}));
app.get('/api/devices/:id/activity',requireAuth,asyncH(async(req,res)=>{const d=await q('SELECT office_id FROM devices WHERE id=$1',[req.params.id]);if(!d.rows[0])return res.status(404).json({ok:false,error:'Device not found'});if(!canOffice(req.user,d.rows[0].office_id))return res.status(403).json({ok:false,error:'Forbidden'});const r=await q("SELECT id,device_id,occurred_at,event_type,app_name,process_name,window_title,duration_seconds FROM activity_events WHERE device_id=$1 AND occurred_at>now()-interval '7 days' ORDER BY occurred_at DESC LIMIT 500",[req.params.id]);res.set('Cache-Control','private, max-age=5').json({ok:true,items:r.rows});}));

app.get('/api/web-policy',requireAuth,requireRole('SUPER_ADMIN','ADMIN','SUPERVISOR'),asyncH(async(req,res)=>{
 const snap=await policySnapshot(req.user,String(req.query.scope||'ALL'));
 const staffParams=[];let sw='WHERE s.active=true';
 if(snap.scope.deviceId){staffParams.push(snap.scope.deviceId);sw+=` AND EXISTS (SELECT 1 FROM device_shift_assignments da WHERE da.device_id=$${staffParams.length} AND da.staff_id=s.id)`;}
 else if(snap.scope.officeId){staffParams.push(snap.scope.officeId);sw+=` AND s.office_id=$${staffParams.length}`;}
 else if(req.user.role!=='SUPER_ADMIN'&&req.user.officeId){staffParams.push(req.user.officeId);sw+=` AND s.office_id=$${staffParams.length}`;}
 const staffR=await q(`SELECT s.id,s.staff_code,s.name,s.office_id,o.name office_name FROM staff s JOIN offices o ON o.id=s.office_id ${sw} ORDER BY o.name,s.name`,staffParams);
 const exceptionIds=snap.exceptions.map(x=>x.staff_id);
 const targets=await policyTargets(snap.scope.scopeKey,snap.scope.officeId,exceptionIds,snap.scope.deviceId);
 const pending=targets.length?await q(`SELECT count(*)::int n FROM commands WHERE device_id = ANY($1::uuid[]) AND command_type='SET_POLICY' AND status IN ('PENDING','SENT') AND payload->>'source'='GLOBAL_WEB_POLICY'`,[targets.map(x=>x.id)]):{rows:[{n:0}]};
 res.set('Cache-Control','no-store').json({ok:true,scopeKey:snap.scope.scopeKey,officeId:snap.scope.officeId,deviceId:snap.scope.deviceId||null,enabled:!!snap.policy.enabled,domains:Array.isArray(snap.policy.blocked_domains)?snap.policy.blocked_domains:[],version:Number(snap.policy.version||0),updatedAt:snap.policy.updated_at,exceptions:snap.exceptions,staff:staffR.rows,stats:{devices:targets.length,exempt:targets.filter(x=>x.exempt).length,blocked:snap.policy.enabled?targets.filter(x=>!x.exempt).length:0,pending:pending.rows[0].n}});
}));
app.put('/api/web-policy',requireAuth,requireRole('SUPER_ADMIN','ADMIN'),asyncH(async(req,res)=>{
 const b=z.object({scope:z.string().min(1).max(100).default('ALL'),enabled:z.boolean(),domains:z.array(z.string()).max(500),exceptionStaffIds:z.array(z.string().uuid()).max(1000).default([])}).parse(req.body||{});
 const scope=resolvePolicyScope(req.user,b.scope);await validatePolicyScopeAccess(req.user,scope);const domains=normalizeDomains(b.domains);
 if(b.enabled&&!domains.length)return res.status(400).json({ok:false,error:'Policy aktif membutuhkan minimal 1 domain valid'});
  if(b.exceptionStaffIds.length){const vr=await q(`SELECT id,office_id FROM staff WHERE id = ANY($1::uuid[]) AND active=true`,[b.exceptionStaffIds]);if(vr.rows.length!==b.exceptionStaffIds.length)return res.status(400).json({ok:false,error:'Ada staff pengecualian yang tidak valid/nonaktif'});if(scope.officeId&&vr.rows.some(x=>x.office_id!==scope.officeId))return res.status(400).json({ok:false,error:'Pengecualian staff harus dari kantor policy yang sama'});}
 const client=await pool.connect();let version;
 try{
  await client.query('BEGIN');
  const pr=await client.query(`INSERT INTO web_policies(scope_key,office_id,enabled,blocked_domains,version,updated_by,updated_at) VALUES($1,$2,$3,$4,1,$5,now()) ON CONFLICT(scope_key) DO UPDATE SET office_id=excluded.office_id,enabled=excluded.enabled,blocked_domains=excluded.blocked_domains,version=web_policies.version+1,updated_by=excluded.updated_by,updated_at=now() RETURNING version`,[scope.scopeKey,scope.officeId,b.enabled,JSON.stringify(domains),req.user.sub]);
  version=Number(pr.rows[0].version);
  await client.query('DELETE FROM web_policy_staff_exceptions WHERE scope_key=$1',[scope.scopeKey]);
  for(const sid of b.exceptionStaffIds)await client.query('INSERT INTO web_policy_staff_exceptions(scope_key,staff_id) VALUES($1,$2)',[scope.scopeKey,sid]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 const fanout=await fanoutWebPolicy({scopeKey:scope.scopeKey,officeId:scope.officeId,deviceId:scope.deviceId,enabled:b.enabled,domains,exceptionStaffIds:b.exceptionStaffIds,version,userId:req.user.sub});
 await audit(req,b.enabled?'WEB_POLICY_APPLY':'WEB_POLICY_UNLOCK',scope.scopeKey,{domains,exceptionStaffIds:b.exceptionStaffIds,version,fanout});
 io.emit('fleet.changed',{});res.json({ok:true,scopeKey:scope.scopeKey,version,domains,enabled:b.enabled,fanout});
}));
app.post('/api/web-policy/reapply',requireAuth,requireRole('SUPER_ADMIN','ADMIN'),asyncH(async(req,res)=>{
 const b=z.object({scope:z.string().min(1).max(100).default('ALL')}).parse(req.body||{});const snap=await policySnapshot(req.user,b.scope);const ids=snap.exceptions.map(x=>x.staff_id);const domains=normalizeDomains(snap.policy.blocked_domains||[]);
 const fanout=await fanoutWebPolicy({scopeKey:snap.scope.scopeKey,officeId:snap.scope.officeId,deviceId:snap.scope.deviceId||null,enabled:!!snap.policy.enabled,domains,exceptionStaffIds:ids,version:Number(snap.policy.version||0),userId:req.user.sub});
 await audit(req,'WEB_POLICY_REAPPLY',snap.scope.scopeKey,{fanout,version:Number(snap.policy.version||0)});res.json({ok:true,fanout});
}));

app.post('/api/devices/:id/command',requireAuth,requireRole('SUPER_ADMIN','ADMIN','SUPERVISOR'),asyncH(async(req,res)=>{const s=z.object({type:z.enum(['WARN','CLOSE_APP','SET_POLICY','BLOCK_DOMAIN','UNBLOCK_DOMAIN','BLOCK_DOMAINS','UNBLOCK_DOMAINS']),payload:z.record(z.string(),z.any()).default({})}).parse(req.body);const d=await q('SELECT office_id,name FROM devices WHERE id=$1',[req.params.id]);if(!d.rows[0])return res.status(404).json({ok:false,error:'Device not found'});if(!canOffice(req.user,d.rows[0].office_id))return res.status(403).json({ok:false,error:'Forbidden'});const c=await q('INSERT INTO commands(id,device_id,command_type,payload,created_by) VALUES(gen_random_uuid(),$1,$2,$3,$4) RETURNING *',[req.params.id,s.type,s.payload,req.user.sub]);await audit(req,'CREATE_COMMAND',d.rows[0].name,{type:s.type,payload:s.payload});res.json({ok:true,command:c.rows[0]});}));


app.post('/api/devices/:id/live/start',requireAuth,requireRole('SUPER_ADMIN','ADMIN','SUPERVISOR'),asyncH(async(req,res)=>{const d=await q('SELECT office_id,name,last_seen,user_last_seen FROM devices WHERE id=$1 AND disabled=false',[req.params.id]);if(!d.rows[0])return res.status(404).json({ok:false,error:'Device not found'});if(!canOffice(req.user,d.rows[0].office_id))return res.status(403).json({ok:false,error:'Forbidden'});if(!d.rows[0].user_last_seen||Date.now()-new Date(d.rows[0].user_last_seen).getTime()>150000)return res.status(409).json({ok:false,error:'User agent belum aktif. Login ke Windows atau reinstall/update agent v2.0.0.'});const sessionId=crypto.randomBytes(16).toString('hex');liveFrames.delete(req.params.id);await q(`INSERT INTO live_sessions(device_id,active,requested_by,updated_at,session_id,expires_at) VALUES($1,true,$2,now(),$3,now()+interval '10 minutes') ON CONFLICT(device_id) DO UPDATE SET active=true,requested_by=$2,updated_at=now(),session_id=$3,expires_at=now()+interval '10 minutes'`,[req.params.id,req.user.sub,sessionId]);await audit(req,'LIVE_VIEW_START',d.rows[0].name,{sessionId});res.json({ok:true,sessionId,expiresInSeconds:600});}));
app.post('/api/devices/:id/live/stop',requireAuth,requireRole('SUPER_ADMIN','ADMIN','SUPERVISOR'),asyncH(async(req,res)=>{const d=await q('SELECT office_id,name FROM devices WHERE id=$1',[req.params.id]);if(!d.rows[0])return res.status(404).json({ok:false,error:'Device not found'});if(!canOffice(req.user,d.rows[0].office_id))return res.status(403).json({ok:false,error:'Forbidden'});await q('UPDATE live_sessions SET active=false,session_id=NULL,expires_at=NULL,updated_at=now() WHERE device_id=$1',[req.params.id]);liveFrames.delete(req.params.id);await audit(req,'LIVE_VIEW_STOP',d.rows[0].name);res.json({ok:true});}));
app.get('/api/devices/:id/live/frame',requireAuth,requireRole('SUPER_ADMIN','ADMIN','SUPERVISOR'),asyncH(async(req,res)=>{const d=await q('SELECT office_id FROM devices WHERE id=$1',[req.params.id]);if(!d.rows[0])return res.status(404).json({ok:false,error:'Device not found'});if(!canOffice(req.user,d.rows[0].office_id))return res.status(403).json({ok:false,error:'Forbidden'});const st=await q('SELECT active,session_id,expires_at FROM live_sessions WHERE device_id=$1',[req.params.id]);const row=st.rows[0];const active=!!row?.active&&!!row?.session_id&&(!row.expires_at||new Date(row.expires_at).getTime()>Date.now());if(!active)return res.status(204).end();const f=liveFrames.get(req.params.id);if(!f||f.sessionId!==row.session_id||Date.now()-f.receivedAt>8000)return res.status(204).end();res.set('Cache-Control','no-store').json({ok:true,frame:f});}));
app.delete('/api/devices/:id',requireAuth,requireRole('SUPER_ADMIN'),asyncH(async(req,res)=>{
 const d=await q('SELECT * FROM devices WHERE id=$1',[req.params.id]);
 if(!d.rows[0])return res.status(404).json({ok:false,error:'Device not found'});
 const uid=d.rows[0].device_uid;
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query('INSERT INTO revoked_devices(device_uid,reason,revoked_at) VALUES($1,$2,now()) ON CONFLICT(device_uid) DO UPDATE SET revoked_at=now(),reason=excluded.reason',[uid,'Deleted from dashboard']);
  await client.query('UPDATE device_tokens SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL',[req.params.id]);
  await client.query('DELETE FROM devices WHERE id=$1',[req.params.id]);
  await client.query('COMMIT');
 }catch(e){try{await client.query('ROLLBACK')}catch{};throw e}finally{client.release()}
 liveFrames.delete(req.params.id);
 await audit(req,'DELETE_DEVICE_REVOKED',d.rows[0].name,{deviceUid:uid,reEnrollAllowed:false});
 io.emit('fleet.changed',{});
 res.json({ok:true,deviceUid:uid,reEnrollAllowed:false,revoked:true});
}));
app.post('/api/devices/:id/reallow',requireAuth,requireRole('SUPER_ADMIN'),asyncH(async(req,res)=>{const d=await q('SELECT * FROM devices WHERE id=$1',[req.params.id]);if(!d.rows[0])return res.status(404).json({ok:false,error:'Device not found'});await q('DELETE FROM revoked_devices WHERE device_uid=$1',[d.rows[0].device_uid]);await q('UPDATE devices SET disabled=false WHERE id=$1',[req.params.id]);await audit(req,'REALLOW_DEVICE',d.rows[0].name);res.json({ok:true});}));
app.get('/api/revoked-devices',requireAuth,requireRole('SUPER_ADMIN'),asyncH(async(req,res)=>{
 const r=await q('SELECT device_uid,reason,revoked_at FROM revoked_devices ORDER BY revoked_at DESC LIMIT 1000');
 res.set('Cache-Control','no-store').json({ok:true,items:r.rows});
}));
app.post('/api/revoked-devices/reallow',requireAuth,requireRole('SUPER_ADMIN'),asyncH(async(req,res)=>{const body=z.object({deviceUid:z.string().trim().min(8).max(200)}).parse(req.body||{});const r=await q('DELETE FROM revoked_devices WHERE device_uid=$1 RETURNING device_uid',[body.deviceUid]);await q('UPDATE devices SET disabled=false WHERE device_uid=$1',[body.deviceUid]);await audit(req,'REALLOW_DEVICE_UID',body.deviceUid,{found:!!r.rows[0]});io.emit('fleet.changed',{});res.json({ok:true,deviceUid:body.deviceUid,wasRevoked:!!r.rows[0]});}));

app.get('/api/staff',requireAuth,asyncH(async(req,res)=>{const params=[];let where='';if(req.user.role!=='SUPER_ADMIN'&&req.user.officeId){params.push(req.user.officeId);where='WHERE s.office_id=$1';}const r=await q(`SELECT s.*,o.name office_name,d.name department_name FROM staff s JOIN offices o ON o.id=s.office_id LEFT JOIN departments d ON d.id=s.department_id ${where} ORDER BY s.active DESC,s.name`,params);res.json({ok:true,items:r.rows});}));
app.post('/api/staff',requireAuth,requireRole('SUPER_ADMIN','ADMIN'),asyncH(async(req,res)=>{const s=z.object({staffCode:z.string().trim().min(1).max(80),name:z.string().trim().min(1).max(200),officeId:z.string().uuid(),departmentId:z.string().uuid().nullable().optional()}).parse(req.body);if(!canOffice(req.user,s.officeId))return res.status(403).json({ok:false,error:'Forbidden'});const r=await q('INSERT INTO staff(id,staff_code,name,office_id,department_id) VALUES(gen_random_uuid(),$1,$2,$3,$4) RETURNING *',[s.staffCode,s.name,s.officeId,s.departmentId||null]);await audit(req,'CREATE_STAFF',s.staffCode);res.json({ok:true,item:r.rows[0]});}));
app.patch('/api/staff/:id',requireAuth,requireRole('SUPER_ADMIN','ADMIN'),asyncH(async(req,res)=>{const s=z.object({staffCode:z.string().trim().min(1).max(80).optional(),name:z.string().trim().min(1).max(200).optional(),officeId:z.string().uuid().optional(),active:z.boolean().optional()}).parse(req.body);const old=await q('SELECT * FROM staff WHERE id=$1',[req.params.id]);if(!old.rows[0])return res.status(404).json({ok:false,error:'Staff tidak ditemukan'});const officeId=s.officeId??old.rows[0].office_id;if(!canOffice(req.user,officeId))return res.status(403).json({ok:false,error:'Forbidden'});const r=await q('UPDATE staff SET staff_code=COALESCE($1,staff_code),name=COALESCE($2,name),office_id=$3,active=COALESCE($4,active) WHERE id=$5 RETURNING *',[s.staffCode??null,s.name??null,officeId,s.active??null,req.params.id]);await audit(req,'UPDATE_STAFF',old.rows[0].staff_code,{after:r.rows[0]});res.json({ok:true,item:r.rows[0]});}));

app.get('/api/audit',requireAuth,requireRole('SUPER_ADMIN','ADMIN'),asyncH(async(req,res)=>{const r=await q('SELECT a.*,u.login_id,u.display_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 500');res.json({ok:true,items:r.rows});}));
app.get('/api/users',requireAuth,requireRole('SUPER_ADMIN'),asyncH(async(req,res)=>{const r=await q('SELECT u.id,u.login_id,u.display_name,u.role,u.office_id,u.active,u.created_at,u.last_login_at,o.name office_name FROM users u LEFT JOIN offices o ON o.id=u.office_id ORDER BY u.created_at');res.json({ok:true,items:r.rows});}));
app.post('/api/users',requireAuth,requireRole('SUPER_ADMIN'),asyncH(async(req,res)=>{const bcrypt=(await import('bcryptjs')).default;const s=z.object({loginId:z.string().min(3).max(100),password:z.string().min(8).max(200),displayName:z.string().min(1).max(200),role:z.enum(['SUPER_ADMIN','ADMIN','SUPERVISOR','VIEWER']),officeId:z.string().uuid().nullable().optional()}).parse(req.body);const hash=await bcrypt.hash(s.password,12);const r=await q('INSERT INTO users(id,login_id,password_hash,display_name,role,office_id) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5) RETURNING id,login_id,display_name,role,office_id,active,created_at',[s.loginId,hash,s.displayName,s.role,s.officeId||null]);await audit(req,'CREATE_USER',s.loginId,{role:s.role});res.json({ok:true,item:r.rows[0]});}));
app.post('/api/users/:id/reset-password',requireAuth,requireRole('SUPER_ADMIN'),asyncH(async(req,res)=>{
 const bcrypt=(await import('bcryptjs')).default;
 const id=z.string().uuid().parse(req.params.id);
 const body=z.object({password:z.string().min(10).max(200)}).parse(req.body||{});
 const target=await q('SELECT id,login_id,display_name,role FROM users WHERE id=$1',[id]);
 if(!target.rows[0])return res.status(404).json({ok:false,error:'Admin user tidak ditemukan'});
 const adminId=String(process.env.ADMIN_ID||'admin').trim();
 if(target.rows[0].login_id===adminId)return res.status(409).json({ok:false,error:'Password akun master dikelola dari Railway ENV ADMIN_PASSWORD'});
 const hash=await bcrypt.hash(body.password,12);
 await q('UPDATE users SET password_hash=$2 WHERE id=$1',[id,hash]);
 await audit(req,'RESET_USER_PASSWORD',target.rows[0].login_id,{role:target.rows[0].role});
 res.json({ok:true,message:'Password berhasil direset'});
}));
app.delete('/api/users/:id',requireAuth,requireRole('SUPER_ADMIN'),asyncH(async(req,res)=>{
 const id=z.string().uuid().parse(req.params.id);
 const target=await q('SELECT id,login_id,display_name,role FROM users WHERE id=$1',[id]);
 if(!target.rows[0])return res.status(404).json({ok:false,error:'Admin user tidak ditemukan'});
 const adminId=String(process.env.ADMIN_ID||'admin').trim();
 if(target.rows[0].login_id===adminId)return res.status(409).json({ok:false,error:'Akun master Railway tidak dapat dihapus dari dashboard'});
 if(String(req.user?.sub||'')===id)return res.status(409).json({ok:false,error:'Tidak dapat menghapus akun yang sedang digunakan'});
 await q('DELETE FROM users WHERE id=$1',[id]);
 await audit(req,'DELETE_USER',target.rows[0].login_id,{role:target.rows[0].role,displayName:target.rows[0].display_name});
 res.json({ok:true,message:'Admin user berhasil dihapus'});
}));


io.on('connection',socket=>{socket.on('watchDevice',id=>{if(typeof id==='string')socket.join(`device:${id}`);});socket.on('unwatchDevice',id=>{if(typeof id==='string')socket.leave(`device:${id}`);});});
setInterval(async()=>{try{const r=await q("UPDATE devices SET status='OFFLINE',current_app=NULL,current_title=NULL WHERE COALESCE(user_last_seen,last_seen)<now()-interval '180 seconds' AND (system_last_seen IS NULL OR system_last_seen<now()-interval '180 seconds') AND status<>'OFFLINE' RETURNING id");if(r.rowCount)io.emit('fleet.changed',{offline:r.rowCount});}catch(e){console.error('offline sweep',e.message)}},30000).unref();
setInterval(async()=>{try{const days=Math.max(7,Number(process.env.RAW_RETENTION_DAYS||90));await q(`DELETE FROM activity_events WHERE occurred_at < now() - ($1 || ' days')::interval`,[days]);}catch(e){console.error('retention sweep',e.message)}},6*60*60*1000).unref();
function friendlyDbError(err){
 const code=String(err?.code||'');
 if(code==='23505')return {status:409,message:'Data sudah digunakan / duplikat'};
 if(code==='23503')return {status:409,message:'Data masih dipakai oleh data lain. Ubah relasinya terlebih dahulu.'};
 if(code==='23502')return {status:400,message:'Ada data wajib yang belum terisi. Database lama akan diperbaiki otomatis saat deploy.'};
 if(code==='22P02')return {status:400,message:'Format data database tidak sesuai. Aplikasi sudah menormalkan input; jika pesan ini tetap muncul setelah redeploy, cek log detail PostgreSQL.'};
 if(code==='42501')return {status:500,message:'Database menolak izin penulisan. Periksa user DATABASE_URL Railway.'};
 if(code==='42P01'||code==='42703')return {status:500,message:'Schema database belum sesuai versi aplikasi. Redeploy agar migration self-repair dijalankan.'};
 return null;
}
app.use((err,req,res,next)=>{
 console.error('[API ERROR]',req.method,req.originalUrl,{message:err?.message,code:err?.code,detail:err?.detail,constraint:err?.constraint});
 if(err?.name==='ZodError')return res.status(400).json({ok:false,error:'Data input belum valid',detail:err.issues});
 const db=friendlyDbError(err);if(db)return res.status(db.status).json({ok:false,error:db.message,code:err?.code||null});
 res.status(err?.statusCode||500).json({ok:false,error:err?.statusCode?err.message:'Server gagal menyimpan data. Silakan ulangi; detail error sudah dicatat di Railway log.',code:err?.code||null});
});
const port=Number(process.env.PORT||8080);server.listen(port,'0.0.0.0',()=>console.log(`Staff Monitor listening on :${port}`));
process.on('SIGTERM',async()=>{server.close();await pool.end();process.exit(0)});
