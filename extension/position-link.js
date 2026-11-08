/* Main-world adapter for this one public UI action. It reads only the job URL
 * produced by 查看职位; no account state, cookies, storage or app internals. */
(()=>{
  const REQUEST='boss-assistant-read-position-link',RESPONSE='boss-assistant-position-link-result';
  const norm=s=>String(s||'').replace(/\s+/g,'');
  const text=e=>(e?.innerText||e?.textContent||'').trim();
  const visible=e=>!!e?.getClientRects().length&&e.ownerDocument.defaultView.getComputedStyle(e).display!=='none';
  const safe=value=>{try{const u=new URL(String(value),location.href);return u.origin==='https://www.zhipin.com'&&/^\/job_detail\/[\w-]+\.html$/.test(u.pathname)?u.origin+u.pathname:'';}catch{return '';}};
  let busy=false;
  window.addEventListener(REQUEST,event=>{
    const input=event.detail;if(busy||!input||typeof input.id!=='string'||input.id.length>80||!input.title)return;
    const docs=[document];for(let i=0;i<docs.length&&docs.length<8;i++)for(const f of docs[i].querySelectorAll('iframe'))try{if(visible(f)&&f.contentDocument?.body)docs.push(f.contentDocument);}catch{}
    const strips=docs.flatMap(d=>[...d.querySelectorAll('.chat-position-content')].filter(visible)).filter(e=>norm(text(e.querySelector('.position-name')))===norm(input.title));
    if(strips.length!==1){window.dispatchEvent(new CustomEvent(RESPONSE,{detail:{id:input.id,error:'未能唯一定位当前聊天职位'}}));return;}
    const entries=[...strips[0].querySelectorAll('a,button,span,div,[role="button"]')].filter(visible).filter(e=>/^查看职位\s*[>›»]?\s*$/.test(text(e))&&![...e.children].some(n=>/^查看职位\s*[>›»]?\s*$/.test(text(n))));
    if(entries.length!==1)return;
    window.dispatchEvent(new CustomEvent(RESPONSE,{detail:{id:input.id,ready:true}}));
    busy=true;const deadline=Date.now()+5000,windows=[...new Set([window,strips[0].ownerDocument.defaultView])],hooks=[];let finished=false,timer;
    const finish=(url,error='')=>{
      if(finished)return;finished=true;clearTimeout(timer);
      for(const {target,key,original,hook} of hooks)if(target[key]===hook)target[key]=original;
      busy=false;window.dispatchEvent(new CustomEvent(RESPONSE,{detail:{id:input.id,url,error}}));
    };
    for(const win of windows){
      const original=win.open;
      const hook=function(value,...args){
        const url=Date.now()<=deadline&&norm(text(strips[0].querySelector('.position-name')))===norm(input.title)?safe(value):'';
        if(url){finish(url);return null;}
        return original.call(this,value,...args);
      };
      try{win.open=hook;hooks.push({target:win,key:'open',original,hook});}catch{}
    }
    for(const proto of [...new Set(windows.map(win=>win.HTMLAnchorElement?.prototype).filter(Boolean))]){
      const original=proto.click;
      const hook=function(...args){const url=Date.now()<=deadline&&norm(text(strips[0].querySelector('.position-name')))===norm(input.title)?safe(this.href):'';if(url){finish(url);return;}return original.apply(this,args);};
      try{proto.click=hook;hooks.push({target:proto,key:'click',original,hook});}catch{}
    }
    timer=setTimeout(()=>finish('','按钮未提供可读取的BOSS职位地址'),5000);
    try{entries[0].click();}catch(e){if(!finished)finish('',String(e.message).slice(0,150));}
  });
})();
