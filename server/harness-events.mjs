// Keep only public progress metadata and the terminal answer. Reasoning, tool
// arguments and tool results are deliberately never retained by this adapter.
export function createHarnessEvents(onProgress=()=>{}){
 let buffer='',sessionId='',answer='',terminal,streamError='',toolCalls=0,sawFinal=false;
 const progress=(stage,type)=>onProgress({stage,type,sessionId,toolCalls,lastActivityAt:Date.now()});
 function consume(line){
  if(!line.trim())return;let event;try{event=JSON.parse(line);}catch{return;}
  if(event.type==='session'){
   if(typeof event.sessionId==='string'&&/^session-[\w-]{1,150}$/.test(event.sessionId))sessionId=event.sessionId;
   progress('ready','session');
  }else if(event.type==='status'){
   if(event.phase==='turn_end')terminal=event.reason;
   progress(event.phase==='step_start'?'thinking':event.phase==='turn_end'?'saving':'working','status');
  }else if(event.type==='tool_call'){toolCalls++;progress('tool','tool_call');}
  else if(event.type==='tool_result')progress('checking','tool_result');
  else if(event.type==='text')progress('writing','text');
  else if(event.type==='thinking')progress('thinking','thinking');
  else if(event.type==='error'){streamError=String(event.message||'Harness 未完成本轮请求').slice(0,800);}
  else if(event.type==='final'){
   sawFinal=true;answer=typeof event.text==='string'?event.text:'';
   if(event.reason!==undefined)terminal=event.reason;
   progress('saving','final');
  }
 }
 return {
  push(chunk){buffer+=chunk;if(buffer.length>1200000&&!buffer.includes('\n'))throw Error('Harness 单条输出过大');let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);consume(line);}},
  finish(){if(buffer){consume(buffer);buffer='';}return {text:answer,sessionId,terminal,streamError,sawFinal,toolCalls};},
  sessionId:()=>sessionId
 };
}
