import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ownerToolEntries,createMcpTools} from '../server/tooling.mjs';
import {createPatch} from '../server/harness.mjs';

test('电脑与浏览器MCP只加载到主人频道，不给HR与学习资料执行权',()=>{
 const dir=mkdtempSync(join(tmpdir(),'whale-tool-channels-')),file=join(dir,'presets.json');
 const servers=['windows','browser','web'].map(name=>({name,command:process.execPath,args:[]}));
 writeFileSync(file,JSON.stringify({servers}));
 const entries=ownerToolEntries(file);assert.equal(entries.length,3);
 const owner=JSON.parse(createPatch('测试规则','deepseek-flash',{channel:'owner',toolEntries:entries}));assert.equal(owner.flatMap(p=>p.insert||[]).filter(p=>p.name==='@deepseek-ai/dsh-mcp-client').length,3);
 const autonomous=JSON.parse(createPatch('长期目标','deepseek-flash',{channel:'autonomy',toolEntries:entries}));assert.equal(autonomous.flatMap(p=>p.insert||[]).filter(p=>p.name==='@deepseek-ai/dsh-mcp-client').length,3);assert(autonomous.some(p=>p.id==='system-prompt'&&p.config.includeRuntimeContext));
 for(const channel of ['hr','learning']){const patch=JSON.parse(createPatch('测试规则','deepseek-flash',{channel,toolEntries:entries}));assert(!patch.flatMap(p=>p.insert||[p]).some(p=>p.name==='@deepseek-ai/dsh-mcp-client'));}
 assert(createMcpTools(dir,{presets:file}).list().servers.every(s=>s.installed));assert(entries.every(e=>e.config.transport==='stdio'));
});
test('工具配置不携带求职密钥与配对凭据，拒绝错误启动参数',()=>{
 const dir=mkdtempSync(join(tmpdir(),'whale-tools-')),file=join(dir,'mcp.json');
 writeFileSync(file,JSON.stringify({servers:[{name:'windows',command:'python.exe',args:[],env:{DEEPSEEK_API_KEY:'fixture'}}]}));assert.throws(()=>ownerToolEntries(file),/凭据/);
 writeFileSync(file,JSON.stringify({servers:[{name:'bad name',command:'python.exe',args:[]}]}));assert.throws(()=>ownerToolEntries(file),/配置无效/);
});
