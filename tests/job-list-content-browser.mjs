// The production browser adapter runs with a synthetic page and mock local API.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';

const base='https://www.zhipin.com/web/geek/job';
const first=base+'?query=game&city=101010100',second=first+'&page=2';
const jobURL=id=>'https://www.zhipin.com/job_detail/list-fixture-'+id+'.html';
const html='<!doctype html><meta charset="utf-8"><main>'+['a','b'].map(id=>
  `<article id="job-${id}" class="job-card-wrapper"><a class="job-name" href="${jobURL(id)}?tracking=fixture">系统策划实习 ${id}</a><span class="boss-name">合成公司</span><span class="company-location">北京</span><span class="job-salary">220元/天</span><ul class="tag-list"><li>在校生</li></ul></article>`
).join('')+'</main>';
const config={running:true,jobSearchRunning:true,hrInboxRunning:false,crawlEnabled:true,favoritesFirst:false,watchEpoch:1,bridgeEpoch:'service:1'};
const calls=[],blocked=[];
let search,failObservation=false,failReceipt=false;

async function handle(message){
  calls.push(structuredClone(message));
  const ok=result=>({ok:true,result});
  if(['worker','crawlWorker','chatJobWorker'].includes(message.type))return ok(null);
  if(message.type!=='api')throw Error('Unexpected fixture runtime message '+message.type);
  if(message.path==='/api/heartbeat')return ok({config,search});
  if(message.path==='/api/jobs/observe'){
    if(failObservation){failObservation=false;return {ok:false,error:'合成采集失败'};}
    return ok({ids:message.data.jobs.map(job=>job.url)});
  }
  if(message.path==='/api/search/observed'){
    if(failReceipt){failReceipt=false;return {ok:false,error:'合成搜索回传失败'};}
    search=undefined;
    return ok({});
  }
  if(message.path==='/api/inspection')return ok({});
  throw Error('Unexpected fixture API '+message.path);
}
const observations=()=>calls.filter(call=>call.path==='/api/jobs/observe');
const receipts=()=>calls.filter(call=>call.path==='/api/search/observed');

const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
  const context=await browser.newContext({serviceWorkers:'block'});
  await context.route('**/*',route=>{
    if([first,second].includes(route.request().url())&&route.request().resourceType()==='document')return route.fulfill({contentType:'text/html',body:html});
    blocked.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  const page=await context.newPage();
  await page.exposeFunction('fixtureTransport',handle);
  await page.addInitScript(()=>{
    window.fixtureClock=1000000;
    Date.now=()=>fixtureClock;
    window.setInterval=()=>0;
    const start=window.setTimeout;
    window.setTimeout=(callback,delay,...args)=>delay===1800?0:start(callback,delay,...args);
    const values={};
    window.chrome={storage:{local:{get:async key=>({[key]:values[key]}),set:async patch=>Object.assign(values,patch)}},
      runtime:{id:'fixture',sendMessage:message=>fixtureTransport(message),onMessage:{addListener:listener=>{window.fixtureRead=listener;}}}};
  });
  async function load(url){
    await page.goto(url);
    for(const name of ['realtime.js','resume-ui.js','favorites.js','content.js'])await page.addScriptTag({content:readFileSync(new URL('../extension/'+name,import.meta.url),'utf8')});
  }
  const tick=()=>page.evaluate(()=>new Promise(resolve=>fixtureRead({type:'assistant-read',command:'tick'},{id:'fixture'},resolve)));
  const advance=milliseconds=>page.evaluate(value=>{fixtureClock+=value;},milliseconds);

  await load(first);
  await tick();
  assert.deepEqual(observations()[0].data.jobs.map(job=>job.url),[jobURL('a'),jobURL('b')]);
  await tick();
  await page.evaluate(()=>document.querySelector('main').prepend(document.querySelector('#job-b')));
  await tick();
  assert.equal(observations().length,1);
  const heartbeats=calls.filter(call=>call.path==='/api/heartbeat');
  assert.equal(heartbeats.length,6,'unchanged data does not suppress presence heartbeats');
  assert(heartbeats.every(call=>call.data.diagnostics.adapter==='0.13.3'),'configuration and full heartbeats both identify the active page adapter');
  await page.locator('#job-a .boss-name').evaluate(node=>{node.textContent='更新后的合成公司';});
  await tick();
  assert.equal(observations().length,2);
  await page.evaluate(url=>history.pushState({},'',url),second);
  await tick();
  assert.equal(observations().length,3);

  search={id:'wrong-city',url:second.replace('101010100','101020100'),at:1000000};
  await tick();
  assert.equal(observations().length,3);
  assert.equal(receipts().length,0);
  search={id:'same-url-new-request',url:second,at:1000000};
  failReceipt=true;
  await tick();
  assert.equal(observations().length,4);
  assert.equal(receipts().length,1);
  await tick();
  assert.equal(observations().length,4);
  assert.equal(receipts().length,2);
  assert.equal(receipts()[1].data.id,'same-url-new-request');

  await page.locator('#job-a .job-salary').evaluate(node=>{node.textContent='250元/天';});
  failObservation=true;
  await tick();
  assert.equal(observations().length,5);
  await tick();
  assert.equal(observations().length,6,'failed writes are retried');
  await tick();
  assert.equal(observations().length,6);
  await advance(59999);
  await tick();
  assert.equal(observations().length,6);
  await advance(1);
  await tick();
  assert.equal(observations().length,7);

  config.bridgeEpoch='service:2';
  await tick();
  assert.equal(observations().length,8);
  config.jobSearchRunning=false;
  await tick();
  config.jobSearchRunning=true;
  await tick();
  assert.equal(observations().length,9);
  await load(second);
  await tick();
  assert.equal(observations().length,10);
  assert.deepEqual(blocked,[]);
  assert(!calls.some(call=>['/api/claim','/api/complete','/api/prepare'].includes(call.path)));
  console.log(JSON.stringify({identicalListCoalesced:true,cityBoundReceipts:true,failedWritesRetried:true,refreshAfterBridgeAndNavigation:true,liveBOSSRequests:0}));
}finally{await browser.close();}
