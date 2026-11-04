// Deliberately bounded local language intents. Ambiguous requests do not execute.
const spaces=[['圆形交流馆','PAV-CIRCLE'],['庭院书吧','PAV-COURT'],['折线商业街','PAV-MARKET'],['西区运动庭院','PARK-W'],['访客接待厅','GATE-VISITOR'],['数据中心','DATA-CENTER']];
export function campusIntent(value){
  if(typeof value!=='string'||value.length>600)return null;
  const goal=value.trim().replace(/[。！!]/g,'');
  if(/^(开启|关闭)(智能)?节电(?:模式)?$/.test(goal))return{type:'energy.configure',targetId:'campus',params:{enabled:goal.startsWith('开启'),idleSeconds:60,dimPercent:20},summary:'按占用调节普通房间照明，保留消防和通行照明'};
  const fire=goal.match(/^(开启|关闭)\s*(LIGHT-B\d{2}-F\d{2}-Z\d{2})\s*(?:模拟)?烟热源$/i);if(fire)return{type:'fire.source',targetId:fire[2].toUpperCase(),params:{active:fire[1]==='开启'},summary:'房间烟热源演练，探测器达到阈值后联动报警'};
  const transfer=goal.match(/^(?:将|把)?\s*(PARCEL-\d{2})\s*(?:送到|配送到|送往)\s*(\d+)\s*(?:楼|层)$/i);if(transfer)return{type:'delivery.transfer',targetId:transfer[1].toUpperCase(),params:{parcelId:transfer[1].toUpperCase(),floor:Number(transfer[2])},summary:'同楼宇实物取件、乘货梯跨层配送，忙碌时排队'};
  const device=goal.match(/^(开启|关闭)\s*(IOT-\d{6})$/i);if(device)return{type:'iot.set',targetId:device[2].toUpperCase(),params:{power:device[1]==='开启'},summary:`${device[2]} · ${device[1]}设备控制器，等待场景回执`};
  const employee=goal.match(/^(STAFF-\d{3})\s*(回工位|去食堂|下班)$/i);if(employee)return{type:'staff.dispatch',targetId:employee[1].toUpperCase(),params:{stage:({回工位:1,去食堂:2,下班:3})[employee[2]]},summary:`${employee[1]} · ${employee[2]}，按真实路线执行`};
  const notice=goal.match(/^通知\s*(STAFF-\d{3})[：: ]+(.+)$/i);if(notice)return{type:'staff.notify',targetId:notice[1].toUpperCase(),params:{message:notice[2]},summary:`通知 ${notice[1]} 的演示收件箱`};
  if(['显示基站数据流','隐藏基站数据流'].includes(goal))return{type:'network.overlay',targetId:'COMMS-N',params:{visible:goal.startsWith('显示')},summary:`${goal} · 仅切换逻辑拓扑显示，持续采样园区状态`};
  const scenario=goal.match(/^(?:切换到?|进入)?(办公|午餐|晚间)场景(?:[，, ]*(0\.25|0\.5|1)倍速)?$/);
  if(scenario)return{type:'sandbox.configure',targetId:'campus',params:{scenario:({办公:'work',午餐:'lunch',晚间:'evening'})[scenario[1]],speed:Number(scenario[2]||1)},summary:`${scenario[1]}场景 · ${scenario[2]||1}倍速；人员沿路线过渡，保持当前暂停状态`};
  const match=spaces.find(([name])=>goal===`${name}开灯`||goal===`${name}关灯`);
  if(match)return{type:'infrastructure.set',targetId:match[1],params:{enabled:goal.endsWith('开灯')},summary:`${match[0]} · ${goal.endsWith('开灯')?'开启':'关闭'}实体照明`};
  return null;
}
