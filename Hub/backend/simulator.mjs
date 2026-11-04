// Independent protocol adapter simulator. Never connects to physical devices.
const endpoint=(process.env.API_BASE||process.env.API_URL||`http://127.0.0.1:${process.env.PORT||8787}`).replace(/\/$/,'');
const token=process.env.SIMULATOR_TOKEN||'bailuwan-local-simulator-change-me';
const interval=Math.max(100,Number(process.env.SIMULATOR_INTERVAL_MS)||2000);
let stopping=false;let connected=false;
async function tick(){
  if(stopping)return;
  try{const response=await fetch(`${endpoint}/api/simulator/tick`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error(`HTTP ${response.status}`);if(!connected)console.log(`设备模拟器已连接 ${endpoint} · 每 ${interval} ms 推送一次`);connected=true;}
  catch(e){if(connected)console.error(`设备模拟器连接中断：${e.message}`);connected=false;}
  if(!stopping)setTimeout(tick,interval);
}
console.log('Starting simulated device adapter. No physical device connections.');tick();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;process.exit(0);});
