import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
test('仅捕获当前聊天查看职位产生的公开BOSS岗位地址，立即恢复原函数，不传查询凭据',()=>{
 const listeners=new Map(),responses=[],calls=[];
 const win={addEventListener:(key,fn)=>listeners.set(key,fn),dispatchEvent:event=>{responses.push(event);listeners.get(event.type)?.(event);},getComputedStyle:()=>({display:'block'}),open:(...args)=>calls.push(args)};
 const doc={defaultView:win,querySelectorAll:selector=>selector==='iframe'?[]:[strip]};
 const entry={innerText:'查看职位',children:[],ownerDocument:doc,getClientRects:()=>[{}],click:()=>win.open('https://www.zhipin.com/job_detail/visible-job.html?securityId=do-not-share')};
 const strip={ownerDocument:doc,getClientRects:()=>[{}],querySelector:()=>({innerText:'游戏关卡策划实习生'}),querySelectorAll:()=>[entry]};
 const original=win.open;vm.runInNewContext(readFileSync(new URL('../extension/position-link.js',import.meta.url),'utf8'),{window:win,document:doc,location:{href:'https://www.zhipin.com/web/geek/chat'},URL,Date,Set,setTimeout,clearTimeout,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}}});
 listeners.get('boss-assistant-read-position-link')({detail:{id:'one-read',title:'游戏关卡策划实习生'}});
 const result=responses.find(e=>e.detail.url);assert.equal(result.detail.url,'https://www.zhipin.com/job_detail/visible-job.html');assert.equal(JSON.stringify(responses).includes('securityId'),false);assert.equal(win.open,original);assert.equal(calls.length,0);
 listeners.get('boss-assistant-read-position-link')({detail:{id:'wrong-title',title:'其他职位'}});assert.equal(calls.length,0);assert.equal(responses.filter(e=>e.detail.url).length,1);
 let anchorClicks=0;const anchorOriginal=function(){anchorClicks++;};win.HTMLAnchorElement={prototype:{click:anchorOriginal}};
 entry.click=()=>{const anchor=Object.create(win.HTMLAnchorElement.prototype);anchor.href='https://www.zhipin.com/job_detail/anchor-job.html?securityId=hidden';anchor.click();};
 listeners.get('boss-assistant-read-position-link')({detail:{id:'anchor-read',title:'游戏关卡策划实习生'}});
 assert.equal(responses.at(-1).detail.url,'https://www.zhipin.com/job_detail/anchor-job.html');assert.equal(win.HTMLAnchorElement.prototype.click,anchorOriginal);assert.equal(anchorClicks,0);
});
