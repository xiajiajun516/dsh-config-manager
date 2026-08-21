# AI 搜索曝光审计：xiajiajun516/dsh-config-manager

> 日期：2026-08-21 · 范围：GitHub 元数据 / npm metadata / README 首屏与结构 / 生态收录现状
> 目的：提升 DSH 生态与自然语言检索（GitHub Search、Google/Bing、DSH 聚合站、AI Web Search）对「备份 / 恢复 / 迁移 / 同步 DSH 配置」意图的召回与排名。

## 结论先行

项目**已经进入全部主流 DSH 生态索引**，当前瓶颈不是「未被收录」，而是：

1. **npm 元数据存在两处硬伤（真实 bug，非优化问题）**：`package.json` description 里的 em-dash 被双重编码成乱码（`â€”`，字节级确认 `C3 A2 E2 82 AC E2 80 9D`），且残留内部备注 `Manifest shape mirrors @linxin666/dsh-ssh@0.1.12`——npmjs 页面直接展示给用户，严重拉低专业度与关键词质量。
2. README 首屏其实已是「用户问题优先」（外部建议中「先讲架构」的前提不成立），主要结构性缺口是**缺少自然语言的 Use Cases 小节**（Backup / Restore / Migrate / Sync 四组用户真实会搜的句子）。
3. GitHub topics 与 npm keywords 偏窄：缺 restore / export / import / sync / webdav / mcp / skills 等高频搜索词。

## 现状盘点（2026-08-21 实测）

### 生态收录（HTTP 全部 200，已存活验证）

| 渠道 | 地址 | 状态 |
|---|---|---|
| DSH Get | https://www.dshget.com/plugins/xiajiajun516/dsh-config-manager | ✅ 200 |
| dshplugins.cc | https://dshplugins.cc/zh/plugins/xiajiajun516-dsh-config-manager | ✅ 200 |
| DSH 插件商店 | https://dsh.deepseek404.com/detail.php?id=xiajiajun516%2Fdsh-config-manager | ✅ 200 |
| awesome-dsh-plugins | https://github.com/dshworks/awesome-dsh-plugins | ✅ 200 |

awesome-dsh-plugins 的收录描述（第三方语义信号，对 AI 召回是加分项）：

> "Backup, export, import, and migrate DeepSeek Harness configuration from the web UI."

### GitHub 元数据（api.github.com 实测）

- **description**：`Backup / export / import / migrate your DeepSeek Harness (DSH) configuration - dual-face Cordis plugin (host engine + Web UI). One-click restore on any machine.`
- **topics（7 个）**：backup, config-manager, deepseek-harness, dsh, dsh-plugin, migration, plugin
- stars 7 · created 2026-08-14 · license MIT · homepage 空

### npm metadata（package.json 实测，修改前）

- **description**：含乱码与内部备注（见上）
- **keywords（7 个）**：dsh, deepseek-harness, cordis, plugin, backup, migration, config-manager

## 已落地改动（本次提交，commit 说明建议引用本文）

1. **README.md 顶部**：副标题改为「DeepSeek Harness Backup, Restore & Migration Plugin」，一句话价值主张覆盖 backup / restore / export / import / migrate / sync / settings / plugins / MCP / skills / agent presets / workspaces。
2. **README.md 新增「Use Cases」小节**：Backup / Restore / Migrate / Sync 四个自然语言 H3（AEO 召回关键——AI 搜索直接命中句子即可召回，无需推理）。
3. **README.zh-CN.md 同步镜像**（新增「典型使用场景」）。
4. **package.json description 重写**：去乱码、去内部备注、关键词密集但自然。
5. **package.json keywords 扩至 17 个**：新增 dsh-plugin / restore / export / import / migrate / sync / webdav / mcp / skills / configuration。

## GitHub Description / Topics（已落地 ✅ 2026-08-21，经本机 `gh` CLI 完成）

> 方式：本机 `gh` CLI 已认证 `xiajiajun516`（scope 含 `repo`，token 存系统 keyring，未入聊天/日志）；`gh repo edit` 设置 description，`gh api --method PUT .../topics` 整组替换 topics。

### GitHub Description（已设置）

```text
DeepSeek Harness (DSH) backup & restore plugin — export, import, migrate and sync your complete DSH configuration, plugins, MCP servers, skills and workspace. One-click migration to another machine.
```

### GitHub Topics（已设置 15 个，`dsh-plugin` 保留——生态发现依赖该 topic）

```text
deepseek-harness, dsh, dsh-plugin, deepseek, backup, restore, configuration, config-manager, migration, export, import, sync, mcp, skills, webdav
```

> 上限 20 个，想再加 cordis / plugin 亦可；上面 15 个是搜索价值最高的集合。

### 注意

- npm 的 description / keywords 只能在**下次 publish** 时生效（npmjs 不提供线上改 description 的途径）；**无需 bump 版本**，随下一个正常发版带上即可。
- README 改动会随发布进入 npm 包文件（`files` 已含 README.md / README.zh-CN.md）。

## 后续建议（不阻塞，按性价比排序）

1. **等时间积累**：仓库 2026-08-14 创建、仅 7 stars——历史 / 权威信号弱是自然语言召回排名的最大短板，短期无法用关键词完全弥补。
2. **争取生态内高相关引用**：awesome-dsh-plugins 已收录且描述命中「backup/export/import/migrate」；后续可留意 DSH 聚合站描述是否升级为更完整版本。
3. **README 首屏补一张「Export → ZIP → Import → Restore」流程 GIF**：对 AI 搜索与人类访客双重加分（`assets/` 已有截图，可后续合成动图）。
4. **改完后复核 GitHub Search 命中**：在 github.com/search 用 `dsh backup plugin`、`deepseek harness migration` 复查排名变化，作为下一次迭代的基线。
