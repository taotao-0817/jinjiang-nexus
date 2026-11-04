// Names are a vocabulary for scene entities, not an intent-to-command rule table.
export const buildingAliases={B01:['科创中心','总部','总部办公楼'],B02:['研发中心','研发楼'],B03:['智慧运营中心','运营楼'],B04:['企业服务中心'],B05:['创新工坊'],B06:['生态会客厅'],B07:['人才楼','原人才公寓'],B08:['原低碳能源站办公楼']};
export const kindNames={luminaire:'室内灯具',street_light:'路灯',facility_light:'设施照明',computer:'电脑主机',monitor:'电脑显示器',camera_sensor:'监控摄像头',occupancy_sensor:'人员存在传感器',smoke_sensor:'烟感',server_rack:'数据中心机柜',hvac:'空调',screen:'显示屏',printer:'打印机',socket:'插座'};
export const roomNames={'LOBBY / LIFT HALL':'门厅与电梯厅','WORKSPACE SOUTH':'南侧办公区','WORKSPACE NORTH':'北侧办公区',MEETING:'会议室','TEA POINT':'茶水间','WASHROOM SOUTH':'南侧卫生间','WASHROOM NORTH':'北侧卫生间','STAIR WEST':'西楼梯间','STAIR EAST':'东楼梯间',CANTEEN:'员工食堂'};
export const controls={
 'lighting.set':'房间、楼层、整栋或全园照明。targetId为房间ID/建筑ID/CANTEEN/all；params:{on:boolean,brightness?:0..100,floor?:整数}。',
 'iot.set':'单个电器供电。targetId为设备ID；params:{power:boolean}。可配合查找结果selectionId批量处理。',
 'energy.configure':'全园占用感知照明节电策略（不是单栋/单层），人员进入恢复。params:{enabled:boolean,idleSeconds?:10..3600,dimPercent?:10..80}。若用户只要求局部调暗，请查找该处无人灯区并用lighting.set。',
 'hvac.set':'楼层空调控制器。targetId建筑；params:{buildingId,floor,power?:boolean,temperature?:16..30,mode?:auto/cool/heat/fan/eco}。不是真实温度仿真。',
 'gate.set':'大门开闭。targetId:GATE-MAIN；params:{open:boolean}。消防期间不能关闭。',
 'fire.source':'指定房间模拟烟热源。targetId房间灯区ID；params:{active:boolean}。这是演练，查询火情时不要注入。',
 'fire.set':'消防联动/复位。targetId:campus；params:{active:boolean}。烟温未恢复不能复位。',
 'staff.schedule':'全部员工目标。params:{stage:0上班/1工作/2吃饭/3下班}。沿路线乘梯，不瞬移。',
 'staff.dispatch':'单个员工目标，targetId员工；params:{stage:0..3}，可按selectionId批量。',
 'staff.notify':'员工演示收件箱。targetId员工；params:{message:文字}，可按selectionId批量。不是真实短信。',
 'campus.pause':'全园实体暂停/继续。params:{paused:boolean}。',
 'daynight.set':'昼夜。params:{night:boolean}。',
 'network.overlay':'全部设备数据流可视化。params:{visible:boolean}。',
 'visitor.lift':'导览者客梯选层。targetId建筑；params:{buildingId,floor}。',
 'patrol.start':'地面非人形安防车巡检。targetId可用ROB-01..04；params:{route:实际可通行建筑ID数组}。当前路线覆盖前8栋。',
 'patrol.action':'巡检车暂停/继续/召回/取消。targetId巡检车；params:{action:pause/resume/recall/cancel}。',
 'delivery.action':'物流暂停/继续。params:{action:pause/resume}。',
 'delivery.dispatch':'绑定正在配送的已有实物，不生成新物品。targetId包裹；params:{parcelId}。',
 'delivery.transfer':'已送达实物在同栋不同楼层间取送。targetId包裹；params:{parcelId,floor:目标楼层}。原批次完成且前排可取时可用；不需要再问已知包裹重量。',
 'drone.dispatch':'派出仍ready的既有无人机及实物包裹，按其实际航路配送。targetId无人机；params:{}。不可编造新航路/实物。',
 'infrastructure.set':'数据中心、车库、公共馆、起降枢纽等现有设施控制。targetId设施；params:{enabled:boolean}。',
 'sandbox.configure':'组合办公/午餐/晚间场景。params:{scenario:work/lunch/evening,speed:0.25/0.5/1}。'
};

export function spatialName(b){return `${b.y>=16000?'北':b.y>=0?'中':'南'}区${b.x< -18000?'西侧':b.x>18000?'东侧':b.x<0?'中西侧':'中东侧'} ${b.floors}层办公楼`;}
