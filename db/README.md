# 数据库

SQLite 是单机运行时的持久层。迁移文件在本目录，连接、迁移执行器和 Store 在
[`packages/storage`](../packages/storage/src/index.ts)。对象清单、不变量、迁移历史
和保留策略的权威说明见[数据模型](../docs/reference/data-model.md)。

## 修改迁移

- 文件名为 `db/migrations/NNNN_name.sql`，编号连续。
- 已发布的迁移只读；修正必须新增迁移。
- 每个迁移在单事务中执行，迁移器记录版本和 checksum。
- 原文过期只清 `source.raw_text`，保留哈希和结构化证据。

## 校验

```bash
npm run db:check        # 内存库
npm run db:check:file   # 真实 WAL 文件库
node tools/check-schema.mjs /path/to/dir
```

涉及连接参数、迁移器或 WAL 行为的改动必须跑 `db:check:file`。
