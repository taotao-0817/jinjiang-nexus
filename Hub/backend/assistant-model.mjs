import {ApiError} from './service.mjs';

// DeepSeek chooses tools and receives their results; no keyword router precedes it.
export async function callAssistantModel(planner,messages,tools,signal){
  const c=planner.config,key=planner.credential();
  if(c.mode!=='model'||!key||!c.baseUrl||!c.model)throw new ApiError(503,'MODEL_NOT_CONFIGURED','请先配置 DeepSeek 接口；自然语言中枢不会退回关键词匹配。');
  const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,c.timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
  try{
    const body={model:c.model,messages,tools,tool_choice:'auto',max_tokens:3200,thinking:{type:'disabled'}};
    const r=await fetch(c.baseUrl+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(body),signal:controller.signal,redirect:'error'});
    if(!r.ok)throw new ApiError(502,r.status===401||r.status===403?'MODEL_AUTH_ERROR':'MODEL_UPSTREAM_ERROR',`DeepSeek 接口返回 ${r.status}，本轮未执行新的设备动作。`);
    const chunks=[];let bytes=0;for await(const b of r.body){bytes+=b.length;if(bytes>1048576)throw new ApiError(502,'MODEL_INVALID_OUTPUT','模型返回内容过大');chunks.push(b);}
    const raw=Buffer.concat(chunks).toString();if(raw.includes(key))throw new ApiError(502,'MODEL_INVALID_OUTPUT','模型返回了不允许的内容');
    let data;try{data=JSON.parse(raw);}catch{throw new ApiError(502,'MODEL_INVALID_OUTPUT','模型返回格式异常');}
    const m=data.choices?.[0]?.message;
    if(!m||m.role!=='assistant'||(m.content!=null&&typeof m.content!=='string')||!Array.isArray(m.tool_calls||[])||(m.tool_calls||[]).length>12)throw new ApiError(502,'MODEL_INVALID_OUTPUT','模型工具调用格式异常');
    for(const t of m.tool_calls||[])if(t.type!=='function'||typeof t.id!=='string'||typeof t.function?.name!=='string'||typeof t.function?.arguments!=='string')throw new ApiError(502,'MODEL_INVALID_OUTPUT','模型工具参数格式异常');
    planner.verified=true;planner.lastError=null;planner.lastSuccessAt=new Date().toISOString();
    return {role:'assistant',content:m.content||null,...(m.tool_calls?.length?{tool_calls:m.tool_calls}: {})};
  }catch(e){const err=e instanceof ApiError?e:new ApiError(502,controller.signal.aborted?'MODEL_TIMEOUT':'MODEL_UNAVAILABLE',controller.signal.aborted?'DeepSeek 请求超时；已提交的动作仍可在回执中查看。':'DeepSeek 暂时不可用；已提交的动作不会重复执行。');planner.lastError=err.code;throw err;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
