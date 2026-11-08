import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeCompatibleBaseURL, providerDefinitions } from './providers.mjs';
const ps=join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
function dpapi(script,input) {
  try {return execFileSync(ps,['-NoProfile','-NonInteractive','-Command',script],{input,encoding:'utf8',windowsHide:true,env:{...process.env,PSModulePath:join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/Modules')},stdio:['pipe','pipe','pipe']}).trim();}
  catch {throw Error('Windows 本机密钥加密操作失败，请检查当前账户权限');}
}
const protect=value=>dpapi("[void][Reflection.Assembly]::LoadWithPartialName('System.Security'); $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))",value);
const unprotect=value=>dpapi("[void][Reflection.Assembly]::LoadWithPartialName('System.Security'); $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))",value);
export function saveKey(dir,key) {
  if(!/^sk-[a-zA-Z0-9_-]{12,200}$/.test(key)) throw Error('API 密钥格式无效');
  mkdirSync(dir,{recursive:true});
  if(process.platform==='win32') {
    writeFileSync(join(dir,'secret.dpapi'),protect(key),{mode:0o600});
  } else writeFileSync(join(dir,'secret.key'),key,{mode:0o600});
}
export function loadKey(dir) {
  if(process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  if(process.platform==='win32'&&existsSync(join(dir,'secret.dpapi'))) {
    return unprotect(readFileSync(join(dir,'secret.dpapi'),'utf8'));
  }
  return existsSync(join(dir,'secret.key'))?readFileSync(join(dir,'secret.key'),'utf8').trim():'';
}

function providerKeyPath(dir,provider,baseURL) {
  if(!Object.hasOwn(providerDefinitions,provider)||['harness','deepseek'].includes(provider))throw Error('API 提供商无效');
  const suffix=provider==='compatible'?'-'+createHash('sha256').update(normalizeCompatibleBaseURL(baseURL)).digest('hex'):'';
  return join(dir,'provider-keys',provider+suffix+(process.platform==='win32'?'.dpapi':'.key'));
}

export function saveProviderKey(dir,provider,key,baseURL) {
  if(provider==='deepseek')return saveKey(dir,key);
  if(typeof key!=='string'||!/^[\x21-\x7e]{12,512}$/.test(key))throw Error('API 密钥格式无效');
  const path=providerKeyPath(dir,provider,baseURL);
  mkdirSync(join(dir,'provider-keys'),{recursive:true,mode:0o700});
  const stored=process.platform==='win32'?protect(key):key;
  writeFileSync(path+'.tmp',stored,{mode:0o600});
  renameSync(path+'.tmp',path);
}

export function loadProviderKey(dir,provider,baseURL) {
  if(provider==='harness'||provider==='deepseek')return loadKey(dir);
  const path=providerKeyPath(dir,provider,baseURL);
  if(!existsSync(path))return '';
  const stored=readFileSync(path,'utf8').trim();
  return process.platform==='win32'?unprotect(stored):stored;
}
