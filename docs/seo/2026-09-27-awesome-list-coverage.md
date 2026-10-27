# awesome 列表 / 生态目录覆盖审计与补录（2026-09-27）

> 状态：历史记录，不再维护（2026-10-28 复核）。8 个补录 PR 的合并状态未复核；方法学教训（「README 里搜不到 ≠ 未收录」）仍有效。

> 背景：`docs/seo/2026-09-27-search-recall-retest.md` 复测显示，英文 query 下经常一屏出现多个收录站（query 20 同时 5 个），说明**生态收录是当前最有效的曝光杠杆**。
> 本文记录对 24 个 DSH awesome 列表 / 生态站点的逐个比对结果，以及据此发起的补录 PR。

## 方法

1. 逐个拉取目标列表的 `README.md`（HEAD 版本）做词面比对（`config-manager` vs 竞品 `dsh-backup`）；
2. 对判定「未收录」或「收录可疑」的列表，**进一步查它的数据文件**（`plugins.json` / `catalog/plugins/*.json` / `catalog/plugins/*.yaml` / `data/verified-plugins.csv` / `CATALOG.md`）与 `CONTRIBUTING.md`；
3. 只有确认「贡献通道明确 + 当前确实缺失或数据过时」的，才提 PR。

> ⚠️ **最重要的一条方法学教训：README 里搜不到 ≠ 未收录。** 本轮实测有 3 个列表在 README 词面比对中判为「未收录」，但数据文件里其实早有本插件：
> - `ZeroPointRepo/awesome-dsh-plugins`：`plugins.json` 有条目，但 `category: unsorted`（不渲染进 README），且 install 命令停留在 `@0.1.8`、5 张截图 URL 全部 404；
> - `diegosouzapw/awesome-omni-dsh-plugins`：`catalog/plugins/xiajiajun516-dsh-config-manager.yaml` 已存在（v0.1.54 / 57 stars / 截图 404）；
> - `cccakeee/awesome-dsh-plugins`：`data/verified-plugins.csv` 里状态为 `verified`，且在 `CATALOG.md` 中。
>
> 后续任何「我们没被收录」的判断，都必须先查数据文件，再决定是否投稿。

## 覆盖现状

### 已收录（无需动作）

| 列表 / 站点 | 依据 |
|---|---|
| awesome-dsh-plugin/awesome-dsh-plugin | README ✅（本仓库此前已有 fork 并投稿） |
| dshworks/awesome-dsh-plugins | README ✅ |
| beancookie/awesome-dsh-plugin | README ✅ |
| Herdeny/awesome-dsh-plugins-2026 | README ✅ |
| fendouai/awesome-deepseek-harness | README ✅ |
| 0xsline/awesome-deepseek-harness | README ✅ |
| cccakeee/awesome-dsh-plugins | `data/verified-plugins.csv`（status=verified）+ `CATALOG.md` ✅ |
| deepseekdocs.com/en/ecosystem | 页面收录 ✅ |

### 本轮补录 PR（8 个）

| # | 目标列表 | PR | 改动 |
|---|---|---|---|
| 1 | imsai-sh/awesome-deepseek-harness-plugins（DSH 1024Store 目录，13k+ 插件） | [#538](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/pull/538) | 新增 `catalog/plugins/xiajiajun516--dsh-config-manager.json`（category `tools`，只动这一个文件，走其「新条目快速通道」） |
| 2 | oslook/awesome-dsh-plugins | [#6](https://github.com/oslook/awesome-dsh-plugins/pull/6) | README 表格按 star 降序插入一行（132 ★，位于 154 与 105 之间） |
| 3 | Anil-matcha/awesome-dsh-plugin | [#5](https://github.com/Anil-matcha/awesome-dsh-plugin/pull/5) | `Workflow & Automation` 段（同段已有 `dickpy/dsh-cloud-sync`）追加一行 |
| 4 | bruc3van/awesome-dsh-plugin | [#130](https://github.com/bruc3van/awesome-dsh-plugin/pull/130) | `SHOWCASE.md` 的「作者自荐」与「Author showcase」末尾各一行（其官方作者自荐通道） |
| 5 | kejixiaoliang/awesome-dsh-plugins | [#106](https://github.com/kejixiaoliang/awesome-dsh-plugins/pull/106) | `plugins/infrastructure-dev.md`「分发 / 运维 / 迁移」段追加；本地 `node scripts/validate.mjs` → 307 条、无格式错误、无重复 |
| 6 | Alex-Yanggg/awesome-DSH-plugin | [#144](https://github.com/Alex-Yanggg/awesome-DSH-plugin/pull/144) | README `Cloud, DevOps & observability` 段 + `catalog/plugins.json` 双语条目；`python scripts/generate_readmes.py --check` 通过 |
| 7 | ZeroPointRepo/awesome-dsh-plugins | [#15](https://github.com/ZeroPointRepo/awesome-dsh-plugins/pull/15) | README `Security and safety` 段落条目 + 修正 `plugins.json` 过时字段（category / stars / install / 4 张 404 截图） |
| 8 | diegosouzapw/awesome-omni-dsh-plugins | [#3717](https://github.com/diegosouzapw/awesome-omni-dsh-plugins/pull/3717) | 刷新既有条目到 v0.1.65（version / integrity / commit / stars / category / description / media）；本地 `npx omni-dsh-plugins catalog validate` → `3626 entries valid` |

### 明确不做（附原因）

| 列表 | 原因 |
|---|---|
| kingselyjoe/awesome-dsh-list | GitHub `topic:dsh-plugin` 的**机器生成快照**（README 自述「数据：2026-08-17 · 按 star 排序」），由作者重新抓取更新，人工 PR 无意义 |
| AdamPlatin123/dsh-plugin-radar | README 自述「你看到的插件目录，只是它自动生成的 artifact」，且收录判定由其自动化验证流水线给出 |
| composio.dev「Best DSH plugins」/ shop.zimaspace.com「10 Best DSH Plugins」 | 无公开投稿通道（内容站，非仓库）。两站的清单里连 `dsh-backup` 等**整个备份/迁移品类都没有**，属于品类空缺，值得自荐——但只能由本人通过其联系渠道/社交媒体发出，见下 |

## 待人工执行（Agent 无法代发）

给 composio.dev 与 shop.zimaspace.com 的自荐短文（品类空缺式切入，避免「请收录我」的语气）：

> 你们的 DSH 插件清单目前覆盖了 UI / TUI / 市场 / 视觉等方向，但缺「配置备份 · 换机迁移 · 多机同步」这一类。这类需求在 DSH 社区里很集中（换电脑、重装系统、家里+公司两台机器），而 DSH 官方没有内置方案。可以补充的条目：`dsh-config-manager`（https://github.com/xiajiajun516/dsh-config-manager ，MIT，132 ★，`dsh plugin --profile web add dsh-config-manager`）——把 settings / Provider / 插件 / MCP / 技能 / Agent 预设 / 工作区导出成一个 ZIP，目标机先 dry-run 预览再导入，失败自动回滚，跨机自动重映射绝对路径，也可用 Git / WebDAV 持续同步。

## 后续观察

- 8 个 PR 的合并状态需要人工跟进；被拒的按其理由修正后重提（各列表 CONTRIBUTING 均写明「拒绝会说清缺什么」）。
- 合并后 3~7 天，用 `docs/seo/2026-09-27-search-recall-retest.md` 的同一份 20 组 query 再测，重点看中文 query（13–18）与 query 7。
