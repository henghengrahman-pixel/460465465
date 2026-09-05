import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf){
  let bits=0,value=0,out='';
  for(const byte of buf){
    value=(value<<8)|byte;bits+=8;
    while(bits>=5){out+=ALPHABET[(value>>>(bits-5))&31];bits-=5;}
  }
  if(bits>0)out+=ALPHABET[(value<<(5-bits))&31];
  return out;
}
function base32Decode(input){
  const s=String(input||'').toUpperCase().replace(/[^A-Z2-7]/g,'');
  if(s.length<16)throw new Error('TOTP secret tidak valid');
  let bits=0,value=0;const bytes=[];
  for(const ch of s){
    const n=ALPHABET.indexOf(ch);if(n<0)throw new Error('TOTP secret tidak valid');
    value=(value<<5)|n;bits+=5;
    if(bits>=8){bytes.push((value>>>(bits-8))&255);bits-=8;}
  }
  return Buffer.from(bytes);
}
function hotp(secret,counter,digits=6){
  const key=base32Decode(secret);const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(counter));
  const h=crypto.createHmac('sha1',key).update(b).digest();const off=h[h.length-1]&15;
  const n=((h[off]&0x7f)<<24)|((h[off+1]&0xff)<<16)|((h[off+2]&0xff)<<8)|(h[off+3]&0xff);
  return String(n%(10**digits)).padStart(digits,'0');
}
export function verifyTotp(secret,code,{window=1,step=30,now=Date.now()}={}){
  const clean=String(code||'').replace(/\s+/g,'');if(!/^\d{6}$/.test(clean))return false;
  const counter=Math.floor(now/1000/step);
  for(let i=-window;i<=window;i++){
    const expected=hotp(secret,counter+i);
    const a=Buffer.from(clean),b=Buffer.from(expected);
    if(a.length===b.length&&crypto.timingSafeEqual(a,b))return true;
  }
  return false;
}
function boolEnv(name,defaultValue){
  const v=process.env[name];if(v==null||v==='')return defaultValue;
  return !['0','false','no','off'].includes(String(v).toLowerCase());
}
function safeDataDir(){
  const requested=process.env.DATA_DIR||'/data';
  for(const dir of [requested,path.join(process.cwd(),'.data')]){
    try{fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.accessSync(dir,fs.constants.R_OK|fs.constants.W_OK);return dir;}catch{}
  }
  throw new Error('DATA_DIR tidak dapat ditulis');
}
function stateFile(){return path.join(safeDataDir(),'admin-2fa.json');}
function readState(){
  try{return JSON.parse(fs.readFileSync(stateFile(),'utf8'));}catch{return null;}
}
function writeState(state){
  const file=stateFile(),tmp=file+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(state,null,2),{mode:0o600});
  fs.renameSync(tmp,file);try{fs.chmodSync(file,0o600);}catch{}
}
function normalizeSecret(s){return String(s||'').toUpperCase().replace(/[^A-Z2-7]/g,'');}
export function getTwoFactorConfig(){
  const enabled=boolEnv('ADMIN_2FA_ENABLED',true);
  if(!enabled)return {enabled:false,configured:false,source:'disabled'};
  const envSecret=normalizeSecret(process.env.ADMIN_2FA_SECRET);
  if(envSecret){base32Decode(envSecret);return {enabled:true,configured:true,secret:envSecret,source:'env'};}
  let state=readState();
  if(!state?.secret){
    state={version:1,secret:base32Encode(crypto.randomBytes(20)),confirmed:false,createdAt:new Date().toISOString()};writeState(state);
  }
  const secret=normalizeSecret(state.secret);base32Decode(secret);
  return {enabled:true,configured:!!state.confirmed,secret,source:'data-dir'};
}
export function confirmDataDirTwoFactor(secret){
  const cfg=getTwoFactorConfig();
  if(cfg.source!=='data-dir')return;
  if(normalizeSecret(secret)!==cfg.secret)throw new Error('Secret 2FA berubah selama proses setup');
  const state=readState()||{};state.secret=cfg.secret;state.confirmed=true;state.confirmedAt=new Date().toISOString();writeState(state);
}
export function makeOtpAuthUri({secret,account,issuer='Staff Management'}){
  const label=`${issuer}:${account}`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
