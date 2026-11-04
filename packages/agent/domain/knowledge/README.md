# @craftmate/agent/domain

Minecraft 1.21.11 的结构化生存知识，供纯规划逻辑查询。

## 数据来源

数据由 [misode/mcmeta](https://github.com/misode/mcmeta) 的
`1.21.11-data-json` 标签生成，该仓库直接导出 Mojang 官方数据包内容。生成器
只做裁剪和规范化，不手写配方或掉落表：

| 文件 | 来源 | 内容 |
| --- | --- | --- |
| `generated/recipes.json` | `data/minecraft/recipe/**` | 工作台/熔炉/切石机配方、原料、产物数量、2×2 或 3×3 |
| `generated/block-drops.json` | `data/minecraft/loot_table/blocks/**` | 方块普通掉落（忽略精准采集分支） |
| `generated/tool-tiers.json` | `data/minecraft/tags/block/needs_*_tool.json` | 方块最低挖掘工具等级 |
| `generated/smelting.json` | `data/minecraft/recipe/**`（`minecraft:smelting`） | 熔炼产物、经验与耗时 |
| `generated/entity-drops.json` | `data/minecraft/loot_table/entities/**` | 实体掉落（末影珍珠、烈焰棒等） |

## 生成与校验

```sh
node --experimental-strip-types scripts/generate.ts   # 需要网络；浅克隆 mcmeta 到临时目录
node --experimental-strip-types scripts/validate.ts   # 校验 schema、版本和关键条目
```

生成器固定标签 `1.21.11-data-json`，输出中的 `meta.sourceTag` 与
`meta.dataVersion` 可用于核对版本。`npm test` 不联网，只读取已提交的数据。

## 查询接口

```ts
import {
  queryRecipe,
  recipesFor,
  requiredTool,
  canMine,
  dropsFor,
  smeltingFor,
  entityDropsFor,
  KNOWLEDGE_VERSION,
} from "@craftmate/agent/domain";
```

物品和方块 ID 使用 `minecraft:` 命名空间；查询函数也接受省略命名空间的短名。
`recipesFor()` 返回所有可用配方，`queryRecipe()` 选择确定性的首选配方（优先
2×2、少原料、ID 排序）。

## 限制

- 只记录可合成的确定性配方；不记录需要特定生物群系、交易或结构战利品的获取方式。
- 掉落表只取普通破坏/击杀路径，忽略精准采集、时运数量浮动和剪刀等特殊工具。
- 掉落概率、附魔和服务器插件行为不在本包范围内。
