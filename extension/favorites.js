/* Favorites come from a visible collection page, never from a per-job save button. */
(()=>{
 if(globalThis.BossFavorites)return;
 // These DIV classes are present in the saved public BOSS header inspection.
 const scope='nav,header,[role="navigation"],[role="menu"],[role="menubar"],[role="tablist"],.header-v2,.nav,.user-nav,.header-nav-group';
 const chatScope='.chat-conversation,.chat-window,.chat-container';
 const jobScope='.job-card-wrapper,.job-card-box,.job-banner,.job-detail,.job-detail-container,.job-detail-box,.job-sec,.job-sec-text,.chat-conversation,.chat-window,.chat-container';
 const favoriteLabel=/^(?:我的收藏(?:职位|岗位)?|我收藏的(?:职位|岗位)|收藏的(?:职位|岗位)|收藏(?:职位|岗位)|职位收藏|岗位收藏|感兴趣的职位|收藏夹)(?:\s*[（(]?\d+[）)]?)?$/;
 const shortFavoriteLabel=/^(?:收藏|感兴趣)(?:\s*[（(]?\d+[）)]?)?$/;
 const text=e=>(e?.innerText||e?.textContent||'').trim();
 const visible=e=>!!e&&e.getClientRects().length>0&&e.ownerDocument.defaultView.getComputedStyle(e).display!=='none'&&e.ownerDocument.defaultView.getComputedStyle(e).visibility!=='hidden';
 const enabled=e=>visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&!e.closest('[disabled],[aria-disabled="true"],.disabled,.unable');
 function safeURL(value,base){try{if(typeof value!=='string'||!value.trim()||value.trim()==='#')return '';const u=new URL(value,base);return u.origin==='https://www.zhipin.com'&&/^\/web\/geek\//.test(u.pathname)&&!/^\/web\/geek\/chat\/?$/.test(u.pathname)&&!u.username&&!u.password?u.href:'';}catch{return '';}}
 const label=e=>e.getAttribute('aria-label')||e.getAttribute('title')||text(e);
 function candidates(root){
  return [...root.querySelectorAll('a,button,[role="button"],[role="tab"],[role="menuitem"]')].filter(enabled).filter(e=>!e.closest(jobScope)).filter(e=>favoriteLabel.test(label(e))||e.closest(scope)&&shortFavoriteLabel.test(label(e))).filter(e=>![...e.querySelectorAll('a,button,[role="button"],[role="tab"],[role="menuitem"]')].some(child=>visible(child)&&favoriteLabel.test(label(child))));
 }
 function discoverNavigation({root=document,url=root.ownerDocument?.URL||root.URL}={}){
  const found=candidates(root).filter(e=>e.matches('a[href]')).map(e=>({url:safeURL(e.getAttribute('href'),url),label:label(e).slice(0,100),sourcePage:String(url),observedAt:Date.now(),method:'visible_anchor'})).filter(e=>e.url);
  const unique=[...new Map(found.map(e=>[e.url,e])).values()];return unique.length===1?unique[0]:null;
 }
 function publicJobURL(value,base){try{const u=new URL(value,base);return u.origin==='https://www.zhipin.com'&&/^\/job_detail\/[\w-]+\.html$/.test(u.pathname)?u.origin+u.pathname:'';}catch{return '';}}
 function jobLinks(root,base){return [...(root.matches?.('a[href]')?[root]:[]),...root.querySelectorAll('a[href]')].filter(visible).filter(link=>!link.closest(chatScope)).map(link=>({link,url:publicJobURL(link.getAttribute('href'),base)})).filter(item=>item.url);}
 function fallbackCards(root,base){
  const byURL=new Map();for(const {link,url} of jobLinks(root,base)){
   if(byURL.has(url)||link.closest('nav,header,footer,[role="navigation"]'))continue;
   // Use the nearest actual visible container with this one public job link.
   // No class names, job titles, companies or other facts are inferred.
   let card=link;for(let node=link.parentElement,depth=0;node&&node!==root.body&&depth<6;node=node.parentElement,depth++){
    if(root.contains&&!root.contains(node))break;const urls=[...new Set(jobLinks(node,base).map(item=>item.url))];
    if(visible(node)&&urls.length===1&&text(node).length<=6000){card=node;break;}
   }
   byURL.set(url,{card,url});
  }return [...byURL.values()];
 }
 function inspect({root=document,url=root.ownerDocument?.URL||root.URL,knownCollectionURL='',ownerCollectionURL='',sourcePageURL='',selectors={}}={}){
  const navigation=discoverNavigation({root,url}),current=safeURL(url,url),known=safeURL(knownCollectionURL,url),owner=safeURL(ownerCollectionURL,url),sourcePage=safeURL(sourcePageURL,url);
  const headings=[...root.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).filter(e=>!e.closest(jobScope)&&favoriteLabel.test(text(e)));
  const selected=candidates(root).filter(e=>e.getAttribute('aria-current')==='page'||e.getAttribute('aria-selected')==='true'||e.matches('.active,.selected')||e.parentElement?.matches('.active,.selected'));
  const heading=headings.length===1?text(headings[0]):'',selectedLabel=selected.length===1?label(selected[0]):'';
  // A title alone is insufficient when it belongs to an unrelated side menu.
  const chatDocument=(()=>{try{return /^\/web\/geek\/chat\/?$/.test(new URL(url).pathname);}catch{return false;}})();
  const pageConfirmed=!chatDocument&&!!current&&!!(known&&known===current&&(heading||selectedLabel)||heading&&(navigation?.url===current||selectedLabel));
  const ownerURLMatched=!chatDocument&&!!owner&&(current===owner||sourcePage===owner),standard=[...root.querySelectorAll(selectors.jobCard||'.job-card-wrapper, .job-card-box')].filter(visible).filter(card=>!card.closest(chatScope));
  const fallback=ownerURLMatched&&!standard.length?fallbackCards(root,sourcePage||url):[];
  const visibleCards=standard.length?standard:fallback.map(item=>item.card),clearEmpty=/暂无(?:收藏|感兴趣)|还没有(?:收藏|感兴趣)|尚未收藏|没有(?:收藏|感兴趣)|收藏(?:夹|列表)为空/.test(text(root.body||root));
  const ownerConfirmed=ownerURLMatched&&(visibleCards.length>0||clearEmpty),confirmedList=pageConfirmed||ownerConfirmed;
  const cards=confirmedList?visibleCards:[],cardEvidence=cards.map((card,index)=>{const urls=[...new Set(jobLinks(card,sourcePage||url).map(item=>item.url))];return {url:fallback[index]?.url||(urls.length===1?urls[0]:'')};});
  const empty=confirmedList&&cards.length===0&&clearEmpty,sourceBasis=ownerConfirmed?'owner_confirmed_url':'visible_page_evidence';
  return {navigation,confirmedList,cards,cardEvidence,empty,url:ownerConfirmed?owner:current,ownerSourceMatched:ownerURLMatched,jobCardCount:standard.length,detailLinkCount:chatDocument?0:new Set(jobLinks(root,sourcePage||url).map(item=>item.url)).size,sourceBasis:confirmedList?sourceBasis:'',evidence:confirmedList?ownerConfirmed?{sourceBasis,ownerCollectionURL:owner,documentURL:current,sourcePageURL:sourcePage,visibleCards:cards.length,explicitEmpty:empty}:{sourceBasis,heading,selectedLabel,knownURLMatched:known===current}:null,reason:confirmedList?'':chatDocument?'聊天文档不作为收藏岗位来源':ownerURLMatched?'主人指定的收藏来源已匹配，等待实际岗位卡片或明确空列表提示':navigation?'已发现收藏入口，当前页面不是已确认的收藏列表':'尚未发现可核对的收藏导航或收藏列表，普通搜索结果不会标为收藏'};
 }
 function collect(options={}){
  const state=inspect(options),{cards,cardEvidence,...metadata}=state;
  const jobs=state.confirmedList&&typeof options.parseCard==='function'?cards.map((card,index)=>{const parsed=options.parseCard(card)||{};return state.sourceBasis==='owner_confirmed_url'?{...parsed,url:cardEvidence[index]?.url||publicJobURL(parsed.url,state.url)}:parsed;}).filter(j=>j&&j.url&&(j.title||state.sourceBasis==='owner_confirmed_url')).map(j=>({...j,source:'favorite',sourceBasis:state.sourceBasis,sourceURL:state.url,sourceObservedAt:Date.now()})):[];
  return {...metadata,jobs};
 }
 async function waitFor(check,doc,timeoutMs){
  const first=check();if(first)return first;
  return new Promise(resolve=>{
   let done=false;const finish=value=>{if(done)return;done=true;observer.disconnect();clearTimeout(timer);clearInterval(pulse);resolve(value);};
   const run=()=>{const value=check();if(value)finish(value);};
   const observer=new doc.defaultView.MutationObserver(run);observer.observe(doc.body,{childList:true,subtree:true,attributes:true,characterData:true});
   const timer=setTimeout(()=>finish(null),timeoutMs),pulse=setInterval(run,300);run();
  });
 }
 let opening=null,lastAttemptAt=0;
 async function scan(options={}){
  const root=options.root||document,doc=root.ownerDocument||root,originalURL=options.url||doc.URL;
  const first=collect({...options,root,url:originalURL});if(first.confirmedList||first.ownerSourceMatched||first.navigation||options.allowNavigate!==true)return first;
  if(opening)return opening;
  if(Date.now()-lastAttemptAt<300000)return {...first,reason:'收藏导航已检查，等待下一轮重试；继续处理聊天和搜索'};
  lastAttemptAt=Date.now();
  opening=(async()=>{
   let controls=candidates(root);
   if(!controls.length){
    const avatars=[...root.querySelectorAll('.user-nav .nav-figure')].filter(enabled).filter(e=>!e.closest(jobScope));
    if(avatars.length===1){
     // The avatar's recommend href is not a collection route. Only reveal its
     // visible menu, then inspect an actual collection link or labeled control.
     const EventType=doc.defaultView.MouseEvent;
     avatars[0].dispatchEvent(new EventType('mouseenter',{bubbles:false,view:doc.defaultView}));
     if(!candidates(root).length)avatars[0].dispatchEvent(new EventType('mouseover',{bubbles:true,view:doc.defaultView}));
     await waitFor(()=>candidates(root).length,doc,1800);controls=candidates(root);
    }
   }
   if(!controls.length){
    const menu=[...root.querySelectorAll('button,[role="button"],a[aria-haspopup]')].filter(enabled).filter(e=>e.closest(scope)&&!e.closest(jobScope)&&/^我的$/.test(label(e)));
    if(menu.length===1){menu[0].click();await waitFor(()=>candidates(root).length,doc,1800);controls=candidates(root);}
   }
   const currentURL=()=>safeURL(doc.defaultView.location.href,originalURL)||originalURL;
   const discovered=discoverNavigation({root,url:currentURL()});if(discovered)return collect({...options,root,url:currentURL()});
   if(controls.length!==1)return {...first,reason:controls.length?'收藏导航控件不唯一，未猜测点击':'当前可见导航没有收藏入口；岗位上的“感兴趣”不会当作收藏列表'};
   const control=controls[0],href=control.getAttribute('href');
   if(!control.closest(scope)||control.matches('a[href]')&&safeURL(href,currentURL()))return {...first,reason:'未找到可唯一确认的收藏导航按钮'};
   if(control.matches('a[href]')&&href&&!/^(?:#|javascript:\s*(?:;|void\(0\);?))$/i.test(href.trim()))return {...first,reason:'收藏入口不是已核对的站内导航，未点击'};
   const controlLabel=label(control);control.click();
   const confirmed=await waitFor(()=>{
    const value=collect({...options,root,url:currentURL(),knownCollectionURL:currentURL()});return value.confirmedList?value:null;
   },doc,4500);
   if(!confirmed)return {...collect({...options,root,url:currentURL()}),reason:'已点击唯一收藏导航，尚未确认收藏列表；不重复点击或刷新'};
   return {...confirmed,navigation:{url:currentURL(),label:controlLabel.slice(0,100),sourcePage:String(originalURL),observedAt:Date.now(),method:'visible_control'}};
  })();
  try{return await opening;}finally{opening=null;}
 }
 globalThis.BossFavorites=Object.freeze({discoverNavigation,inspect,collect,scan,safeURL});
})();
