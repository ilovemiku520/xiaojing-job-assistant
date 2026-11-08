(bossTransport=>{
  let contentListener;
  const chrome={
    runtime:{
      id:'xiaojing-embedded',
      sendMessage:message=>bossTransport.send(message),
      onMessage:{addListener:listener=>{contentListener=listener;}}
    },
    storage:{local:{get:key=>bossTransport.get(key),set:value=>bossTransport.set(value)}}
  };
  globalThis.xiaojingBossDeliver=message=>new Promise((resolve,reject)=>{
    if(!contentListener){reject(Error('BOSS 页面组件尚未就绪'));return;}
    const timer=setTimeout(()=>reject(Error('BOSS 页面操作尚未返回')),145000);
    const respond=value=>{clearTimeout(timer);resolve(value);};
    try{
      if(contentListener(message,{id:chrome.runtime.id},respond)!==true)respond(undefined);
    }catch(error){clearTimeout(timer);reject(error);}
  });
  return chrome;
})
