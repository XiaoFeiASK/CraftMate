# 真实游戏身体：接入候选

目标是让 Bridge 接入真实 Minecraft，先完成一个可观察的动作，并能由操作员接管和停止。当前状态见 [实现状态](status.md)，已有模拟验证见 [Bridge 运行报告](bridge-run-report.md)。

`packages/bridge-mcpfabric` 中的技能映射和握手检查只是候选声明，未接入运行时，也未验证上游工具名、接口、取消或安全停止能力。仓库目前没有 MCPFabric 探测工具或真实身体实现。

接入前先在实际环境中确认 Minecraft、Fabric 和候选适配器的版本与接口，验证权限、动作结果、取消和断线停止。根据实测选择现有适配器或实现所需的身体端；不要将 HTTP 请求取消或配置声明当作游戏内动作已经停止的证据。

早期方案保留在 [历史版本](https://github.com/XiaoFeiASK/CraftMate/blob/c0c056274512aa737c5da2af1771dcc40ef2c33f/docs/c1-phase2-plan.md)，其中的接口和进度声明未经验证。
