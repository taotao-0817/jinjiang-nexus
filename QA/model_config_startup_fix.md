# DeepSeek 双击启动配置修复

2026-11-01，用户从资源管理器启动 Windows 发布版时，自然语言入口返回 `MODEL_NOT_CONFIGURED`；同一台机器由开发工具启动的测试却通过。

根因是 Windows 打包桌面应用的 AppData 重定向。原有私有配置实际保存在 Codex 的 LocalCache 中，资源管理器启动的进程看不到该文件，因而使用旧的规则模式默认值。之前仅从开发工具启动的验证没有覆盖用户的启动方式。

现在私有配置优先读取 `%USERPROFILE%\.jinjiang-nexus\model.json`，密钥单独保存在该用户目录的 `Secrets` 中。此目录对开发工具和资源管理器启动的进程一致。保留旧 AppData 配置兼容；显式配置路径不存在时报告路径错误；没有配置时也不再显示规则模式已就绪。用户已有密钥已迁移，源码及发布包不包含密钥。

验证证据：

- `tests/model-config.test.mjs` 在临时用户目录中模拟两种启动环境，修复前因进入规则模式而失败，修复后通过。显式错误配置路径也有回归测试。
- Node 全部 81 项测试通过，见发布包 `QA/assistant-node-tests.log`。
- 通过资源管理器双击发布版 `JinjiangNexus.exe`，确认启动器的父进程是 `explorer.exe`。同一服务调用真实 DeepSeek 后，状态由 `not_verified` 变为 `ready`、`verified: true`。
- 只读问题“当前园区有多少栋办公楼”返回 20 栋，现场保持连接，本轮设备指令数为 0。详见 `explorer_model_config_regression.json`。

模型继续使用 `deepseek-flash`，请求显式发送 `thinking: {"type":"disabled"}`。自然语言入口由模型选择并调用园区工具，不使用关键词规则作为故障回退。

预防措施：后续发布验证同时覆盖私有配置加载回归测试与资源管理器启动的真实模型请求，不能仅凭开发工具启动成功判定配置可用。
