const bossOrigin='https://www.zhipin.com';
const proofLifetime=45000;
const priorContact=new Set(['sent','uncertain','executing']);
export const accountRecheckReason='请核对当前 BOSS 登录的是原账号。换了账号时，请另用全新工作区。';

function bossPath(value){
  try{
    const url=new URL(value);
    return url.origin===bossOrigin&&!url.username&&!url.password?url.pathname:'';
  }catch{return '';}
}

export function createAccountRecheck(state,now=Date.now){
  let workspaceAt=0;
  const required=()=>state.accountRecheck?.required===true;
  const priorKnown=()=>state.accountRecheck?.known===true||state.config.browserCalibrated===true||
    (state.tasks||[]).some(t=>priorContact.has(t.status))||Object.values(state.memories||{}).some(c=>
      c.sends?.some(s=>priorContact.has(s.status))||c.history?.some(m=>m.role==='self'&&m.id));
  function status(){
    const data=state.accountRecheck;
    return {required:required(),reason:data?.reason||null,at:data?.at||null,canConfirm:required()&&workspaceAt>0&&now()-workspaceAt<proofLifetime,confirmedAt:data?.confirmedAt||null};
  }
  function markKnown(){
    if(!state.accountRecheck?.known)state.accountRecheck={...state.accountRecheck,known:true};
  }
  function lock(reason,bridge){
    workspaceAt=0;
    if(!priorKnown())return false;
    state.config.browserCalibrated=false;
    if(required()&&state.accountRecheck.bridge===bridge)return false;
    state.accountRecheck={...state.accountRecheck,known:true,required:true,reason,bridge,at:now()};
    return true;
  }
  function observe(data,bridge){
    const path=bossPath(data.page);
    if(!path)return {};
    const loginPath=/^\/web\/user\/?$/.test(path);
    const login=loginPath&&(data.accountForeground!==false||data.accountSignal==='login-navigation')||
      data.accountForeground===true&&data.accountSignal==='sign-in-ui';
    if(login)return {login:true,locked:lock('login_observed',bridge)};
    if(required()&&data.accountForeground===true){
      const visibleChat=data.accountSignal==='chat-workspace'&&/^\/web\/geek\/chat\/?$/.test(path);
      workspaceAt=visibleChat?now():0;
    }
    return {};
  }
  function confirm(sameAccount){
    if(!required())throw Error('当前无需核对 BOSS 账号');
    if(sameAccount!==true)throw Error(accountRecheckReason);
    if(!status().canConfirm)throw Error('请先登录 BOSS 并打开已有聊天，再确认是原账号');
    state.accountRecheck={...state.accountRecheck,required:false,reason:null,at:null,confirmedAt:now()};
    workspaceAt=0;
    return status();
  }
  return {required,status,markKnown,rememberPrior:()=>{if(priorKnown())markKnown();},lock,observe,confirm};
}
