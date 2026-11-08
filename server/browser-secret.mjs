import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const filename='playwright-extension.dpapi';
export function normalizeBrowserToken(value){
  const token=String(value||'').trim().replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*/,'');
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error('请粘贴微软扩展页面提供的完整连接令牌');
  return token;
}
function protect(value,decrypt=false){
  if(process.platform!=='win32')throw Error('浏览器连接令牌仅支持当前Windows账户加密保存');
  const code=decrypt?"$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))":"$b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd());[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
  try{return execFileSync(join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',"Add-Type -AssemblyName System.Security;"+code],{input:value,encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PSModulePath:join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/Modules')}}).trim();}
  catch{throw Error('浏览器连接令牌加密操作失败');}
}
export function browserTokenConfigured(dir){return existsSync(join(dir,filename));}
export function saveBrowserToken(dir,value){
  const token=normalizeBrowserToken(value),encrypted=protect(token);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,filename),encrypted,{mode:0o600});
}
export function loadBrowserToken(dir){return browserTokenConfigured(dir)?normalizeBrowserToken(protect(readFileSync(join(dir,filename),'utf8'),true)):'';}
export function clearBrowserToken(dir){rmSync(join(dir,filename),{force:true});}
