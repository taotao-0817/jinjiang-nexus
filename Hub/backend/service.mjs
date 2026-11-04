import { randomUUID } from 'node:crypto';
import { now, digest } from './store.mjs';
import {deliveryCandidates,positionOnRoute} from './routing.mjs';

export class ApiError extends Error { constructor(status,code,message,details) { super(message); this.status=status; this.code=code; this.details=details; } }
const fail=(status,code,message,details)=>{throw new ApiError(status,code,message,details);};
const id=(prefix)=>`${prefix}-${randomUUID().slice(0,8).toUpperCase()}`;
const admins=['super_admin','park_admin'];
const permissions = {
  control:[...admins,'ops'], security:[...admins,'security'], emergency:admins,
  patrol:[...admins,'security'], delivery:[...admins,'ops'], approve:[...admins,'approver'],
  attendance:[...admins,'security'], automate:admins, takeover:['super_admin'], audit:[...admins,'security','ops','approver'], agent:admins
};
const activeTasks = new Set(['running','queued','returning']);
const text=(v,label,max=200,required=true)=>{if(typeof v!=='string'||(required&&!v.trim())||v.length>max) fail(400,'VALIDATION_ERROR',`${label}格式不正确（最多 ${max} 字）`);return v.trim();};
const choice=(v,choices,label)=>{if(!choices.includes(v)) fail(400,'VALIDATION_ERROR',`${label}必须是：${choices.join(', ')}`);return v;};
const number=(v,min,max,label)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail(400,'VALIDATION_ERROR',`${label}应为 ${min}–${max}`);return v;};
const requireTrue=(v)=>{if(v!==true)fail(400,'CONFIRMATION_REQUIRED','该操作需要明确的人工确认');};

export class ParkService {
  constructor(store, broadcast=()=>{}) {this.store=store;this.broadcast=broadcast;}
  attachNative(native) { this.native=native; }
  require(user,permission) {if(!permissions[permission]?.includes(user.role))fail(403,'FORBIDDEN','当前角色没有此操作权限',{permission,role:user.role});}
  entity(table,key) {if(typeof key!=='string'||!key||key.length>128)fail(400,'VALIDATION_ERROR','记录标识必须为非空字符串');const item=this.store.get(table,key);if(!item)fail(404,'NOT_FOUND','记录不存在');return item;}
  changed(type='state',payload={}) { this.broadcast({type,at:now(),...payload}); }
  record(user,action,target,detail) {this.store.audit(user,action,target,detail);}
  once(user,scope,body,fn) {
    const key=body.idempotencyKey;
    if(!key)return fn();
    text(key,'幂等键',128);const composite=`${user.id}:${scope}:${key}`;
    const clean={...body};delete clean.idempotencyKey;const fingerprint=digest(JSON.stringify(clean));
    const previous=this.store.db.prepare('SELECT * FROM idempotency WHERE key=?').get(composite);
    if(previous) {if(previous.fingerprint!==fingerprint)fail(409,'IDEMPOTENCY_CONFLICT','相同幂等键不能用于不同请求');return JSON.parse(previous.response);}
    const result=fn();this.store.db.prepare('INSERT INTO idempotency VALUES (?,?,?,?)').run(composite,fingerprint,JSON.stringify(result),now());return result;
  }
  bootstrap(user) {
    const devices=this.store.all('devices'); const alerts=this.store.all('alerts');const patrols=this.store.all('patrols'); const deliveries=this.store.all('deliveries');
    const online=devices.filter(d=>d.status!=='offline').length;
    const canAudit=permissions.audit.includes(user.role);
    const energy=this.store.setting('energy');const energyToday=energy.reduce((total,item)=>total+item.value,0);const baseline=energy.reduce((total,item)=>total+(item.baseline||item.value),0);
    return {user,park:this.native?.enabled?{id:'PARK-NEXUS',name:'锦江超级园区 AI 中枢',area:'345,600 m²',location:'成都 · 锦江',mode:'native_demo'}:{id:'PARK-BLW',name:'成都市白鹭湾智慧园区',area:'128,600 m²',location:'成都 · 锦江',mode:'simulation'},buildings:this.store.all('buildings'),devices,alerts,patrols,deliveries,
      approvals:this.store.all('approvals').filter(a=>user.role!=='user'||a.requesterId===user.id),
      attendance:permissions.attendance.includes(user.role)?this.store.all('attendance'):[],automations:this.store.all('automations'),takeover:this.store.setting('takeover'),
      metrics:{deviceCount:devices.length,onlineCount:online,onlineRate:Number((online/devices.length*100).toFixed(1)),activeAlerts:alerts.filter(a=>a.status!=='archived').length,criticalAlerts:alerts.filter(a=>a.severity==='critical'&&a.status!=='archived').length,energyToday,energySaving:Number(((baseline-energyToday)/baseline*100).toFixed(1)),patrolCompletion:patrols.length?Math.round(patrols.reduce((s,p)=>s+p.progress,0)/patrols.length):0,activeDeliveries:deliveries.filter(d=>['running','queued'].includes(d.status)).length,peopleToday:this.store.all('attendance').filter(a=>['present','late'].includes(a.status)).length,simulation:true},
      energy:this.store.setting('energy'),audit:canAudit?this.store.audits(100):[],agentRuns:admins.includes(user.role)?this.store.all('agent_runs').slice(-30).reverse():[],commands:this.store.all('commands').slice(-100).reverse(),simulator:this.simulatorStatus(),permissions:Object.keys(permissions).filter(p=>permissions[p].includes(user.role))};
  }
  simulatorStatus() {const sim=this.store.setting('simulator');return this.native?.enabled?{...sim,mode:'native',...this.native.summary()}:{...sim,connected:!!sim.lastTick&&Date.now()-Date.parse(sim.lastTick)<8000};}
  validateCommand(device,action,value) {
    if(device.status==='offline')fail(409,'DEVICE_OFFLINE',`${device.name} 已离线`,{deviceId:device.id});
    if(!device.capabilities.includes(action))fail(400,'UNSUPPORTED_CAPABILITY',`${device.name} 不支持 ${action}`);
    if(['power','open'].includes(action)&&typeof value!=='boolean')fail(400,'VALIDATION_ERROR','开关值必须为布尔值');
    if(action==='brightness')number(value,0,100,'亮度');
    if(action==='temperature')number(value,16,30,'温度');
    if(action==='mode')choice(value,['auto','cool','heat','fan','eco'],'运行模式');
  }
  commands(user,body,source='human',permissionChecked=false) {
    if(!permissionChecked)this.require(user,'control');
    if(source!=='human'&&this.store.setting('takeover').active)fail(423,'HUMAN_TAKEOVER','人工接管期间已暂停自动指令');
    return this.once(user,'commands',body,()=>{
      if(!Array.isArray(body.deviceIds)||body.deviceIds.length<1||body.deviceIds.length>100)fail(400,'VALIDATION_ERROR','每次应选择 1–100 台设备');
      choice(body.action,['power','brightness','temperature','mode','open'],'设备动作');
      const ids=[...new Set(body.deviceIds)]; const devices=ids.map(k=>this.entity('devices',k));
      for(const device of devices) {this.validateCommand(device,body.action,body.value);if(this.native?.enabled&&!['light','hvac'].includes(device.type))fail(400,'NATIVE_UNSUPPORTED_DEVICE','该设备没有原生控制映射');if(this.store.all('commands').some(c=>c.deviceId===device.id&&c.status==='pending'))fail(409,'COMMAND_PENDING',`${device.name} 已有指令等待设备回执`);}
      const timeoutMs=Math.max(100,Number(process.env.COMMAND_TIMEOUT_MS)||12000);
      const commands=devices.map(device=>{
        const command=this.store.put('commands',{id:id('CMD'),deviceId:device.id,action:body.action,value:body.value,status:'pending',createdAt:now(),deadline:new Date(Date.now()+timeoutMs).toISOString(),actor:user.name,source,result:null});
        if(this.native?.enabled){const nativeCommand=this.native.enqueueDeviceCommand(command,device,user.name);command.nativeCommandId=nativeCommand.id;device.adapter='native';this.store.put('devices',device);this.store.put('commands',command);}
        return command;
      });
      this.record(user,'device.command.requested',ids.join(','),{source,action:body.action,value:body.value,commandIds:commands.map(c=>c.id)});
      this.changed('commands');return {commands,message:'指令已入队，等待设备模拟器回执'};
    });
  }
  cancelCommand(user,commandId) {
    this.require(user,'takeover');if(!this.store.setting('takeover').active)fail(409,'TAKEOVER_REQUIRED','请先人工接管，再撤销待执行联动');
    const command=this.entity('commands',commandId);if(command.status!=='pending')fail(409,'INVALID_TRANSITION','只能撤销尚未收到回执的指令');
    command.status='cancelled';command.completedAt=now();command.result='接管管理员已撤销待执行联动，设备状态未改变';
    this.store.put('commands',command);this.record(user,'device.command.cancelled',command.id,{deviceId:command.deviceId,source:command.source,reason:'human_takeover_cancel',deviceStateChanged:false});
    this.changed('command',{commandId:command.id,status:command.status});return command;
  }
  scenes(user,body,source='human') {
    this.require(user,'control');choice(body.mode,['work','off','night','eco','emergency'],'场景');
    if(body.mode==='emergency'){this.require(user,'emergency');requireTrue(body.confirmed);}
    return this.once(user,'scene',body,()=>{
      const available=this.store.all('devices').filter(d=>d.status!=='offline'&&['light','hvac'].includes(d.type));
      const busy=new Set(this.store.all('commands').filter(c=>c.status==='pending').map(c=>c.deviceId));
      if(available.some(d=>busy.has(d.id)))fail(409,'COMMAND_PENDING','部分设备仍有待回执指令，请等待后重试');
      const commands=[];
      for(const type of ['light','hvac']) {
        const selected=available.filter(d=>d.type===type).map(d=>d.id);if(!selected.length)continue;
        let action='power',value=body.mode==='work';
        if(type==='light'&&['night','eco'].includes(body.mode)){action='brightness';value=body.mode==='night'?25:55;}
        if(type==='hvac'&&body.mode==='eco'){action='temperature';value=27;}
        if(body.mode==='emergency')value=type==='light';
        for(let start=0;start<selected.length;start+=100)commands.push(...this.commands(user,{deviceIds:selected.slice(start,start+100),action,value},source,true).commands);
      }
      this.record(user,'scene.applied',body.mode,{source,commands:commands.length,skippedOffline:this.store.all('devices').filter(d=>d.status==='offline').map(d=>d.id)});
      return {commands,mode:body.mode};
    });
  }
  scenario(user,type) {
    this.require(user,'security');choice(type,['security','fire'],'演示场景');
    const fire=type==='fire';const buildingId=fire?'B02':'B05';const device=fire?this.store.all('devices').find(d=>d.buildingId===buildingId&&d.type==='sensor'&&d.floor===2):this.entity('devices','ROB-02');
    const a={id:id('ALT'),title:fire?'【演练】A2 研发中心烟温复合告警':'【模拟】C1 东侧发现陌生人闯入',type,severity:fire?'critical':'high',status:'detected',buildingId,deviceId:device.id,description:fire?'消防演练：A2 二层模拟烟感浓度上升，需要人工确认后启动区域广播、照明和新风联动。':'模拟视觉识别发现人员进入限制区域；请确认、派单并现场复核。',createdAt:now(),drill:true,evidence:{kind:'simulation',camera:fire?'A2-2F-走廊':'C1-东门',caption:'模拟场景快照 · 不含真实影像',confidence:0.96},timeline:[{action:'发现',at:now(),actor:fire?'复合烟温传感器':'智能巡检识别',note:fire?'演练数据：烟感 0.86 / 温度 58 ℃':'模拟识别：限制区域入侵'}]};
    if(fire){device.status='alert';device.state.smoke=0.86;device.state.temperature=58;device.updatedAt=now();this.store.put('devices',device);}
    this.store.put('alerts',a);this.record(user,`scenario.${type}`,a.id,{drill:true});this.changed('alert',{alertId:a.id});return a;
  }
  transitionAlert(user,alertId,body) {
    this.require(user,'security');const a=this.entity('alerts',alertId);const transitions={confirm:['detected','confirmed'],dispatch:['confirmed','dispatched'],resolve:['dispatched','resolved'],review:['resolved','reviewed'],archive:['reviewed','archived']};
    const step=transitions[body.action];if(!step)fail(400,'VALIDATION_ERROR','未知告警处置动作');
    if(a.status!==step[0])fail(409,'INVALID_TRANSITION',`当前状态 ${a.status} 不允许 ${body.action}`);
    if(a.type==='fire'&&body.action==='resolve'){
      if(!a.emergencyExecuted)fail(409,'EMERGENCY_NOT_EXECUTED','请先执行消防演练预案');
      const commands=(a.commandIds||[]).map(cid=>this.entity('commands',cid));
      if(a.nativeCommandId){const command=this.native?.session?.queue.find(c=>c.id===a.nativeCommandId);if(command?.status!=='succeeded')fail(409,'COMMAND_PENDING','UE消防联动尚未收到成功实体回执');}
      if(commands.some(c=>c.status==='pending'))fail(409,'COMMAND_PENDING','联动指令仍在等待回执');
      if(commands.some(c=>c.status!=='succeeded'))fail(409,'EMERGENCY_COMMAND_FAILED','部分联动指令失败，请重新执行预案并核验');
    }
    if(body.note!==undefined)text(body.note,'处置记录',1000,false);
    if(body.assignee!==undefined)text(body.assignee,'处理人',80);
    a.status=step[1];if(body.assignee)a.assignee=body.assignee;
    if(a.emergencySteps&&['resolve','review','archive'].includes(body.action))a.emergencySteps[4]={...a.emergencySteps[4],status:body.action==='resolve'?'running':'completed'};
    a.timeline.push({action:body.action,at:now(),actor:user.name,note:body.note||{confirm:'告警已人工确认',dispatch:'已派发现场处置工单',resolve:'现场处置完成',review:'复核通过',archive:'事件闭环归档'}[body.action]});
    this.store.put('alerts',a);this.record(user,`alert.${body.action}`,a.id,{status:a.status,note:body.note||''});this.changed('alert');return a;
  }
  emergency(user,alertId,body) {
    this.require(user,'emergency');requireTrue(body.confirmed);
    return this.once(user,`emergency:${alertId}`,body,()=>{
      const a=this.entity('alerts',alertId);if(a.type!=='fire'||!['confirmed','dispatched'].includes(a.status))fail(409,'INVALID_TRANSITION','消防告警须先确认，且尚未完成处置');
      if(!a.drill)fail(409,'REAL_CONTROL_DISABLED','当前版本仅允许模拟消防演练');
      const devices=this.store.all('devices').filter(d=>d.buildingId===a.buildingId&&d.status!=='offline');const commands=[];
      for(const [type,value] of [['light',true],['hvac',false]]){const ids=devices.filter(d=>d.type===type).map(d=>d.id);for(let start=0;start<ids.length;start+=100)commands.push(...this.commands(user,{deviceIds:ids.slice(start,start+100),action:'power',value},'human',true).commands);}
      if(this.native?.enabled){const c=this.native.enqueue('fire.set',a.buildingId,{active:true,buildingId:a.buildingId,floor:1},{source:'human',actor:user.name,confirmed:true,idempotencyKey:`fire:${a.id}`});a.nativeCommandId=c.id;}
      a.status='dispatched';a.emergencyExecuted=true;a.commandIds=commands.map(c=>c.id);a.timeline.push({action:'emergency.execute',at:now(),actor:user.name,note:'【演练】已发出区域照明开启、新风停止指令；广播、疏散指引及救援通知已模拟。设备效果等待回执。'});
      a.emergencySteps=[{name:'人工确认',status:'completed'},{name:'区域广播（模拟）',status:'completed'},{name:'设备联动',status:'pending'},{name:'疏散与救援通知（模拟）',status:'completed'},{name:'现场处置及复核',status:'waiting'}];
      this.store.put('alerts',a);this.record(user,'emergency.execute',a.id,{drill:true,commandIds:a.commandIds,confirmed:true});this.changed('emergency');return {...a,commands};
    });
  }
  robotAvailable(robot,table,taskId) {
    if(robot.status==='offline')fail(409,'DEVICE_OFFLINE','所选无人系统已离线');
    if(robot.state.battery!==null&&robot.state.battery!==undefined&&robot.state.battery<25)fail(409,'LOW_BATTERY','设备电量低于 25%，请更换设备或充电');
    const all=[...this.store.all('patrols'),...this.store.all('deliveries')];
    if(all.some(t=>t.id!==taskId&&(t.robotId===robot.id||t.vehicleId===robot.id)&&['queued','running','paused','returning'].includes(t.status)))fail(409,'VEHICLE_BUSY','设备已被另一进行中或暂停任务占用');
  }
  availableVehicle(type,taskId,weight=0,excludeId=null) {
    const tasks=[...this.store.all('patrols'),...this.store.all('deliveries')];
    return this.store.all('devices').find(v=>type.includes(v.type)&&v.id!==excludeId&&v.status!=='offline'&&Number(v.state.battery)>=25&&!v.state.routeBlocked&&(v.type!=='drone'||weight<=5)&&!tasks.some(t=>t.id!==taskId&&(t.robotId===v.id||t.vehicleId===v.id)&&['queued','running','paused','returning'].includes(t.status)));
  }
  createPatrol(user,body,source='human') {
    this.require(user,'patrol');if(source!=='human'&&this.store.setting('takeover').active)fail(423,'HUMAN_TAKEOVER','人工接管期间禁止自动巡检');
    const robot=body.robotId?this.entity('devices',body.robotId):this.availableVehicle(['robot']);if(!robot)fail(409,'NO_VEHICLE_AVAILABLE','暂无电量充足且未占用的巡检机器人');if(robot.type!=='robot')fail(400,'VALIDATION_ERROR','只能选择巡检机器人');this.robotAvailable(robot,'patrols');
    const route=body.route||['B01','B02','B03','B04'];if(!Array.isArray(route)||route.length<2||route.length>16)fail(400,'VALIDATION_ERROR','巡检路线应包含 2–16 个区域');route.forEach(b=>this.entity('buildings',b));
    const p={id:id('PAT'),name:text(body.name||'临时安全巡检','巡检名称'),robotId:robot.id,status:'running',progress:0,route,createdAt:now(),source,checkpoint:0};
    if(this.native?.enabled){const c=this.native.enqueue('patrol.start',robot.id,{vehicleId:robot.id,route},{source,actor:user.name});c.businessTable='patrols';c.businessId=p.id;this.native.persistCommand(c);p.nativeCommandId=c.id;}
    this.store.put('patrols',p);this.syncVehicle(p.robotId,p.status);this.record(user,'patrol.created',p.id,{robotId:p.robotId,route});this.changed('patrol');return p;
  }
  patrolAction(user,taskId,body) {
    this.require(user,'patrol');const p=this.entity('patrols',taskId);choice(body.action,['pause','resume','recall','cancel'],'巡检动作');
    const allowed={pause:['running'],resume:['paused','queued'],recall:['running','paused','queued'],cancel:['running','paused','queued','returning']};
    if(!allowed[body.action].includes(p.status))fail(409,'INVALID_TRANSITION',`当前巡检状态 ${p.status} 不允许此操作`);
    if(body.action==='resume')this.robotAvailable(this.entity('devices',p.robotId),'patrols',p.id);
    if(this.native?.enabled){const c=this.native.enqueue('patrol.action',p.robotId,{vehicleId:p.robotId,action:body.action,taskId:p.id},{source:'human',actor:user.name,confirmed:true});p.nativeActionCommandId=c.id;}
    p.status={pause:'paused',resume:'running',recall:'returning',cancel:'cancelled'}[body.action];if(body.action==='recall')p.returnProgress=0;
    p.pauseReason=body.action==='pause'?'人工暂停':null;p.source='human';this.store.put('patrols',p);this.syncVehicle(p.robotId,p.status);this.record(user,`patrol.${body.action}`,p.id,{});this.changed('patrol');return p;
  }
  deliveryDecision(body,taskId,excludeId) {
    return deliveryCandidates(this.store,{from:body.from,to:body.to,weight:body.weight??1,taskId,excludeId});
  }
  dispatchCandidates(decision) {
    return decision.candidates.map(({routePlan,...candidate})=>({
      ...candidate,pickupDistanceMeters:routePlan?.pickupDistanceMeters,
      totalDistanceMeters:routePlan?.distanceMeters,batteryAfterEstimate:routePlan?.batteryAfterEstimate
    }));
  }
  createDelivery(user,body,source='human') {
    if(this.native?.enabled)fail(409,'NATIVE_FINITE_BATCH_REQUIRED','UE 场景中的16件实体包裹已绑定收件楼层；请在原生物流区选择已有包裹，不能创建无实体新货物');
    return this.once(user,'delivery.create',body,()=>{
      const title=text(body.title,'配送物品');const from=this.entity('buildings',body.from),to=this.entity('buildings',body.to);if(from.id===to.id)fail(400,'VALIDATION_ERROR','起点和终点不能相同');
      if(body.weight==null)fail(400,'WEIGHT_REQUIRED','请填写物品总重量（kg）');
      const weight=number(body.weight,0.01,20,'载重 kg');const priority=choice(body.priority||'normal',['normal','urgent'],'优先级');
      const recipient=body.recipient==null||body.recipient===''?'目的地交接岗位':text(body.recipient,'收件人或岗位',80);
      if(!permissions.delivery.includes(user.role)){
        const order={
          id:id('DLV'),title,from:from.id,to:to.id,vehicleId:null,priority,weight,
          status:'pending_approval',progress:0,approved:false,autoDispatch:false,
          approvalPolicy:'request_review',route:[from.id,to.id],source:'human',
          createdAt:now(),requesterId:user.id,recipient
        };
        this.store.put('deliveries',order);
        const approval=this.createApproval(user,{
          title:'配送申请：'+title,type:'delivery',relatedId:order.id,
          description:from.name+' → '+to.name+'，'+weight+' kg，交给'+recipient
        },true);
        this.record(user,'delivery.requested',order.id,{approvalId:approval.id});
        this.changed('delivery');
        return {...order,approvalId:approval.id};
      }
      if(this.store.setting('takeover')?.active)fail(423,'HUMAN_TAKEOVER','人工接管期间自动配送暂停');
      if(!this.simulatorStatus().connected)fail(409,'SIMULATOR_OFFLINE','设备模拟器离线，不能启动自动配送');
      const decision=this.deliveryDecision({from:from.id,to:to.id,weight});
      if(!decision.selected)fail(409,'NO_VEHICLE_AVAILABLE','没有满足位置、载重、电量储备及任务占用条件的配送设备',{candidates:decision.candidates.map(c=>({resourceId:c.resourceId,name:c.name,reasons:c.reasons}))});
      if(body.vehicleId&&body.vehicleId!==decision.selected.vehicleId)fail(409,'AUTO_SELECTION_POLICY','自动配送按最近可用设备策略选择，不能指定不符合最近原则的设备',{selectedVehicleId:decision.selected.vehicleId});
      const selected=decision.selected;const routePlan={...selected.routePlan,reason:selected.reason};
      const d={
        id:id('DLV'),title,from:from.id,to:to.id,vehicleId:selected.vehicleId,priority,
        status:'running',phase:routePlan.pickupDistanceMeters>0?'to_pickup':'to_destination',
        progress:0,eta:Math.ceil(routePlan.estimatedDurationSeconds/60),weight,createdAt:now(),
        approved:true,approvalPolicy:'automatic_validation',autoDispatch:true,route:[from.id,to.id],
        routePlan,dispatchReason:selected.reason,selectionPolicy:'nearest_feasible_pickup_with_battery_reserve',
        routingCandidates:this.dispatchCandidates(decision),
        source,requesterId:user.id,recipient
      };
      this.store.put('deliveries',d);this.syncVehicle(d.vehicleId,'running');
      this.record(user,'delivery.auto_dispatched',d.id,{vehicleId:d.vehicleId,from:d.from,to:d.to,weight,reason:selected.reason,policy:d.selectionPolicy,approvalPolicy:d.approvalPolicy,routePlan,excludedCandidates:decision.candidates.filter(c=>!c.eligible).map(c=>({vehicleId:c.vehicleId,reasons:c.reasons}))});
      this.changed('delivery');return d;
    });
  }
  deliveryAction(user,taskId,body) {
    this.require(user,'delivery');const d=this.entity('deliveries',taskId);choice(body.action,['dispatch','pause','resume','recall','cancel','sign','archive','reassign'],'配送动作');
    if(d.nativeReadOnly){
      if(['pause','resume'].includes(body.action)){const c=this.native.enqueue('delivery.action',d.nativeParcelId,{action:body.action,parcelId:d.nativeParcelId},{source:'human',actor:user.name});this.record(user,`delivery.${body.action}`,d.id,{nativeCommandId:c.id});return {...d,nativeActionCommandId:c.id};}
      if(body.action==='sign'&&d.status==='delivered'){d.status='signed';d.signedAt=now();this.store.put('deliveries',d);return d;}
      if(body.action==='archive'&&d.status==='signed'){d.status='archived';this.store.put('deliveries',d);return d;}
      fail(409,'NATIVE_PHYSICAL_BATCH','实体包裹不能取消、重生或改写固定收件目标；等待实体送达后可签收归档');
    }
    const previousVehicleId=d.vehicleId;
    if(d.status==='pending_approval'&&['dispatch','resume','reassign'].includes(body.action))fail(409,'APPROVAL_REQUIRED','待审批配送单须由审批人通过后再调度');
    const allowed={dispatch:['queued'],pause:['running'],resume:['paused'],recall:['running','paused','exception'],cancel:['pending_approval','queued','running','paused','exception','returning'],sign:['delivered'],archive:['signed'],reassign:['queued','exception','paused']};
    if(!allowed[body.action].includes(d.status))fail(409,'INVALID_TRANSITION','当前配送状态 '+d.status+' 不允许 '+body.action);
    if(['dispatch','resume','reassign'].includes(body.action)) {
      if(this.store.setting('takeover')?.active)fail(423,'HUMAN_TAKEOVER','人工接管期间自动配送调度暂停');
      if(!this.simulatorStatus().connected)fail(409,'SIMULATOR_OFFLINE','设备模拟器离线，无法继续调度');
      if(!d.approved)fail(409,'APPROVAL_REQUIRED','配送单尚未通过审批');
      if(body.action==='resume'&&d.routePlan&&d.vehicleId){
        const vehicle=this.entity('devices',d.vehicleId);this.robotAvailable(vehicle,'deliveries',d.id);if(vehicle.state.routeBlocked)fail(409,'ROUTE_BLOCKED','设备路线阻塞，请解除阻塞或改派');const remaining=d.routePlan.estimatedBatteryUse*(1-d.progress/100);if(vehicle.state.battery-remaining<20)fail(409,'LOW_BATTERY','剩余配送完成后电量不足20%储备，请改派');
      }else{
        const decision=this.deliveryDecision(d,d.id,body.action==='reassign'?d.vehicleId:null),requested=body.vehicleId;
        if(requested&&decision.selected&&requested!==decision.selected.vehicleId)fail(409,'AUTO_SELECTION_POLICY','配送由后端按最近可用设备原则自动选择，不能强制指定其他设备',{selectedVehicleId:decision.selected.vehicleId});
        const candidate=requested?decision.candidates.find(c=>c.vehicleId===requested&&c.eligible):decision.selected;
        if(!candidate)fail(409,'NO_VEHICLE_AVAILABLE','暂无满足路线、电量、载重与任务占用要求的配送设备',{candidates:decision.candidates.map(c=>({vehicleId:c.vehicleId,reasons:c.reasons}))});
        d.vehicleId=candidate.vehicleId;d.routePlan={...candidate.routePlan,reason:candidate.reason};d.dispatchReason=candidate.reason;d.progress=0;d.eta=Math.ceil(d.routePlan.estimatedDurationSeconds/60);d.approvalPolicy=d.approvalPolicy||'legacy_approved';d.selectionPolicy='nearest_feasible_pickup_with_battery_reserve';
        d.routingCandidates=this.dispatchCandidates(decision);
        d.phase=d.routePlan.pickupDistanceMeters>0?'to_pickup':'to_destination';
        this.record(user,'delivery.auto_dispatched',d.id,{vehicleId:d.vehicleId,reason:candidate.reason,action:body.action,routePlan:d.routePlan,approvalPolicy:d.approvalPolicy});
      }
      d.exception=null;d.status='running';
    }else d.status={pause:'paused',recall:'returning',cancel:'cancelled',sign:'signed',archive:'archived'}[body.action];
    if(body.action==='recall')d.returnProgress=0;if(body.action==='sign')d.signedAt=now();
    if(body.action==='cancel')for(const a of this.store.all('approvals').filter(a=>a.relatedId===d.id&&a.status==='pending')){a.status='withdrawn';a.result='配送已取消';this.store.put('approvals',a);}
    d.source='human';this.store.put('deliveries',d);if(d.vehicleId)this.syncVehicle(d.vehicleId,d.status);if(previousVehicleId&&previousVehicleId!==d.vehicleId)this.syncVehicle(previousVehicleId,'reassigned');this.record(user,'delivery.'+body.action,d.id,{vehicleId:d.vehicleId,status:d.status});this.changed('delivery');return d;
  }
  syncVehicle(vehicleId,taskStatus) {const vehicle=this.store.get('devices',vehicleId);if(!vehicle||vehicle.status==='offline')return;const current=[...this.store.all('patrols'),...this.store.all('deliveries')].find(t=>(t.robotId===vehicleId||t.vehicleId===vehicleId)&&['running','returning'].includes(t.status));vehicle.status=current?'running':'online';vehicle.state.taskStatus=current?.status||taskStatus;vehicle.updatedAt=now();this.store.put('devices',vehicle);}
  createApproval(user,body,internal=false) {
    const type=choice(body.type,['maintenance','purchase','delivery','permission','incident'],'申请类型');const title=text(body.title,'申请标题');
    if(type==='delivery'&&!internal)fail(400,'USE_DELIVERY_FLOW','配送申请请通过创建配送任务发起');
    if(body.description!==undefined)text(body.description,'申请说明',2000,false);
    if(body.relatedId&&type==='maintenance')this.entity('devices',body.relatedId);
    const a={id:id('OA'),title,type,requester:user.name,requesterId:user.id,status:'pending',createdAt:now(),relatedId:body.relatedId||null,description:body.description||'',steps:[{name:'申请提交',status:'completed',at:now()},{name:'审批确认',status:'pending'},{name:'执行反馈',status:'waiting'}],result:null,history:[]};
    this.store.put('approvals',a);this.record(user,'approval.created',a.id,{type,relatedId:a.relatedId});this.changed('approval');return a;
  }
  approvalAction(user,approvalId,body) {
    const a=this.entity('approvals',approvalId);choice(body.action,['approve','reject','transfer','withdraw','remind'],'审批动作');
    if(a.status!=='pending')fail(409,'INVALID_TRANSITION','该审批已结束');
    if(['approve','reject','transfer'].includes(body.action)){this.require(user,'approve');if(a.assignee&&a.assignee!==user.id&&!admins.includes(user.role))fail(403,'NOT_ASSIGNED_APPROVER','该申请已转交给其他审批人，请由指定审批人处理');}
    else if(a.requesterId!==user.id&&!admins.includes(user.role))fail(403,'FORBIDDEN','只能操作本人发起的申请');
    if(body.note!==undefined)text(body.note,'审批意见',1000,false);
    if(body.action==='transfer'){const target=text(body.assignee,'转交人',80);const assignee=this.store.db.prepare('SELECT id,name,role FROM users WHERE id=? OR username=?').get(target,target);if(!assignee||!permissions.approve.includes(assignee.role))fail(400,'INVALID_ASSIGNEE','只能转交给已注册且具有审批权限的用户');a.assignee=assignee.id;a.assigneeName=assignee.name;a.result=`已转交 ${assignee.name}`;}
    if(body.action==='remind'){a.remindedAt=now();a.result='催办已记录，等待审批处理';}
    if(body.action==='withdraw'){a.status='withdrawn';a.result='申请人已撤回';if(a.type==='delivery'){const d=this.entity('deliveries',a.relatedId);d.status='cancelled';this.store.put('deliveries',d);}}
    if(body.action==='reject'){a.status='rejected';a.result=body.note||'审批未通过';if(a.type==='delivery'){const d=this.entity('deliveries',a.relatedId);d.status='cancelled';this.store.put('deliveries',d);}}
    if(body.action==='approve'){
      a.status='approved';a.steps[1]={...a.steps[1],status:'completed',at:now(),actor:user.name};
      if(a.type==='delivery'){const d=this.entity('deliveries',a.relatedId);if(d.status!=='pending_approval')fail(409,'INVALID_TRANSITION','配送状态已变化');d.status='queued';d.approved=true;this.store.put('deliveries',d);a.result='配送校验通过，任务已进入待调度队列';a.steps[2].status='running';}
      else if(a.type==='permission'){a.result='权限申请审核通过，等待超级管理员线下授权；本系统未自动扩大权限';a.steps[2].status='waiting';}
      else {a.executionTask={id:id('WORK'),status:'queued',kind:a.type,relatedId:a.relatedId,createdAt:now()};a.result=`已创建${a.type==='maintenance'?'维修':a.type==='purchase'?'采购':'异常处置'}执行工单，模拟器将回传处理结果`;a.steps[2].status='running';}
    }
    (a.history||=[]).push({action:body.action,at:now(),actor:user.name,note:body.note||''});
    this.store.put('approvals',a);this.record(user,`approval.${body.action}`,a.id,{note:body.note||'',assignee:a.assignee});this.changed('approval');return a;
  }
  reviewAttendance(user,attendanceId,body) {
    this.require(user,'attendance');const a=this.entity('attendance',attendanceId);a.reviewNote=text(body.note||'人工核验：异常已确认并留存记录','复核说明',500);a.reviewedAt=now();a.reviewedBy=user.name;
    this.store.put('attendance',a);this.record(user,'attendance.review',a.id,{note:a.reviewNote,originalStatus:a.status});this.changed('attendance');return a;
  }
  automation(user,automationId,body) {
    this.require(user,'automate');const a=this.entity('automations',automationId);
    if(typeof body.enabled!=='boolean')fail(400,'VALIDATION_ERROR','enabled 应为布尔值');
    if(body.mode)choice(body.mode,['work','off','night','eco'],'场景模式');
    if(body.schedule&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.schedule))fail(400,'VALIDATION_ERROR','定时格式为 HH:mm');
    Object.assign(a,{enabled:body.enabled,mode:body.mode||a.mode,schedule:body.schedule||a.schedule});this.store.put('automations',a);this.record(user,'automation.updated',a.id,{enabled:a.enabled,mode:a.mode,schedule:a.schedule});this.changed('automation');return a;
  }
  takeover(user,body) {
    this.require(user,'takeover');requireTrue(body.confirmed);choice(body.action,['activate','release'],'接管动作');
    let takeover=this.store.setting('takeover');
    if(body.action==='activate') {
      if(takeover.active)fail(409,'ALREADY_TAKEN_OVER','系统已处于人工接管模式');
      const reason=text(body.reason||'管理员紧急接管','接管理由',500);const pausedTasks=[];
      for(const table of ['patrols','deliveries'])for(const task of this.store.all(table))if(activeTasks.has(task.status)){pausedTasks.push({id:task.id,table,previousStatus:task.status});task.status='paused';task.pauseReason='人工接管：在安全位置保持，等待人工调度';this.store.put(table,task);this.syncVehicle(task.robotId||task.vehicleId,'paused');}
      for(const command of this.store.all('commands'))if(command.status==='pending'&&command.source!=='human'){command.status='cancelled';command.completedAt=now();command.result='人工接管，自动指令已撤销';this.store.put('commands',command);this.record(user,'device.command.cancelled',command.id,{reason:'takeover'});}
      takeover={active:true,actor:user.name,actorId:user.id,at:now(),reason,pausedTasks,mode:'human',effects:['Agent 调用暂停','定时策略暂停','无人系统安全暂停','人类指令继续等待回执，可手动召回']};
      if(this.native?.enabled)this.native.enqueue('campus.pause',null,{paused:true},{source:'human',actor:user.name,confirmed:true});
    }else {
      if(!takeover.active)fail(409,'NOT_TAKEN_OVER','当前未处于人工接管模式');
      const blockers=[];
      if(this.store.all('alerts').some(a=>a.type==='fire'&&a.severity==='critical'&&!['reviewed','archived'].includes(a.status)))blockers.push('仍有未复核的高危消防事件');
      if(this.store.all('commands').some(c=>c.status==='pending'))blockers.push('仍有设备指令等待回执');
      if(!this.simulatorStatus().connected)blockers.push('设备模拟器未连接');
      if(blockers.length)fail(409,'RECOVERY_CHECK_FAILED','恢复前状态检查未通过',{blockers});
      takeover={active:false,actor:null,at:null,reason:null,pausedTasks:[],releasedBy:user.name,releasedAt:now(),releaseChecks:['无未复核高危消防事件','设备指令已收敛','模拟器连接正常'],notice:'自动化已恢复；此前暂停的无人任务须逐条人工恢复'};
      if(this.native?.enabled)this.native.enqueue('campus.pause',null,{paused:false},{source:'human',actor:user.name,confirmed:true});
    }
    this.store.setting('takeover',takeover);this.record(user,`takeover.${body.action}`,'park',{...takeover,password:undefined});this.changed('takeover');return takeover;
  }
  agentTools() {return {version:'1.0',contextSchema:{requestId:'string',reason:'string (optional)'},tools:[
    {name:'park.status',risk:'read',inputSchema:{type:'object',properties:{}}},{name:'energy.analyze',risk:'read',inputSchema:{type:'object',properties:{}}},{name:'alerts.summarize',risk:'read',inputSchema:{type:'object',properties:{}}},{name:'patrol.report',risk:'read',inputSchema:{type:'object',properties:{}}},
    {name:'device.control',risk:'low-lighting-only',inputSchema:{type:'object',required:['deviceIds','action','value'],properties:{deviceIds:{type:'array',items:{type:'string'},maxItems:20},action:{enum:['power','brightness']},value:{type:['boolean','number']}}}},
    {name:'patrol.create',risk:'requires-human-confirmation',inputSchema:{type:'object',properties:{name:{type:'string'}}}},
    {name:'emergency.execute',risk:'requires-human-confirmation',inputSchema:{type:'object',required:['alertId'],properties:{alertId:{type:'string'}}}}
    ],policy:{canExpandPermissions:false,allowedDeviceTypes:['light'],allowedActions:['power','brightness'],maxDevicesPerCall:20,highRisk:'proposal_only',takeover:'all_calls_blocked',directDeviceAccess:false},errorSchema:{error:{code:'string',message:'string',details:'object?'}}};}
  agent(user,body) {
    this.require(user,'agent');const tool=text(body.tool,'工具名称',80);const input=body.input||{};
    if(typeof input!=='object'||Array.isArray(input))fail(400,'VALIDATION_ERROR','input 应为对象');
    if(JSON.stringify(input).length>10000)fail(400,'VALIDATION_ERROR','工具输入过长');
    const run={id:id('AGENT'),at:now(),tool,input,context:{requestId:typeof body.context?.requestId==='string'?body.context.requestId.slice(0,128):id('REQ'),reason:typeof body.context?.reason==='string'?body.context.reason.slice(0,500):''},status:'succeeded',basis:'确定性规则模拟，未调用真实大模型；权限由业务后端限定',result:null};
    try {
      if(this.store.setting('takeover').active)fail(423,'HUMAN_TAKEOVER','人工接管期间 Agent 已暂停');
      if(tool==='park.status'){const b=this.bootstrap(user);run.result={summary:`园区 ${b.devices.length} 台设备，在线率 ${b.metrics.onlineRate}%，当前 ${b.metrics.activeAlerts} 条未归档事件。`,metrics:b.metrics};}
      else if(tool==='energy.analyze'){run.result={summary:'模拟能耗日内高峰出现在办公时段。建议对空置区域照明降至 55%，空调设为 27 ℃；空调变更需要管理员操作。',data:this.store.setting('energy'),recommendations:['照明分区节能','检查 A2 二层异常能耗','结合使用率优化空调定时策略']};}
      else if(tool==='alerts.summarize'){const alerts=this.store.all('alerts').filter(a=>a.status!=='archived');run.result={summary:`当前有 ${alerts.length} 条待闭环事件，其中 ${alerts.filter(a=>a.severity==='critical').length} 条高危消防演练事件。`,alerts:alerts.map(a=>({id:a.id,title:a.title,status:a.status,severity:a.severity})),recommendation:'优先确认高危消防告警，再完成派单、处置和复核。'};}
      else if(tool==='patrol.report'){const tasks=this.store.all('patrols');run.result={summary:`已安排 ${tasks.length} 次巡检，${tasks.filter(t=>t.status==='completed').length} 次完成。暂停任务需要确认现场条件后恢复。`,tasks};}
      else if(tool==='device.control'){
        if(!Array.isArray(input.deviceIds)||input.deviceIds.length<1||input.deviceIds.length>20)fail(400,'VALIDATION_ERROR','Agent 每次只能选择 1–20 台照明设备');
        const devices=input.deviceIds.map(k=>this.entity('devices',k));
        if(devices.some(d=>d.type!=='light')||!['power','brightness'].includes(input.action)){run.status='requires_confirmation';run.result={proposal:'请求超出 Agent 低风险照明授权范围，请管理员通过设备控制界面确认执行。',executed:false};}
        else run.result=this.commands({...user,name:`Agent / ${user.name}`},{...input,idempotencyKey:body.context?.requestId},'agent',true);
      }
      else if(['patrol.create','emergency.execute'].includes(tool)){run.status='requires_confirmation';run.result={proposal:tool==='emergency.execute'?'建议管理员确认消防告警并执行演练预案。':'建议管理员在巡检管理中创建临时任务，核验机器人及路线安全。',executed:false,requiredRole:tool==='emergency.execute'?'park_admin':'security',businessEndpoint:tool==='emergency.execute'?`/api/emergency/${input.alertId||':alertId'}/execute`:'/api/patrols'};}
      else fail(400,'UNKNOWN_TOOL','未注册的 Agent 工具');
      this.store.put('agent_runs',run);this.record(user,'agent.call',run.id,{tool,input,basis:run.basis,status:run.status,result:run.result});this.changed('agent');return run;
    }catch(error){run.status='failed';run.result={code:error.code||'INTERNAL_ERROR',message:error.message};this.store.put('agent_runs',run);this.record(user,'agent.failed',run.id,{tool,input,basis:run.basis,result:run.result});this.changed('agent');throw error;}
  }
  tick() {
    if(this.native?.enabled){this.settleCommands(true);return {ok:true,mode:'native',at:now(),notice:'实体状态由UE遥测驱动；独立模拟器不推进原生对象',...this.native.summary()};}
    const sim=this.store.setting('simulator');const tick=(sim.ticks||0)+1;const timestamp=now();this.store.setting('simulator',{...sim,lastTick:timestamp,ticks:tick,connected:true});
    this.settleCommands();
    for(const device of this.store.all('devices')){
      if(device.type==='sensor'&&device.status!=='offline'){const fire=this.store.all('alerts').some(a=>a.deviceId===device.id&&a.type==='fire'&&!['resolved','reviewed','archived'].includes(a.status));device.status=fire?'alert':'online';device.state.temperature=fire?58:Number((24+Math.sin(tick/8+device.floor)*1.3).toFixed(1));device.state.smoke=fire?0.86:0.02;device.state.humidity=Math.round(54+Math.sin(tick/12)*5);device.updatedAt=timestamp;this.store.put('devices',device);}
    }
    for(const table of ['patrols','deliveries'])for(const task of this.store.all(table)){
      const isPatrol=table==='patrols';if(!['running','returning'].includes(task.status))continue;
      const vehicle=this.store.get('devices',isPatrol?task.robotId:task.vehicleId);if(!vehicle)continue;
      if(vehicle.status==='offline'||vehicle.state.battery<15||vehicle.state.routeBlocked){task.status=isPatrol?'paused':'exception';task.exception=vehicle.status==='offline'?'设备离线':vehicle.state.routeBlocked?'路线阻塞':'低电量，待人工改派';task.pauseReason=task.exception;this.store.put(table,task);this.store.audit('设备模拟器','task.exception',task.id,{reason:task.exception});continue;}
      if(task.status==='returning'){
        task.returnProgress=(task.returnProgress||0)+25;
        if(task.returnProgress>=100){task.status='cancelled';task.returnedAt=timestamp;vehicle.position=vehicle.home;vehicle.status='online';this.store.audit('设备模拟器','task.returned',task.id,{});}
      }else{
        const previousProgress=task.progress;task.progress=Math.min(100,task.progress+10);vehicle.state.progress=task.progress;vehicle.status='running';
        if(!isPatrol&&task.routePlan?.points?.length){
          vehicle.position=positionOnRoute(task.routePlan.points,task.progress/100);const used=task.routePlan.estimatedBatteryUse*(task.progress-previousProgress)/100;vehicle.state.battery=Number(Math.max(0,vehicle.state.battery-used).toFixed(2));
          task.eta=Math.max(0,Math.ceil(task.routePlan.estimatedDurationSeconds*(1-task.progress/100)/60));task.phase=task.progress/100*task.routePlan.distanceMeters<task.routePlan.pickupDistanceMeters?'to_pickup':'to_destination';
        }else{
          vehicle.state.battery=Number(Math.max(0,vehicle.state.battery-0.15).toFixed(2));const route=task.route||[task.from,task.to];const fraction=task.progress/100*(route.length-1);const segment=Math.min(route.length-2,Math.floor(fraction));const t=Math.min(1,fraction-segment);const from=this.entity('buildings',route[segment]);const to=this.entity('buildings',route[segment+1]);
          vehicle.position={x:Number((from.x+(to.x-from.x)*t).toFixed(2)),y:vehicle.type==='drone'?18:0.6,z:vehicle.type==='drone'?Number((from.z+(to.z-from.z)*t).toFixed(2)):3+Math.sin(t*Math.PI)*2};if(isPatrol)task.checkpoint=Math.floor(fraction);else task.eta=Math.max(0,Math.ceil((100-task.progress)/20));
        }
        if(task.progress===100){task.status=isPatrol?'completed':'delivered';task.completedAt=timestamp;vehicle.status='online';if(!isPatrol){vehicle.buildingId=task.to;task.phase='awaiting_handover';}this.store.audit('设备模拟器',isPatrol?'patrol.completed':'delivery.delivered',task.id,{vehicleId:vehicle.id,routeDistanceMeters:task.routePlan?.distanceMeters});}
      }
      vehicle.updatedAt=timestamp;this.store.put('devices',vehicle);this.store.put(table,task);
    }
    for(const a of this.store.all('approvals')){
      if(a.status!=='approved')continue;
      if(a.type==='delivery'){const d=this.store.get('deliveries',a.relatedId);if(d&&['signed','archived'].includes(d.status)&&a.steps[2]?.status!=='completed'){a.result='配送已签收，执行结果已回传';a.steps[2]={...a.steps[2],status:'completed',at:timestamp};this.store.put('approvals',a);this.store.audit('设备模拟器','approval.execution.completed',a.id,{deliveryId:d.id});}}
      else if(a.executionTask&&a.executionTask.status!=='completed'){
        a.executionTask.progress=(a.executionTask.progress||0)+25;
        if(a.executionTask.progress>=100){a.executionTask.status='completed';a.executionTask.completedAt=timestamp;a.result='模拟执行工单已完成并回传；真实维修/采购需接入业务系统确认';a.steps[2]={...a.steps[2],status:'completed',at:timestamp};this.store.audit('设备模拟器','approval.execution.completed',a.id,{taskId:a.executionTask.id,simulation:true});}
        this.store.put('approvals',a);
      }
    }
    for(const a of this.store.all('alerts').filter(a=>a.emergencyExecuted&&a.emergencySteps)){
      const commands=(a.commandIds||[]).map(cid=>this.store.get('commands',cid));const state=commands.every(c=>c?.status==='succeeded')?'completed':commands.some(c=>['failed','timed_out','cancelled'].includes(c?.status))?'failed':'pending';
      if(a.emergencySteps[2].status!==state){a.emergencySteps[2].status=state;this.store.put('alerts',a);}
    }
    if(!this.store.setting('takeover').active)this.runSchedules();
    this.changed('telemetry',{tick});return {ok:true,tick,at:timestamp};
  }
  settleCommands(timeoutOnly=false) {
    if(this.native?.enabled)this.native.expireCommands();
    for(const command of this.store.all('commands').filter(c=>c.status==='pending'&&!c.nativeCommandId)){
      const device=this.entity('devices',command.deviceId);const expired=Date.now()>Date.parse(command.deadline);
      if(timeoutOnly&&!expired)continue;
      if(device.state.simulateTimeout&&!expired)continue;
      if(expired){command.status='timed_out';command.result='在指令截止时间前未收到设备回执，设备状态未更新';}
      else if(device.status==='offline'||device.state.simulateFailure){command.status='failed';command.result=device.status==='offline'?'设备已离线':'模拟适配器返回执行失败';}
      else{command.status='succeeded';device.state[command.action]=command.value;if(command.action==='brightness')device.state.power=command.value>0;device.updatedAt=now();this.store.put('devices',device);command.result='模拟设备已确认执行';}
      command.completedAt=now();this.store.put('commands',command);this.store.audit('设备适配器',`device.command.${command.status}`,command.id,{deviceId:device.id,action:command.action,result:command.result});this.changed('command',{commandId:command.id,status:command.status});
    }
  }
  runSchedules() {
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());const p=Object.fromEntries(parts.map(v=>[v.type,v.value]));const day=`${p.year}-${p.month}-${p.day}`;const clock=`${p.hour}:${p.minute}`;
    const actor={id:'AUTOMATION',name:'自动化策略引擎',role:'super_admin'};
    for(const a of this.store.all('automations'))if(a.enabled&&a.schedule===clock&&a.lastRunDate!==day){
      a.lastRunDate=day;a.lastRunAt=now();
      try{const result=this.scenes(actor,{mode:a.mode},'automation');a.lastResult=`已入队 ${result.commands.length} 条模拟指令`;}catch(e){a.lastResult=`执行失败：${e.message}`;this.store.audit(actor,'automation.failed',a.id,{code:e.code,message:e.message});}
      this.store.put('automations',a);
    }
  }
}
