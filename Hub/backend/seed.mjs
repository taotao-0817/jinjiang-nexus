import { randomBytes, scryptSync } from 'node:crypto';
import { now } from './store.mjs';

export function seed(store) {
  if (store.setting('seedVersion')) return;
  store.transaction(() => {
    const names = [ ['admin','总控管理员','super_admin'],['park','园区管理员','park_admin'],['security','安保值班员','security'],['ops','设备运维员','ops'],['approver','流程审批员','approver'],['viewer','园区观察员','user'] ];
    for (const [username,name,role] of names) {
      const salt=randomBytes(16).toString('hex'); const hash=scryptSync(process.env.DEMO_PASSWORD || 'Bailuwan2026!',salt,64).toString('hex');
      store.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(`U-${username}`,username,name,role,salt,hash);
    }
    const buildingData = [
      ['B01','科创中心','A1',-30,-22,15,13,26,8,'总部办公',286],['B02','研发中心','A2',-9,-24,13,12,21,6,'研发实验',218],
      ['B03','智慧运营中心','B1',16,-23,17,12,18,5,'运营指挥',156],['B04','企业服务中心','B2',37,-19,12,15,14,4,'企业服务',128],
      ['B05','创新工坊','C1',-32,16,16,13,17,5,'联合办公',192],['B06','生态会客厅','C2',-9,21,15,12,10,3,'会议展览',86],
      ['B07','人才公寓','D1',18,20,14,14,23,7,'人才社区',234],['B08','低碳能源站','D2',39,19,11,11,11,3,'能源设施',32]
    ];
    for(const d of buildingData) store.put('buildings',Object.fromEntries(['id','name','code','x','z','width','depth','height','floors','usage','occupancy'].map((k,i)=>[k,d[i]])));
    let index=0;
    for(const b of store.all('buildings')) {
      for(let f=1;f<=3;f++) for (const type of ['light','hvac','window','sensor']) {
        index++; const suffix={light:'智能照明',hvac:'新风空调',window:'电动天窗',sensor:'复合烟温感'}[type];
        const state = type==='light'?{power:true,brightness:72,powerKw:0.18}:type==='hvac'?{power:true,temperature:25,mode:'auto',powerKw:3.2}:type==='window'?{open:false,powerKw:0}:{temperature:24+f*0.4,smoke:0.02,humidity:55,powerKw:0.004};
        store.put('devices',{id:`DEV-${String(index).padStart(3,'0')}`,name:`${b.code} · ${f}F ${suffix}`,type,buildingId:b.id,floor:f,position:{x:b.x+(f-2)*3,y:f*3.1,z:b.z},status:index===26?'offline':'online',state,capabilities:type==='light'?['power','brightness']:type==='hvac'?['power','temperature','mode']:type==='window'?['open']:[],updatedAt:now(),adapter:'simulated'});
      }
    }
    const mobile = [
      ['ROB-01','白鹭·巡检一号','robot','B01',-25,0,5,86],['ROB-02','白鹭·巡检二号','robot','B05',-35,0,8,72],
      ['UAV-01','云翼·配送无人机','drone','B03',16,13,-10,94],['UAV-02','云翼·备用无人机','drone','B08',38,9,8,18],
      ['DLV-01','鹭行·配送机器人','delivery_robot','B06',-8,0,9,81],['DLV-02','鹭行·配送二号','delivery_robot','B04',35,0,3,67]
    ];
    for(const [id,name,type,buildingId,x,y,z,battery] of mobile) store.put('devices',{id,name,type,buildingId,floor:1,position:{x,y,z},home:{x,y,z},status:'online',state:{battery,progress:0,loadKg:0,speed:type==='drone'?8:1.2},capabilities:['pause','recall'],updatedAt:now(),adapter:'simulated'});
    const createdAt = now();
    store.put('alerts',{id:'ALT-001',title:'C1 东侧消防通道占用',type:'security',severity:'medium',status:'detected',buildingId:'B05',deviceId:'ROB-02',description:'巡检机器人发现消防通道存在模拟遗留物，需要安保人员现场核验。',createdAt,drill:true,evidence:{kind:'simulation',camera:'C1-东侧通道',caption:'模拟识别画面 · 非真实影像',confidence:0.94},timeline:[{action:'发现',at:createdAt,actor:'白鹭·巡检二号',note:'目标检测：通道阻塞，置信度 94%'}]});
    store.put('alerts',{id:'ALT-002',title:'A2 二层空调能耗偏高',type:'energy',severity:'low',status:'confirmed',buildingId:'B02',deviceId:'DEV-018',description:'当前空调能耗较同类设备模拟基线高 18%，建议检查空调设定温度与门窗状态。',createdAt,drill:true,timeline:[{action:'发现',at:createdAt,actor:'能耗监测',note:'模拟阈值规则触发'},{action:'确认',at:createdAt,actor:'设备运维员',note:'已确认，等待处理'}]});
    store.put('patrols',{id:'PAT-001',name:'北区日间安全巡检',robotId:'ROB-01',status:'running',progress:32,route:['B01','B02','B03','B04'],createdAt,checkpoint:1,source:'human'});
    store.put('patrols',{id:'PAT-002',name:'南区消防通道巡检',robotId:'ROB-02',status:'paused',progress:68,route:['B05','B06','B07','B08'],createdAt,checkpoint:2,source:'human',pauseReason:'等待通道异常处理'});
    store.put('deliveries',{id:'DLV-T001',title:'研发样品 · 恒温箱',from:'B03',to:'B02',vehicleId:'UAV-01',priority:'urgent',status:'running',progress:42,eta:2,weight:1.2,createdAt,approved:true,route:['B03','B02'],source:'human'});
    store.put('deliveries',{id:'DLV-T002',title:'会议材料 · 运营周报',from:'B03',to:'B06',vehicleId:'DLV-01',priority:'normal',status:'pending_approval',progress:0,eta:5,weight:2.5,createdAt,approved:false,route:['B03','B06'],source:'human'});
    store.put('approvals',{id:'OA-001',title:'配送申请：会议材料 · 运营周报',type:'delivery',requester:'园区管理员',requesterId:'U-park',status:'pending',createdAt,relatedId:'DLV-T002',description:'从智慧运营中心配送至生态会客厅。',steps:[{name:'业务申请',status:'completed',at:createdAt},{name:'审批确认',status:'pending'},{name:'执行反馈',status:'waiting'}],result:null});
    store.put('approvals',{id:'OA-002',title:'A2 二层设备离线检修',type:'maintenance',requester:'设备运维员',requesterId:'U-ops',status:'pending',createdAt,relatedId:'DEV-026',description:'空调离线，请安排运维排查通信链路。',steps:[{name:'报修登记',status:'completed',at:createdAt},{name:'运维审批',status:'pending'},{name:'执行反馈',status:'waiting'}],result:null});
    const dept=['园区运营','安全管理','设施运维','企业服务'];
    for(let i=1;i<=20;i++) store.put('attendance',{id:`ATT-${String(i).padStart(3,'0')}`,name:`员工 ${String(i).padStart(3,'0')}`,department:dept[i%4],shift:i%4===1?'08:00–20:00':'09:00–18:00',checkIn:i===17?null:i===8?'09:12':'08:'+String(31+i).padStart(2,'0'),status:i===17?'absent':i===8?'late':i===14?'review':i===19?'early':'present',checkpoint:i%2?'北区门禁':'南区巡查点',reviewNote:null});
    for(const a of [{id:'AUTO-01',name:'工作日晨间舒适模式',enabled:true,mode:'work',schedule:'08:30'},{id:'AUTO-02',name:'夜间低碳照明策略',enabled:true,mode:'night',schedule:'21:00'},{id:'AUTO-03',name:'离峰节能空调策略',enabled:false,mode:'eco',schedule:'12:30'}]) store.put('automations',a);
    store.setting('takeover',{active:false,actor:null,at:null,reason:null,pausedTasks:[]});
    store.setting('energy',Array.from({length:24},(_,h)=>({label:`${String(h).padStart(2,'0')}:00`,value:Math.round(95+(h>=8&&h<=19?125:15)+Math.sin(h*0.8)*22),baseline:255})));
    store.setting('simulator',{lastTick:null,ticks:0,mode:'simulation',connected:false});
    store.setting('seedVersion',1);
    store.audit('系统','system.initialized','park',{mode:'simulation',buildings:8,devices:102,notice:'全部设备、人物、数据及场景均为模拟'});
  });
}
