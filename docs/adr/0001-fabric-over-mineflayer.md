# ADR-0001：游戏执行层用 Fabric Mod，不用 Mineflayer

- 状态：已采纳
- 日期：2026-11-02

## 背景

最初计划用 Mineflayer 做 MVP，理由是接入快、纯 JS、能和内核同语言。用户随后确认已经见过成熟的 Fabric Mod + WebSocket 玩法，不需要再为迁移付一次成本。

## 决策

游戏执行层直接采用 Fabric 客户端 Mod + 本地 WebSocket Bridge。Mineflayer 方案废止。

## 理由

- 客户端 Mod 有完整的相机、手部动作、HUD、受伤反馈，Mineflayer 基本没有。
- 复杂建造、战斗、原版 UI 交互在 Mineflayer 上受限。
- 执行循环放在 Mod 内，延迟从「每步一次往返」降到「一个任务一次下发」。
- 用户已有成熟玩法参照，方案风险已被外部验证。

## 后果

- 多一个 Java 进程、一套 Gradle 构建、一套 Mixin 维护成本。
- 版本升级成本高于 Mineflayer，需要 compat 层（见 ADR-0006）。
- 内核与 Mod 之间必须有稳定协议，协议成为核心资产。

## 被废止的方案

> 旧 D-001：MVP 用 Mineflayer + pathfinder 快速验证技能层与仲裁器；玩法成立后换 Fabric Mod。

