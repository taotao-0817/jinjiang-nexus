import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
// A packaged desktop host can redirect LocalAppData to its own LocalCache.
// User-profile configuration is shared by Explorer and development launches.
// Executable startup only: createApp/library tests never inherit a private key.
export function loadPrivateModelConfig(explicitPath=process.env.NEXUS_MODEL_CONFIG){
  const canonical=join(homedir(),'.jinjiang-nexus','model.json');
  const legacy=join(process.env.LOCALAPPDATA||join(homedir(),'Library','Application Support'),'JinjiangNexus','model.json');
  const path=explicitPath||[canonical,legacy].find(p=>existsSync(p));
  if(!path)return {mode:'model',provider:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash',protocol:'chat_completions',apiKeyFile:join(homedir(),'.jinjiang-nexus','Secrets','deepseek.key')};
  if(!existsSync(path))throw new Error('指定的本机模型配置文件不存在，请检查 NEXUS_MODEL_CONFIG');
  const config=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
  const allowed=['mode','provider','baseUrl','model','protocol','apiKeyFile','timeoutMs'];
  if(!config||Array.isArray(config)||Object.keys(config).some(k=>!allowed.includes(k)))throw new Error('本机模型配置字段无效');
  if(config.provider==='deepseek'&&(config.baseUrl!=='https://api.deepseek.com'||config.model!=='deepseek-flash'||config.protocol!=='chat_completions'))throw new Error('DeepSeek 配置必须使用官方地址、deepseek-flash 和 chat_completions');
  return config;
}
