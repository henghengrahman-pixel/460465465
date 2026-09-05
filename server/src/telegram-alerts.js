import crypto from 'crypto';
import { q } from './db.js';

const DEFAULT_WATCH=['youtube.com','facebook.com','tiktok.com','instagram.com'];
const SITE_ALIASES=[
  ['youtube.com',/\byoutube\b/i],['facebook.com',/\bfacebook\b|\bfb\.com\b/i],
  ['tiktok.com',/\btiktok\b/i],['instagram.com',/\binstagram\b/i]
];
const locks=new Map();

function keyMaterial(){
  const raw=String(process.env.TELEGRAM_CONFIG_KEY||process.env.JWT_SECRET||'');
  if(raw.length<16) throw new Error('TELEGRAM_CONFIG_KEY atau JWT_SECRET minimal 16 karakter wajib diatur');
  return crypto.createHash('sha256').update(raw).digest();
}
export function encryptSecret(value){
  const iv=crypto.randomBytes(12), key=keyMaterial();
  const c=crypto.createCipheriv('aes-256-gcm',key,iv);
  const enc=Buffer.concat([c.update(String(value),'utf8'),c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
export function decryptSecret(value){
  const [ver,ivb,tagb,datab]=String(value||'').split(':');
  if(ver!=='v1'||!ivb||!tagb||!datab) throw new Error('Konfigurasi bot token tidak valid');
  const d=crypto.createDecipheriv('aes-256-gcm',keyMaterial(),Buffer.from(ivb,'base64'));
  d.setAuthTag(Buffer.from(tagb,'base64'));
  return Buffer.concat([d.update(Buffer.from(datab,'base64')),d.final()]).toString('utf8');
}
export function normalizeDomain(raw){
  let v=String(raw||'').trim().toLowerCase();
  if(!v)return '';
  try{if(/^https?:\/\//i.test(v))v=new URL(v).hostname.toLowerCase();}catch{}
  v=v.replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0].split(':')[0].replace(/\.+$/,'');
  return /^[a-z0-9.-]+\.[a-z]{2,63}$/.test(v)?v:'';
}
export function detectWatchedDomain({domain,url,title='',app=''},watchDomains=DEFAULT_WATCH){
  const normalizedWatch=[...new Set((watchDomains||[]).map(normalizeDomain).filter(Boolean))];
  const explicit=normalizeDomain(domain||url);
  if(explicit){
    const hit=normalizedWatch.find(w=>explicit===w||explicit.endsWith('.'+w));
    if(hit)return hit;
  }
  const text=`${title||''} ${app||''}`;
  for(const [site,re] of SITE_ALIASES){
    if(normalizedWatch.includes(site)&&re.test(text))return site;
  }
  for(const w of normalizedWatch){
    if(text.toLowerCase().includes(w))return w;
  }
  return '';
}
function escHtml(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function fmtWib(ts){
  return new Intl.DateTimeFormat('id-ID',{timeZone:'Asia/Jakarta',dateStyle:'medium',timeStyle:'medium'}).format(new Date(ts||Date.now()));
}
async function sendTelegram(token,chatId,text){
  const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(),9000);
  try{
    const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',signal:ctl.signal,headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text,parse_mode:'HTML',disable_web_page_preview:true})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.ok)throw new Error(j.description||`Telegram HTTP ${r.status}`);
    return j.result;
  }finally{clearTimeout(t);}
}
export async function getOfficeTelegramConfig(officeId){
  const r=await q(`SELECT office_id,enabled,bot_token_enc,chat_id,cooldown_seconds,watch_domains,updated_at FROM office_telegram_configs WHERE office_id=$1`,[officeId]);
  const row=r.rows[0];
  if(!row)return {office_id:officeId,enabled:false,chat_id:'',cooldown_seconds:600,watch_domains:DEFAULT_WATCH,has_bot_token:false,updated_at:null};
  return {...row,watch_domains:Array.isArray(row.watch_domains)?row.watch_domains:DEFAULT_WATCH,has_bot_token:!!row.bot_token_enc,bot_token_enc:undefined};
}
export async function processTelegramActivity({deviceId,domain,url,title,app,occurredAt}){
  if(!deviceId)return;
  const lockKey=String(deviceId);
  if(locks.get(lockKey))return;
  locks.set(lockKey,true);
  try{
    const r=await q(`SELECT d.id,d.name,d.office_id,o.name office_name,c.enabled,c.bot_token_enc,c.chat_id,c.cooldown_seconds,c.watch_domains,
      COALESCE(json_agg(json_build_object('shift',a.shift,'name',s.name,'code',s.staff_code) ORDER BY a.shift) FILTER (WHERE s.id IS NOT NULL),'[]'::json) staff
      FROM devices d LEFT JOIN offices o ON o.id=d.office_id LEFT JOIN office_telegram_configs c ON c.office_id=d.office_id
      LEFT JOIN device_shift_assignments a ON a.device_id=d.id LEFT JOIN staff s ON s.id=a.staff_id
      WHERE d.id=$1 GROUP BY d.id,o.name,c.enabled,c.bot_token_enc,c.chat_id,c.cooldown_seconds,c.watch_domains`,[deviceId]);
    const x=r.rows[0];
    if(!x?.office_id||!x.enabled||!x.bot_token_enc||!x.chat_id)return;
    const watch=Array.isArray(x.watch_domains)&&x.watch_domains.length?x.watch_domains:DEFAULT_WATCH;
    const hit=detectWatchedDomain({domain,url,title,app},watch); if(!hit)return;
    const cooldown=Math.min(86400,Math.max(60,Number(x.cooldown_seconds||600)));
    const inserted=await q(`INSERT INTO telegram_alert_events(office_id,device_id,domain,app_name,window_title,occurred_at,status)
      SELECT $1,$2,$3,$4,$5,$6,'PENDING'
      WHERE NOT EXISTS(SELECT 1 FROM telegram_alert_events WHERE device_id=$2 AND domain=$3 AND occurred_at>now()-($7||' seconds')::interval)
      RETURNING id`,[x.office_id,deviceId,hit,app||null,title||null,occurredAt||new Date().toISOString(),String(cooldown)]);
    if(!inserted.rows[0])return;
    const eventId=inserted.rows[0].id;
    const staff=(x.staff||[]).map(s=>`${s.shift}: ${s.code||'-'} - ${s.name||'-'}`).join('\n')||'Belum diassign';
    const text=`⚠️ <b>AKTIVITAS WEB TERDETEKSI</b>\n\n<b>Kantor:</b> ${escHtml(x.office_name||'-')}\n<b>PC:</b> ${escHtml(x.name||'-')}\n<b>Staff:</b> ${escHtml(staff)}\n<b>Aplikasi:</b> ${escHtml(app||'-')}\n<b>Website:</b> ${escHtml(hit)}\n<b>Window:</b> ${escHtml(title||'-')}\n<b>Waktu:</b> ${escHtml(fmtWib(occurredAt))}`;
    try{
      const result=await sendTelegram(decryptSecret(x.bot_token_enc),x.chat_id,text);
      await q(`UPDATE telegram_alert_events SET status='SENT',sent_at=now(),telegram_message_id=$1 WHERE id=$2`,[String(result?.message_id||''),eventId]);
    }catch(e){
      await q(`UPDATE telegram_alert_events SET status='FAILED',error=$1 WHERE id=$2`,[String(e.message||e).slice(0,1000),eventId]);
      console.error('[TELEGRAM ALERT]',x.office_name||x.office_id,e.message);
    }
  }finally{locks.delete(lockKey);}
}
export async function testOfficeTelegram(officeId){
  const r=await q(`SELECT o.name,c.* FROM offices o LEFT JOIN office_telegram_configs c ON c.office_id=o.id WHERE o.id=$1`,[officeId]);
  const x=r.rows[0]; if(!x)throw Object.assign(new Error('Kantor tidak ditemukan'),{statusCode:404});
  if(!x.bot_token_enc||!x.chat_id)throw Object.assign(new Error('Bot Token dan Chat/Group ID belum disimpan'),{statusCode:400});
  const msg=`✅ <b>TEST STAFF MONITOR 8008</b>\n\nNotifikasi Telegram untuk <b>${escHtml(x.name)}</b> berhasil terhubung.\nWaktu: ${escHtml(fmtWib())}`;
  return sendTelegram(decryptSecret(x.bot_token_enc),x.chat_id,msg);
}
export { DEFAULT_WATCH };
