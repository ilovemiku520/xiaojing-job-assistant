import {spawnSync} from 'node:child_process';
import {readFileSync,statSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const {version}=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const exe=resolve(process.argv[2]||join(root,'output','desktop',`Xiaojing-Desktop-${version}-Windows-x64`,'Xiaojing.exe'));
const resources=join(dirname(exe),'resources','app');
if(!statSync(exe,{throwIfNoEntry:false})?.isFile()||!statSync(join(resources,'package.json'),{throwIfNoEntry:false})?.isFile()){
  throw Error('找不到完整的桌面便携包，请先构建或传入已解压的 Xiaojing.exe 路径');
}

const native=['desktop-app','desktop-embedded-layout','desktop-embedded-browser','desktop-external-pair-browser','desktop-job-export','desktop-inbox-handoff','desktop-workbook-quit'];
const adapter=['content-workflow-browser','resume-prior-card-browser','resume-chooser-race-browser','late-reply-receipt-browser','control-reply-recovery-browser','mcp-settings-race-browser'];
for(const [target,suites] of [[exe,native],[resources,adapter]]){
  for(const name of suites){
    console.log(`\n${name}`);
    const result=spawnSync(process.execPath,[join(root,'tests',name+'.mjs'),target],{cwd:root,stdio:'inherit',windowsHide:true,timeout:180000});
    if(result.error)throw result.error;
    if(result.status!==0)process.exit(result.status??1);
  }
}
