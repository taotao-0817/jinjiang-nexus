import {mkdirSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {loadPrivateModelConfig} from './model-config.mjs';
import {ModelPlanner} from './llm.mjs';

class SetupError extends Error{}
function restrictWindowsDirectory(dir){
 if(process.platform!=='win32')return;
 const who=spawnSync(join(process.env.SystemRoot||'C:\\Windows','System32','whoami.exe'),['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});
 const sid=who.stdout?.match(/S-1-5-[\d-]+/)?.[0];
 if(who.status!==0||!sid)throw new SetupError('无法确认当前 Windows 用户，未保存密钥。');
 const acl=spawnSync(join(process.env.SystemRoot||'C:\\Windows','System32','icacls.exe'),[dir,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F'],{encoding:'utf8',windowsHide:true});
 if(acl.status!==0)throw new SetupError('无法设置私有目录权限，未保存密钥。');
}
export async function configurePrivateModel(input,{home=homedir(),explicitPath=process.env.NEXUS_MODEL_CONFIG,fetchImpl=fetch}={}){
 const key=typeof input==='string'?input.trim():'';
 if(!/^[^\s]{12,512}$/.test(key))throw new SetupError('API Key 格式不正确，请粘贴完整密钥。');
 const dir=join(home,'.jinjiang-nexus'),configPath=join(dir,'model.json');
 if(explicitPath&&resolve(explicitPath)!==resolve(configPath))throw new SetupError('当前设置了 NEXUS_MODEL_CONFIG，请移除该环境变量后使用本机配置窗口，或更新它指定的文件。');
 let response;
 try{response=await fetchImpl('https://api.deepseek.com/chat/completions',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'content-type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({model:'deepseek-flash',messages:[{role:'user',content:'请仅回复：连接成功'}],max_tokens:24,thinking:{type:'disabled'}})});}
 catch{throw new SetupError('无法连接 DeepSeek，请检查网络后重试。密钥尚未保存。');}
 if(!response.ok){await response.body?.cancel();throw new SetupError(response.status===401||response.status===403?'密钥无效或没有模型权限，请核对后重试。':response.status===402?'DeepSeek 账户余额不足，请充值后重试。':response.status===429?'DeepSeek 请求受限，请稍后重试。':`DeepSeek 返回 ${response.status}，请稍后重试。`);}
 try{
  let bytes=0;const chunks=[];for await(const chunk of response.body){bytes+=chunk.length;if(bytes>65536)throw Error();chunks.push(chunk);}
  const data=JSON.parse(Buffer.concat(chunks).toString());if(typeof data.choices?.[0]?.message?.content!=='string')throw Error();
 }catch{throw new SetupError('DeepSeek 返回内容异常，未保存密钥。');}
 const secrets=join(dir,'Secrets'),keyPath=join(secrets,'deepseek-'+randomUUID()+'.key'),tempPath=join(dir,'.model-'+randomUUID()+'.tmp');
 try{
  mkdirSync(secrets,{recursive:true,mode:0o700});restrictWindowsDirectory(dir);restrictWindowsDirectory(secrets);
  writeFileSync(keyPath,key,{encoding:'utf8',mode:0o600,flag:'wx'});
  const config={mode:'model',provider:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash',protocol:'chat_completions',apiKeyFile:keyPath};
  writeFileSync(tempPath,JSON.stringify(config,null,2),{encoding:'utf8',mode:0o600,flag:'wx'});renameSync(tempPath,configPath);
 }catch(e){for(const path of [tempPath,keyPath]){try{unlinkSync(path);}catch{}}throw e instanceof SetupError?e:new SetupError('连接成功，但无法保存本机配置，请检查用户目录的写入权限。');}
 return {configured:true,verified:true,model:'deepseek-flash',message:'DeepSeek 连接成功，已保存到当前电脑。'};
}
async function main(){
 if(process.argv.includes('--status')){
  try{const state=new ModelPlanner(loadPrivateModelConfig()).status(),configured=state.mode==='model'&&state.configured;console.log(JSON.stringify({configured,model:state.model}));process.exitCode=configured?0:3;}
  catch{console.log(JSON.stringify({configured:false,message:'本机配置无法读取，请重新配置 DeepSeek。'}));process.exitCode=3;}
  return;
 }
 if(!process.argv.includes('--configure'))throw new SetupError('请选择本机配置操作。');
 let input='';for await(const chunk of process.stdin){input+=chunk.toString('utf8');if(input.length>1024)throw new SetupError('API Key 格式不正确。');}
 console.log(JSON.stringify(await configurePrivateModel(input)));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){main().catch(e=>{console.log(JSON.stringify({configured:false,message:e instanceof SetupError?e.message:'本机配置失败，请检查网络或目录权限。'}));process.exitCode=1;});}
