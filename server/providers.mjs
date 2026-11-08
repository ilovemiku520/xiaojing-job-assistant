import {isIP} from 'node:net';

export const providerDefinitions=Object.freeze({
  harness:{label:'DeepSeek Harness'},
  deepseek:{label:'DeepSeek API',baseURL:'https://api.deepseek.com'},
  openai:{label:'OpenAI API',baseURL:'https://api.openai.com/v1'},
  anthropic:{label:'Anthropic API',baseURL:'https://api.anthropic.com/v1'},
  gemini:{label:'Google Gemini API',baseURL:'https://generativelanguage.googleapis.com/v1beta/openai'},
  dashscope:{label:'阿里云百炼（北京）',baseURL:'https://dashscope.aliyuncs.com/compatible-mode/v1'},
  compatible:{label:'其他 OpenAI 兼容 API'}
});
export const modelStages=Object.freeze(['owner','autonomy','greeting','reply','followup','learning']);
const effortOptions=['high','max'];
const modelName=/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/;

export function normalizeCompatibleBaseURL(input) {
  if(typeof input!=='string'||input.length>512)throw Error('兼容 API 地址无效');
  let url;
  try {url=new URL(input.trim());} catch {throw Error('兼容 API 地址无效');}
  const host=url.hostname.toLowerCase().replace(/\.$/,'');
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||
     isIP(host.replace(/^\[|\]$/g,''))||!host.includes('.')||
     /(?:^|\.)(localhost|local|internal|lan)$/.test(host)||url.pathname.includes('%')) {
    throw Error('兼容 API 地址必须是带域名的 HTTPS 基础地址');
  }
  url.hostname=host;
  return url.href.replace(/\/+$/,'').replace(/\/chat\/completions$/,'');
}

export function validateModelRouting(config,input) {
  if(input.compatibleBaseURL!==undefined) {
    config.compatibleBaseURL=input.compatibleBaseURL===''?'':normalizeCompatibleBaseURL(input.compatibleBaseURL);
  }
  if(input.modelRoutes!==undefined) {
    const routes=input.modelRoutes;
    if(!routes||typeof routes!=='object'||Array.isArray(routes))throw Error('模型路由必须按任务填写');
    config.modelRoutes={...config.modelRoutes};
    for(const [stage,route] of Object.entries(routes)) {
      if(!modelStages.includes(stage))throw Error('模型任务类型无效');
      if(route===null) {
        delete config.modelRoutes[stage];
        continue;
      }
      if(!route||typeof route!=='object'||Array.isArray(route)||!Object.hasOwn(providerDefinitions,route.provider)||
        typeof route.model!=='string'||!modelName.test(route.model)||
        (route.reasoningEffort!==undefined&&!effortOptions.includes(route.reasoningEffort))) {
        throw Error('模型路由的提供商、模型名称或推理强度无效');
      }
      config.modelRoutes[stage]={provider:route.provider,model:route.model,...(route.reasoningEffort?{reasoningEffort:route.reasoningEffort}:{})};
    }
  }
  if(Object.values(config.modelRoutes||{}).some(route=>route.provider==='compatible')&&!config.compatibleBaseURL) {
    throw Error('请填写兼容 API 基础地址');
  }
  return config;
}

export function resolveModelRoute(config,stage) {
  if(!modelStages.includes(stage))throw Error('模型任务类型无效');
  const override=config.modelRoutes?.[stage];
  const provider=override?.provider??(['owner','autonomy'].includes(stage)||config.backend!=='api'?'harness':'deepseek');
  return {
    provider,
    model:override?.model??config.model,
    reasoningEffort:override?.reasoningEffort??config.reasoningEffort??'high',
    baseURL:provider==='compatible'?normalizeCompatibleBaseURL(config.compatibleBaseURL):providerDefinitions[provider].baseURL
  };
}

function responseError(provider,status) {
  const reason=status===401||status===403?'：请检查密钥和模型权限':status===402?'：请检查余额':status===429?'：达到请求限制':'';
  return Object.assign(Error(`${providerDefinitions[provider].label} 请求失败（${status}）${reason}`),{httpStatus:status});
}

async function fetchCompletion(fetcher,endpoint,provider,headers,body,signal){
  let response;
  try {
    response=await fetcher(endpoint,{method:'POST',headers,redirect:'error',signal,body:JSON.stringify(body)});
  } catch(error) {
    if(error?.name==='TimeoutError'||signal.reason?.name==='TimeoutError')throw Error('模型请求超时');
    if(signal.aborted)throw Error('模型请求已停止');
    throw Error(`${providerDefinitions[provider].label} 连接失败，请检查网络和 API 地址`);
  }
  if(!response.ok)throw responseError(provider,response.status);
  try {return await response.json();} catch {throw Error('模型接口未返回有效 JSON');}
}

function toolRequest(data,isClaude){
  if(isClaude&&data?.stop_reason==='tool_use'&&Array.isArray(data.content)){
    if(!data.content.every(block=>['text','thinking','redacted_thinking','tool_use'].includes(block?.type)))throw Error('模型请求了无效的工具');
    return {assistant:{role:'assistant',content:data.content},calls:data.content.filter(block=>block?.type==='tool_use').map(block=>({id:block.id,name:block.name,args:block.input}))};
  }
  const choice=data?.choices?.[0],message=choice?.message;
  if(!isClaude&&choice?.finish_reason==='tool_calls'&&Array.isArray(message?.tool_calls)){
    const {content,tool_calls,reasoning_content}=message;
    const calls=tool_calls.map(call=>{
      let args;
      try {args=JSON.parse(call?.function?.arguments);} catch {}
      return {id:call?.id,name:call?.type==='function'?call.function?.name:undefined,args};
    });
    return {assistant:{role:'assistant',content:content??null,tool_calls,...(typeof reasoning_content==='string'?{reasoning_content}:{})},calls};
  }
}

export async function requestModel({route,key,system,payload,format='json',signal,fetcher=fetch,timeoutMs=60000,maxTokens=6000,ownerWebTool,onProgress}) {
  const {provider,model,reasoningEffort}=route;
  if(!Object.hasOwn(providerDefinitions,provider)||provider==='harness')throw Error('API 提供商无效');
  const baseURL=provider==='compatible'?normalizeCompatibleBaseURL(route.baseURL):providerDefinitions[provider].baseURL;
  if(!key)throw Error(`请先配置 ${providerDefinitions[provider].label} 密钥`);
  const isClaude=provider==='anthropic';
  const endpoint=baseURL+(isClaude?'/messages':'/chat/completions');
  const hide=value=>key.length>=8?value.replaceAll(key,'[凭据已隐藏]'):value;
  const content=typeof payload==='string'?hide(payload):JSON.stringify(payload,(_name,value)=>typeof value==='string'?hide(value):value);
  const requireJSON=format==='json';
  const instruction=hide(system)+(requireJSON?'\n只输出一个有效 JSON 对象。':'');
  const headers={'Content-Type':'application/json'};
  if(isClaude) {
    headers['x-api-key']=key;
    headers['anthropic-version']='2023-06-01';
  } else {
    headers.Authorization=`Bearer ${key}`;
    if(provider==='gemini')headers['x-goog-api-client']='xiaojing-boss/0.13.0';
  }
  const body=isClaude
    ? {model,system:instruction,messages:[{role:'user',content}],max_tokens:maxTokens,stream:false}
    : {model,messages:[{role:'system',content:instruction},{role:'user',content}],stream:false,
       ...(provider==='openai'?{max_completion_tokens:maxTokens}:{max_tokens:maxTokens}),
       ...(requireJSON&&['deepseek','openai'].includes(provider)?{response_format:{type:'json_object'}}:{}),
       ...(provider==='deepseek'?{reasoning_effort:reasoningEffort||'high',thinking:{type:'enabled'}}:{})};
  const tool=!requireJSON&&ownerWebTool;
  if(tool){
    const {name,description,inputSchema}=tool;
    body.tools=[isClaude?{name,description,input_schema:inputSchema}:{type:'function',function:{name,description,parameters:inputSchema}}];
  }
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)].filter(Boolean));
  let count=0;
  let data;
  while(true){
    bounded.throwIfAborted();
    data=await fetchCompletion(fetcher,endpoint,provider,headers,body,bounded);
    const request=tool&&toolRequest(data,isClaude);
    if(!request)break;
    const {assistant,calls}=request;
    if(!calls.length||count+calls.length>3||calls.some(call=>typeof call.id!=='string'||call.name!==tool.name||!call.args)){
      throw Error('模型请求了无效的工具，或超出本轮公开网页读取次数');
    }
    body.messages.push(assistant);
    const results=[];
    for(const call of calls){
      bounded.throwIfAborted();
      onProgress?.({stage:'tool',type:'tool_call',toolCalls:++count});
      let content,isError=false;
      try {content=hide(JSON.stringify(await tool.call(call.args,bounded)));}
      catch {content='未能读取此地址。请向主人说明并根据已有资料作答。';isError=true;}
      results.push(isClaude?{type:'tool_result',tool_use_id:call.id,content,is_error:isError}:{role:'tool',tool_call_id:call.id,content});
    }
    if(isClaude)body.messages.push({role:'user',content:results});
    else body.messages.push(...results);
    onProgress?.({stage:'checking',type:'tool_result',toolCalls:count});
  }
  const choice=data?.choices?.[0];
  const complete=isClaude
    ? data?.stop_reason==='end_turn'&&Array.isArray(data.content)&&data.content.every(block=>block?.type==='text'||block?.type==='thinking'||block?.type==='redacted_thinking')
    : choice?.finish_reason==='stop'&&!choice.message?.tool_calls?.length&&!choice.message?.function_call&&!choice.message?.refusal;
  if(!complete)throw Error('模型输出未完整结束，本次不发送');
  const answer=isClaude?data.content.filter(block=>block.type==='text').map(block=>block.text).join(''):choice.message?.content;
  if(typeof answer!=='string'||!answer.trim())throw Error('模型没有返回正文');
  const sanitized=hide(answer).trim();
  if(!requireJSON)return sanitized;
  try {
    const value=JSON.parse(sanitized.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error();
    return value;
  } catch {throw Error('模型没有返回有效 JSON，本次不发送');}
}
