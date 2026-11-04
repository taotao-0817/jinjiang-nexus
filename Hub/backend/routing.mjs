// Simulated campus route graph. Vehicle decisions are validated server-side, never executed from model text.
const round=n=>Math.round(n*100)/100;
const distance=(a,b)=>Math.hypot(a.x-b.x,(a.y||0)-(b.y||0),a.z-b.z);
const point=(x,y,z)=>({x:round(x),y:round(y),z:round(z)});
const MOBILE=['drone','delivery_robot'];
export function makeRoadGraph(buildings){
  const nodes=new Map(),edges=new Map(),xs=[...new Set([-66,4,...buildings.map(b=>b.x)])].sort((a,b)=>a-b),zs=[-43,0,43];
  const add=(id,p)=>{nodes.set(id,p);if(!edges.has(id))edges.set(id,[]);};
  const link=(a,b,kind='road')=>{const d=distance(nodes.get(a),nodes.get(b));edges.get(a).push({to:b,distance:d,kind});edges.get(b).push({to:a,distance:d,kind});};
  for(const z of zs)for(const x of xs)add('road:'+x+':'+z,point(x,.6,z));
  for(const z of zs)for(let i=1;i<xs.length;i++)link('road:'+xs[i-1]+':'+z,'road:'+xs[i]+':'+z);
  for(const x of [-66,4])for(let i=1;i<zs.length;i++)link('road:'+x+':'+zs[i-1],'road:'+x+':'+zs[i]);
  for(const b of buildings){const z=zs.slice().sort((a,c)=>Math.abs(a-b.z)-Math.abs(c-b.z))[0];const entryZ=b.z+(z>b.z?1:-1)*(b.depth/2+1);add('entry:'+b.id,point(b.x,.6,entryZ));link('entry:'+b.id,'road:'+b.x+':'+z,'building_access');}
  return{nodes,edges};
}
export function shortestPath(graph,from,to){
  const cost=new Map([[from,0]]),prior=new Map(),open=new Set([from]);
  while(open.size){let current=[...open].sort((a,b)=>(cost.get(a)-cost.get(b))||a.localeCompare(b))[0];open.delete(current);if(current===to)break;for(const edge of graph.edges.get(current)||[]){const next=cost.get(current)+edge.distance;if(next<(cost.get(edge.to)??Infinity)){cost.set(edge.to,next);prior.set(edge.to,current);open.add(edge.to);}}}
  if(!cost.has(to))return null;const nodeIds=[to];while(nodeIds[0]!==from){const previous=prior.get(nodeIds[0]);if(!previous)return null;nodeIds.unshift(previous);}return{nodeIds,points:nodeIds.map(id=>graph.nodes.get(id)),distanceMeters:round(cost.get(to))};
}
function attachPosition(graph,pos){
  const p=point(Number(pos.x)||0,.6,Number(pos.z)||0);let best;
  for(const [id,loc]of graph.nodes){const d=distance(p,loc);if(!best||d<best.distance)best={id,distance:d};}
  graph.nodes.set('vehicle',p);graph.edges.set('vehicle',[{to:best.id,distance:best.distance,kind:'current_position_access'}]);graph.edges.get(best.id).push({to:'vehicle',distance:best.distance,kind:'current_position_access'});return'vehicle';
}
function joinPaths(...arrays){const result=[];for(const values of arrays)for(const p of values){if(!result.length||distance(result[result.length-1],p)>.01)result.push(p);}return result;}
export function buildDeliveryRoute(buildings,vehicle,fromId,toId,weight=1){
  const from=buildings.find(b=>b.id===fromId),to=buildings.find(b=>b.id===toId);if(!from||!to)return null;
  let pickup,delivery,algorithm,assumptions;
  if(vehicle.type==='drone'){
    const current=point(vehicle.position?.x??from.x,vehicle.position?.y??18,vehicle.position?.z??from.z),a=point(from.x,18,from.z),b=point(to.x,18,to.z);
    pickup={points:joinPaths([current],[point(current.x,18,current.z),a]),nodeIds:['vehicle','air:'+from.id]};delivery={points:[a,b],nodeIds:['air:'+from.id,'air:'+to.id]};algorithm='direct_air_corridor';assumptions='模拟空中通道，不代表真实空域或飞行许可；设备按已验证坐标执行';
  }else{
    const graph=makeRoadGraph(buildings),origin=attachPosition(graph,vehicle.position||{x:from.x,z:from.z});pickup=shortestPath(graph,origin,'entry:'+from.id);delivery=shortestPath(graph,'entry:'+from.id,'entry:'+to.id);algorithm='dijkstra';assumptions='模拟园区道路与楼宇接驳通道；道路图可替换为真实地图';
  }
  if(!pickup||!delivery)return null;
  const length=points=>round(points.slice(1).reduce((sum,p,i)=>sum+distance(points[i],p),0));
  pickup.distanceMeters=length(pickup.points);delivery.distanceMeters=length(delivery.points);const distanceMeters=round(pickup.distanceMeters+delivery.distanceMeters),points=joinPaths(pickup.points,delivery.points);
  const estimatedBatteryUse=round((vehicle.type==='drone'?3:1)+distanceMeters*(vehicle.type==='drone'?.07:.045)*(1+weight*.015));
  return{algorithm,vehicleId:vehicle.id,pickup:{...pickup,buildingId:from.id,name:from.name},delivery:{...delivery,from:from.id,to:to.id,name:to.name},points,distanceMeters,pickupDistanceMeters:pickup.distanceMeters,deliveryDistanceMeters:delivery.distanceMeters,estimatedBatteryUse,estimatedDurationSeconds:Math.ceil(10+distanceMeters/(vehicle.type==='drone'?8:1.2)),batteryBefore:Number(vehicle.state?.battery||0),batteryAfterEstimate:round(Number(vehicle.state?.battery||0)-estimatedBatteryUse),reserveBatteryPercent:20,assumptions};
}
export function deliveryCandidates(store,{from,to,weight=1,taskId,excludeId}={}){
  const buildings=store.all('buildings'),jobs=[...store.all('deliveries'),...store.all('patrols')];
  const candidates=store.all('devices').filter(v=>MOBILE.includes(v.type)).map(v=>{
    const reasons=[],maxWeight=v.type==='drone'?5:20,battery=Number(v.state?.battery||0);if(v.id===excludeId)reasons.push('排除原设备');if(v.status==='offline')reasons.push('设备离线');if(battery<25)reasons.push('电量低于25%');if(v.state?.routeBlocked)reasons.push('设备路线阻塞');if(weight>maxWeight)reasons.push('载重上限不足');if(jobs.some(j=>j.id!==taskId&&(j.vehicleId===v.id||j.robotId===v.id)&&['queued','running','paused','returning'].includes(j.status)))reasons.push('已被进行中任务占用');
    const collision=store.all('deliveries').find(d=>d.id!==taskId&&d.status==='running'&&((d.from===from&&d.to===to)||(d.from===to&&d.to===from)));if(collision)reasons.push('同一配送通道已有运行任务');
    const routePlan=buildDeliveryRoute(buildings,v,from,to,weight);if(!routePlan)reasons.push('没有可达路线');else if(routePlan.batteryAfterEstimate<20)reasons.push('预计到达后电量低于20%安全储备');
    const eligible=!reasons.length,reason=routePlan?'距取件点 '+routePlan.pickupDistanceMeters+' 米，配送 '+routePlan.deliveryDistanceMeters+' 米，电量 '+battery+'%，预计到达后 '+routePlan.batteryAfterEstimate+'%；按最近可用且电量足够原则选择':'无可达路线';
    return{resourceId:'device:'+v.id,vehicleId:v.id,name:v.name,type:v.type,eligible,reasons,score:routePlan?round(-routePlan.pickupDistanceMeters):0,reason,routePlan,battery,maxWeight};
  }).sort((a,b)=>Number(b.eligible)-Number(a.eligible)||(a.routePlan?.pickupDistanceMeters??Infinity)-(b.routePlan?.pickupDistanceMeters??Infinity)||(a.routePlan?.distanceMeters??Infinity)-(b.routePlan?.distanceMeters??Infinity)||b.battery-a.battery||a.vehicleId.localeCompare(b.vehicleId));
  return{candidates,selected:candidates.find(c=>c.eligible)||null};
}
export function positionOnRoute(points,fraction){if(!points?.length)return null;const segments=points.slice(1).map((p,i)=>distance(points[i],p));const total=segments.reduce((a,b)=>a+b,0);if(total<=.001)return{...points[points.length-1]};let remaining=Math.max(0,Math.min(1,fraction))*total;for(let i=0;i<segments.length;i++){const length=segments[i];if(remaining<=length||i===segments.length-1){const t=length?Math.min(1,remaining/length):1,a=points[i],b=points[i+1];return point(a.x+(b.x-a.x)*t,(a.y||0)+((b.y||0)-(a.y||0))*t,a.z+(b.z-a.z)*t);}remaining-=length;}return{...points[points.length-1]};}
