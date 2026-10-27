# 搜索召回复测：08-21 基线的同 20 组 query（2026-09-27）

> 对照对象：08-21 基线（同一份 20 组 query，一字未改）。该文件已于 2026-10-28 文档精简时并入本文「08-21 基线要点」小节，原件删除。
> 目的：验证 08-21 那轮改动（GitHub Description/Topics、README 首屏与 Use Cases、npm keywords）是否真的抬升了「不知道仓库名」场景的召回。
> 结论先行：**英文需求词从 5~6/10 抬到 7/11；中文需求词几乎没动（1/6），仍是最大缺口。**

## ⚠️ 方法学差异（读结论前必看）

08-21 基线标注为「外部测试结论」，未记录使用的搜索引擎；本次复测使用 **DSH 内置 web_search**（每次返回 8 条来源）。
两者引擎与排序不同，**绝对命中数不可直接相减**，可对照的是「同一 query 下本仓库是否出现在结果中」以及中文/英文两类词的结构性差异。
判定口径沿用基线：「命中」= 结果中出现 `dsh-config-manager` 仓库、本插件聚合页（dshplugin.app / deepseek1024.com / deepseek-harness-plugin.com / dsh.deepseek404.com / dshplugins.cc）或 npm 包页。

## 08-21 基线要点（原 `2026-08-21-search-recall-baseline.md` 的唯一有效残留）

**曝光评分（08-21，外部测试结论，无搜索引擎记录）**：品牌搜索 9/10、生态收录 8/10、英文需求 5~6/10、中文需求 4~5/10、AI 搜索/AEO 6/10。

**三大缺口 → 已修复（08-21 当天落地，故后续复测看到的是修复后的状态）**

1. `restore` 词面缺失：v0.1.44 前 GitHub Description 只有 `backup / export / import / migrate`，聚合站抓的是旧描述 → 已用 `gh` 改为含 `restore` 的版本，聚合站重抓后自动更新。
2. 中文「配置备份 / 恢复」：中文首屏原为英文直译 → README.zh-CN.md 首屏改为「DeepSeek Harness（DSH）配置备份、恢复与迁移插件」+ 备份内容列表。
3. `backup plugin` 泛意图：README 首屏补 8 条关键词句 Features（Backup & Restore / Export / Import / Migrate / plugins / MCP / Skills / Encrypted / Git·WebDAV sync / Snapshot rollback）。

**竞品（词面相关性的直接对手）**

| 竞品 | 仓库 | 威胁度 | 为什么 |
|---|---|---|---|
| dsh-backup | `xiaoyuyu6420/dsh-backup` | 🔴 高 | 标题即 `dsh-backup`，首句 "One-command backup and restore for DeepSeek Harness…"，backup/restore 词面极强 |
| dsh-backup-sync | `csiroqa/dsh-backup-sync` | 🟡 中 | 中英双语明写「备份/恢复 + 跨机同步」 |
| dsh-config-sync | `muyifc/dsh-config-sync` | 🔴 高（最直接） | 同赛道（配置迁移）；函数名 `dsh_config_export` / `dsh_config_export_encrypted` / `dsh_config_import`，对「配置导出/导入」query 天然高相关 |

**已固化词汇规范（对外文案一律遵守）**：核心六词 = Backup · Restore · Export · Import · Migrate · Sync；官方术语链 = DeepSeek Harness → DSH → plugin → configuration → Cordis → profile → skills，下行 backup → restore → export → import → migrate → sync。**禁止自创搜索系统无法理解的词**（如 "environment transporter"）；README 内文比喻（"moving service" / 「搬家工具」）可保留，但首屏主描述必须用官方术语 + 六词。

## 20-query 复测矩阵（2026-09-27）

| # | query | 本次 | 08-21 | 本次首位竞争结果 |
|---|---|---|---|---|
| 1 | DeepSeek Harness backup plugin | ❌ | ❌ | DeepSeek 官方 developer preview |
| 2 | DeepSeek Harness backup restore configuration plugin | ✅ | ❌ | **本仓库 #1** |
| 3 | DeepSeek Harness export import configuration plugin | ❌ | ⚠️ | DSH 官方 `config.md` |
| 4 | DeepSeek Harness migrate configuration plugin | ❌ | ⚠️ | composio「Best plugins」清单 |
| 5 | DSH backup restore plugin DeepSeek Harness configuration | ✅ | ❌ | **本仓库 #1** |
| 6 | DSH configuration backup plugin | ✅ | ⚠️ | **本仓库 #1** |
| 7 | DSH config manager plugin | ❌ | ✅ | DSH CLI reference README |
| 8 | DSH migrate config another machine | ✅ | ⚠️ | **本仓库 #1** |
| 9 | DeepSeek Harness config manager backup | ✅ | ✅ | **本仓库 #1** |
| 10 | DeepSeek Harness backup MCP skills plugins | ❌ | ⚠️ | 0xsline/awesome-deepseek-harness |
| 11 | DeepSeek Harness one-click restore machine | ✅ | ⚠️ | **本仓库 #1** + deepseek-harness-plugin.com |
| 12 | DeepSeek Harness WebDAV backup plugin | ✅ | ❌ | **本仓库 #3** |
| 13 | DeepSeek Harness 配置 备份 插件 | ❌ | ❌ | DSH discussions #1597 |
| 14 | DeepSeek Harness 配置 导出 导入 | ❌ | ⚠️ | DSH discussions #1071（pack-agent-dsh） |
| 15 | DeepSeek Harness 配置 迁移 插件 | ❌ | ⚠️ | DSH discussions #68 + 知乎 |
| 16 | DSH 配置 备份 恢复 插件 | ❌ | ❌ | DSH discussions #4644（dsh-backup 宣传帖） |
| 17 | DSH 配置 导出 插件 | ❌ | ⚠️ | dev.to 插件开发教程 / discussions #2428 |
| 18 | DSH 换电脑 配置 迁移 | ✅ | ⚠️ | **本仓库 README.zh-CN #1** |
| 19 | DSH backup export import migrate plugin | ✅ | ✅/⚠️ | **本仓库 #1** |
| 20 | deepseek harness backup export import migrate plugin | ✅ | ✅/⚠️ | **本仓库 #1**（同屏还有 5 个生态站） |

**合计：10 ✅ / 0 ⚠️ / 10 ❌**

分类得分：

| 类别 | 本次 | 08-21 | 变化 |
|---|---|---|---|
| 英文需求词（1,2,3,4,5,6,10,11,12,19,20） | 7/11 | 5~6/10 | ↗ 明显抬升 |
| 品牌词（7,8,9） | 2/3 | 9/10 区间 | → 持平（7 号在本次引擎下未命中） |
| 中文需求词（13–18） | 1/6 | 4~5/10 | ↘ **仍是最大缺口，无实质改善** |

## 生态收录（本次顺带观测，比基线时明显变多）

20 组 query 的结果里出现、且都在收录本插件的站点（基线时只记录了 4 个）：

`dshplugin.app` · `deepseek1024.com` · `deepseekharness.io` · `agentsmd.io` · `deepseek-harness-plugin.com` · `dsh.deepseek404.com` · `dshplugins.cc` · `dshget.com` · `npmjs.com/package/dsh-config-manager`

第三方主动内容也出现了：`blog.yeyupiaoling.cn` 有本插件的专文（"DSH Config Manager: One-Click Backup, Migration…"）——属于外部背书信号，对 AI 搜索加权有利。

## 结论

1. **08-21 那轮改动是有效的**：英文需求词 +1~2 个命中档，`backup restore configuration plugin`、`WebDAV backup plugin`、`换电脑 配置 迁移` 三个曾经的 ❌/⚠️ 现在直接命中，说明 description/keywords/README 结构确实进了检索词表。
2. **中文需求词没被那轮改动带动**：13–17 全部 ❌，首位结果清一色是 DSH 官方 discussions、知乎、YouTube——**中文流量池在讨论区与自媒体，不在仓库元数据**。要抬这一档，靠的是中文内容出现在那些载体上，不是继续改 README。
3. **聚合站已成主要入口**：英文 query 下经常一屏出现多个收录站（query 20 同时 5 个），说明生态收录是当前最有效的曝光杠杆；awesome 列表补录（见 `docs/seo/2026-09-27-awesome-list-coverage.md`）优先级高于继续堆关键词。
4. **单点退化**：query 7「DSH config manager plugin」在本次引擎下未命中、基线为 ✅。不确定是引擎差异还是排序波动，**下一轮复测需单独盯这一条**；不建议为此改任何元数据。

## 下一轮动作

- 中文缺口的现实打法：在 DSH discussions 放一个中文场景帖（换电脑 / 多机同步实操），并配 README.zh-CN 的锚点；同时把中文教程类内容投到知乎/掘金——**这属于内容投放，不是仓库改动**。
- 3~7 天后（awesome 列表补录 PR 合并后）用**完全相同的 20 组 query** 再测一次，重点看 13–18 与 query 7。
- 复测时把使用的搜索引擎/工具记进文档——本次因基线缺这一项，只能做结构性对照。
