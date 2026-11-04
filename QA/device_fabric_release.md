# 数据中心、逐设备控制与发布验证

本轮对应 2026-11-01 的设备数据流、AI 中枢控制、访客登记、员工调度及 Windows / Mac 交付请求。

## 实现与边界

- 当前目录包含 33,181 个场景端点、24 种设备类别；其中有 6,638 套分区灯具及 3,642 个新监测节点（存在、烟感、监控各 1,214）。另有 278 个移动端点：240 员工、8 AMR、24 道路车辆和 6 架无人机。
- 三维连线使用场景实际端点坐标，按楼层汇聚至 DC01。网页使用同源导出的 45 种网格、293,162 个实例，并保留灯具、屏幕、设备指示灯的控制编号。连线为逻辑信息显示，不是实体光缆或实测网络吞吐。
- 单灯关闭会改变灯具材质、关联点光；屏幕关闭改变实际屏幕。其他电器以现场演示控制器和指示灯状态表示供电，不模拟完整电器内部机理。
- 人员传感器按当前位置选楼栋/食堂和楼层，不把员工的归属楼栋当成当前位置。烟感来自消防演练状态；监控节点没有真实视频源。
- 访客按登记码核验，验证有效接待员工、楼层、有效期和重复使用；收到实际道闸打开的回执后才标记入园。没有生物识别。
- 员工个人调度改变目标并沿现有路线行走和乘梯；回执意味着目标接收，不意味着已经到达。通知进入 UE 演示员工收件箱，使用指令编号核对送达，不发外部短信或邮件。

## 验证记录

- `Builds/Campus20QA/Saved/Nexus/iot_regression.json`：243 个抽样控制、84 个物理材质检查、3 段数据中心通行检测均通过。
- `Builds/Campus20QA/Saved/Nexus/all_regressions.json`：园区工作日、机器人几何、建筑与灯具、公共区、门区、道路车流和无人机回归通过。
- `Builds/Campus20ControlsQA/control_parity.json`：使用发布目录内的 EXE、Node 与中枢后端，41 项真实 HTTP → UE 控制通过，另验证访客放行、离园、单层 27 个传感器巡检。报告记录了实际运行的打包 EXE 路径。
- 控制系统 64 项 Node 测试通过；新增测试明确拒绝仅有成功 ACK、缺少匹配场景状态的伪成功，并覆盖访客码重放和访问角色限制。
- `Builds/Campus20QA/web_scene_regression.json`：两个网页入口共用同一园区模型，设备表、人员面板、物流和设施面板通过；无 JavaScript / WebGL 着色器错误。未登录时预期的 `/api/bootstrap` 401 单独排除。
- 网页三维场景不可见时停止绘制，数据流以受限频率刷新。UE 包粒子采用实例变换批量更新；SQLite 将一次遥测合并为单个事务提交。
- `Builds/DataCenterVisual/Saved/Nexus/`：已检查数据中心外观、机房、楼层监测点及全园数据流。发现并移除了伸入机房的树冠；入口及通道保持可通行。

## 发布状态

Windows x64 原生程序已完成构建和资源打包。发布目录为 `Builds/Releases/JinjiangNexus-Windows`，入口是 `JinjiangNexus.exe`；必须保留整个目录。程序随包附带 Node 与中枢资源，不依赖本机 Unreal Editor 或 Node 安装。

发布启动器的 `--verify` 返回 0，`QA/PackagedRuntime/all_regressions.json` 为通过，覆盖工作日、机器人几何、建筑、设施、道路车辆、无人机及逐设备控制等 11 项运行回归。实际打包 EXE 的中枢联调也已通过。最终归档由 `Tools/Release/Finalize-NexusRelease.ps1 -CreateZip` 核验源文件一致性、运行报告和新生成的 GPU 截图，并写入 `release-manifest.json` 的 `runtime_validation_passed`、验证信息和文件 SHA-256。

Mac 构建脚本与启动脚本已通过 Bash 语法检查，`Builds/Releases/MacBuildScripts.zip` 是脚本包。尚无 Mac / Xcode 环境，未生成、未验证 DMG。脚本在 Mac 上调用 UE 原生构建，再用 hdiutil 创建和校验镜像。
