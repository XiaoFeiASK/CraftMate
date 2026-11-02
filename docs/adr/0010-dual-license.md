# ADR-0010：双许可 MIT OR Apache-2.0

- 状态：已采纳
- 日期：2026-11-02

## 背景

用户要求许可证与 SeekMemory 一致。SeekMemory 采用 MIT 或 Apache-2.0 双许可。

## 决策

项目采用 `MIT OR Apache-2.0`，使用者可任选其一。完整文本放在 `licenses/` 目录。

## 后果

- 两个许可证文件不放在仓库根目录，根目录只保留 README。
- GitHub 不会自动识别许可证徽标，需要在 README 中说明。
- 第三方依赖的许可证仍需单独核对，特别是 LGPL 的 Baritone。

