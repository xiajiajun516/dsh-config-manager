# 搜索召回基线：20 组「不知道仓库名」真实搜索词测试

> 日期：2026-08-21（v0.1.44 发布、GitHub Description/Topics 更新**之后**的下一轮测试）
> 目的：建立可对照的召回基线。「命中」= 搜索结果中直接出现 `dsh-config-manager` 或其 DSH Get / 聚合页，而非已知仓库名后的定向搜索。
> 复测计划：**过几天（建议 3~7 天，让搜索索引与聚合站重抓）用完全相同的 20 组 query 重测**，与本基线前后对照。

## 20-query 召回矩阵

| 用户可能搜索的词 | 本项目 | 主要竞争结果 | 评价 |
|---|---|---|---|
| DeepSeek Harness backup plugin | ❌ | dsh-backup | 🔴 |
| DeepSeek Harness backup restore configuration plugin | ❌ | dsh-backup | 🔴 |
| DeepSeek Harness export import configuration plugin | ⚠️ | 官方文档/其他插件 | 🟡 |
| DeepSeek Harness migrate configuration plugin | ⚠️ | 生态页面 | 🟡 |
| DSH backup restore plugin DeepSeek Harness configuration | ❌ | dsh-backup | 🔴 |
| DSH configuration backup plugin | ⚠️ | config-sync 等 | 🟡 |
| **DSH config manager plugin** | **✅** | dsh-config-manager | 🟢 |
| DSH migrate config another machine | ⚠️ | 分散 | 🟡 |
| **DeepSeek Harness config manager backup** | **✅** | dsh-config-manager | 🟢 |
| DeepSeek Harness backup MCP skills plugins | ⚠️ | dsh-backup | 🟡 |
| DeepSeek Harness one-click restore machine | ⚠️ | 分散 | 🟡 |
| DeepSeek Harness WebDAV backup plugin | ❌ | backup-sync | 🔴 |
| DeepSeek Harness 配置 备份 插件 | ❌ | dsh-backup/config-sync | 🔴 |
| DeepSeek Harness 配置 导出 导入 | ⚠️ | config-sync | 🟡 |
| DeepSeek Harness 配置 迁移 插件 | ⚠️ | 分散 | 🟡 |
| DSH 配置 备份 恢复 插件 | ❌ | dsh-backup/config-sync | 🔴 |
| DSH 配置 导出 插件 | ⚠️ | config-sync | 🟡 |
| DSH 换电脑 配置 迁移 | ⚠️ | 分散 | 🟡 |
| **DSH backup export import migrate plugin** | **✅/⚠️** | 多个 | 🟢🟡 |
| **deepseek harness backup export import migrate plugin** | **✅/⚠️** | 多个 | 🟢🟡 |

## 当前曝光评分（外部测试结论）

- **品牌搜索：9/10**（搜 `dsh-config-manager` / `DSH config manager` 无问题）
- **生态收录：8/10**（DSH Get / dshplugins.cc / DSH 插件商店 / awesome-dsh-plugins 已收录；DSH Get 显示来源含 awesome-dsh-plugin、hrhgit catalog、OMDSH Hub 与 GitHub topic）
- **英文需求搜索：5~6/10**（`backup` / `restore` 单独搜索时竞争项目占优）
- **中文需求搜索：4~5/10**（最容易提升的板块）
- **AI 搜索/AEO：6/10**（description 结构化良好，缺更多「问题 → 答案」自然语言段与第三方引用）

## 三大缺口（按优先级）

1. **`restore` 词面缺失**：v0.1.44 之前 GitHub Description 为 `backup / export / import / migrate`，无 `restore`；DSH Get 等聚合站摘要抓的是旧描述。**已修复**：2026-08-21 经 `gh` 将 GitHub Description 更新为含 `restore` 的版本（`DeepSeek Harness (DSH) backup & restore plugin — export, import, migrate and sync ...`）；聚合站重抓后自动更新。
2. **中文「配置备份 / 恢复」**：中文首屏此前只有英文直译。**已修复**：README.zh-CN.md 首屏改为自然语言「DeepSeek Harness（DSH）配置备份、恢复与迁移插件」+ 备份内容列表（设置 / Provider / 插件及插件配置 / MCP / Skills / Agent Presets / Profiles / Workspace·AGENTS.md）。
3. **`backup plugin` 泛意图**：README 首屏新增 8 条关键词句 Features 列表（Backup & Restore / Export / Import / Migrate / plugins / MCP / Skills / Encrypted / Git·WebDAV sync / Snapshot rollback），让「我不知道名字、只想备份」的用户意图直接命中。

## 竞品观察

| 竞品 | 仓库 | 威胁度 | 备注 |
|---|---|---|---|
| dsh-backup | xiaoyuyu6420/dsh-backup | 🔴 高 | 页面标题即 `dsh-backup`，首句 "One-command backup and restore for DeepSeek Harness…"，backup/restore 词面极强 |
| dsh-backup-sync | csiroqa/dsh-backup-sync | 🟡 中 | 中英双语 description 明写「备份/恢复 + 跨机同步 / snapshot backup, restore and cross-machine sync」 |
| **dsh-config-sync** | **muyifc/dsh-config-sync** | **🔴 高（最直接）** | 同赛道（配置迁移而非整盘灾备）；页面覆盖 backing up and restoring your DSH configuration / settings / API credentials / portable bundles / password-encrypted file，函数名 `dsh_config_export` / `dsh_config_export_encrypted` / `dsh_config_import`，对「配置导出/导入」query 词面相关性天然高 |

## 已固化词汇规范（后续所有对外文案遵守）

**核心六词（固定 vocabulary）**：Backup · Restore · Export · Import · Migrate · Sync

**官方术语链（贴 DeepSeek 官方语义，不自创词）**：

```
DeepSeek Harness → DSH → plugin → configuration → Cordis → profile → skills
                          ↓
              backup → restore → export → import → migrate → sync
                          ↓
                      dsh-config-manager
```

- 官方定义 Harness 为 "Everything is a plugin"（plugins 含 models / tools / skills / sessions / storage / UI），配置文档使用 `Plugin configuration`、`cordis.yml`（Cordis 加载）
- 禁止自创搜索系统无法理解的词（如 "environment transporter"）；README 内文比喻（"moving service" / 「搬家工具」）允许保留，但首屏主描述必须用官方术语 + 六词

## 复测指引

1. 3~7 天后（索引与聚合站重抓一轮后）用**完全相同的 20 组 query** 重测
2. 关注三个缺口的迁移：`restore` query、中文「配置备份/恢复」query、`backup plugin` 泛意图
3. 记录新矩阵到 `docs/seo/`，与本文前后对照
