import test from 'node:test';
import assert from 'node:assert/strict';
import {browserOutputFilter,scrubBrowserText} from '../server/browser-redaction.mjs';
test('扩展连接页回显中的连接令牌不传给模型',()=>{
 const token='fake-browser-secret',line=JSON.stringify({text:`chrome-extension://example/connect.html?token=${token}&protocolVersion=2`});
 const clean=scrubBrowserText(line,token);assert(!clean.includes(token));assert.equal(JSON.parse(clean).text,'chrome-extension://example/connect.html?token=[redacted]&protocolVersion=2');
});
test('跨进程分块的令牌和中文仍可正确过滤并解析',async()=>{
 const token='Z'.repeat(43),data=Buffer.from(JSON.stringify({text:'小鲸连接 '+token})+'\n'),filter=browserOutputFilter(token),output=[];
 filter.on('data',x=>output.push(x));const ended=new Promise((resolve,reject)=>{filter.on('end',resolve);filter.on('error',reject);});
 for(let i=0;i<data.length;i+=7)filter.write(data.subarray(i,i+7));filter.end();await ended;
 const result=Buffer.concat(output).toString('utf8');assert(!result.includes(token));assert.equal(JSON.parse(result).text,'小鲸连接 [redacted]');
});
