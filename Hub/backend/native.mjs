import { randomUUID, timingSafeEqual } from 'node:crypto';
import { now, digest } from './store.mjs';
import { ApiError } from './service.mjs';
import {readFileSync,existsSync} from 'node:fs';

// The native bridge is deliberately a small authority boundary.  Unreal owns
// physical positions, animation, lights, lifts, parcels and vehicle state;
// this service owns intent, role checks, audit records and command delivery.
// It is dormant unless NEXUS_NATIVE_TOKEN is explicitly supplied by the
// launcher, so the original simulation API and tests remain unchanged.
const fail=(status,code,message,details)=>{throw new ApiError(status,code,message,details);};
const text=(v,label,max=180)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(400,'VALIDATION_ERROR',`${label}格式不正确`);return v.trim();};
const eq=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&timingSafeEqual(x,y);};
const id=()=>`NXC-${randomUUID().replaceAll('-','').slice(0,20).toUpperCase()}`;
const allowedTypes=new Set(['infrastructure.set','drone.dispatch','lighting.set','gate.set','fire.set','staff.schedule','campus.pause','daynight.set','visitor.lift','patrol.start','patrol.action','meeting.reserve','respond.start','hvac.set','delivery.action','delivery.dispatch']);
const highRisk=new Set(['gate.set','fire.set','campus.pause','delivery.dispatch','patrol.action','respond.start']);
allowedTypes.add('sandbox.configure');
allowedTypes.add('network.overlay');
for(const t of ['fire.source','energy.configure','delivery.transfer'])allowedTypes.add(t);
highRisk.add('fire.source');highRisk.add('delivery.transfer');
for(const t of ['iot.set','staff.dispatch','staff.notify'])allowedTypes.add(t);
for(const t of ['iot.batch','lighting.batch'])allowedTypes.add(t);
const terminal=new Set(['succeeded','failed','cancelled','timed_out']);
const bool=(v,k)=>{if(typeof v!=='boolean')fail(400,'VALIDATION_ERROR',`${k} 必须为布尔值`);};
const integer=(v,a,b,k)=>{if(!Number.isInteger(v)||v<a||v>b)fail(400,'VALIDATION_ERROR',`${k} 超出范围`);};
const buildings=[[-13000,-7000,8],[-5000,-7000,10],[3000,-7000,12],[11000,-7000,8],[-13000,4500,10],[-5000,4500,12],[3000,4500,8],[11000,4500,10]];
export const nativeActor={id:'U-native-ops',name:'UE园区操作员',role:'ops'};

export class NativeBridge {
  constructor(store,{token=process.env.NEXUS_NATIVE_TOKEN,ttlMs=15*60_000}={}) {
    this.store=store;this.token=typeof token==='string'&&token.length>=32?token:null;this.ttlMs=ttlMs;this.session=null;this.lastResponse=null;this.lastFingerprint=null;this.onChange=()=>{};
    this.store.db.exec('CREATE TABLE IF NOT EXISTS native_commands (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)))');
    const layoutPath=new URL('../frontend/public/campus-layout.json',import.meta.url);
    const devicesPath=new URL('../frontend/public/campus-devices.json',import.meta.url);this.deviceCatalog=existsSync(devicesPath)?JSON.parse(readFileSync(devicesPath,'utf8')):{version:'',devices:[]};this.deviceIndex=new Map(this.deviceCatalog.devices.map(d=>[d.id,d]));
    if(this.enabled&&existsSync(layoutPath)){const saved=JSON.parse(readFileSync(layoutPath,'utf8'));this.layout=saved.buildings.map(b=>({...b,x:b.x*100,y:b.z*100}));this.bindCampus();}
  }
  get enabled(){return !!this.token;}
  assertToken(value){if(!this.enabled)fail(503,'NATIVE_BRIDGE_DISABLED','UE 原生控制桥未启用');if(!eq(value,this.token))fail(401,'NATIVE_UNAUTHORIZED','原生控制桥凭据无效');}
  tokenFrom(req){return req.headers['x-nexus-token']||req.headers.authorization?.replace(/^Bearer\s+/i,'');}
  assertSession(value){if(!this.session||!eq(value,this.session.sessionId)||Date.now()>this.session.expiresAt)fail(401,'NATIVE_SESSION_EXPIRED','UE 原生会话已过期，请重新注册');return this.session;}
  register(value,payload={}) {
    this.assertToken(value);const runId=text(payload.runId,'运行标识',120);
    if(payload.schemaVersion!=='1')fail(400,'NATIVE_SCHEMA_UNSUPPORTED','原生桥 schemaVersion 必须为 1');
    if(!Array.isArray(payload.capabilities)||payload.capabilities.length<1||payload.capabilities.length>100)fail(400,'VALIDATION_ERROR','原生能力列表无效');
    const capabilities=[...new Set(payload.capabilities.map(v=>this.ensureType(v)))];
    if(this.session?.runId===runId&&Date.now()<this.session.expiresAt)return {sessionId:this.session.sessionId,expiresAt:new Date(this.session.expiresAt).toISOString(),schemaVersion:'1',serverCapabilities:[...allowedTypes],nextSequence:this.session.lastSequence+1};
    if(this.session)for(const c of this.session.queue)if(!terminal.has(c.status)){c.status='failed';c.message='UE运行已替换；不会向新运行重播旧命令';c.completedAt=now();this.persistCommand(c);}
    const session={sessionId:randomUUID(),runId,createdAt:now(),expiresAt:Date.now()+this.ttlMs,lastSequence:-1,capabilities,telemetry:null,queue:[],history:[]};
    this.session=session;this.lastResponse=null;
    this.store.setting('nativeBridge',{enabled:true,runId,sessionId:session.sessionId,createdAt:session.createdAt,expiresAt:new Date(session.expiresAt).toISOString(),capabilities:session.capabilities,lastSequence:-1,connected:true});
    this.store.audit('UE原生桥','native.register',runId,{schemaVersion:'1',capabilities:session.capabilities});
    this.layout=Array.isArray(payload.buildings)&&payload.buildings.length?payload.buildings:buildings.map(([x,y,floors],i)=>({id:'B'+String(i+1).padStart(2,'0'),x,y,floors}));
    this.bindCampus();
    return {sessionId:session.sessionId,expiresAt:new Date(session.expiresAt).toISOString(),schemaVersion:'1',serverCapabilities:[...allowedTypes],nextSequence:0};
  }
  bindCampus(){
    for(const [i,layout] of this.layout.entries()){
      const {x,y:z,floors}=layout,key=layout.id,b=this.store.get('buildings',key)||{id:key,name:layout.name||`园区 ${key}`,type:'office',status:'normal'};this.store.put('buildings',{...b,code:'A'+String(i+1).padStart(2,'0'),x:x/100,z:z/100,width:40,depth:38,height:floors*3.5,floors,adapter:'native',positionSource:'UE-centimetres',occupancy:0});
      if(b)this.store.put('rooms',{id:`ROOM-NATIVE-${key}`,name:`${b.name} · 一层会议室`,buildingId:key,floor:1,capacity:6,equipment:['会议显示屏','独立照明','真实室内'],status:'available',adapter:'native'});
    }
    for(const room of this.store.all('rooms'))if(!room.id.startsWith('ROOM-NATIVE-')){room.status='offline';room.adapter='unmapped';this.store.put('rooms',room);}
    for(const d of this.store.all('devices')){
      if(['light','hvac','sensor'].includes(d.type)||['ROB-01','ROB-02'].includes(d.id)){d.adapter='native';d.status='offline';d.position={x:(this.store.get('buildings',d.buildingId)?.x||0),y:(d.floor-1)*3.5,z:(this.store.get('buildings',d.buildingId)?.z||0)};}
      else {d.adapter='unmapped';d.status='offline';d.unavailableReason='本次UE场景没有该原种子设备的实体映射';}
      this.store.put('devices',d);
    }
    for(const table of ['patrols','deliveries'])for(const task of this.store.all(table))if(['running','queued','paused','returning'].includes(task.status)&&!task.nativeCommandId){task.status='cancelled';task.cancelReason='载入UE实体园区，旧独立模拟任务保留为历史';this.store.put(table,task);}
    for(const e of this.store.all('attendance'))if(e.source!=='native'){e.status='historical';e.source='original_seed';this.store.put('attendance',e);}
  }
  validate(type,targetId,p){
    if(type==='lighting.set'&&targetId&&targetId!=='all'&&targetId!=='CANTEEN'&&!((this.session?.telemetry?.rooms||[]).some(r=>r.id===targetId||(targetId==='CANTEEN'&&r.name==='CANTEEN'))||(/^B\d{2}$/.test(targetId)&&this.store.get('buildings',targetId))))fail(400,'INVALID_ZONE','没有找到该建筑或灯区');
    if(['iot.batch','lighting.batch'].includes(type)){
      if(!Array.isArray(p.ids)||!p.ids.length||p.ids.length>256||p.ids.some(x=>typeof x!=='string')||new Set(p.ids).size!==p.ids.length)fail(400,'INVALID_BATCH','批量目标须为1至256个不重复的实体');
      const single=type.replace('.batch','.set');for(const id of p.ids){if(type==='lighting.batch'&&!(this.session?.telemetry?.rooms||[]).some(r=>r.id===id||r.buildingId===id||(id==='CANTEEN'&&r.name==='CANTEEN')))fail(400,'INVALID_ZONE','批量照明包含不存在的区域');this.validate(single,id,{...p,buildingId:id.startsWith('B')?id:p.buildingId});}return;
    }
    if(type==='energy.configure'){bool(p.enabled,'enabled');if(p.idleSeconds!==undefined)integer(p.idleSeconds,10,3600,'空闲秒数');if(p.dimPercent!==undefined)integer(p.dimPercent,10,80,'节电亮度');}
    if(type==='fire.source'){bool(p.active,'active');if(!(this.session?.telemetry?.rooms||[]).some(r=>r.id===targetId))fail(400,'INVALID_ZONE','请选择现场房间灯区');}
    if(type==='delivery.transfer'){
      const parcel=this.session?.telemetry?.parcels?.find(x=>x.id===p.parcelId);if(!parcel||parcel.carrier!=='floor_receiver')fail(409,'PARCEL_NOT_READY','请等待实物到达楼层收件架');
      const b=this.store.get('buildings',parcel.buildingId);integer(p.floor,1,b?.floors||0,'目标楼层');if(p.floor===parcel.floor)fail(400,'SAME_FLOOR','目标须为同一楼宇的另一个楼层');
      if((this.session?.telemetry?.floorTransfers||[]).some(j=>j.status!=='completed'&&(this.session.telemetry.parcels.find(x=>x.id===j.parcelId)?.buildingId===parcel.buildingId)))fail(409,'COURIER_BUSY','本楼配送机器人已有跨层任务');
    }
    if(type==='iot.set'){bool(p.power,'power');const d=this.deviceIndex.get(targetId);if(!d||this.session?.telemetry?.iot?.catalogVersion!==this.deviceCatalog.version||this.session?.telemetry?.iot?.count!==this.deviceCatalog.devices.length)fail(409,'DEVICE_CATALOG_MISMATCH','设备目录与现场版本不一致，请重新导出园区');}
    if(['staff.dispatch','staff.notify'].includes(type)){if(!(this.session?.telemetry?.staff||[]).some(e=>e.id===targetId))fail(400,'INVALID_STAFF','未找到场景员工');if(type==='staff.dispatch'){integer(p.stage,0,3,'人员目标');if(this.session?.telemetry?.flags?.fire)fail(409,'FIRE_INTERLOCK','消防期间不能改派员工');}else text(p.message,'员工通知',500);}
    if(type==='network.overlay')bool(p.visible,'visible');
    if(type==='sandbox.configure'){if(!['work','lunch','evening'].includes(p.scenario)||![.25,.5,1].includes(p.speed))fail(400,'VALIDATION_ERROR','请选择办公、午餐或晚间场景，以及 0.25、0.5 或 1 倍速度');if(this.session?.telemetry?.flags?.fire)fail(409,'NATIVE_FIRE_INTERLOCK','请先结束消防演练');}
    if(type==='infrastructure.set'){bool(p.enabled,'enabled');if(!(this.session?.telemetry?.infrastructure||[]).some(f=>f.id===targetId))fail(400,'VALIDATION_ERROR','该设施没有实体映射');}
    if(type==='drone.dispatch'){const d=this.session?.telemetry?.drones?.find(d=>d.id===targetId);if(!d||d.status!=='ready'||d.delivered)fail(409,'NATIVE_DRONE_UNAVAILABLE','无人机未就绪或本批实物已派出');}
    const building=()=>{const b=p.buildingId||targetId;if(typeof b!=='string'||!/^B\d{2}$/.test(b)||!this.store.get('buildings',b))fail(400,'VALIDATION_ERROR','请选择当前园区的有效建筑');return b;};
    const floor=()=>{const b=this.store.get('buildings',building());integer(p.floor,1,b.floors,'楼层');};
    if(type==='lighting.set'){bool(p.on,'on');if(targetId!=null&&!/^B\d{2}$|^LIGHT-B\d{2}-F\d{2}-Z\d{2}$|^CANTEEN$|^all$/.test(targetId))fail(400,'VALIDATION_ERROR','照明区域标识无效');if(p.floor!==undefined)floor();if(p.brightness!==undefined&&(typeof p.brightness!=='number'||p.brightness<0||p.brightness>100))fail(400,'VALIDATION_ERROR','亮度应为0到100');}
    if(type==='hvac.set'){floor();if(p.power!==undefined)bool(p.power,'power');if(p.temperature!==undefined&&(typeof p.temperature!=='number'||p.temperature<16||p.temperature>30))fail(400,'VALIDATION_ERROR','温度应为16到30');if(p.mode!==undefined&&!['auto','cool','heat','fan','eco'].includes(p.mode))fail(400,'VALIDATION_ERROR','空调模式无效');}
    if(type==='gate.set')bool(p.open,'open');if(type==='fire.set')bool(p.active,'active');if(type==='campus.pause')bool(p.paused,'paused');if(type==='daynight.set')bool(p.night,'night');if(type==='staff.schedule')integer(p.stage,0,3,'员工日程');
    if(type==='visitor.lift')floor();
    if(type==='patrol.start'){if(!['ROB-01','ROB-02','ROB-03','ROB-04'].includes(p.vehicleId||targetId))fail(400,'VALIDATION_ERROR','巡检车标识无效');if(!Array.isArray(p.route)||!p.route.length||p.route.length>16||p.route.some(b=>!/^B0[1-8]$/.test(b)))fail(400,'VALIDATION_ERROR','巡检路线无效');}
    if(type==='patrol.action'&&!['pause','resume','recall','cancel'].includes(p.action))fail(400,'VALIDATION_ERROR','巡检动作无效');
    if(type==='delivery.action'&&!['pause','resume'].includes(p.action))fail(400,'VALIDATION_ERROR','物流仅支持暂停和继续');
    if(type==='delivery.dispatch'){
      const parcelId=p.parcelId||targetId;if(!/^PARCEL-(0[0-9]|1[0-5])$/.test(parcelId||''))fail(400,'NATIVE_FINITE_BATCH_REQUIRED','配送须绑定现有 PARCEL-00 至 PARCEL-15');
      const parcel=this.session?.telemetry?.parcels?.find(p=>p.id===parcelId);if(!parcel)fail(409,'NATIVE_PARCEL_UNAVAILABLE','本次UE运行没有该实体包裹');if(p.to&&p.to!==parcel.buildingId)fail(409,'NATIVE_PARCEL_DESTINATION','不能更改实体包裹的固定收件建筑');
    }
    if(type==='meeting.reserve'){floor();if(p.active!==undefined)bool(p.active,'active');}
    if(type==='respond.start'){floor();if(!['fire','fall'].includes(p.kind))fail(400,'VALIDATION_ERROR','响应类型无效');}
  }
  ensureType(type){if(!allowedTypes.has(type))fail(400,'NATIVE_UNSUPPORTED_COMMAND','原生桥不支持该控制类型');return type;}
  enqueue(type,targetId,params={},meta={}) {
    this.ensureType(type);const session=this.assertSession(meta.sessionId||this.session?.sessionId);
    if(highRisk.has(type)&&meta.confirmed!==true)fail(409,'CONFIRMATION_REQUIRED','该原生动作需要明确人工确认');
    if(!session.capabilities.includes(type)&&!session.capabilities.includes('*'))fail(400,'NATIVE_CAPABILITY_MISSING',`UE 未声明能力 ${type}`);
    if(typeof params!=='object'||Array.isArray(params))fail(400,'VALIDATION_ERROR','原生参数必须是对象');
    this.validate(type,targetId,params);
    const command={id:id(),type,targetId:targetId==null?null:text(String(targetId),'目标标识',160),params,status:'queued',createdAt:now(),deadline:new Date(Date.now()+(['delivery.transfer','drone.dispatch','patrol.start','respond.start','delivery.dispatch','visitor.lift'].includes(type)?3600000:30000)).toISOString(),source:meta.source||'hub',actor:meta.actor||'中枢',idempotencyKey:meta.idempotencyKey||null};
    if(command.idempotencyKey){text(command.idempotencyKey,'幂等键',128);const old=session.queue.find(x=>x.idempotencyKey===command.idempotencyKey&&x.actor===command.actor);if(old){if(JSON.stringify([old.type,old.targetId,old.params])!==JSON.stringify([type,command.targetId,params]))fail(409,'IDEMPOTENCY_CONFLICT','相同幂等键不能用于不同控制');return old;}}
    if(session.queue.filter(c=>!terminal.has(c.status)).length>=1000)fail(429,'NATIVE_QUEUE_FULL','原生命令队列已满，请等待设备回执');
    session.queue.push(command);this.persistCommand(command);this.persist();this.store.audit(meta.actor||'中枢','native.command.queued',command.id,{type,targetId,source:command.source});return command;
  }
  enqueueDeviceCommand(backendCommand,device,actor='设备运维员') {
    const type=device.type==='light'?'lighting.set':device.type==='hvac'?'hvac.set':null;
    if(!type)fail(400,'NATIVE_UNSUPPORTED_DEVICE','该设备类型没有 UE 原生控制映射');
    const params=device.type==='light'
      ? {on:backendCommand.action==='power'?backendCommand.value:backendCommand.value>0,brightness:backendCommand.action==='brightness'?backendCommand.value:undefined}
      : {power:backendCommand.action==='power'?backendCommand.value:undefined,temperature:backendCommand.action==='temperature'?backendCommand.value:undefined,mode:backendCommand.action==='mode'?backendCommand.value:undefined};
    const targetId=device.nativeId||device.buildingId;params.buildingId=device.buildingId;params.floor=device.floor;
    const command=this.enqueue(type,targetId,Object.fromEntries(Object.entries(params).filter(([,v])=>v!==undefined)),{source:'web',actor,sessionId:this.session?.sessionId,idempotencyKey:`backend:${backendCommand.id}`});
    command.backendCommandId=backendCommand.id;this.persistCommand(command);return command;
  }
  applyTelemetry(telemetry) {
    if(!telemetry||typeof telemetry!=='object'||Array.isArray(telemetry))fail(400,'VALIDATION_ERROR','telemetry 必须为对象');
    const s=this.session;s.telemetry=telemetry;s.lastTelemetryAt=now();
    // Canonical UE coordinates are centimetres; expose a metres copy only in
    // the bridge snapshot. Backend business rows are never moved by guesswork.
    this.store.setting('nativeTelemetry',{at:now(),runId:s.runId,sequence:s.lastSequence,telemetry});
    this.store.setting('simulator',{...(this.store.setting('simulator')||{}),lastTick:now(),ticks:(this.store.setting('simulator')?.ticks||0)+1,mode:'native',connected:true});
    const position=p=>({x:Number(p.x||0)/100,y:Number(p.z||0)/100,z:Number(p.y||0)/100});
    for(const b of telemetry.buildings||[]){const row=this.store.get('buildings',b.id);if(row)this.store.put('buildings',{...row,name:b.name||row.name,x:b.x/100,z:b.y/100,width:(b.width||4000)/100,depth:(b.depth||3800)/100,height:b.floors*3.5,floors:b.floors,occupancy:(telemetry.staff||[]).filter(e=>e.buildingId===b.id&&!['Offsite','offsite'].includes(e.activity)).length});}
    const roomRows=telemetry.rooms||[];
    // One audit event per detected room episode. Clearing a source does not erase it.
    for(const z of telemetry.fireDetection?.zones||[]){
      if(!z.detected)continue;
      const key=`nativeFire:${s.runId}:${z.zoneId}`;
      if(this.store.setting(key))continue;
      const alertId='ALT-NATIVE-'+randomUUID().replaceAll('-','').slice(0,16);
      const a={id:alertId,title:`【模拟探测】${z.buildingId} ${z.floor}层烟热告警`,type:'fire',severity:'critical',status:'detected',buildingId:z.buildingId,floor:z.floor,deviceId:z.zoneId,description:'实体场景房间烟热读数持续超限，现场已联动门禁释放、疏散和物流停车。',createdAt:now(),drill:true,source:'native_detector',evidence:{kind:'simulation',caption:'UE房间烟热模拟探测',smoke:z.smoke,temperature:z.temperature},timeline:[{action:'发现',at:now(),actor:'UE烟热探测器',note:`烟 ${Number(z.smoke).toFixed(2)} / 温度 ${Number(z.temperature).toFixed(1)}℃`}]};
      this.store.put('alerts',a);this.store.setting(key,alertId);this.store.audit('UE烟热探测器','native.fire.detected',alertId,{zoneId:z.zoneId,smoke:z.smoke,temperature:z.temperature});
    }
    // A reset ends the detection episode; history remains in the alerts table.
    for(const r of roomRows){const key=`nativeFire:${s.runId}:${r.id}`;if(this.store.setting(key)&&!(telemetry.fireDetection?.zones||[]).some(z=>z.zoneId===r.id&&z.detected))this.store.setting(key,null);}
    for(const r of roomRows){if(!/^LIGHT-B\d{2}-F\d{2}-Z\d{2}$/.test(r.id)||!this.store.get('buildings',r.buildingId))continue;const b=this.store.get('buildings',r.buildingId);this.store.put('devices',{id:r.id,nativeId:r.id,name:`${b.code} ${r.floor}F ${r.name||'照明分区'+r.zone}`,type:'light',buildingId:r.buildingId,floor:r.floor,position:{x:b.x,y:(r.floor-1)*3.5+2.99,z:b.z},status:'online',state:{power:r.on,brightness:r.brightness??(r.on?100:0),powerKw:null},capabilities:['power','brightness'],adapter:'native',updatedAt:now()});}
    for(const d of this.store.all('devices').filter(d=>d.adapter==='native'&&!d.nativeId)){
      const rooms=roomRows.filter(r=>r.buildingId===d.buildingId&&r.floor===d.floor),h=(telemetry.hvac||[]).find(h=>h.buildingId===d.buildingId&&h.floor===d.floor),v=(telemetry.vehicles||[]).find(v=>v.id===d.id);
      if(d.type==='light'&&rooms.length){d.state={...d.state,power:rooms.some(r=>r.on),brightness:Math.round(rooms.reduce((a,r)=>a+(r.brightness??(r.on?100:0)),0)/rooms.length)};d.status='online';}
      else if(d.type==='hvac'&&h){d.state={...d.state,power:h.power,temperature:h.temperature,mode:h.mode||d.state.mode};d.status='online';}
      else if(d.type==='sensor'){const zones=(telemetry.fireDetection?.zones||[]).filter(z=>z.buildingId===d.buildingId&&z.floor===d.floor);d.state={...d.state,smoke:Math.max(0,...zones.map(z=>z.smoke)),temperature:Math.max(24,...zones.map(z=>z.temperature)),source:'UE房间烟热模拟探测'};d.status=zones.some(z=>z.detected)?'alert':zones.some(z=>!z.detectorOnline)?'offline':'online';}
      else if(v){d.position=position(v);d.state={...d.state,progress:v.progress||0,battery:v.battery??null,batterySource:v.battery===undefined?'not_simulated':'UE',taskStatus:v.status};d.status=v.status==='idle'||v.progress>=100?'online':'running';if(v.buildingId)d.buildingId=v.buildingId;}
      d.updatedAt=now();this.store.put('devices',d);
    }
    for(const r of telemetry.robots||[]){const b=this.store.get('buildings',r.buildingId);if(!b)continue;this.store.put('devices',{id:r.id,name:`配送 AMR ${r.id}`,type:'delivery_robot',buildingId:r.buildingId,floor:r.floor||1,position:position(r),status:[12,'Parked','Done'].includes(r.phase)?'online':'running',state:{progress:r.delivered||0,battery:r.battery??null,batterySource:r.battery===undefined?'not_simulated':'UE',taskStatus:r.phase,parcelId:r.parcelId,finiteBatch:true},capabilities:['pause','resume'],adapter:'native',nativeId:r.id,updatedAt:now()});}
    // Keep the imported control system's robot type so its task capability
    // registry and resource selector can dispatch all four physical patrols.
    for(const v of telemetry.vehicles||[]){if(v.type!=='patrol_robot')continue;const old=this.store.get('devices',v.id);this.store.put('devices',{...old,id:v.id,name:`安防巡检 ${v.id}`,type:'robot',nativeType:v.type,buildingId:old?.buildingId||'B01',floor:1,position:position(v),status:v.status==='paused'?'online':'running',state:{progress:v.progress||0,battery:v.battery??null,batterySource:'UE演示估计',taskStatus:v.status,patrolRounds:v.patrolRounds||0,automaticPatrol:v.automaticPatrol===true},capabilities:['pause','resume','recall'],adapter:'native',nativeId:v.id,updatedAt:now()});}
    for(const p of telemetry.parcels||[]){const pid='UE-'+p.id,old=this.store.get('deliveries',pid),delivered=['receiver','floor_receiver','delivered'].includes(p.carrier);this.store.put('deliveries',{...old,id:pid,title:`实体包裹 ${p.id}`,from:'B01',to:p.buildingId,vehicleId:old?.vehicleId||null,priority:'normal',status:old&&['signed','archived'].includes(old.status)?old.status:delivered?'delivered':'running',phase:p.carrier,progress:delivered?100:0,weight:null,createdAt:old?.createdAt||now(),approved:true,approvalPolicy:'fixed_native_batch',nativeReadOnly:true,nativeParcelId:p.id,nativePosition:position(p),floor:p.floor,source:'native',recipient:'指定楼层收件架',adapter:'native'});}
    for(const e of telemetry.staff||[]){const old=this.store.get('attendance',e.id);this.store.put('attendance',{...old,id:e.id,name:`园区职员 ${e.id.replace('STAFF-','')}`,department:'原生园区',shift:'日程驱动',checkIn:null,status:['Offsite','offsite'].includes(e.activity)?'offsite':'present',activity:e.activity,buildingId:e.buildingId,floor:e.floor,position:position(e),source:'native',checkpoint:'实际员工遥测',reviewNote:old?.reviewNote||null});}
    return telemetry;
  }
  applyAck(ack={}) {
    const s=this.session;if(!ack||typeof ack!=='object')fail(400,'VALIDATION_ERROR','ack 必须为对象');
    const command=s.queue.find(c=>c.id===ack.id);if(!command)return {ignored:true,id:ack.id};
    if(!['accepted','running','succeeded','failed','cancelled','timed_out'].includes(ack.status))fail(400,'VALIDATION_ERROR','回执状态无效');
    if(terminal.has(command.status))return command;
    if(command.status==='running'&&ack.status==='accepted')return command;
    if(ack.status==='succeeded'&&!this.receiptMatches(command)){command.reportedAck=ack;command.status='running';command.message='UE已报告执行，等待对应实体遥测与目标状态一致';this.persistCommand(command);return command;}
    command.status=ack.status;command.updatedAt=now();if(ack.message!==undefined)command.message=String(ack.message).slice(0,500);if(ack.result!==undefined)command.result=ack.result;
    if(terminal.has(command.status))command.completedAt=now();
    if(command.backendCommandId){
      const backend=this.store.get('commands',command.backendCommandId);
      if(backend){backend.status=ack.status==='succeeded'?'succeeded':ack.status==='failed'?'failed':ack.status==='timed_out'?'timed_out':backend.status;backend.result=command.message||command.result||`UE 原生回执：${ack.status}`;backend.completedAt=command.completedAt;this.store.put('commands',backend);if(ack.status==='succeeded'){const device=this.store.get('devices',backend.deviceId);if(device){device.state[backend.action]=backend.value;if(backend.action==='brightness')device.state.power=backend.value>0;device.updatedAt=now();device.adapter='native';this.store.put('devices',device);}}}
    }
    if(command.businessTable&&command.businessId){const task=this.store.get(command.businessTable,command.businessId);if(task){task.nativeExecutionStatus=ack.status;if(ack.status==='succeeded'){task.status=command.businessTable==='patrols'?'completed':task.status;task.progress=100;task.completedAt=now();}else if(['failed','timed_out'].includes(ack.status)){task.status=command.businessTable==='patrols'?'paused':'exception';task.exception=command.message||'UE执行失败';}this.store.put(command.businessTable,task);}}
    this.store.audit('UE原生桥',`native.command.${ack.status}`,command.id,{type:command.type,targetId:command.targetId,message:command.message||''});this.persistCommand(command);this.persist();return command;
  }
  exchange(value,payload={}) {
    this.assertToken(value);const s=this.assertSession(payload.sessionId);if(!Number.isInteger(payload.sequence)||payload.sequence<0)fail(400,'VALIDATION_ERROR','sequence 必须是非负整数');
    const fingerprint=digest(JSON.stringify(payload));
    if(payload.sequence===s.lastSequence&&this.lastResponse){if(fingerprint!==this.lastFingerprint)fail(409,'NATIVE_REPLAY_CONFLICT','相同遥测序号不能使用不同内容');return this.lastResponse;}
    if(payload.sequence!==s.lastSequence+1)fail(409,'NATIVE_SEQUENCE_GAP','原生遥测序号不连续',{expected:s.lastSequence+1,received:payload.sequence});
    if(!payload.telemetry||typeof payload.telemetry!=='object'||Array.isArray(payload.telemetry))fail(400,'VALIDATION_ERROR','telemetry 必须为对象');
    for(const key of ['drones','infrastructure','buildings','rooms','staff','robots','parcels','lifts','vehicles','gates','hvac','meetings','devices'])if(payload.telemetry[key]!==undefined&&(!Array.isArray(payload.telemetry[key])||payload.telemetry[key].length>2000))fail(400,'VALIDATION_ERROR',`telemetry.${key} 无效`);
    if(payload.acks!==undefined&&(!Array.isArray(payload.acks)||payload.acks.length>1000||payload.acks.some(a=>!a||typeof a.id!=='string'||!['accepted','running','succeeded','failed','cancelled','timed_out'].includes(a.status))))fail(400,'VALIDATION_ERROR','acks 无效');
    s.lastSequence=payload.sequence;this.store.transaction(()=>this.applyTelemetry(payload.telemetry||{}));for(const ack of payload.acks||[])this.applyAck(ack);
    for(const c of s.queue)if(c.reportedAck&&!terminal.has(c.status)&&this.receiptMatches(c))this.applyAck(c.reportedAck);
    s.expiresAt=Date.now()+this.ttlMs;this.onChange();
    const response={ok:true,sessionId:s.sessionId,sequence:s.lastSequence,expiresAt:new Date(s.expiresAt).toISOString(),commands:s.queue.filter(c=>!terminal.has(c.status)),telemetryAcceptedAt:now(),hub:this.hubSummary?.()||{tasks:[],stats:{}},native:{...this.summary(),takeover:!!this.store.setting('takeover')?.active}};this.lastResponse=structuredClone(response);this.lastFingerprint=fingerprint;this.persist();return response;
  }
  summary(){const s=this.session;return{connected:!!s&&Date.now()<s.expiresAt&&!!s.lastTelemetryAt&&Date.now()-Date.parse(s.lastTelemetryAt)<8000,runId:s?.runId||null,lastSequence:s?.lastSequence??null,lastTelemetryAt:s?.lastTelemetryAt||null,queued:s?.queue.filter(c=>!terminal.has(c.status)).length||0,completed:s?.queue.filter(c=>c.status==='succeeded').length||0};}
  status(actor){const allowed=!actor||['super_admin','park_admin','security','ops','approver'].includes(actor.role);return{enabled:this.enabled,bridge:this.summary(),telemetry:allowed?this.session?.telemetry||null:null,commands:allowed?this.session?.queue||[]:[],capabilities:allowed?this.session?.capabilities||[]:[]};}
  snapshot(){const t=this.session?.telemetry||{};return{schemaVersion:'1',coordinateSystem:'unreal-centimeters',at:now(),runId:this.session?.runId||null,...t,bridge:this.summary(),commands:this.session?.queue||[]};}
  receiptMatches(c){
    if(['iot.batch','lighting.batch'].includes(c.type))return c.params.ids.every(id=>this.receiptMatches({...c,type:c.type.replace('.batch','.set'),targetId:id}));
    const t=this.session.telemetry||{},p=c.params||{},near=(a,b)=>Number.isFinite(a)&&Math.abs(a-b)<.1;
    if(c.type==='energy.configure')return t.energy?.enabled===p.enabled&&(p.idleSeconds===undefined||near(t.energy?.idleSeconds,p.idleSeconds))&&(p.dimPercent===undefined||near(t.energy?.dimPercent,p.dimPercent));
    if(c.type==='fire.source'){const z=t.fireDetection?.zones?.find(z=>z.zoneId===c.targetId);return !!t.fireDetection&&(p.active?z?.sourceActive===true:!z?.sourceActive);}
    if(c.type==='delivery.transfer')return(t.floorTransfers||[]).some(j=>j.id===c.id&&j.parcelId===p.parcelId&&j.toFloor===p.floor&&j.status==='completed')&&(t.parcels||[]).some(x=>x.id===p.parcelId&&x.floor===p.floor&&x.carrier==='floor_receiver');
    if(c.type==='iot.set'){const d=this.deviceIndex.get(c.targetId);return !!d&&t.iot?.powerBits?.[d.index]===(p.power?'1':'0');}
    if(c.type==='staff.dispatch')return(t.staff||[]).some(e=>e.id===c.targetId&&e.dispatchTarget===(p.stage===2?'meal':p.stage===3?'offsite':'work'));
    if(c.type==='staff.notify')return(t.staffNotificationReceipts||[]).includes(c.id)||(t.staffInbox||[]).some(n=>n.commandId===c.id&&n.staffId===c.targetId&&n.status==='received_in_demo');
    if(c.type==='network.overlay')return t.network?.visible===p.visible;
    if(c.type==='sandbox.configure')return t.flags?.sandboxScenario===p.scenario&&near(t.flags?.sandboxSpeed,p.speed)&&t.flags?.night===(p.scenario==='evening')&&t.flags?.scheduleStage===({work:1,lunch:2,evening:3}[p.scenario]);
    if(c.type==='infrastructure.set')return(t.infrastructure||[]).some(f=>f.id===c.targetId&&f.enabled===p.enabled);
    if(c.type==='drone.dispatch')return(t.drones||[]).some(d=>d.id===c.targetId&&d.taskId===c.id&&d.status==='completed'&&d.delivered&&d.parcel?.carrier==='receiver');
    if(c.type==='lighting.set'){const rows=(t.rooms||[]).filter(r=>(!c.targetId||c.targetId==='all'||r.id===c.targetId||r.buildingId===c.targetId||(c.targetId==='CANTEEN'&&r.name==='CANTEEN'))&&(p.floor===undefined||r.floor===p.floor));return rows.length>0&&rows.every(r=>r.on===p.on&&(p.brightness===undefined||near(r.brightness,p.brightness)));}
    if(c.type==='hvac.set'){const rows=(t.hvac||[]).filter(r=>r.buildingId===(p.buildingId||c.targetId)&&r.floor===p.floor);return rows.length>0&&rows.every(r=>(p.power===undefined||r.power===p.power)&&(p.temperature===undefined||near(r.temperature,p.temperature))&&(p.mode===undefined||r.mode===p.mode));}
    if(c.type==='staff.schedule')return t.flags?.scheduleStage===p.stage;
    if(c.type==='daynight.set')return t.flags?.night===p.night;
    if(c.type==='campus.pause')return t.flags?.paused===p.paused;
    if(c.type==='fire.set')return t.flags?.fire===p.active;
    if(c.type==='gate.set')return (t.gates||[]).some(g=>(!c.targetId||g.id===c.targetId)&&g.open===p.open&&!g.moving);
    if(c.type==='visitor.lift')return(t.lifts||[]).some(l=>l.buildingId===(p.buildingId||c.targetId)&&l.kind==='passenger'&&Math.abs(l.z-(p.floor-1)*350)<3&&l.doorOpen);
    if(c.type==='delivery.dispatch')return(t.parcels||[]).some(x=>x.id===(p.parcelId||c.targetId)&&['receiver','floor_receiver','delivered'].includes(x.carrier));
    if(c.type==='patrol.start'||c.type==='respond.start')return(t.vehicles||[]).some(v=>v.taskId===c.id&&v.progress>=100);
    if(c.type==='meeting.reserve'){const rows=(t.meetings||[]).filter(m=>m.taskId===p.taskId&&m.buildingId===p.buildingId&&m.floor===p.floor);return p.active===false?!rows.some(m=>m.active):rows.some(m=>m.active);}
    return true;
  }
  expireCommands(){if(!this.session)return;for(const c of this.session.queue)if(!terminal.has(c.status)&&Date.now()>Date.parse(c.deadline))this.applyAck({id:c.id,status:'timed_out',message:'截止时间内未收到UE实体成功回执'});}
  persist(){const s=this.session;if(!s)return;this.store.setting('nativeBridge',{enabled:this.enabled,runId:s.runId,sessionId:s.sessionId,createdAt:s.createdAt,expiresAt:new Date(s.expiresAt).toISOString(),capabilities:s.capabilities,lastSequence:s.lastSequence,connected:this.summary().connected});}
  persistCommand(c){this.store.db.prepare('INSERT INTO native_commands(id,run_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(c.id,this.session?.runId||'',JSON.stringify(c));}
  restoreQueue(){if(this.session)this.session.queue=this.store.db.prepare('SELECT body FROM native_commands WHERE run_id=? ORDER BY rowid').all(this.session.runId).map(r=>JSON.parse(r.body));}
}
