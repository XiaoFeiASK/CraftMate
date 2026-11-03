# 方向 C - C1 阶段 2：真实身体 Adapter 设计

> 更新日期：2026-11-03
> 基线：`main@fed54c0`
> 任务：Issue #27 C1 - 真实身体选型与最小纵向技能

## 当前状态

### 已完成（阶段 1）

✅ **环境探测框架**（已合并到 main）
- `docs/mcpfabric-capability-probe.md` - 探测报告文档
- `tools/mcpfabric/probe-capabilities.mts` - 自动化探测工具
- `tools/mcpfabric/README.md` - 工具使用文档
- `docs/c1-progress-summary.md` - 阶段进展总结

提交：
- `704aaa7` feat: add MCPFabric capability probe tool and documentation
- `98cffcf` docs: add C1 progress summary and next steps

### 设计完成（阶段 2 - 本文档）

✅ **真实身体 Adapter 架构设计**

已设计但未实现的组件：

1. **RealBody 类** (`packages/bridge-mcpfabric/src/real-body.ts`)
   - Bridge 协议完整实现
   - 500ms 本地看门狗
   - 控制权管理
   - 幂等性支持
   - 取消机制（AbortController）
   - 安全验证（loopback + token）

2. **SkillExecutor 类** (`packages/bridge-mcpfabric/src/skill-executor.ts`)
   - 技能到 MCPFabric 工具的映射
   - 7 个基础技能实现逻辑
   - 进度报告机制
   - HTTP 调用封装

3. **单元测试** (`packages/bridge-mcpfabric/src/real-body.test.ts`)
   - 安全验证测试
   - 控制权测试
   - 幂等性测试
   - 断线测试

4. **实现文档** (`docs/real-body-implementation.md`)
   - 架构说明
   - 使用示例
   - 实现指南
   - 验证清单

## 架构概览

### 组件关系

```
┌─────────────────────────────────────────────────────┐
│ Orchestrator (services/orchestrator)                │
│ - Bridge WebSocket Server                           │
│ - 发送 BridgeServerFrame (cmd, cancel, ownership)   │
│ - 接收 BridgeClientFrame (ack, progress, result)    │
└──────────────────┬──────────────────────────────────┘
                   │ WebSocket
                   ↓
┌─────────────────────────────────────────────────────┐
│ RealBody (packages/bridge-mcpfabric/src/real-body) │
│ - 解析和验证 Bridge 帧                               │
│ - 控制权管理 (agent/operator/none)                  │
│ - 幂等性检查 (idempotencyKey)                       │
│ - 500ms 看门狗 (lastServerFrameAt)                  │
│ - 取消协调 (AbortController)                        │
└──────────────────┬──────────────────────────────────┘
                   │ execute(command, context)
                   ↓
┌─────────────────────────────────────────────────────┐
│ SkillExecutor (packages/bridge-mcpfabric/src)      │
│ - 技能路由 (goto, mine_block, etc.)                 │
│ - 多步骤编排 (composed skills)                       │
│ - 进度报告 (reportProgress)                         │
│ - MCPFabric HTTP 调用封装                           │
└──────────────────┬──────────────────────────────────┘
                   │ HTTP/JSON
                   ↓
┌─────────────────────────────────────────────────────┐
│ MCPFabric MCP Server (Etoryx/mcpfabric)            │
│ - HTTP bridge (127.0.0.1:3000)                     │
│ - 工具: navigate_to, break_block, etc.             │
│ - Token 鉴权                                        │
└──────────────────┬──────────────────────────────────┘
                   │ Fabric Mod API
                   ↓
┌─────────────────────────────────────────────────────┐
│ Minecraft + Fabric Loader                           │
│ - MCPFabric Mod                                     │
│ - 游戏内执行 (移动、挖掘、放置等)                     │
└─────────────────────────────────────────────────────┘
```

### 关键设计决策

**1. 安全边界**
- **决策**：在 RealBody 构造时强制验证 loopback 和危险工具禁用
- **理由**：安全检查前置，避免运行时才发现配置问题
- **实现**：`assertSafeMcpFabricHandshake()` 在构造函数中调用

**2. 500ms 看门狗**
- **决策**：在 RealBody 本地实现，使用 `lastServerFrameAt` 跟踪
- **理由**：不依赖 MCPFabric 或网络，确保本地安全停止
- **实现**：100ms 检查间隔，超过 500ms 自动 `releaseEverything()`

**3. 技能映射层**
- **决策**：单独的 SkillExecutor 类，而不是在 RealBody 中内联
- **理由**：职责分离，便于测试和替换（路线 A/B 切换）
- **实现**：RealBody 持有 SkillExecutor 实例，委托技能执行

**4. 取消机制**
- **决策**：使用标准 AbortController，而不是自定义取消逻辑
- **理由**：与 fetch API 天然集成，标准化的取消模式
- **实现**：每个任务一个 AbortController，取消时 abort()

**5. 进度报告**
- **决策**：通过 context.reportProgress 回调报告
- **理由**：解耦进度报告和技能执行，便于测试
- **实现**：SkillExecutor 调用回调，RealBody 发送 progress 帧

## 技能实现策略

### Strong 技能（直接映射）

这些技能直接映射到单个 MCPFabric 工具：

| 技能 | MCPFabric 工具 | 实现复杂度 |
| --- | --- | --- |
| `goto` | `navigate_to` | 低 |
| `look_at` | `look_at` | 低 |
| `place_block` | `place_block` | 低 |
| `attack` | `attack_entity` | 低 |
| `say` | `send_chat` | 低（需输出审查） |
| `wait` | 本地定时器 | 低 |

**实现模式：**
```typescript
async executeGoto(command, context, mapping) {
  const { x, y, z } = command.args;
  context.reportProgress("navigating", 0);
  await this.mcpCall("navigate_to", { x, y, z }, context.signal);
  context.reportProgress("arrived", 1, 1);
}
```

### Composed 技能（多步骤）

这些技能需要组合多个 MCPFabric 工具：

| 技能 | MCPFabric 工具 | 实现复杂度 |
| --- | --- | --- |
| `mine_block` | `find_blocks` + `navigate_to` + `break_block` | 中 |
| `craft` | `plan_craft` + `craft_item` | 中 |
| `eat` | `use_item` (with food check) | 低 |
| `deposit` | `open_container` + `container_transfer` | 中 |

**实现模式：**
```typescript
async executeMineBlock(command, context, mapping) {
  const { blockType, maxDistance } = command.args;

  // 步骤 1/3: 查找
  context.reportProgress("searching", 0, 3);
  const blocks = await this.mcpCall("find_blocks", {...}, context.signal);
  
  // 步骤 2/3: 移动
  context.reportProgress("moving", 1, 3);
  await this.mcpCall("navigate_to", target, context.signal);
  
  // 步骤 3/3: 破坏
  context.reportProgress("breaking", 2, 3);
  await this.mcpCall("break_block", target, context.signal);
  
  context.reportProgress("completed", 3, 3);
}
```

### Weak 技能（需要外部循环）

这些技能当前不实现，等待 A 方向的规划器支持：

| 技能 | 原因 | 未来方向 |
| --- | --- | --- |
| `equip` | 只支持 hotbar，不完整 | 等待完整装备系统 |
| `sleep` | 无专用工具 | 使用 use_entity 变通 |
| `follow` | 需要外部循环 | 等待持续跟随规划 |
| `flee` | 缺少方向策略 | 等待危险评估系统 |

## 待确认的 API 细节

这些细节需要在能力探测后确认：

### 1. HTTP 端点格式

**可能的格式：**
```
选项 A: POST /tools/{toolName}
选项 B: POST /mcp/tools/{toolName}
选项 C: POST /execute (with tool name in body)
```

**需要确认：**
- 实际端点路径
- 是否需要 API 版本前缀
- 是否支持批量调用

### 2. 请求格式

**可能的格式：**
```json
选项 A: { "tool": "navigate_to", "arguments": { "x": 100, "y": 64, "z": 200 } }
选项 B: { "name": "navigate_to", "params": { "x": 100, "y": 64, "z": 200 } }
选项 C: { "x": 100, "y": 64, "z": 200 } (直接参数)
```

**需要确认：**
- 参数键名（arguments vs params vs 直接展开）
- 工具名称包含方式
- 是否需要额外的 metadata

### 3. 响应格式

**可能的格式：**
```json
选项 A: { "success": true, "result": {...} }
选项 B: { "status": "completed", "data": {...} }
选项 C: {...} (直接结果)
```

**需要确认：**
- 成功/失败标识
- 错误信息格式
- 进度报告格式（如果支持）

### 4. 认证方式

**可能的方式：**
```
选项 A: Authorization: Bearer {token}
选项 B: X-MCP-Token: {token}
选项 C: Query parameter ?token={token}
```

**需要确认：**
- Header 名称
- Token 格式要求
- 是否需要额外的客户端标识

## 实现路线图

### 阶段 1：环境准备 ✅（已完成）

- [x] 创建能力探测工具
- [x] 编写探测文档
- [x] 建立路线 A/B 决策框架

### 阶段 2：架构设计 ✅（已完成）

- [x] 设计 RealBody 类
- [x] 设计 SkillExecutor 类
- [x] 规划技能实现策略
- [x] 编写实现文档

### 阶段 3：Minecraft 环境搭建 ⏸️（阻塞中）

- [ ] 安装 Minecraft Java Edition 1.21.1
- [ ] 安装 Fabric Loader for 1.21.1
- [ ] 下载并安装 MCPFabric mod 0.5.0+26.3
- [ ] 创建测试世界
- [ ] 确认 mod 正确加载

### 阶段 4：能力探测 ⏸️（依赖阶段 3）

- [ ] 启动 Minecraft with MCPFabric
- [ ] 确认 MCP server 监听端口
- [ ] 运行 `tools/mcpfabric/probe-capabilities.mts`
- [ ] 记录实际可用工具列表
- [ ] 确认 API 端点和格式
- [ ] 做出路线 A 或 B 的最终决策

### 阶段 5：代码实现 ⏸️（依赖阶段 4）

- [ ] 实现 RealBody 类
- [ ] 实现 SkillExecutor 类
- [ ] 根据实际 API 更新 mcpCall()
- [ ] 实现 7 个基础技能
- [ ] 编写单元测试
- [ ] 通过类型检查和测试

### 阶段 6：集成测试 ⏸️（依赖阶段 5）

- [ ] 创建集成测试脚本
- [ ] 测试 goto 实际移动
- [ ] 测试 mine_block 完整流程
- [ ] 验证进度报告
- [ ] 验证错误处理
- [ ] 验证取消机制

### 阶段 7：安全验证 ⏸️（依赖阶段 6）

- [ ] 测试 500ms 看门狗触发
- [ ] 测试断线后按键释放
- [ ] 测试控制权切换
- [ ] 测试接管停止当前动作
- [ ] 测试急停清空队列
- [ ] 验证 loopback 强制

### 阶段 8：ActionPort 集成 ⏸️（依赖阶段 7）

- [ ] 在 orchestrator 中集成 RealBody
- [ ] 连接到 SqliteActionPort
- [ ] 测试完整 Bridge 链路
- [ ] 验证 trace 记录
- [ ] 端到端烟雾测试

## 下一步行动

**立即可做（不依赖 Minecraft）：**

1. ✅ **完成架构设计**（已完成）
   - 设计文档已编写
   - 组件接口已定义
   - 实现策略已确定

2. **准备测试数据**
   - 设计测试场景
   - 准备测试世界配置
   - 规划验收标准

**需要 Minecraft 环境：**

1. **环境搭建**
   - 参考 `docs/mcpfabric-capability-probe.md` 中的安装步骤
   - 下载 Minecraft 官方启动器
   - 安装 Fabric Loader
   - 从 Modrinth 下载 MCPFabric

2. **能力探测**
   ```bash
   # 启动 Minecraft + MCPFabric
   # 找到 MCP server 监听端口
   
   # 运行探测工具
   MCPFABRIC_URL=http://127.0.0.1:3000 \
     node --experimental-strip-types tools/mcpfabric/probe-capabilities.mts
   ```

3. **根据探测结果实现代码**
   - 如果路线 A：实现 RealBody + SkillExecutor
   - 如果路线 B：设计自研 Fabric Mod

## 风险和缓解

### 风险 1：MCPFabric 能力不足

**概率：** 中等  
**影响：** 需要切换到路线 B

**缓解措施：**
- 架构设计已考虑路线切换
- RealBody 的 Bridge 协议部分可复用
- 已有 SimBody 作为参考实现

### 风险 2：API 格式与预期不符

**概率：** 高  
**影响：** 需要调整 SkillExecutor.mcpCall()

**缓解措施：**
- 能力探测工具会确认实际格式
- mcpCall() 设计为可配置
- 预留了多种可能格式的方案

### 风险 3：性能或延迟问题

**概率：** 低  
**影响：** 用户体验下降

**缓解措施：**
- 本地 HTTP 调用延迟应该很低
- 如果有问题可以考虑 IPC 或共享内存
- 进度报告可以掩盖一定延迟

### 风险 4：Minecraft 版本兼容性

**概率：** 低  
**影响：** 需要调整版本或等待 mod 更新

**缓解措施：**
- 使用 MCPFabric 明确支持的版本（1.21.1-1.21.11）
- 如果必要可以降级 Minecraft
- 社区支持的 mod 通常会快速更新

## 参考资料

- Issue #27: https://github.com/XiaoFeiASK/CraftMate/issues/27
- 阶段 1 工作：`docs/c1-progress-summary.md`
- 能力探测文档：`docs/mcpfabric-capability-probe.md`
- 探测工具：`tools/mcpfabric/probe-capabilities.mts`
- Bridge 协议：`packages/contracts/src/bridge.ts`
- 模拟身体参考：`packages/bridge/src/sim-body.ts`
- MCPFabric Modrinth: https://modrinth.com/project/eA63YgUh

## 总结

**已完成：**
- ✅ 环境探测框架（阶段 1）
- ✅ 真实身体架构设计（阶段 2）

**当前阻塞：**
- ⏸️ Minecraft + MCPFabric 环境未安装

**下一步：**
1. 安装 Minecraft 环境
2. 运行能力探测工具
3. 根据探测结果实现代码
4. 验证真实移动和挖掘

所有设计工作已完成，等待环境就绪后即可快速实现。
