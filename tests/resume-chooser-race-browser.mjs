// Real browser input against a simulated attachment chooser. No BOSS traffic.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';

const resources=process.argv[2]?resolve(process.argv[2]):fileURLToPath(new URL('../',import.meta.url));
const browser=await chromium.launch({headless:true,channel:'msedge'});
const source=readFileSync(join(resources,'extension','resume-ui.js'),'utf8');
const cases=['manual-known','manual-unknown','manual-before-row','site-selection-changed','named-receipt-mismatch','named-truncated-receipt','authorized-default','unchanged-no-marker'];
try{
 for(const scenario of cases){
  const page=await browser.newPage();
  try{
   await page.setContent(`<div class="friend-content selected"><div class="title-box"><span class="name-text">模拟招聘者</span><span>模拟公司</span></div></div>
    <div class="chat-conversation"><div class="chat-record"><div class="message-item item-friend" data-mid="previous">你好</div></div><button id="opener" aria-haspopup="dialog">发简历</button></div>`);
   await page.addScriptTag({content:source});
   await page.evaluate(scenario=>{
    const root=document.querySelector('.chat-conversation'),selectedPeer=document.querySelector('.selected');
    const before={id:'boss:fixture',root,selectedPeer,header:'模拟招聘者 模拟公司',messages:[{id:'previous',role:'hr',text:'你好'}]};
    const named='合成简历.pdf',different='另一份附件.pdf',isDefault=scenario==='authorized-default';
    const config={profile:{resumeName:named},allowSiteDefaultResume:isDefault};
    let checks=0,chosen='',trusted=false,submitted='',report='',selects=0,sends=0;
    const dialog=document.createElement('div');dialog.className='resume-dialog';
    dialog.innerHTML=`<div class="resume-item" id="intended"><span class="resume-name">${isDefault?'站内默认.pdf':named}</span>${isDefault?'<span>默认</span>':''}</div>
     <div class="resume-item" id="other"><span class="resume-name">${different}</span></div><button class="btn-primary">发送</button>`;
    const rows=[...dialog.querySelectorAll('.resume-item')];
    const useMarker=!['manual-unknown','unchanged-no-marker'].includes(scenario);
    for(const row of rows)row.onclick=event=>{
     selects++;
     if(useMarker)for(const candidate of rows)candidate.setAttribute('aria-selected',String(candidate===row));
     chosen=row.querySelector('.resume-name').textContent;
     if(row.id==='other')trusted=event.isTrusted;
    };
    dialog.querySelector('button').onclick=()=>{
     sends++;submitted=chosen;
     const label=scenario==='named-receipt-mismatch'?different:scenario==='named-truncated-receipt'?'合成简...':submitted;
     const notice=document.createElement('div');notice.className='resume-system-notice';notice.textContent='您的附件简历 '+label+' 已发送给Boss点击查看附件';
     root.querySelector('.chat-record').append(notice);dialog.remove();
    };
    document.querySelector('#opener').onclick=()=>document.body.append(dialog);
    const ensure=async()=>{
     checks++;
     if(scenario==='site-selection-changed'&&checks===4)rows[1].click();
     if(scenario.startsWith('manual-')&&checks===(scenario==='manual-before-row'?3:4))await new Promise(resolve=>{window.releaseChooserCheck=resolve;});
    };
    const execution=BossResumeUI.execute({before,config,getCurrent:()=>before,resolveCurrent:async()=>before,ensure,
     finish:async(success,evidence)=>{if(success)report=evidence;},timeoutMs:1000});
    window.chooserOutcome=execution.then(value=>({value,submitted,trusted,report,selects,sends}),error=>({error:error.message,transmissionStarted:error.resumeTransmissionStarted,submitted,trusted,report,selects,sends}));
   },scenario);
   if(scenario.startsWith('manual-')){
    await page.waitForFunction(()=>!!window.releaseChooserCheck);
    await page.locator('#other').click();
    await page.evaluate(()=>window.releaseChooserCheck());
   }
   const result=await page.evaluate(()=>window.chooserOutcome);
   if(scenario.startsWith('manual-')){
    assert.equal(result.trusted,true);assert.equal(result.sends,0);assert.equal(result.report,'');assert.match(result.error,/人工操作/);
    assert.equal(result.transmissionStarted,scenario!=='manual-before-row');
   }else if(scenario==='site-selection-changed'){
    assert.equal(result.trusted,false);assert.equal(result.sends,0);assert.equal(result.report,'');assert.match(result.error,/选中的附件已变化/);assert.equal(result.transmissionStarted,true);
   }else if(scenario==='named-receipt-mismatch'){
    assert.equal(result.sends,1);assert.equal(result.report,'');assert.match(result.error,/回执的文件名与指定简历不一致/);assert.equal(result.transmissionStarted,true);
   }else{
    assert.equal(result.selects,1);assert.equal(result.sends,1);assert.equal(result.value.sent,true);
    if(scenario==='authorized-default'){
     assert.equal(result.submitted,'站内默认.pdf');assert.equal(result.value.attachmentSource,'site_default_owner_authorized');assert.match(result.report,/主人已授权发送当前站内默认附件/);
    }else{
     assert.equal(result.submitted,'合成简历.pdf');assert.equal(result.value.attachmentSource,'named_chooser');
    }
   }
  }finally{await page.close();}
 }
 console.log(JSON.stringify({cases:cases.length,trustedManualChangesBlocked:3,observableChangeBlocked:true,mismatchedNamedReceiptUnverified:true,realBossRequests:0}));
}finally{await browser.close();}
