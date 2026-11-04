import {randomUUID} from 'node:crypto';
import {now} from './store.mjs';
import {ApiError} from './service.mjs';
const uuid=p=>p+'-'+randomUUID().slice(0,8).toUpperCase();
const admins=['super_admin','park_admin'];
const terminal=new Set(['completed','failed','rejected','cancelled']);
const occupied=new Set(['running','paused','waiting_human']);
const titles={delivery:'物品配送',patrol:'区域巡查',meeting:'会议安排',fire:'火情处置',fall:'跌倒协助'};
const fail=(status,code,message,details)=>{throw new ApiError(status,code,message,details);};
const required=(v,label,max=1000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(400,'VALIDATION_ERROR',label+'应为非空文本，最多'+max+'字');return v.trim();};
const numeric=(v,min,max,label)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail(400,'VALIDATION_ERROR',label+'须在'+min+'至'+max+'之间');return v;};

// Only quantities evidenced in the operator's original goal or explicit total-weight field count.
function declaredWeight(goal,field){
  if(field!=null)return numeric(field,.01,20,'总载重（kg）');
  const ask=()=>fail(400,'WEIGHT_REQUIRED','请填写物品的总重量（kg），或明确写出如“八公斤”或“500克”。');
  const input=goal.normalize('NFKC');
  const masses=[...input.matchAll(/([负+-]?(?:[0-9.]+|[半零〇一二两三四五六七八九十百千万点]+))\s*(公斤|千克|kg|斤|克|g)(?![a-z])/gi)];
  if(masses.length!==1)return ask();
  const match=masses[0],prefix=input.slice(0,match.index);
  if(/(?:至|到|[-~～—]|每(?:件|箱|份|个|包|袋)(?:重|约)?)\s*$/.test(prefix.replace(/(到|至)\s*$/,'$1'))&&/[零〇一二两三四五六七八九十\d]\s*(?:至|到|[-~～—])\s*$|每(?:件|箱|份|个|包|袋)(?:重|约)?\s*$/.test(prefix))return ask();
  const quantity=match[1],unit=match[2].toLowerCase();
  if(/[负+-]/.test(quantity))return ask();
  const digits='零一二三四五六七八九';
  const digit=c=>digits.indexOf(c==='两'?'二':c==='〇'?'零':c);
  function chineseNumber(value){
    if(value==='半')return .5;
    const [whole,fraction,...rest]=value.split('点');
    if(rest.length||!whole)return NaN;
    let result;
    if(whole.length===1&&digit(whole)>=0)result=digit(whole);
    else if(/^[一二两三四五六七八九]?十[一二三四五六七八九]?$/.test(whole)){
      const [tens,units]=whole.split('十');
      result=(tens?digit(tens):1)*10+(units?digit(units):0);
    }else return NaN;
    if(fraction!==undefined){
      if(!fraction||[...fraction].some(c=>digit(c)<0))return NaN;
      result+=Number('0.'+[...fraction].map(digit).join(''));
    }
    return result;
  }
  const value=/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(quantity)?Number(quantity):chineseNumber(quantity);
  if(!Number.isFinite(value))return ask();
  const kg=unit==='g'||unit==='克'?value/1000:unit==='斤'?value/2:value;
  return numeric(kg,.01,20,'总载重（kg）');
}
const stepsFor=type=>({delivery:['目标解析与能力匹配','路线与电量安全校验','最近可用资源自动派发','运输执行回执','人工交接与归档'],patrol:['目标解析与能力匹配','资源复核与路线派发','巡检执行与遥测','结果归档'],meeting:['时间人数解析与空间匹配','复核时段并确认预订','记录参会通知（模拟）','反馈预订结果'],fire:['记录来源与安全通知（模拟）','能力匹配与风险检查','管理员确认高风险联动','设备指令与执行回执','人工处置、复核与归档'],fall:['记录来源与安全通知（模拟）','匹配现场协助人员','管理员确认协调方案','协调人员到场（模拟）','人工确认协助结果']})[type].map((name,i)=>({id:'step-'+(i+1),name,status:i===0?'completed':'pending'}));

export function seedHub(store){
  if(store.setting('hubSeedVersion'))return;
  store.transaction(()=>{
    const buildings=store.all('buildings');
    for(const [i,b] of buildings.entries()){
      if(i<6)store.put('rooms',{id:'ROOM-'+String(i+1).padStart(2,'0'),name:b.name+' · '+(i%2?'协作室':'白鹭会议室'),buildingId:b.id,floor:Math.min(2,b.floors),capacity:[8,12,20,6,16,30][i],equipment:['显示屏','视频会议'],status:'available'});
    }
    for(const [i,name,capabilities] of [[0,'北区安保值班员',['safety.respond','assistance.coordinate','notify']],[3,'东区安全协调员',['safety.respond','assistance.coordinate','notify']],[6,'南区现场协助员',['safety.respond','assistance.coordinate','notify']]]){
      const b=buildings[i]||buildings[0];store.put('responders',{id:'RESP-'+String(i+1).padStart(2,'0'),name,buildingId:b.id,floor:1,capabilities,status:'available',description:'模拟岗位资源；不含个人敏感信息，不提供医疗诊断'});
    }
    store.setting('hubSeedVersion',1);store.audit('系统','hub.initialized','hub',{version:'1.1.0',mode:'rules_simulation'});
  });
}

export class HubService{
  constructor(park){this.park=park;this.store=park.store;}
  resources(){
    const buildings=this.store.all('buildings'),tasks=this.store.all('hub_tasks');
    const point=(buildingId,floor=0)=>{const b=buildings.find(x=>x.id===buildingId);return{x:b?.x||0,y:floor*3.1,z:b?.z||0};};
    const jobs=[...this.store.all('patrols'),...this.store.all('deliveries')];
    const busyFor=(resourceId,sourceId)=>tasks.find(t=>occupied.has(t.status)&&!(t.type==='delivery'&&t.status==='waiting_human')&&t.resourceIds.includes(resourceId))||jobs.find(j=>['queued','running','paused','returning'].includes(j.status)&&(j.robotId===sourceId||j.vehicleId===sourceId));
    const semantic={light:['lighting.control'],hvac:['hvac.control'],window:['window.control'],sensor:['environment.sense'],robot:['move.ground','inspect','environment.sense'],drone:['move.air','carry','deliver'],delivery_robot:['move.ground','carry','deliver']};
    const devices=this.store.all('devices').map(d=>{const resourceId='device:'+d.id,busy=busyFor(resourceId,d.id),mobile=['robot','drone','delivery_robot'].includes(d.type);return{id:resourceId,sourceId:d.id,name:d.name,kind:mobile?'robot':'device',type:d.type,buildingId:d.buildingId,floor:d.floor,position:d.position||point(d.buildingId,d.floor),status:d.status==='offline'?'offline':mobile&&d.state.battery!=null&&d.state.battery<25?'low_battery':busy?'busy':'available',capabilities:semantic[d.type]||[],limits:{...(mobile?{battery:d.state.battery,maxWeight:d.type==='drone'?5:d.type==='delivery_robot'?20:0}:{}),routeBlocked:!!d.state.routeBlocked},activeTaskId:busy?.id||null,description:d.adapter==='native'?'UE实体遥测；未模拟的电量显示未知':'模拟适配器：状态直接派生自设备与业务任务'};});
    const rooms=this.store.all('rooms').map(room=>({id:'space:'+room.id,sourceId:room.id,name:room.name,kind:'space',type:'meeting_room',buildingId:room.buildingId,floor:room.floor,position:point(room.buildingId,room.floor),status:room.status==='offline'?'offline':this.store.all('bookings').some(b=>b.roomId===room.id&&b.status==='confirmed'&&Date.parse(b.startAt)<=Date.now()&&Date.parse(b.endAt)>Date.now())?'reserved':'available',capabilities:['meeting.host'],limits:{capacity:room.capacity},description:room.equipment.join(' / ')}));
    const people=this.store.all('responders').map(p=>{const busy=busyFor('person:'+p.id,p.id);return{id:'person:'+p.id,sourceId:p.id,name:p.name,kind:'person',type:'responder',buildingId:p.buildingId,floor:p.floor,position:point(p.buildingId,p.floor),status:p.status==='offline'?'offline':busy?'busy':'available',capabilities:p.capabilities,limits:{},activeTaskId:busy?.id||null,description:p.description};});
    const areas=buildings.map(b=>({id:'area:'+b.id,sourceId:b.id,name:b.name,kind:'area',type:'building',buildingId:b.id,floor:0,position:point(b.id),status:'available',capabilities:['space.locate'],limits:{floors:b.floors},description:b.usage}));
    return[...devices,...rooms,...people,...areas];
  }
  bootstrap(user){
    this.sync();
    const privileged=admins.includes(user.role)||['security','ops','approver'].includes(user.role);
    const tasks=this.store.all('hub_tasks').filter(t=>privileged||t.requesterId===user.id).reverse();
    const ids=new Set(tasks.map(t=>t.id));
    const resources=this.resources();
    return{version:'1.1.0',mode:'rules_simulation',resources,tasks,notifications:this.store.all('notifications').filter(n=>ids.has(n.taskId)).reverse(),rooms:this.store.all('rooms'),responders:privileged?this.store.all('responders'):[],capabilities:[...new Set(resources.flatMap(r=>r.capabilities))],taskTypes:Object.entries(titles).map(([id,name])=>({id,name})),stats:{resources:resources.length,activeTasks:tasks.filter(t=>!terminal.has(t.status)).length,awaitingConfirmation:tasks.filter(t=>t.status==='awaiting_confirmation').length,completed:tasks.filter(t=>t.status==='completed').length}};
  }
  authorize(user,type,action='plan',task){
    if(!Object.hasOwn(titles,type))fail(400,'UNKNOWN_TASK_TYPE','仅支持配送、巡查、会议、火情与跌倒协助五类任务');
    if(type==='meeting'){if(task&&task.requesterId!==user.id&&!admins.includes(user.role))fail(403,'FORBIDDEN','只能操作本人发起的会议任务');return;}
    if(action==='plan'&&type==='delivery'){this.park.require(user,'delivery');return;}
    if(['fire','fall'].includes(type)){this.park.require(user,action==='plan'?'security':'emergency');return;}
    this.park.require(user,type==='patrol'?'patrol':'delivery');
  }
  location(value,label){const b=this.store.all('buildings').find(b=>b.id===value||b.code.toLowerCase()===String(value||'').toLowerCase()||b.name===value);if(!b)fail(400,'LOCATION_REQUIRED',label+'未识别，请从园区建筑中明确选择');return b.id;}
  parse(body){
    const goal=required(body.goal,'任务目标',1200),p={...(body.params||{})};
    if(body.params&&(typeof body.params!=='object'||Array.isArray(body.params)))fail(400,'VALIDATION_ERROR','params 必须为对象');
    let type=body.type;
    if(!type){const matches=[['fall',/跌倒|摔倒/],['fire',/烟雾|烟感|火情|火灾|温度异常/],['meeting',/会议|开会|会议室/],['patrol',/巡检|巡查|检查区域/],['delivery',/配送|送到|送往|递送|运送/]].filter(([,re])=>re.test(goal));if(matches.length!==1)fail(400,'AMBIGUOUS_GOAL','未能唯一识别任务类型，请选择任务类型并补充地点等条件');type=matches[0][0];}
    if(!Object.hasOwn(titles,type))fail(400,'UNKNOWN_TASK_TYPE','任务类型不支持');
    const mentioned=this.store.all('buildings').map(b=>{const offsets=[b.name,b.code,b.id].map(alias=>goal.toLowerCase().indexOf(alias.toLowerCase())).filter(i=>i>=0);return{b,index:offsets.length?Math.min(...offsets):-1};}).filter(v=>v.index>=0).sort((a,b)=>a.index-b.index).map(v=>v.b.id);
    if(type==='delivery'){
      const afterAnchor=(anchors)=>{const hits=[];for(const b of this.store.all('buildings'))for(const alias of [b.name,b.code,b.id])for(const anchor of anchors){const match=goal.toLowerCase().match(new RegExp(anchor+'\\s*'+alias.toLowerCase()));if(match)hits.push({id:b.id,index:match.index,length:alias.length});}hits.sort((a,b)=>a.index-b.index||b.length-a.length);const ids=[...new Set(hits.map(h=>h.id))];if(ids.length>1)fail(400,'AMBIGUOUS_LOCATION','任务包含多个起点或终点，请在结构化条件中明确选择');return ids[0];};
      const anchoredFrom=p.from||afterAnchor(['从','由','起点[：:]?']);const anchoredTo=p.to||afterAnchor(['配送至','送到','送往','运往','递送至','到','终点[：:]?']);
      if(!anchoredFrom||!anchoredTo)fail(400,'LOCATION_REQUIRED','配送目标请明确使用“从起点配送到终点”，或填写结构化起终点');
      p.from=this.location(anchoredFrom,'配送起点');p.to=this.location(anchoredTo,'配送终点');if(p.from===p.to)fail(400,'SAME_LOCATION','起点和终点不能相同');
      const submittedWeight=Object.hasOwn(body,'submittedWeight')?body.submittedWeight:p.weight;
      p.weight=declaredWeight(goal,submittedWeight);
      p.recipient=typeof p.recipient==='string'?p.recipient.trim():(goal.match(/(?:交给|收件人[：:]?)\s*([^，。；,;]+)/)?.[1]?.trim()||'目的地交接岗位');if(p.recipient.length>80)fail(400,'VALIDATION_ERROR','收件岗位最多80字');
    }else{
      if(p.buildingId||mentioned.length)p.buildingId=this.location(p.buildingId||mentioned[0],'目标位置');
      else if(type!=='meeting')fail(400,'LOCATION_REQUIRED','请明确目标建筑名称或编号');
      if(mentioned.length>1&&!body.params?.buildingId)fail(400,'AMBIGUOUS_LOCATION','任务中出现多个建筑，请明确目标区域');
      const chineseFloor={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8};const fm=goal.match(/([1-9一二三四五六七八])\s*(?:层|楼|F)/i);p.floor=p.floor??(fm?(chineseFloor[fm[1]]||Number(fm[1])):1);
      const building=p.buildingId?this.store.get('buildings',p.buildingId):null;if(building)numeric(p.floor,1,building.floors,'楼层');
    }
    if(type==='meeting'){
      p.participants=numeric(p.participants??Number(goal.match(/([0-9]+)\s*人/)?.[1]||0),1,100,'参会人数');
      if(!Number.isInteger(p.participants))fail(400,'VALIDATION_ERROR','参会人数必须是整数');
      const start=Date.parse(p.startAt),end=Date.parse(p.endAt);if(!Number.isFinite(start)||!Number.isFinite(end)||start<=Date.now()||end<=start||end-start>12*3600000)fail(400,'TIME_RANGE_REQUIRED','请填写未来的开始和结束时间，单次会议最长12小时');p.startAt=new Date(start).toISOString();p.endAt=new Date(end).toISOString();
      if(p.attendees!==undefined&&(!Array.isArray(p.attendees)||p.attendees.length>100||p.attendees.some(a=>typeof a!=='string'||a.length>80)))fail(400,'VALIDATION_ERROR','参会岗位应为最多100个短文本');p.attendees=p.attendees?.length?p.attendees:[goal.match(/为([^，。；,;]{1,80}?)安排/)?.[1]?.trim()||'会议组织者'];
    }
    return{goal,type,params:p};
  }
  matching(type,p,taskId){
    if(type==='delivery'&&this.park.native?.enabled){
      const parcels=this.park.native.session?.telemetry?.parcels||[],parcel=parcels.find(x=>x.id===p.parcelId),valid=parcel&&parcel.buildingId===p.to;
      return{requiredCapabilities:['carry','deliver'],selection:valid?[{resourceId:'parcel:'+parcel.id,name:parcel.id,capabilities:['carry','deliver'],reason:'绑定本次UE运行中已有的持续实体包裹及固定收件楼层',score:100}]:[],candidates:parcels.map(x=>({resourceId:'parcel:'+x.id,name:x.id,eligible:x.id===p.parcelId&&x.buildingId===p.to,reasons:x.buildingId===p.to?[]:['固定收件建筑不同']})),available:!!valid,error:valid?null:'请指定本次实体批次 PARCEL-00 至 PARCEL-15，且目标建筑须与固定包裹一致；系统不会生成虚假包裹'};
    }
    if(type==='delivery'){
      const task=this.store.get('hub_tasks',taskId),legacyId=task?.businessRefs?.deliveryId;
      const decision=this.park.deliveryDecision(p,legacyId||taskId);
      const selected=decision.selected,resource=selected?this.resources().find(r=>r.id===selected.resourceId):null;
      return{requiredCapabilities:['carry','deliver'],selection:selected?[{resourceId:selected.resourceId,name:selected.name,capabilities:resource?.capabilities||['carry','deliver'],reason:selected.reason,score:selected.score,routePlan:{...selected.routePlan,reason:selected.reason}}]:[],candidates:decision.candidates.map(c=>({...c,routeMetrics:{pickupDistanceMeters:c.routePlan?.pickupDistanceMeters,deliveryDistanceMeters:c.routePlan?.deliveryDistanceMeters,distanceMeters:c.routePlan?.distanceMeters,estimatedBatteryUse:c.routePlan?.estimatedBatteryUse,batteryAfterEstimate:c.routePlan?.batteryAfterEstimate}})),available:!!selected,error:selected?null:'没有满足当前位置、载重、电量储备和任务占用条件的配送设备：'+decision.candidates.map(c=>c.name+'（'+c.reasons.join('、')+'）').join('；')};
    }

    const requiredCapabilities={delivery:['carry','deliver'],patrol:['inspect','environment.sense'],meeting:['meeting.host'],fire:['safety.respond'],fall:['assistance.coordinate']}[type];
    const targetId=p.from||p.buildingId||p.to;const target=targetId?this.store.get('buildings',targetId):null;const pool=this.resources().filter(r=>type==='delivery'?['drone','delivery_robot'].includes(r.type):type==='patrol'?r.type==='robot':type==='meeting'?r.kind==='space':r.kind==='person');
    const candidates=pool.map(r=>{const reasons=[];const own=r.activeTaskId===taskId;for(const cap of requiredCapabilities)if(!r.capabilities.includes(cap))reasons.push('缺少能力：'+cap);if(['offline','low_battery'].includes(r.status))reasons.push(r.status==='offline'?'资源离线':'电量不足25%');if(['busy','reserved'].includes(r.status)&&!own&&type!=='meeting')reasons.push('已被其他任务占用');if(r.limits.routeBlocked)reasons.push('当前路线阻塞');if(type==='delivery'&&r.limits.maxWeight<p.weight)reasons.push('载重上限不足');if(type==='meeting'){if(r.status==='offline')reasons.push('会议空间不可用');if(r.limits.capacity<p.participants)reasons.push('容量不足');if(p.buildingId&&r.buildingId!==p.buildingId)reasons.push('不在指定建筑');if(this.store.all('bookings').some(b=>b.taskId!==taskId&&b.roomId===r.sourceId&&b.status==='confirmed'&&Date.parse(b.startAt)<Date.parse(p.endAt)&&Date.parse(b.endAt)>Date.parse(p.startAt)))reasons.push('该时段已有预订');}
      const distance=target?Math.hypot((r.position.x||0)-target.x,(r.position.z||0)-target.z):0;const score=Math.round(100-distance*.5+(r.limits.battery||0)*.05-(type==='meeting'?(r.limits.capacity-p.participants)*.2:0));return{resourceId:r.id,name:r.name,eligible:!reasons.length,reasons,score,resource:r};
    }).sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.score-a.score||a.resourceId.localeCompare(b.resourceId));
    const best=candidates.find(c=>c.eligible);let selection=best?[{resourceId:best.resourceId,name:best.name,capabilities:best.resource.capabilities,reason:'能力匹配、状态可用；结合位置、电量或容量评分 '+best.score,score:best.score}]:[];
    if(type==='fire')selection.push(...this.resources().filter(r=>r.buildingId===p.buildingId&&['lighting.control','hvac.control'].some(c=>r.capabilities.includes(c))&&r.status!=='offline').map(r=>({resourceId:r.id,name:r.name,capabilities:r.capabilities,reason:'目标建筑联动设备，执行仍需管理员确认与设备回执',score:100})));
    const missingFire=type==='fire'?['lighting.control','hvac.control'].filter(cap=>!selection.some(r=>r.capabilities.includes(cap))):[];
    const available=!!best&&!missingFire.length;
    const error=missingFire.length?'目标建筑缺少在线的消防演练联动能力：'+missingFire.join('、')+'；请恢复资源后重新规划':best?null:'没有满足能力、位置与可用状态的资源：'+candidates.map(c=>c.name+'（'+c.reasons.join('、')+'）').join('；');
    return{requiredCapabilities:type==='fire'?[...requiredCapabilities,'lighting.control','hvac.control']:requiredCapabilities,selection,candidates:candidates.map(({resource,...c})=>c),available,error};
  }
  plan(user,body){
    return this.park.once(user,'hub.plan',body,()=>{
      const parsed=this.parse(body);
      this.authorize(user,parsed.type);
      const taskId=uuid('HUB'),match=this.matching(parsed.type,parsed.params,taskId);
      const high=['fire','fall'].includes(parsed.type);
      const dispatchRequested=parsed.type==='delivery'&&body.automaticDelivery===true;
      const target=parsed.params.to||parsed.params.buildingId;
      let riskReason='执行前再次校验资源与状态';
      if(parsed.type==='fire')riskReason='目标建筑照明与空调联动须管理员确认';
      if(parsed.type==='fall')riskReason='涉及人员安全，先通知值班岗位，调度与结案须人工确认';
      if(parsed.type==='delivery')riskReason=dispatchRequested?'已明确选择配送。系统核验取件距离、载重和剩余电量后派发。':'先核对起终点、载重与收件人，确认调度后再派发。';
      const t={
        id:taskId,...parsed,title:titles[parsed.type]+' · '+(this.store.get('buildings',target||'')?.name||'园区'),
        origin:'goal',status:!match.available?'blocked':high?'awaiting_confirmation':'planned',progress:10,
        requiredCapabilities:match.requiredCapabilities,resourceIds:match.selection.map(r=>r.resourceId),
        selection:match.selection,candidates:match.candidates,risk:high?'high':parsed.type==='delivery'?'medium':'low',
        riskReason,steps:stepsFor(parsed.type),timeline:[{at:now(),actor:user.name,action:'plan',
          note:body.interpretation?.source==='model'?'模型完成目标理解，后端校验参数、能力与资源边界':'结构化或规则输入已校验，后端匹配资源能力'}],
        businessRefs:{},result:null,error:match.error||null,createdAt:now(),updatedAt:now(),
        requesterId:user.id,requester:user.name,interpretation:this.interpretationMetadata(body.interpretation)
      };
      this.store.put('hub_tasks',t);
      this.park.record(user,'hub.plan',t.id,{goal:t.goal,type:t.type,params:t.params,selection:t.selection,status:t.status,dispatchRequested});
      this.park.changed('hub');
      return dispatchRequested&&match.available?this.execute(user,t):t;
    });
  }
  interpretationMetadata(value){
    if(!value||typeof value!=='object')return null;
    const clean={};for(const key of ['source','provider','model','summary','confidence','requestId','latencyMs','durationMs','status','schemaVersion']){const v=value[key];if(typeof v==='string')clean[key]=v.slice(0,key==='summary'?1000:160);else if(typeof v==='number'&&Number.isFinite(v))clean[key]=v;}
    if(value.usage&&typeof value.usage==='object')clean.usage=Object.fromEntries(['input_tokens','output_tokens','total_tokens'].filter(k=>Number.isFinite(value.usage[k])).map(k=>[k,value.usage[k]]));return clean;
  }
  notify(t,recipient,message){const n={id:uuid('NOTE'),taskId:t.id,channel:'in_app_simulation',recipient,message,status:'recorded',createdAt:now()};this.store.put('notifications',n);return n;}
  event(user,body){this.park.require(user,'security');if(!['fire','fall'].includes(body.type))fail(400,'VALIDATION_ERROR','事件类型仅限 fire 或 fall');return this.park.once(user,'hub.event',body,()=>{const buildingId=this.location(body.buildingId,'事件位置');const b=this.store.get('buildings',buildingId);const floor=body.floor??1;numeric(floor,1,b.floors,'事件楼层');const note=body.note?required(body.note,'事件说明'):('模拟'+titles[body.type]+'事件');const t=this.plan(user,{goal:b.name+' '+floor+'层 '+note,type:body.type,params:{buildingId,floor}});t.origin='event';this.ensureAlert(t,user);const selected=t.selection.find(s=>s.resourceId.startsWith('person:'));this.notify(t,selected?.name||'园区安全值班岗位','【模拟通知】'+b.name+' '+floor+'F：'+note+'；等待管理员确认处置方案。');t.steps[0].status='completed';t.steps[1].status=t.status==='blocked'?'failed':'completed';this.save(t,user,'event.created','被动事件进入同一能力匹配与执行通道；安全通知已记录，不代表真实短信或人员已到场');return t;});}
  ensureAlert(t,user){if(t.businessRefs.alertId)return this.store.get('alerts',t.businessRefs.alertId);const b=this.store.get('buildings',t.params.buildingId),sensor=this.store.all('devices').find(d=>d.type==='sensor'&&d.buildingId===b.id&&d.floor===t.params.floor);const a={id:uuid('ALT'),title:'【演练】'+b.name+' '+t.params.floor+'F '+titles[t.type],type:t.type==='fire'?'fire':'security',hubEventType:t.type,severity:t.type==='fire'?'critical':'high',status:'detected',buildingId:b.id,deviceId:sensor?.id||null,description:t.type==='fire'?'模拟烟温异常，需要管理员确认后执行建筑照明/空调联动。':'模拟人员跌倒线索，仅协调现场帮助，不做医疗诊断。',createdAt:now(),drill:true,hubTaskId:t.id,timeline:[{at:now(),actor:user.name,action:'发现',note:t.goal}]};this.store.put('alerts',a);t.businessRefs.alertId=a.id;if(t.type==='fire'&&sensor){sensor.status='alert';sensor.state.smoke=.86;sensor.state.temperature=58;this.store.put('devices',sensor);}return a;}
  save(t,user,action,note){t.updatedAt=now();t.timeline.push({at:t.updatedAt,actor:user.name,action,note});this.store.put('hub_tasks',t);this.park.record(user,'hub.'+action,t.id,{type:t.type,status:t.status,note,businessRefs:t.businessRefs});this.park.changed('hub');return t;}
  guardAutomation(){if(this.store.setting('takeover')?.active)fail(423,'HUMAN_TAKEOVER','人工接管期间中枢自动编排暂停；可拒绝、取消或人工处理已存在的任务');}
  execute(user,t){
    this.guardAutomation();
    if(this.park.native?.enabled)return this.executeNative(user,t);
    if(!this.park.simulatorStatus().connected&&['delivery','patrol','fire'].includes(t.type))fail(409,'SIMULATOR_OFFLINE','设备模拟器离线，不能开始需要设备回执的执行');
    const match=this.matching(t.type,t.params,t.id);t.selection=match.selection;t.resourceIds=match.selection.map(s=>s.resourceId);t.candidates=match.candidates;
    if(!match.available){t.status='blocked';t.error=match.error;return this.save(t,user,'blocked',match.error);}
    t.error=null;
    if(t.type==='delivery'){
      this.park.require(user,'delivery');let d;
      if(!t.businessRefs.deliveryId){
        d=this.park.createDelivery(user,{title:t.goal.slice(0,180),from:t.params.from,to:t.params.to,weight:t.params.weight,recipient:t.params.recipient,priority:'normal'},'hub');
        t.businessRefs={deliveryId:d.id};
      }else{
        d=this.park.entity('deliveries',t.businessRefs.deliveryId);
        if(d.status==='pending_approval')fail(409,'APPROVAL_REQUIRED','该配送单仍待审批，不能启动调度');
        if(['exception','paused'].includes(d.status))d=this.park.deliveryAction(user,d.id,{action:'reassign'});
        else if(d.status==='queued')d=this.park.deliveryAction(user,d.id,{action:'dispatch'});
        else if(d.status!=='running')fail(409,'INVALID_TRANSITION','配送已终结或等待签收，不能再次自动派发');
      }
      t.routePlan=d.routePlan;t.progress=35;t.status='running';t.resourceIds=['device:'+d.vehicleId];t.selection=[{resourceId:'device:'+d.vehicleId,name:this.park.entity('devices',d.vehicleId).name,capabilities:this.resources().find(r=>r.id==='device:'+d.vehicleId)?.capabilities||['carry','deliver'],reason:d.dispatchReason,score:-(d.routePlan?.pickupDistanceMeters||0),routePlan:d.routePlan}];t.steps[1].status='completed';t.steps[2].status='completed';t.steps[3].status='running';
      this.notify(t,t.params.recipient||'目的地交接岗位','【配送记录】已按路线和电量校验派发 '+t.selection[0].name+'，抵达后等待交接确认。');
    }else if(t.type==='patrol'){
      this.park.require(user,'patrol');const resource=this.resources().find(r=>r.id===t.resourceIds[0]);const robot=this.park.entity('devices',resource.sourceId);const route=[robot.buildingId,t.params.buildingId];const p=this.park.createPatrol(user,{name:t.goal.slice(0,180),robotId:robot.id,route},'hub');t.businessRefs.patrolId=p.id;t.status='running';t.progress=25;t.steps[1].status='completed';t.steps[2].status='running';
    }else if(t.type==='meeting'){
      if(Date.parse(t.params.startAt)<=Date.now())fail(409,'MEETING_TIME_EXPIRED','会议开始时间已经过期，请创建新的会议安排');
      const room=this.resources().find(r=>r.id===t.resourceIds[0]);const booking={id:uuid('BOOK'),taskId:t.id,roomId:room.sourceId,buildingId:room.buildingId,startAt:t.params.startAt,endAt:t.params.endAt,participants:t.params.participants,attendees:t.params.attendees,status:'confirmed',createdAt:now()};this.store.put('bookings',booking);t.businessRefs.bookingId=booking.id;for(const recipient of t.params.attendees)this.notify(t,recipient,'【模拟会议通知】'+room.name+'，'+t.params.startAt+' 至 '+t.params.endAt);t.status='completed';t.progress=100;t.steps.forEach(s=>s.status='completed');t.result={summary:'会议空间已预订；参会通知已在系统中记录（模拟），并未发送真实消息',details:{room:room.name,startAt:booking.startAt,endAt:booking.endAt,bookingId:booking.id}};
    }else if(t.type==='fire'){
      const a=this.ensureAlert(t,user);if(a.status==='detected')this.park.transitionAlert(user,a.id,{action:'confirm',note:'中枢风险方案经管理员明确确认'});this.park.emergency(user,a.id,{confirmed:true,idempotencyKey:uuid('HUBFIRE')});t.status='running';t.progress=45;t.steps[0].status='completed';t.steps[1].status='completed';t.steps[2].status='completed';t.steps[3].status='running';this.notify(t,t.selection[0].name,'【模拟通知】消防演练方案已由管理员确认；请核验现场处置与疏散结果');
    }else if(t.type==='fall'){
      const a=this.ensureAlert(t,user);if(a.status==='detected')this.park.transitionAlert(user,a.id,{action:'confirm',note:'管理员确认现场协助方案'});if(this.store.get('alerts',a.id).status==='confirmed')this.park.transitionAlert(user,a.id,{action:'dispatch',assignee:t.selection[0].name,note:'模拟协调现场协助；不替代真实应急响应'});this.notify(t,t.selection[0].name,'【模拟通知】请前往'+this.store.get('buildings',t.params.buildingId).name+' '+t.params.floor+'F核验跌倒线索，协调现场帮助；如需专业救援由现场人员决定。');t.status='waiting_human';t.progress=65;t.steps[0].status='completed';t.steps[1].status='completed';t.steps[2].status='completed';t.steps[3].status='completed';t.steps[4].status='running';
    }
    return this.save(t,user,'execution.started','资源重新校验通过，使用统一业务服务执行并等待真实业务状态或人工反馈');
  }
  executeNative(user,t){
    const native=this.park.native;
    if(!native?.session)fail(409,'NATIVE_OFFLINE','UE 原生桥尚未注册，不能启动需要实体回执的中枢任务');
    const match=this.matching(t.type,t.params,t.id);if(!match.available){t.status='blocked';t.error=match.error;return this.save(t,user,'blocked',match.error);}t.selection=match.selection;t.resourceIds=match.selection.map(s=>s.resourceId);const selected=t.selection[0];
    let type,targetId,params={};
    if(t.type==='patrol'){
      this.park.require(user,'patrol');type='patrol.start';targetId=selected?.resourceId?.replace(/^device:/,'')||t.params.vehicleId;params={vehicleId:targetId,route:t.params.route||[t.params.buildingId]};
    }else if(t.type==='delivery'){
      this.park.require(user,'delivery');if(!t.params.parcelId)fail(409,'NATIVE_FINITE_BATCH_REQUIRED','UE 原生配送只接受现有 PARCEL-00 至 PARCEL-15 的固定包裹标识');type='delivery.dispatch';targetId=t.params.parcelId;params={parcelId:t.params.parcelId,from:t.params.from,to:t.params.to,recipient:t.params.recipient,weight:t.params.weight};
    }else if(t.type==='meeting'){
      if(Date.parse(t.params.startAt)<=Date.now())fail(409,'MEETING_TIME_EXPIRED','会议开始时间已过期，请重新选择时段');
      const room=this.resources().find(r=>r.id===t.resourceIds[0]);
      const booking={id:uuid('BOOK'),taskId:t.id,roomId:room.sourceId,buildingId:room.buildingId,startAt:t.params.startAt,endAt:t.params.endAt,participants:t.params.participants,attendees:t.params.attendees,status:'confirmed',createdAt:now(),adapter:'native'};this.store.put('bookings',booking);t.businessRefs.bookingId=booking.id;
      type='meeting.reserve';targetId=room.buildingId;params={...t.params,buildingId:room.buildingId,floor:room.floor,taskId:t.id,title:t.goal,active:true};
    }else if(t.type==='fire'){
      this.park.require(user,'emergency');const a=this.ensureAlert(t,user);if(a.status==='detected')this.park.transitionAlert(user,a.id,{action:'confirm',note:'管理员明确确认原生消防演练'});a.status='dispatched';a.emergencyExecuted=true;a.nativeExecution=true;this.store.put('alerts',a);type='fire.set';targetId=t.params.buildingId;params={active:true,buildingId:t.params.buildingId,floor:t.params.floor,taskId:t.id};
    }else if(t.type==='fall'){
      this.park.require(user,'emergency');const a=this.ensureAlert(t,user);if(a.status==='detected')this.park.transitionAlert(user,a.id,{action:'confirm',note:'管理员明确确认原生现场协助'});if(this.store.get('alerts',a.id).status==='confirmed')this.park.transitionAlert(user,a.id,{action:'dispatch',note:'实体响应车前往指定位置；未代替人工核验'});type='respond.start';targetId=t.params.buildingId;params={buildingId:t.params.buildingId,floor:t.params.floor,kind:'fall',taskId:t.id};
    }else fail(400,'NATIVE_UNSUPPORTED_TASK','该中枢任务没有原生执行映射');
    const command=native.enqueue(type,targetId,params,{sessionId:native.session.sessionId,source:'hub',actor:user.name,confirmed:true,idempotencyKey:`hub:${t.id}`});
    t.businessRefs.nativeCommandId=command.id;if(t.businessRefs.alertId){const a=this.store.get('alerts',t.businessRefs.alertId);a.nativeCommandId=command.id;this.store.put('alerts',a);}t.status='running';t.progress=t.type==='meeting'?20:35;t.steps[0].status='completed';if(t.steps[1])t.steps[1].status='completed';if(t.steps[2])t.steps[2].status='running';
    t.result={summary:'已发送至 UE 原生控制桥，完成状态等待实体设备遥测回执'};return this.save(t,user,'execution.started','UE 原生桥已接收，未以计划动画代替实体回执');
  }
  action(user,taskId,body){const t=this.park.entity('hub_tasks',taskId);const action=body.action;if(!['start','confirm','reject','pause','resume','cancel','complete','replan'].includes(action))fail(400,'VALIDATION_ERROR','未知中枢任务动作');this.authorize(user,t.type,action,t);return this.park.once(user,'hub.action:'+taskId,body,()=>{
    if(terminal.has(t.status)&&!(action==='cancel'&&t.type==='meeting'&&t.status==='completed'))fail(409,'INVALID_TRANSITION','任务已经终结，不能重复操作');
    const note=body.note===undefined?'':required(body.note,'操作说明',1000);
    if(action==='reject'){
      if(t.status!=='awaiting_confirmation')fail(409,'INVALID_TRANSITION','只有等待人工确认的任务可拒绝');if(!note)fail(400,'NOTE_REQUIRED','请填写拒绝原因');t.status='rejected';t.result={summary:'人工拒绝处置方案：'+note+'。未执行设备联动，已有安全通知仍保留。'};t.steps.filter(s=>s.status==='pending').forEach(s=>s.status='rejected');return this.save(t,user,'rejected',note);
    }
    if(action==='confirm'){
      if(t.status!=='awaiting_confirmation')fail(409,'INVALID_TRANSITION','当前任务不等待风险确认');if(!note)fail(400,'NOTE_REQUIRED','高风险确认须填写核验说明');this.guardAutomation();t.confirmedBy=user.name;t.confirmedAt=now();return this.execute(user,t);
    }
    if(action==='start'){
      if(!['planned','awaiting_approval'].includes(t.status))fail(409,'INVALID_TRANSITION','当前状态不能启动任务');return this.execute(user,t);
    }
    if(action==='replan'){
      this.guardAutomation();if(!['blocked','planned','awaiting_confirmation','awaiting_approval'].includes(t.status))fail(409,'INVALID_TRANSITION','执行中任务请先安全暂停，不能重复创建下游任务');const match=this.matching(t.type,t.params,t.id);
      Object.assign(t,{selection:match.selection,resourceIds:match.selection.map(s=>s.resourceId),candidates:match.candidates,error:match.error,status:match.available?(['fire','fall'].includes(t.type)?'awaiting_confirmation':'planned'):'blocked'});
      return this.save(t,user,'replanned',match.available?'已按当前资源状态重新形成方案，请确认下一步':match.error);
    }
    if(action==='pause'||action==='resume'){
      if(action==='pause'&&t.status!=='running'||action==='resume'&&t.status!=='paused')fail(409,'INVALID_TRANSITION','当前任务状态不允许暂停或恢复');this.guardAutomation();
      if(t.businessRefs.nativeCommandId){const original=this.park.native?.session?.queue.find(c=>c.id===t.businessRefs.nativeCommandId);if(!original||!['patrol','delivery'].includes(t.type))fail(409,'UNSUPPORTED_ACTION','该原生任务不支持暂停');const c=this.park.native.enqueue(t.type==='patrol'?'patrol.action':'delivery.action',original.targetId,{...original.params,action},{source:'hub',actor:user.name,confirmed:true});t.businessRefs.nativeActionCommandId=c.id;t.requestedStatus=action==='pause'?'paused':'running';return this.save(t,user,'action.requested','已请求原生设备'+action+'，等待回执');}
      if(t.businessRefs.deliveryId)this.park.deliveryAction(user,t.businessRefs.deliveryId,{action});else if(t.businessRefs.patrolId)this.park.patrolAction(user,t.businessRefs.patrolId,{action});else fail(409,'UNSUPPORTED_ACTION','该任务须通过人工处置完成，不支持暂停');t.status=action==='pause'?'paused':'running';return this.save(t,user,action,note||'人工调度');
    }
    if(action==='cancel'){
      if(['fire','fall'].includes(t.type)&&t.status==='running')fail(409,'UNSAFE_CANCEL','安全联动已经发出，请核验回执并人工结案；接管后可在设备指令列表撤销待执行指令');
      if(t.businessRefs.deliveryId){const d=this.park.entity('deliveries',t.businessRefs.deliveryId);if(!['archived','signed','delivered','cancelled'].includes(d.status))this.park.deliveryAction(user,d.id,{action:'cancel'});}
      if(t.businessRefs.patrolId){const p=this.park.entity('patrols',t.businessRefs.patrolId);if(!['completed','cancelled'].includes(p.status))this.park.patrolAction(user,p.id,{action:'cancel'});}
      if(t.businessRefs.nativeCommandId){const original=this.park.native?.session?.queue.find(c=>c.id===t.businessRefs.nativeCommandId);if(t.type==='delivery')fail(409,'NATIVE_PHYSICAL_BATCH','实体包裹不能无故取消或消失，请暂停配送并人工处理');if(t.type==='patrol'&&original)this.park.native.enqueue('patrol.action',original.targetId,{...original.params,action:'cancel'},{source:'hub',actor:user.name,confirmed:true});if(t.type==='meeting'&&original)this.park.native.enqueue('meeting.reserve',original.targetId,{...original.params,active:false},{source:'hub',actor:user.name,confirmed:true});}
      if(t.businessRefs.bookingId){const b=this.park.entity('bookings',t.businessRefs.bookingId);b.status='cancelled';b.cancelledAt=now();this.store.put('bookings',b);}
      t.status='cancelled';t.result={summary:['fire','fall'].includes(t.type)?'协调任务已取消，关联安全事件仍待人工处置；已记录的安全通知保留':'任务已取消；下游未完成任务和会议预订已同步终结'};return this.save(t,user,'cancelled',(note||'人工取消')+(['fire','fall'].includes(t.type)?'；关联安全事件保持当前状态，等待人工处置':''));
    }
    if(action==='complete'){
      this.sync();const current=this.park.entity('hub_tasks',taskId);if(current.status!=='waiting_human')fail(409,'INVALID_TRANSITION','请等待设备执行完成或现场协助确认后再结案');Object.assign(t,current);if(!note)fail(400,'NOTE_REQUIRED','请填写签收、复核或现场协助结果');
      if(t.businessRefs.deliveryId){const d=this.park.entity('deliveries',t.businessRefs.deliveryId);if(d.status==='delivered')this.park.deliveryAction(user,d.id,{action:'sign'});if(this.store.get('deliveries',d.id).status==='signed')this.park.deliveryAction(user,d.id,{action:'archive'});}
      if(t.businessRefs.alertId){let a=this.park.entity('alerts',t.businessRefs.alertId);for(const [state,next] of [['dispatched','resolve'],['resolved','review'],['reviewed','archive']]){a=this.store.get('alerts',a.id);if(a.status===state)this.park.transitionAlert(user,a.id,{action:next,note});}for(const n of this.store.all('notifications').filter(n=>n.taskId===t.id)){n.status='acknowledged';n.acknowledgedAt=now();this.store.put('notifications',n);}}
      t.status='completed';t.progress=100;t.steps.forEach(s=>s.status='completed');t.result={summary:titles[t.type]+'已完成并归档：'+note};return this.save(t,user,'completed',note);
    }
  });}
  sync(){
    for(const t of this.store.all('hub_tasks')){
      if(terminal.has(t.status))continue;const before=JSON.stringify(t);const refs=t.businessRefs;
      if(refs.nativeCommandId&&this.park.native?.session){
        const c=this.park.native.session.queue.find(c=>c.id===refs.nativeCommandId);
        if(c){if(['failed','cancelled','timed_out'].includes(c.status)){t.status=c.status==='cancelled'?'cancelled':'failed';t.error=c.message||'UE 原生执行失败';}
        else if(c.status==='succeeded'){t.status=['fire','fall','delivery'].includes(t.type)?'waiting_human':'completed';t.progress=t.status==='completed'?100:95;t.steps.forEach(s=>s.status='completed');t.result={summary:c.message||'UE 原生实体执行已回传'};}
        else {t.status=t.status==='paused'?'paused':'running';t.progress=c.status==='running'?55:35;}}
        if(refs.nativeActionCommandId){const action=this.park.native.session.queue.find(c=>c.id===refs.nativeActionCommandId);if(action?.status==='succeeded'&&t.requestedStatus){t.status=t.requestedStatus;delete t.requestedStatus;}}
      }
      if(refs.deliveryId){
        const d=this.store.get('deliveries',refs.deliveryId);
        if(d){
          if(d.routePlan)t.routePlan=d.routePlan;
          if(d.vehicleId){
            const resourceId='device:'+d.vehicleId;
            const device=this.store.get('devices',d.vehicleId);
            const previous=t.selection.find(item=>item.resourceId===resourceId);
            t.resourceIds=[resourceId];
            t.selection=[{
              resourceId,name:device?.name||previous?.name||d.vehicleId,
              capabilities:device?['move.'+(device.type==='drone'?'air':'ground'),'carry','deliver']:(previous?.capabilities||['carry','deliver']),
              reason:d.dispatchReason||previous?.reason||'由配送订单分配的设备',
              score:d.routePlan?-(d.routePlan.pickupDistanceMeters||0):(previous?.score||0),
              ...(d.routePlan?{routePlan:d.routePlan}:{})
            }];
          }
          if(d.routingCandidates)t.candidates=d.routingCandidates;
          t.progress=d.status==='pending_approval'?25:d.status==='queued'?30:Math.min(95,35+d.progress*.6);
          t.error=d.status==='exception'?(d.exception||'配送异常，需人工处理'):null;
          if(d.status==='pending_approval')t.status='awaiting_approval';
          else if(d.status==='queued')t.status='planned';
          else if(['running','returning'].includes(d.status))t.status='running';
          else if(d.status==='paused')t.status='paused';
          else if(d.status==='exception')t.status='blocked';
          else if(d.status==='delivered'){
            t.status='waiting_human';t.progress=95;
            t.steps[3].status='completed';t.steps[4].status='running';
          }else if(['signed','archived'].includes(d.status)){
            t.status='completed';t.progress=100;t.steps.forEach(s=>s.status='completed');
            t.result={summary:'关联配送已签收，结果由业务服务同步'};
          }else if(d.status==='cancelled'){
            t.status='cancelled';t.result={summary:'关联配送已取消或审批未通过'};
          }
        }
      }
      if(refs.patrolId){const p=this.store.get('patrols',refs.patrolId);if(p){t.progress=Math.min(100,25+p.progress*.75);if(['running','returning'].includes(p.status))t.status='running';else if(p.status==='paused'){t.status='paused';t.error=p.pauseReason||null;}else if(p.status==='completed'){t.status='completed';t.progress=100;t.steps.forEach(s=>s.status='completed');t.result={summary:'指定区域巡查已由模拟机器人执行完成，检查范围与轨迹已记录；不是实际视觉识别结果'};}else if(p.status==='cancelled'){t.status='cancelled';t.result={summary:'关联巡检已取消'};}}}
      if(t.type==='fire'&&refs.alertId){const a=this.store.get('alerts',refs.alertId);if(a?.emergencyExecuted){const commands=(a.commandIds||[]).map(id=>this.store.get('commands',id));if(commands.some(c=>['failed','timed_out','cancelled'].includes(c?.status))){t.status='failed';t.error='消防联动指令失败或未确认，请在安防消防中核验处置；中枢不会虚报完成';t.steps[3].status='failed';t.result={summary:t.error};}else if(commands.length&&commands.every(c=>c?.status==='succeeded')){t.steps[3].status='completed';if(a.status==='archived'){t.status='completed';t.progress=100;t.steps.forEach(s=>s.status='completed');t.result={summary:'关联消防演练经人工复核归档'};}else{t.status='waiting_human';t.progress=85;t.steps[4].status='running';}}}}
      if(JSON.stringify(t)!==before){t.updatedAt=now();this.store.put('hub_tasks',t);this.store.audit('中枢状态同步','hub.execution.sync',t.id,{status:t.status,progress:t.progress,businessRefs:t.businessRefs});}
    }
  }
}
