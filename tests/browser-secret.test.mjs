import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {browserTokenConfigured,normalizeBrowserToken,saveBrowserToken,loadBrowserToken,clearBrowserToken} from '../server/browser-secret.mjs';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';

test('微软扩展连接令牌接受官方复制格式，拒绝其他凭据',()=>{
 const token='A'.repeat(43);assert.equal(normalizeBrowserToken(' PLAYWRIGHT_MCP_EXTENSION_TOKEN='+token+'\n'),token);
 for(const value of ['', 'sk-fake-key', 'http://localhost', token+';', '\n'+token+'\ninvalid'])assert.throws(()=>normalizeBrowserToken(value));
});
test('浏览器令牌按当前Windows账户加密，删除后不再自动重连',{skip:process.platform!=='win32'},()=>{
 const dir=mkdtempSync(join(tmpdir(),'whale-browser-secret-')),token='B'.repeat(43);
 assert.equal(browserTokenConfigured(dir),false);saveBrowserToken(dir,token);assert.equal(browserTokenConfigured(dir),true);
 assert(!readFileSync(join(dir,'playwright-extension.dpapi'),'utf8').includes(token));assert.equal(loadBrowserToken(dir),token);
 clearBrowserToken(dir);assert.equal(browserTokenConfigured(dir),false);assert.equal(loadBrowserToken(dir),'');
});
test('自动连接配置只允许主人修改，状态接口不回传令牌',{skip:process.platform!=='win32'},async()=>{
 const port=await testPort(),local=mkdtempSync(join(tmpdir(),'whale-browser-api-')),app=createApplication({local,port,key:'fixture'});
 await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${port}`;
 try{
  const session=await(await fetch(base+'/api/session')).json(),token='C'.repeat(43);
  const send=(credential,data)=>fetch(base+'/api/browser-token',{method:'POST',headers:{'Content-Type':'application/json','X-Boss-Token':credential},body:JSON.stringify(data)});
  assert.equal((await send(session.extensionToken,{token})).status,403);
  const saved=await send(session.token,{token});assert.equal(saved.status,200);assert.equal((await saved.json()).configured,true);
  const response=await fetch(base+'/api/state',{headers:{'X-Boss-Token':session.token}}),body=await response.text();
  assert.equal(JSON.parse(body).browserAutoConnectConfigured,true);assert(!body.includes(token));assert(!JSON.stringify(app.state).includes(token));
  assert.equal((await send(session.token,{clear:true})).status,200);assert.equal(browserTokenConfigured(local),false);
 }finally{await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});}
});
