# @craftmate/agent/domain

Minecraft 1.20.1 的结构化生存知识，供纯规划逻辑查询。

## 数据来源

数据由 [misode/mcmeta](https://github.com/misode/mcmeta) 生成，该仓库直接导出
Mojang 官方数据包内容。生成器只做裁剪和规范化，不手写配方、掉落表或交易表：

| 文件 | 来源 | 内容 |
| --- | --- | --- |
| `generated/recipes.json` | `data/minecraft/recipe/**` | 工作台/熔炉/切石机配方、原料、产物数量、2×2 或 3×3 |
| `generated/block-drops.json` | `data/minecraft/loot_table/blocks/**` | 方块普通掉落（忽略精准采集分支） |
| `generated/tool-tiers.json` | `data/minecraft/tags/block/needs_*_tool.json` | 方块最低挖掘工具等级 |
| `generated/smelting.json` | `data/minecraft/recipe/**`（`minecraft:smelting`） | 熔炼产物、经验与耗时 |
| `generated/entity-drops.json` | `data/minecraft/loot_table/entities/**` | 实体掉落（末影珍珠、烈焰棒等） |
| `generated/graph.json` | `1.20.1-summary` + `1.20.1-data-json` + `overrides/trades.json` | 物品/方块/实体/结构/维度/站点/能力/动作的类型化图与获取边 |

## 生成与校验

```sh
node --experimental-strip-types scripts/generate.ts   # 需要网络；浅克隆 mcmeta 到临时目录
node --experimental-strip-types scripts/validate.ts   # 校验 schema、版本和关键条目
```

生成器固定标签 `1.20.1-data-json`，输出中的 `meta.sourceTag` 与
`meta.dataVersion` 可用于核对版本。`npm test` 不联网，只读取已提交的数据。

### 知识图（graph.json）

知识图在构建期生成并随 Agent 发布，没有运行时图数据库或检索服务：

```sh
git clone --depth 1 --branch 1.20.1-summary https://github.com/misode/mcmeta.git /tmp/mcmeta-summary
git clone --depth 1 --branch 1.20.1-data-json https://github.com/misode/mcmeta.git /tmp/mcmeta-data

CRAFTMATE_SUMMARY_DIR=/tmp/mcmeta-summary \
CRAFTMATE_MCMETA_DIR=/tmp/mcmeta-data \
node --experimental-strip-types scripts/generate-graph.ts

node --test --experimental-strip-types packages/agent/domain/knowledge/src/graph.test.ts
```

校验覆盖 1255 个物品、1003 个方块、124 个实体类型、3 个维度、边引用完整性、
可生存获取性和六件铁装路径。村庄交易使用 `overrides/trades.json`，每一行都有
来源、审核人和日期；创造模式物品保留节点但标记为不可获得。

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
  acquisitionActions,
  acquisitionPath,
} from "@craftmate/agent/domain";
```

物品和方块 ID 使用 `minecraft:` 命名空间；查询函数也接受省略命名空间的短名。
`recipesFor()` 返回所有可用配方，`queryRecipe()` 选择确定性的首选配方（优先
2×2、少原料、ID 排序）。`acquisitionActions()` 把挖矿、合成、熔炼、开箱、交易、
钓鱼、剪羊毛、种植、击杀等不同来源作为竞争动作，按风险、成本、概率排序；
`acquisitionPath()` 沿 AND 输入递归解析一条有证据的获取路径。

## 限制

- 配方与掉落来自原版数据；服务器插件、自定义经济、领地行为和模组内容不在范围内。
- 掉落表只取普通破坏/击杀路径，忽略时运数量浮动和部分特殊工具分支；图仍保留
  精准采集等竞争 action 作为替代来源。
- 物品粒度为 ID + 结构化变体/能力，不展开 NBT；药水、附魔、地图、旗帜等用字段表示。
- 知识图是 Agent 的规划与解释依据，不是身体可执行技能的自动生成器；执行仍受
  `run_plan` guard、目标族白名单和真机证据约束。
