export const channelNames=['jobSearch','hrInbox'];
export const validChannel=name=>channelNames.includes(name);
// The fallback keeps old saved profiles and isolated legacy callers compatible.
export function channelRunning(config,name){return typeof config?.channels?.[name]==='boolean'?config.channels[name]:config?.running===true;}
export function setChannelFlags(config,input){
 const next=Object.fromEntries(channelNames.map(name=>[name,channelRunning(config,name)]));
 for(const name of Object.keys(input||{})){if(!validChannel(name)||typeof input[name]!=='boolean')throw Error('请选择自主求职或HR消息的开启状态');next[name]=input[name];}
 config.channels=next;config.running=next.jobSearch||next.hrInbox;return next;
}
export function taskChannel(state,task){
 if(validChannel(task?.sourceChannel))return task.sourceChannel;
 const plan=task?.ownerChatPlanId?(state.ownerChats||[]).find(p=>p.id===task.ownerChatPlanId):task?.greetingPlanId?(state.greetingPlans||[]).find(p=>p.id===task.greetingPlanId):null;
 if(validChannel(plan?.sourceChannel))return plan.sourceChannel;
 if(plan?.origin==='autonomy'||plan?.origin==='standing_goal')return 'jobSearch';
 if(task?.singleTestPlanId||task?.ownerChatPlanId||task?.greetingPlanId)return 'owner';
 return task?.kind==='reply'?'hrInbox':task?.kind==='greeting'?'jobSearch':'owner';
}
export function taskChannelRunning(state,task){const channel=taskChannel(state,task);return channel==='owner'||channelRunning(state.config,channel);}
