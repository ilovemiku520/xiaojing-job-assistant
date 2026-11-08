import {execFile,spawn} from 'node:child_process';
import {createWriteStream,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {lstat,mkdir,mkdtemp,readFile,realpath,rename,rm,stat,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {promisify} from 'node:util';

const metadataURL='https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const legacyOrigin='http://127.0.0.1:17321';
const desktopOrigin='http://127.0.0.1:17322';
const bossURL='https://www.zhipin.com/web/geek/chat';
const maxArchiveBytes=400*1024*1024;
const versionPattern=/^\d{2,4}(?:\.\d{1,7}){3}$/;
const repairID=/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
const repairPrefix=version=>version+'-repair-';
const extensionFiles=['background.js','content.js','favorites.js','popup.css','popup.html','popup.js','position-link.js','realtime.js','resume-ui.js'];
const runFile=promisify(execFile);

export function stableWin64Chrome(metadata){
  const stable=metadata?.channels?.Stable,version=stable?.version;
  if(typeof version!=='string'||!versionPattern.test(version))throw Error('无法从 Google 的官方列表确认 Chrome 版本');
  const url=`https://storage.googleapis.com/chrome-for-testing-public/${version}/win64/chrome-win64.zip`;
  if(!Array.isArray(stable.downloads?.chrome)||!stable.downloads.chrome.some(item=>item?.platform==='win64'&&item.url===url))throw Error('Google 的官方列表未提供可验证的 Windows 64 位下载地址');
  return {version,url};
}

async function runPowerShell(script,variables){
  const systemRoot=process.env.SystemRoot||'C:/Windows';
  const exe=join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  await runFile(exe,['-NoProfile','-NonInteractive','-Command',script],{
    windowsHide:true,timeout:180000,env:{...process.env,PSModulePath:join(systemRoot,'System32','WindowsPowerShell','v1.0','Modules'),...variables}
  });
}

async function checkGoogleSignature(exe){
  try{
    await runPowerShell(`$ErrorActionPreference='Stop'; $signature=Get-AuthenticodeSignature -LiteralPath $env:XIAOJING_CHROME_EXE; if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.GetNameInfo('SimpleName',$false) -ne 'Google LLC') { exit 24 }`,{XIAOJING_CHROME_EXE:exe});
  }catch{throw Error('Chrome 浏览器的 Google 签名验证未通过');}
}

async function unzip(archive,destination){
  try{
    await runPowerShell(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:XIAOJING_CHROME_ARCHIVE,$env:XIAOJING_CHROME_DEST)`,{XIAOJING_CHROME_ARCHIVE:archive,XIAOJING_CHROME_DEST:destination});
  }catch{throw Error('Chrome 下载包无法解压');}
}

async function isFile(file){return (await stat(file,{throwIfNoEntry:false}).catch(()=>undefined))?.isFile()===true;}
async function existingEntry(path){
  try{return await lstat(path);}catch(error){if(error.code!=='ENOENT')throw error;return undefined;}
}

async function writeAtomic(file,content){
  const temp=file+'.'+randomUUID()+'.tmp';
  try{await writeFile(temp,content,{flag:'wx',mode:0o600});await rename(temp,file);}finally{await rm(temp,{force:true});}
}

async function download(url,file,fetcher){
  const signal=AbortSignal.timeout(15*60000);
  const response=await fetcher(url,{redirect:'error',signal});
  if(!response.ok||!response.body||Number(response.headers.get('content-length'))>maxArchiveBytes)throw Error('无法从 Google 下载 Chrome 浏览器');
  let bytes=0;
  const cap=new Transform({transform(chunk,encoding,done){
    bytes+=chunk.length;
    if(bytes>maxArchiveBytes){done(Error('Chrome 下载包超过大小限制'));return;}
    done(null,chunk);
  }});
  await pipeline(Readable.fromWeb(response.body),cap,createWriteStream(file,{flags:'wx',mode:0o600}),{signal});
}

async function startBrowser(exe,args){
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/(?:API_KEY|TOKEN|SECRET|PASSWORD|ELECTRON_RUN_AS_NODE)/i.test(name)));
  const child=spawn(exe,args,{stdio:'ignore',detached:true,env});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();
}

const defaults={fetcher:fetch,checkGoogleSignature,unzip,startBrowser};
export function createBrowserSetup({runtimeDir,extensionDir,serviceOrigin=desktopOrigin,issuePairingCode,onProgress=()=>{}},dependencies=defaults){
  if(typeof serviceOrigin!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(serviceOrigin)||Number(serviceOrigin.split(':').at(-1))>65535){
    throw Error('桌面浏览器只连接带有效端口的 127.0.0.1 HTTP 服务');
  }
  const managedExtension=resolve(runtimeDir,'browser-extension'),profilePath=resolve(runtimeDir,'managed-browser-profile');
  const versions=resolve(runtimeDir,'managed-chrome'),record=join(versions,'installed.json');
  const {fetcher,checkGoogleSignature,unzip,startBrowser}={...defaults,...dependencies};
  let inProgress;

  async function stageExtension(extensionPath){
    await mkdir(extensionPath,{recursive:true,mode:0o700});
    // The standalone extension still talks to the original local service.
    // Retarget only the isolated desktop copy, including host permissions.
    const retarget=async file=>(await readFile(file,'utf8')).replaceAll(legacyOrigin,serviceOrigin);
    const manifest=JSON.parse(await retarget(join(extensionDir,'manifest.json')));
    for(const filename of extensionFiles){
      await writeAtomic(join(extensionPath,filename),await retarget(join(extensionDir,filename)));
    }
    await writeAtomic(join(extensionPath,'desktop-background.js'),await retarget(new URL('./extension-pairing.js',import.meta.url)));
    manifest.background={service_worker:'desktop-background.js'};
    await writeAtomic(join(extensionPath,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    return extensionPath;
  }

  async function preparePairing(){
    const {code,expiresAt,activate,assertReady}=await issuePairingCode();
    if(typeof code!=='string'||!/^[a-f0-9]{64}$/.test(code)||!Number.isFinite(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+125000||activate!==undefined&&typeof activate!=='function'||assertReady!==undefined&&typeof assertReady!=='function')throw Error('本地服务未返回有效的配对请求');
    return {code,expiresAt,activate,assertReady};
  }

  function publishPairing(extensionPath,{code,expiresAt,activate,assertReady}){
    if(expiresAt<=Date.now())throw Error('本次浏览器配对已过期，请重新打开外部浏览器');
    assertReady?.();
    const content=JSON.stringify({code,expiresAt});
    const challenge=join(extensionPath,'desktop-pairing.json');
    const temp=challenge+'.'+randomUUID()+'.tmp';
    try{writeFileSync(temp,content,{flag:'wx',mode:0o600});renameSync(temp,challenge);}finally{rmSync(temp,{force:true});}
    // Register the published challenge in the same turn. The current browser
    // remains active until an extension successfully redeems it.
    try{activate?.();}catch(error){rmSync(challenge,{force:true});throw error;}
    // A new launch may replace this file before the old code expires.
    setTimeout(()=>{
      try{if(readFileSync(challenge,'utf8')===content)rmSync(challenge,{force:true});}catch{}
    },Math.max(0,expiresAt-Date.now())+1000).unref();
    return expiresAt;
  }

  const executable=slot=>join(versions,slot,'chrome-win64','chrome.exe');
  async function ownsVersions(){
    return (await existingEntry(versions))?.isDirectory()===true&&
      await realpath(versions)===join(await realpath(runtimeDir),'managed-chrome');
  }
  async function readInstalled(){
    try{
      if(!await ownsVersions()||!(await lstat(record)).isFile())return null;
      const {version,slot=version}=JSON.parse(await readFile(record,'utf8'));
      if(typeof version!=='string'||!versionPattern.test(version))return null;
      const prefix=repairPrefix(version);
      if(slot!==version&&(typeof slot!=='string'||!slot.startsWith(prefix)||!repairID.test(slot.slice(prefix.length))))return null;
      return {version,slot};
    }catch{return null;}
  }
  async function cachedChrome(installation){
    if(!installation)return null;
    const {version,slot}=installation,exe=executable(slot);
    try{
      if(!await ownsVersions()||!(await lstat(join(versions,slot))).isDirectory()||!(await lstat(join(versions,slot,'chrome-win64'))).isDirectory()||!(await lstat(exe)).isFile())return null;
      await checkGoogleSignature(exe);
      return {version,slot,exe};
    }catch{return null;}
  }
  const saveInstalled=(version,slot)=>writeAtomic(record,JSON.stringify(slot===version?{version}:{version,slot})+'\n');
  async function getChrome(){
    onProgress('正在查询 Chrome for Testing 稳定版');
    const installed=await readInstalled();
    let release;
    try{
      const response=await fetcher(metadataURL,{redirect:'error',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error('暂时无法连接 Google 下载服务');
      const json=await response.text();
      if(json.length>1000000)throw Error('Chrome 下载列表过大');
      release=stableWin64Chrome(JSON.parse(json));
    }catch{
      const cached=await cachedChrome(installed);if(cached)return cached;
      throw Error('无法从 Google 获取 Chrome 安装信息，可改用已安装的 Edge 或 Chrome');
    }
    await mkdir(versions,{recursive:true,mode:0o700});
    if(!await ownsVersions())throw Error('专用 Chrome 缓存目录已变化，可改用已安装的 Edge 或 Chrome');
    const {version,url}=release;
    if(installed?.version===version){
      const cached=await cachedChrome(installed);
      if(cached)return cached;
    }
    if(installed?.slot!==version){
      const canonical=await cachedChrome({version,slot:version});
      if(canonical){await saveInstalled(version,version);return canonical;}
    }
    const stage=await mkdtemp(join(versions,'.download-'));
    let slot=version;
    try{
      const archive=join(stage,'chrome.zip'),unpacked=join(stage,'unpacked');
      onProgress(`正在下载 Google Chrome for Testing ${version}`);
      await download(url,archive,fetcher);
      onProgress('正在解压并验证 Google 签名');
      await unzip(archive,unpacked);
      const stagedBrowser=join(unpacked,'chrome-win64'),stagedExe=join(stagedBrowser,'chrome.exe');
      if(!(await existingEntry(unpacked))?.isDirectory()||
        !(await existingEntry(stagedBrowser))?.isDirectory()||
        !(await existingEntry(stagedExe))?.isFile())throw Error('Chrome 下载包缺少浏览器程序');
      await checkGoogleSignature(stagedExe);
      // A damaged or running cache may be locked. Keep it intact and switch the
      // record only after the verified browser is in its own version directory.
      if(await existingEntry(join(versions,version)))slot=repairPrefix(version)+randomUUID();
      await rename(unpacked,join(versions,slot));
      await saveInstalled(version,slot);
    }finally{await rm(stage,{recursive:true,force:true});}
    return {version,slot,exe:executable(slot)};
  }

  async function exclusive(work){
    if(inProgress)throw Error('浏览器正在设置，请等待当前操作完成');
    inProgress=work();
    try{return await inProgress;}finally{inProgress=undefined;}
  }

  return {
    prepare:()=>exclusive(()=>stageExtension(managedExtension)),
    launch:()=>exclusive(async()=>{
      if(process.platform!=='win32'||!['x64','arm64'].includes(process.arch))throw Error('一键安装适用于 Windows 64 位，可改用手动扩展安装');
      const {version,exe}=await getChrome();
      const pairing=await preparePairing();
      const extensionPath=await stageExtension(managedExtension);
      await mkdir(profilePath,{recursive:true,mode:0o700});
      pairing.assertReady?.();
      onProgress('正在打开专用浏览器，请登录 BOSS 直聘');
      try{await startBrowser(exe,[`--user-data-dir=${profilePath}`,`--load-extension=${extensionPath}`,'--no-first-run','--no-default-browser-check','--new-window',bossURL]);}
      catch{throw Error('Chrome 已准备好，但未能启动，请尝试已安装的 Edge 或 Chrome');}
      return {browser:'managed',version,extensionPath,profilePath,pairingExpiresAt:publishPairing(extensionPath,pairing)};
    }),
    openFallback:browser=>exclusive(async()=>{
      if(process.platform!=='win32'||!['edge','chrome'].includes(browser))throw Error('请选择 Windows 上已安装的 Edge 或 Chrome');
      const relative=browser==='edge'?['Microsoft','Edge','Application','msedge.exe']:['Google','Chrome','Application','chrome.exe'];
      const installs=[process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.LocalAppData].filter(Boolean);
      let exe;
      for(const dir of installs){const path=join(dir,...relative);if(await isFile(path)){exe=path;break;}}
      if(!exe)throw Error(browser==='edge'?'未找到已安装的 Microsoft Edge':'未找到已安装的 Google Chrome');
      const pairing=await preparePairing();
      const extensionPath=await stageExtension(resolve(runtimeDir,`${browser}-extension`));
      pairing.assertReady?.();
      try{await startBrowser(exe,[browser==='edge'?'edge://extensions/':'chrome://extensions/']);}
      catch{throw Error('无法打开浏览器的扩展管理页');}
      return {browser,extensionPath,pairingExpiresAt:publishPairing(extensionPath,pairing)};
    })
  };
}
