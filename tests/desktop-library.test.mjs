import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {once} from 'node:events';
import {createApplication} from '../server/app.mjs';
import {createOwnerLibrary, ownerLibraryContext} from '../server/library.mjs';
import {defaults, generationInput} from '../server/core.mjs';
import {testPort} from './port.mjs';

test('桌面资料库按相关词检索、去重，并将文件内容与人格规则分开', () => {
  const directory = mkdtempSync(join(tmpdir(),'boss-library-'));
  const library = createOwnerLibrary(directory);
  assert.deepEqual(library.state(),{persona:'',rules:'',documents:[],resume:null});
  library.setPersona({persona:'表达简洁',rules:'先说明求职目标'});
  assert.equal(library.importDocument({name:'系统策划.md',text:'设计技能连携和战斗节奏。'}).importStatus,'added');
  assert.equal(library.importDocument({name:'副本.txt',text:'设计技能连携和战斗节奏。'}).importStatus,'duplicate');
  library.importDocument({name:'写作技巧.txt',text:'如何写简短的介绍。'});
  assert.equal(library.state().documents.length,2);
  assert.equal(Object.hasOwn(library.state(),'importStatus'),false);
  assert(!Object.hasOwn(library.state().documents[0],'content'));
  const sources = ownerLibraryContext(directory,'系统策划和战斗节奏');
  const input = generationInput(defaults,{kind:'greeting',job:{}},sources);
  assert.match(input.system,/表达简洁/);
  assert.match(input.system,/先说明求职目标/);
  assert.deepEqual(input.payload.owner_knowledge,[{source:'系统策划.md',content:'设计技能连携和战斗节奏。'}]);
  assert(!input.system.includes('设计技能连携'));
});

test('知识库满额时，重复内容仍去重，唯一新资料不会覆盖旧文件',()=>{
  const directory=mkdtempSync(join(tmpdir(),'boss-library-capacity-')),library=createOwnerLibrary(directory);
  for(let index=0;index<40;index++)library.importDocument({name:'fixture-'+index+'.md',text:'合成资料 '+index});
  const stored=library.state().documents;
  assert.throws(()=>library.importDocument({name:'overflow.md',text:'新的超额合成资料'}),/最多保留 40 份/);
  const duplicate=library.importDocument({name:'duplicate.txt',text:'  合成资料 0\n'});
  assert.equal(duplicate.importStatus,'duplicate');
  assert.deepEqual(duplicate.documents,stored);
  assert.deepEqual(library.state().documents,stored);
});

test('人格与规则可单独更新，另一项和已导入资料按当前文件保留',()=>{
  const directory=mkdtempSync(join(tmpdir(),'boss-library-partial-')),library=createOwnerLibrary(directory);
  library.setPersona({persona:'原人格',rules:'原规则'});
  library.importDocument({name:'合成资料.txt',text:'需要保留的内容'});
  library.setPersona({rules:'先提交的规则'});
  const updated=library.setPersona({persona:'后提交的人格'});
  assert.equal(updated.persona,'后提交的人格');
  assert.equal(updated.rules,'先提交的规则');
  assert.deepEqual(updated.documents.map(row=>row.name),['合成资料.txt']);
  assert.throws(()=>library.setPersona({persona:'不应保存',rules:'甲'.repeat(16001)}),/最多/);
  assert.deepEqual(library.state(),updated);
  assert.equal(library.setPersona({rules:''}).rules,'');
  assert.equal(library.state().persona,updated.persona);
});

test('导入 PDF 保留文件名，拒绝路径与错误格式', () => {
  const directory = mkdtempSync(join(tmpdir(),'boss-resume-'));
  const library = createOwnerLibrary(directory);
  const base64 = Buffer.from('%PDF-1.7\n%%EOF').toString('base64');
  assert.throws(()=>library.importResume({name:'../other.pdf',base64}),/文件名称/);
  assert.throws(()=>library.importResume({name:'test.pdf',base64:'dGVzdA=='}),/PDF/);
  assert.throws(()=>library.importDocument({name:'bad.json',text:'{' }),/JSON/);
  library.importResume({name:'测试简历.pdf',base64});
  const resume = library.activeResume();
  assert.equal(basename(resume.path),'测试简历.pdf');
  assert.equal(readFileSync(resume.path).toString('base64'),base64);
});

test('桌面资料接口仅限认证主人，并从空白求职资料启动', async t => {
  const local = mkdtempSync(join(tmpdir(),'boss-desktop-profile-'));
  const port = await testPort();
  const app = createApplication({local,port,key:'',desktop:true});
  app.server.listen(port,'127.0.0.1');
  await once(app.server,'listening');
  t.after(()=>app.shutdown());
  const base = 'http://127.0.0.1:'+port;
  const {token,extensionToken} = await(await fetch(base+'/api/session')).json();
  const update = auth => fetch(base+'/api/library/persona',{method:'POST',headers:{'X-Boss-Token':auth,'Content-Type':'application/json'},body:JSON.stringify({persona:'简短自然',rules:''})});
  assert.equal((await update(extensionToken)).status,401);
  assert.equal((await update(app.embeddedToken)).status,403);
  assert.equal((await update(token)).status,200);
  assert.equal(app.state.config.profile.name,'');
  assert.equal(app.state.config.running,false);
  assert.equal(app.state.config.backend,'api');
  assert.equal(app.library.state().persona,'简短自然');
  const saveFacts = facts => fetch(base+'/api/config',{method:'POST',headers:{'X-Boss-Token':token,'Content-Type':'application/json'},body:JSON.stringify({profile:{facts}})});
  const facts='甲'.repeat(16000);
  const saved=await saveFacts(facts);assert.equal(saved.status,200);await saved.body.cancel();
  const profileFile=join(local,'state.json'),before=readFileSync(profileFile,'utf8');
  const rejected=await saveFacts(facts+'不能静默删除');
  assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/经历与能力最多 16,000 字/);
  assert.equal(app.state.config.profile.facts,facts);
  assert.equal(readFileSync(profileFile,'utf8'),before);
});

test('重复导入保留原文件、待发送草稿和生成队列，只有新增资料记录修改',async t=>{
  const local=mkdtempSync(join(tmpdir(),'boss-library-import-api-')),port=await testPort();
  const app=createApplication({local,port,key:'',desktop:true});
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  t.after(()=>app.shutdown());
  const base='http://127.0.0.1:'+port,{token,extensionToken}=await(await fetch(base+'/api/session')).json();
  async function api(path,data,auth=token){
    const response=await fetch(base+path,{method:data?'POST':'GET',headers:{'X-Boss-Token':auth,'Content-Type':'application/json'},
      ...(data?{body:JSON.stringify(data)}:{})});
    return {status:response.status,value:await response.json()};
  }
  const route='/api/library/document',document={name:'合成资料.md',text:'合成的游戏策划项目笔记。'};
  assert.equal((await api(route,document,extensionToken)).status,401);
  assert.equal((await api(route,document,app.embeddedToken)).status,403);
  const added=await api(route,document);
  assert.equal(added.status,200);
  assert.equal(added.value.importStatus,'added');
  assert.deepEqual(added.value.documents.map(row=>row.name),[document.name]);
  const libraryFile=join(local,'owner-library.json'),stateFile=join(local,'state.json');
  const storedLibrary=readFileSync(libraryFile,'utf8'),storedState=readFileSync(stateFile,'utf8');
  const peerId='boss:library-fixture',draft={id:'draft-fixture',kind:'reply',status:'pending',peerId,job:{title:'合成岗位'},createdAt:Date.now()};
  app.state.tasks.push(draft);
  app.state.replyQueue.push({id:'queue-fixture',peerId,status:'queued'});
  app.state.snapshots[peerId]='existing-draft-fingerprint';
  const previousEvents=app.state.events.length;

  app.state.ownerBusy=true;
  assert.equal((await api(route,document)).status,400);
  app.state.ownerBusy=false;
  const duplicate=await api(route,{name:'重复的不同文件名.txt',text:'\ufeff '+document.text+'\n'});
  assert.equal(duplicate.status,200);
  assert.equal(duplicate.value.importStatus,'duplicate');
  assert.deepEqual(duplicate.value.documents,added.value.documents);
  assert.equal(draft.status,'pending');
  assert.equal(app.state.replyQueue[0].status,'queued');
  assert.equal(app.state.snapshots[peerId],'existing-draft-fingerprint');
  assert.equal(app.state.events.length,previousEvents);
  assert.equal(readFileSync(libraryFile,'utf8'),storedLibrary);
  assert.equal(readFileSync(stateFile,'utf8'),storedState);
  const plain=(await api('/api/library')).value;
  assert.equal(Object.hasOwn(plain,'importStatus'),false);
  assert(!Object.hasOwn(plain.documents[0],'content'));
  assert(!Object.hasOwn(plain.documents[0],'hash'));

  const changed=await api(route,{name:'另一个合成项目.md',text:'新的模拟项目说明。'});
  assert.equal(changed.value.importStatus,'added');
  assert.equal(changed.value.documents.length,2);
  assert.equal(draft.status,'stale');
  assert.equal(app.state.replyQueue[0].status,'stale');
  assert.equal(app.state.snapshots[peerId],undefined);
  assert.equal(app.state.events.length,previousEvents+1);
});
