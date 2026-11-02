# ADR-0012：模型接入先用 DeepSeek

- 状态：已采纳
- 日期：2026-11-02

## 背景

项目需要分层使用模型：Stage B 做分类打分，Stage C 做规划，Voice 侧做台词生成。候选包括 DeepSeek、Claude、GPT 和国内其他厂商。

## 决策

第一阶段统一走 DeepSeek API，通过 OpenAI 兼容协议接入：

- Stage B 与台词生成用 `deepseek-chat`。
- Stage C 规划用 `deepseek-reasoner`。
- 所有调用经统一的 Provider 层，保留切换到其他供应商的能力。

## 理由

- 人格设定本身就是 DeepSeek 生态的大肥鱼，模型与角色来源一致，观众问起来不会穿帮。
- 中文表达和口语化台词质量好，成本低。
- OpenAI 兼容协议意味着换供应商只改 baseURL 和 model 名，不改业务代码。

## 后果

- 结构化输出与 function calling 的稳定性需要实测，必要时用 JSON 模式加本地校验兜底。
- Stage C 的推理模型延迟高于普通模型，必须先说话后执行，避免观众等太久。
- API Key 存 macOS Keychain，按 Key 独立预算与速率限制。

