# Changelog

本文档记录 dsh-config-manager 的发布亮点（中英双语）。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
This file records release highlights of dsh-config-manager (bilingual: 中文 + English). Format: [Keep a Changelog](https://keepachangelog.com/).

> **发布流程**：打 tag 发布时 CI（`.github/workflows/publish.yml`）自动抽取**当前版本段**作为 GitHub Release 描述亮点；
> 如果忘记写当前版本段，CI 会 **fail fast** 拒绝发版，避免漏写。
>
> **Release workflow**: on tag push, CI extracts the current version's section as the release notes highlights;
> the build fails fast if the section is missing, so you cannot forget to update it.

## [Unreleased]

## [v0.1.47] - 2026-08-23

### 🎯 亮点 / Highlights (zh)

- 🛠️ **修复模型工具注册崩溃（v0.1.46 回归）**：安装后启动 DSH 报 `cannot get property "tools" without inject` 导致插件树加载失败——5 个 Agent 模型工具（config_backup 等）改为经 `ctx.get('tools')` 结果注册，不再做 `ctx.tools` 属性访问（Cordis 属性访问要求显式 inject，而 tools 是可选服务不应进 inject）；新增模拟真实 Cordis 守卫的回归测试

### Highlights (en)

- 🛠️ **Fix model-tool registration crash (v0.1.46 regression)**: DSH failed to boot with `cannot get property "tools" without inject` — the 5 agent tools (config_backup etc.) are now registered via the `ctx.get('tools')` result instead of `ctx.tools` property access (Cordis property access requires explicit inject; tools is an optional service and must not be injected); regression test simulating the real Cordis guard added

## [v0.1.46] - 2026-08-23

### 🎯 亮点 / Highlights (zh)

- ⏰ **定时备份调度器**：设置 6 小时 / 12 小时 / 24 小时 / 7 天的固定节奏，DSH 在后台静默产出完整备份——secrets 从不包含，磁盘上无需密码也安全；README 双语宣传同步
- 🔒 **Vault 文件级脱敏**：导出（不含 secrets 模式）时把 `.credentials.yaml` 等敏感文件移入 `dataDir/vault` 并在报告标注刷新动作——备份文件里不再残留凭据明文
- 🧹 **Ghost-sweep 幽灵清扫**：检测备份中「已不存在于宿主」的幽灵条目并提示清理；宿主无归档 API 时降级为本地校验
- 🗑️ **Tombstone 删除记录**：删除动作以 tombstone 记录进同步流，导入时按记录跳过已删除项，报告标注「已按删除记录跳过 N 项」
- ☁️ **WebDAV 快照级跳过**：内容未变的快照自动跳过（`sectionsEqual` 比对），不再重复传输整包；加密快照始终上传（密文不可比对）
- 🕵️ **Secret-scanner 个人化扩展**：新增 `extraValuePatterns` 与 `createConfiguredSecretScanner`，可从插件配置注入自定义敏感值模式
- 🛒 **市场共享模式**：prepare 增加保守档拦截与 deviceSpecific 分区拒绝（机型相关配置不共享），服务端 / UI 全程透传 mode
- 🧪 **架构与 schema 兼容测试**：`architecture-boundaries` 固化分层边界（KNOWN_VIOLATIONS 例外表）；`schema-compat` 固化 manifest 兼容策略（拒绝未来版本、未知字段保留）
- 🚀 **导入体验**：进度条下方实时命令日志面板（RunRegistry 轮询、刷新不丢）；导入中可跳过当前插件（彻底清理半装状态）；结果页支持重试失败 / 跳过的子集

### Highlights (en)

- ⏰ **Scheduled full backups**: pick a fixed cadence (6h / 12h / 24h / 7d) and DSH quietly keeps a fresh full backup in the background — secrets are never included, so it stays safe on disk without a password; bilingual README updated
- 🔒 **File-level vault redaction**: exporting without secrets moves sensitive files (e.g. `.credentials.yaml`) into `dataDir/vault` and flags the refresh in the report — no plaintext credentials left in backup archives
- 🧹 **Ghost-sweep**: detects and flags backup entries that no longer exist on the host (local-validation fallback when the host exposes no archive API)
- 🗑️ **Tombstone deletions**: deletes are recorded as tombstones in the sync stream; import skips deleted items and reports "skipped N items per delete records"
- ☁️ **WebDAV snapshot-level skip**: unchanged snapshots are skipped via `sectionsEqual` — no more re-uploading whole archives; encrypted snapshots always upload (ciphertext cannot be compared)
- 🕵️ **Personalized secret scanning**: `extraValuePatterns` + `createConfiguredSecretScanner` let you inject custom sensitive-value patterns from plugin config
- 🛒 **Market share mode**: prepare adds a conservative-mode gate and rejects device-specific sections (no machine-bound config sharing); mode is threaded through server & UI
- 🧪 **Architecture & schema-compat tests**: `architecture-boundaries` locks layer boundaries (KNOWN_VIOLATIONS exception table); `schema-compat` locks manifest compatibility (future versions rejected, unknown fields preserved)
- 🚀 **Import experience**: live command-log panel under the progress bar (RunRegistry polling, survives refresh); skip the current plugin mid-import (half-installed state fully cleaned); retry failed/skipped subsets from the results page

## [v0.1.45] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- 🧹 **安装命令简化**：README / DEVELOPERS 的安装命令统一为 `dsh plugin --profile web add dsh-config-manager@latest`，移除 `--config.auto-install-peers=false` 后缀——照着复制即可，无需再关心 peer 解析参数
- 🛒 **README 配置市场描述上线**：两个 README（中英镜像）新增配置市场完整描述——首屏亮点 + Use Cases + 核心亮点表格 + 功能详解小节（内置官方市场 / 搜索筛选排序 / 供应链警示恒展示 + 逐分区批准 / 安装复用安全导入管道 / 「我的配置」一键上传到自有仓库 + 自动收录 PR）；功能截图新增 `assets/screenshot-market.png`
- 🎨 **市场「我的配置」上传向导打磨**：改为三步式（选文件 → 本地校验 → 精简表单，仅 name / description / categories，其余系统自动）；更新模式支持页内换新 ZIP 并自动校验；详情视图 JSX 结构调整

### Highlights (en)

- 🧹 **Simplified install command**: README / DEVELOPERS now use `dsh plugin --profile web add dsh-config-manager@latest` — the `--config.auto-install-peers=false` suffix is gone, so users can just copy-paste
- 🛒 **Marketplace docs shipped**: both READMEs (en + zh mirror) now fully describe the config marketplace — hero bullet, Use Cases, highlights table and a dedicated feature section (built-in official market / search, filter & sort / always-on supply-chain warnings + per-section approval / install reuses the safe import pipeline / "My Configs" one-click upload to your own repo with auto listing PR); new `assets/screenshot-market.png` added to the screenshots
- 🎨 **Marketplace "My Configs" upload wizard polished**: now a three-step flow (pick file → local dry-run validation → slim form with only name / description / categories, the rest auto-filled); update mode lets you swap in a new ZIP inline with auto-validation; detail view JSX restructured

## [v0.1.44] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- 🔍 **AI 搜索曝光优化（SEO/AEO）**：README 首屏副标题改为「DeepSeek Harness Backup, Restore & Migration Plugin」，一句话价值主张覆盖 backup / restore / export / import / migrate / sync / plugins / MCP / skills 等全部高频搜索词；新增「Use Cases」小节（Backup / Restore / Migrate / Sync 四组自然语言场景，中文版同步镜像「典型使用场景」），让 AI 搜索直接命中句子即可召回
- 🧹 **npm description 修复**：清除双重编码乱码（`â€”`）与残留内部备注，重写为关键词密集的自然描述，末尾补充中文简介；keywords 由 7 个扩至 17 个（新增 dsh-plugin / restore / export / import / migrate / sync / webdav / mcp / skills / configuration）
- 📄 **新增 AI 搜索曝光审计文档**：`docs/seo/2026-08-21-ai-search-exposure-audit.md`——生态收录现状盘点（DSH Get / dshplugins.cc / DSH 插件商店 / awesome-dsh-plugins 全部收录）+ GitHub Description / Topics 建议值 + 后续优化清单

### Highlights (en)

- 🔍 **AI search exposure optimization (SEO/AEO)**: README opening now reads "DeepSeek Harness Backup, Restore & Migration Plugin" with a value proposition covering backup / restore / export / import / migrate / sync / plugins / MCP / skills and more; a new "Use Cases" section (Backup / Restore / Migrate / Sync natural-language scenarios; Chinese mirror added) lets AI search hit the exact sentences
- 🧹 **npm description fixed**: removed a double-encoded mojibake (`â€”`) and a leftover internal note; rewrote a keyword-rich, natural description with a short Chinese intro; keywords expanded from 7 to 17 (added dsh-plugin / restore / export / import / migrate / sync / webdav / mcp / skills / configuration)
- 📄 **AI search exposure audit doc added**: `docs/seo/2026-08-21-ai-search-exposure-audit.md` — ecosystem listing review (indexed by DSH Get / dshplugins.cc / DSH plugin store / awesome-dsh-plugins) + recommended GitHub Description / Topics + follow-up checklist

## [v0.1.43] - 2026-08-22

### 🎯 亮点 / Highlights (zh)

- 📐 **弹窗正文间距统一**：确认弹窗（`dialogBody`）与同步通道配置弹窗（`dialogBodyScroll`）的正文改为 flex 纵向排布 + 统一 10px 间距——message 与自定义内容、表单内的 tab/Banner/字段/操作行不再紧贴，视觉节奏与页面视图一致；纯视觉微调，无行为 / 交互 / API 变化，`DESIGN.md` 同步更新

### Highlights (en)

- 📐 **Unified dialog body spacing**: confirm dialog (`dialogBody`) and sync channel config dialog (`dialogBodyScroll`) bodies now use a flex column layout with a consistent 10px gap — messages, custom content, and form blocks (tabs/banners/fields/actions/hints) no longer collide, matching the page views' vertical rhythm; purely visual, no behavioral / API change; `DESIGN.md` updated accordingly

## [v0.1.42] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- ⭐ **市场页仓库级 Star 展示**：市场浏览列表每个条目新增「⭐ N」徽章，显示其**来源仓库**的 star 数（官方条目 = 官方市场仓库统一数字；第三方条目 = 作者自托管 `dsh-configs` 仓库），并标注「来源仓库」避免误解；「我的配置」页同步显示自己配置仓库的 star
- 🔍 **来源筛选下拉框**：市场工具栏新增「全部来源 / 官方配置 / 个人配置」筛选，selected 状态随 store 持久化（切 tab / 刷新不丢）
- 🔃 **排序下拉框**：新增「默认 / 最新更新 / ⭐ 最多 / 名称 A–Z」四种排序（升/降与 undefined 值规则确定且稳定）
- 🔒 **零凭据 star 查询**：浏览端点一律**匿名**查询 GitHub（`/repos/{owner}/{repo}`），按仓库 URL 去重 + 1 小时 TTL 内存缓存 + 单仓库失败降级显示「—」，不触碰任何 token，保持市场端点「无凭据」硬不变式
- 📜 **MIT 许可证 + Issue 模板**：仓库新增 MIT `LICENSE` 与中英双语 **Bug 报告 / 功能建议** Issue 模板；npm 包 metadata 同步补齐 `license` 字段

### Highlights (en)

- ⭐ **Repo-level stars in the market**: each market item now shows a "⭐ N" badge with its **source repo** star count (official items share the official market repo's single count; community items show the author's self-hosted `dsh-configs` repo), labeled as "source repo" to avoid confusion; "My Configs" shows your own config repo's stars too
- 🔍 **Source filter dropdown**: new market filter "All / Official / Community", persisted in the store (survives tab switches / refresh)
- 🔃 **Sort dropdown**: "Default / Recently updated / Most starred / Name A–Z" with deterministic, stable ordering (missing values sort last)
- 🔒 **Credential-free star lookup**: browsing queries GitHub **anonymously** (`/repos/{owner}/{repo}`), deduped per repo URL with a 1h in-memory TTL cache and per-repo failure fallback ("—"); no token is ever touched, keeping the market endpoints' credential-free invariant
- 📜 **MIT license + issue templates**: added the MIT `LICENSE` and bilingual **bug report / feature request** issue templates; npm metadata now carries the `license` field

## [v0.1.41] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- 🧹 **缓存自动清理**：`~/.dsh/dsh-config-manager/` 下的临时文件（`tmp/` 导入/解密/同步暂存）、导出副本（`exports/`，导出时已下载到本地）、市场缓存与 git 工作副本（`market/cache/`、`market/work/`）由插件**自动清理**——DSH 启动时清理一次、此后每 24 小时清理一次，只删除超过保留期（临时文件 24 小时、导出产物与市场缓存 7 天）的条目；导入回滚快照（`snapshots/`）与同步数据（`sync/`）属用户数据/安全网，**不自动清理**
- 🗑️ **「我的配置」删除条目**：列表新增删除入口，点删除弹**确认弹窗**（遮罩/Esc/取消三途径关闭，危险操作默认焦点落取消）——已收录条目自动提交**下架 PR**（独立分支 `dsh-market-delist/<id>`），待审核条目直接关闭收录 PR；收录/下架任务**后台执行 + 状态轮询**，进程重启后仍可一键**重试**（幂等复用已有 fork/PR）
- 📢 **市场操作免责弹窗**：上传 / 下载 / 装回本地三处操作前置免责声明，支持「不再提示」（三操作**分开记忆**，localStorage 持久化；存储不可用时静默降级为每次提示）
- 🪟 **同步设置改弹窗驱动**：远程同步页改为「同步通道」入口卡 + **通道配置弹窗**（Git/WebDAV 子 tab 与登录块移入弹窗，关闭弹窗 = 放弃本次操作含 GitHub 登录流程）；新增 **GitHub 登录态真实校验**（`/sync/github/validate`：token 有效则隐藏登录块，失效自动重新展示）
- 💾 **一键同步差异确认决策持久化**：逐项「采纳/解决」决策镜像进 store，切 tab / 刷新不丢，恢复会话可继续决策
- 🚀 **市场首次打开自动刷新**：本次 DSH 启动后首次打开市场页自动拉取一次最新条目（手动刷新成功即置位，失败可重试）
- 🔒 **秘密扫描宽松档**：市场发布扫描新增 `literalValueOnly` 档位——字段名敏感**且**值像真实字面量凭据才命中（占位符/示例形态/代码表达式/环境引用一律放行），真实密钥形状仍硬拦

### Highlights (en)

- 🧹 **Automatic cache cleanup**: transient files under `~/.dsh/dsh-config-manager/` (`tmp/` import/decrypt/sync staging), export copies (`exports/` — already downloaded to your machine on export), and marketplace cache/git worktrees (`market/cache/`, `market/work/`) are now **cleaned automatically** — once at DSH startup and then every 24 hours, removing only entries older than their retention (24 h for tmp, 7 days for exports and market cache); import rollback snapshots (`snapshots/`) and sync data (`sync/`) are user data / safety nets and are **never auto-removed**
- 🗑️ **"My Configs" item deletion**: each listed item gains a delete action guarded by a **confirm dialog** (mask / Esc / Cancel close paths; focus lands on Cancel for destructive ops) — listed items automatically open a **de-listing PR** (dedicated branch `dsh-market-delist/<id>`), pending-review items just close the listing PR; listing/de-listing jobs run **in background with status polling**, and a failed/lost job can be **retried in one click** (idempotent, reuses the existing fork/PR)
- 📢 **Market operation disclaimers**: upload / download / install-back-local now show a disclaimer first, with a per-operation **"don't ask again"** toggle (remembered independently in localStorage; silently degrades to always-ask when storage is unavailable)
- 🪟 **Sync settings moved to a dialog**: the sync page is now an entry card that opens a **channel-config dialog** (Git/WebDAV tabs and the GitHub login block live inside; closing the dialog abandons the operation, including an in-flight GitHub login); new **real GitHub sign-in validation** (`/sync/github/validate`: valid token hides the login block, an invalid one re-shows it)
- 💾 **One-click-sync confirm decisions persisted**: per-item adopt/resolve choices are mirrored into the store, surviving tab switches / refresh so a session can be resumed
- 🚀 **Market auto-refresh on first open**: the market page auto-fetches once per DSH startup (a successful manual refresh also arms it; failures can be retried)
- 🔒 **Lenient secret-scan tier**: market publishing gains a `literalValueOnly` mode — a sensitive field name only hits when the value looks like a real literal credential (placeholders / example shapes / code expressions / env references always pass); real key shapes are still hard-blocked

## [v0.1.40] - 2026-08-20

### 🎯 亮点 / Highlights (zh)

- 🧭 **「我的配置」体验修复**：移除标题上方的「返回市场」按钮（子视图切换已在顶部，无需重复返回）；update 更新改为**显式按条目 id 定位**（不再靠名称转 id 猜测，中文名/改名场景不再误建新条目，目标条目不存在时明确报错）；秘密扫描**消除技能文档误报**（`token:`/`password:` 等代码示例、类型声明、占位符、环境引用不再误判，真实密钥 sk-/ghp_/JWT/PEM/Bearer 仍强制拦截）

### Highlights (en)

- 🧭 **"My Configs" UX fixes**: removed the "back to market" button above the title (the sub-view tabs already switch back); update now targets the item by its **explicit id** (no more name→slug guessing — Chinese names / renames no longer create a duplicate item, and a missing target id errors clearly); secret scan **no longer false-positives on skill docs** (code samples like `token:`/`password:`, type declarations, placeholders, env references are allowed; real key shapes sk-/ghp_/JWT/PEM/Bearer are still hard-blocked)

## [v0.1.39] - 2026-08-20

### 🎯 亮点 / Highlights (zh)

- 🧹 **上传入口收敛**：移除「配置市场」浏览视图中的旧「发布到市场」向导（PublishView）及其入口按钮，上传配置统一收敛到「我的配置」子视图（一键上传 → 自动建仓 → 自动收录 PR）；fork 创建轮询超时 60s → 180s（GitHub 首次 fork 复制仓库内容可能超过 1 分钟）

### Highlights (en)

- 🧹 **Upload entry consolidated**: the legacy "Publish to Market" wizard (PublishView) and its entry button are removed from the browse view; uploading configs now lives solely in the "My Configs" sub-view (one-click upload → auto repo → auto listing PR); fork creation polling timeout raised 60s → 180s (GitHub's first fork copies the whole repo and can take over a minute)

## [v0.1.38] - 2026-08-20

### 🎯 亮点 / Highlights (zh)

- 🚀 **「一键上传 / 我的配置」**：配置市场新增「我的配置」子视图——GitHub device flow 登录（token 只存本机凭据槽）后，选择配置 zip → 本地 8 道校验 + 秘密扫描 → 一键上传到**你自己的公开仓库**（自动创建 `<login>/dsh-configs`）→ 自动 fork 官方市场仓库、改 `index.json` 收录**自托管引用**并提交自动 PR（固定分支 `dsh-market-sync/<itemId>`：未合并自动更新、已合并基于最新 main 重开）；支持查看已上传（收录状态徽章：未收录 / PR 待审核 / 已收录）、一键更新（元数据全自动：id / author / version / updatedAt / sha256 系统生成，版本纯自动 +1）、装回本地（复用市场下载 + 逐分区批准 + 回滚管道）。目标收录仓库固定 `xiajiajun516/dsh-config-market`，界面不可修改

### Highlights (en)

- 🚀 **One-click upload / "My configs"**: the Market panel gains a "My Configs" sub-view — after GitHub sign-in (device flow; token stays in the local credential slot), pick a config ZIP → local 8-step validation + secret scan → upload in one click to **your own public repo** (auto-created as `<login>/dsh-configs`) → auto-fork the official market repo, add a **self-hosted reference** to `index.json`, and open the listing PR automatically (fixed branch `dsh-market-sync/<itemId>`: auto-updated while unmerged, reopened from latest main after merge); view uploads with listing-status badges (not listed / PR pending / listed), update in one click (all metadata auto-generated — id / author / version / updatedAt / sha256; version bumps automatically), and install back locally (reusing the market download + per-section approval + rollback pipeline). The listing target repo is fixed to `xiajiajun516/dsh-config-market` and not editable in the UI

## [v0.1.37] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🐛 **修复异步操作切 tab 丢失状态**：远程同步的推送/拉取/一键同步、市场下载与确认导入、快照恢复等异步操作，在请求进行中切换 tab 再切回时不再丢状态——结果（推送/拉取报告、差异确认会话、导入结果、恢复计划与报告）在组件卸载期间完成也能落库，切回即恢复；进行中的 busy spinner 也随模块级 store 保留（刷新后清空，凭据仍仅内存白名单剔除）

### Highlights (en)

- 🐛 **Fix state loss for async operations on tab switch**: pushing/pulling/one-click sync, market download & confirmed import, and snapshot restore no longer lose their result when you switch tabs mid-request — results (push/pull reports, diff-confirm session, import outcome, restore plan & report) are persisted into the store even when the request settles after the view unmounted, and restore on return; in-flight busy spinners survive tab switches too (cleared on refresh; credentials stay memory-only behind the whitelist)

## [v0.1.36] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🐛 **修复同步快照二进制损坏（文件分区丢字节）**：文件类分区（技能/插件文件等）在内存为 Uint8Array，整份快照走 JSON 的通道（WebDAV 单文件快照、加密载荷）会把字节序列化成数字索引对象，拉取/解密后 `Buffer.from(对象)` 直接抛错；新增二进制安全序列化（文件字节 ↔ `{ $bin: base64 }`）——三个通道全部接入，往返字节无损
- 🔐 **Git 加密快照改「密文单文件」布局**：加密快照（密文载荷无法平铺为明文 JSON 分区）改走 `snapshots-encrypted/<id>.json` 整体 JSON 提交，与明文散文件目录并存——远端只存密文、本地不产生额外明文审计副本
- 🛡️ **市场条目禁止分区**：sessions（历史会话）/ pluginFiles（任意文件直通）/ self（本地环境）永久禁止进入市场条目——安全校验与条目生成两端强制拒绝（产品决策，详见市场仓库搭建规格书）
- 🏷️ **同步历史标记触发通道**：快照 manifest 与自动同步历史记录各自 transport（git/webdav），快照/历史列表显示通道徽章——多通道同步一次看清哪个通道做了什么
- 📖 **官方市场仓库搭建规格书**：新增 docs/design/2026-08-19-market-repo-setup-guide.md——索引格式、8 道安全校验、条目结构整份规格，可直接复制发给搭建 AI

### Highlights (en)

- 🐛 **Fix binary corruption in synced snapshots (file-section bytes)**: file-based sections (skills/plugin files…) hold `Uint8Array` in memory; any channel that JSON-serializes the whole snapshot (WebDAV single-file snapshots, encrypted payloads) mangled the bytes into numeric-index objects, making `Buffer.from(obj)` throw on pull/decrypt. A binary-safe serializer (bytes ↔ `{ $bin: base64 }`) is now wired into all three channels — lossless round-trips
- 🔐 **Git encrypted snapshots move to a ciphertext-single-file layout**: encrypted snapshots (ciphertext cannot be flattened into plaintext JSON sections) are now committed as a whole `snapshots-encrypted/<id>.json`, coexisting with the plaintext scatter-dir layout — remote keeps only ciphertext, no extra plaintext audit copy locally
- 🛡️ **Banned market sections**: `sessions` (chat history) / `pluginFiles` (arbitrary passthrough files) / `self` (local environment) are permanently forbidden in market items — enforced at both validation and item-generation (product decision, see the market repo setup spec)
- 🏷️ **Sync history records the triggering channel**: each snapshot manifest and autosync history entry now carries its `transport` (git/webdav), shown as a channel badge in the snapshot/history lists — multi-channel sync is now readable at a glance
- 📖 **Official market repo setup spec**: new docs/design/2026-08-19-market-repo-setup-guide.md — index format, 8-step security validation, item structure as a single spec, copy-paste ready for a setup AI

## [v0.1.35] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🛒 **配置市场发布向导（去中心化方案 B）**：配置市场新增「发布到市场」五步向导——选择配置 zip → 本地 dry-run 校验（内容合法且不含密钥）→ 生成条目包（L2 manifest + SHA-256 + sections）→ 推送作者仓库（生成 git 命令模板，插件不做任何 git 写操作、不持有凭据）→ 提交收录申请（index.json 片段 + PR 指引）；官方 index 只收录引用、保持只读零凭据，条目由作者自托管公开 git 仓库
- 🧩 **self 分区：插件自身配置纳入备份/迁移**：新增 self 适配器——导出/同步自动收集 `$DSH_HOME/dsh-config-manager/` 下的 sync-config / sync-autosync / sync-selection / ui-prefs / market-config 白名单配置（不含凭据值），换机器一键恢复
- 🔀 **同步通道独立子 tab**：远程同步面板 Git / WebDAV 改为子 tab 各自持有独立配置——自动同步（启用/间隔/状态）、同步模式与分区勾选、是否加密、远端快照列表均按通道独立（autosync / sync-selection schema v2 按通道命名空间 + v1 自动迁移）
- 💾 **UI 偏好落盘**：上次选择的同步通道从浏览器 localStorage 迁入磁盘 ui-prefs.json——换浏览器/换机器不丢，Host 可读写（浏览器关闭时自动同步也能读到）

- 🐛 **加密备份导入只输一次密码**：导入整体加密备份（DCA1 容器）时不再需要第二个「解密备份」页面——选完 ZIP 输入一次解锁密码即可，Host 解锁时顺带解出内部凭据覆盖清单（refs），该密码同时作为解密密码完成凭据恢复（导出时两者同源）
- 🐛 **修复切 tab / 刷新丢失面板状态**：快照恢复、远程同步、配置市场三个低频面板的非敏感 UI 状态（选中快照 / dry-run 计划 / 执行报告、通道表单 / 同步模式与分区勾选 / 一键同步差异确认会话、搜索词 / 类别筛选 / 条目详情与逐分区批准）现经模块级 runStore + sessionStorage 白名单持久化——切 tab 不丢、刷新后回到原 tab 并恢复现场；同步凭据（token / webdav 密码 / 加密与解密密码）仍仅内存，刷新后清空要求重输

### Highlights (en)

- 🛒 **Marketplace publish wizard (decentralized)**: a five-step "Publish to Marketplace" wizard — pick a config ZIP → local dry-run validation (valid content, no secrets) → generate the item package (L2 manifest + SHA-256 + sections) → push to your own repo (git command template generated; the plugin never performs git writes or holds credentials) → submit an index entry (index.json snippet + PR guidance); the official index stays read-only with zero credentials and only references author self-hosted public repos
- 🧩 **`self` section: the plugin's own config joins backup/migration**: a new `self` adapter collects the plugin's own config files under `$DSH_HOME/dsh-config-manager/` (sync-config / sync-autosync / sync-selection / ui-prefs / market-config whitelist, credential-free) for export & sync — restore everything on a new machine in one shot
- 🔀 **Per-channel sync sub-tabs**: the Sync panel now has Git / WebDAV sub-tabs, each owning independent settings — autosync (enabled / interval / status), sync mode & section selection, encryption toggle, and remote snapshot list are all per-channel (autosync / sync-selection schema v2 with namespaced channels + v1 auto-migration)
- 💾 **UI prefs on disk**: the last-selected sync channel moved from browser localStorage to `sync/ui-prefs.json` — survives browser/device changes and is readable by the Host process (autosync keeps working while the browser is closed)
- 🐛 **Encrypted backup import now asks for the password once**: the separate "decrypt backup" step is gone for fully-encrypted (DCA1) archives — enter the unlock password right after picking the ZIP; the Host returns the covered credential refs with the unlock response and reuses the same password (both layers derive from it at export time) to restore credentials
- 🐛 **Fix state loss on tab switch / page refresh**: non-sensitive UI state of the Snapshots / Sync / Market panels (selected snapshot + dry-run plan + restore report; channel form + sync mode & section selection + one-click sync confirm session; search / category filter / item detail + per-section approvals) is now mirrored into the module-level runStore and persisted via the sessionStorage whitelist — surviving tab switches and restoring after refresh, with the current panel re-opened; sync credentials (token / WebDAV password / encrypt & decrypt passwords) stay memory-only and are cleared after refresh

## [v0.1.34] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🆕 **关于（About）面板**：设置页新增第六个 tab——展示插件元数据（名称/仓库/作者）、当前插件版本与 DSH 版本/平台，并提供 Star / 文档 / Issues 快捷链接；链接恒等派生自仓库 URL，杜绝拼接错误
- ⬇️ **导出下载静默化**：导出 ZIP 完成后默认以 Blob + `<a download>` 静默下载到浏览器「下载」目录（无需另存为对话框）；需要选择保存位置时可走系统保存对话框（saveDialog 模式）
- 🔀 **同步配置 schema v3**：git 与 WebDAV 双命名空间共存——切换通道不再丢失另一通道的 repoUrl/url 配置，status 路由可回填另一通道配置
- 🐛 **修复加密备份解锁后 zipPath 丢失**：导入解锁加密备份时保留已记录的容器路径，避免 store 中已 patch 的 zipPath 被覆盖回 null
- ⚙️ **发布流程改进**：GitHub Release 亮点改为从 CHANGELOG.md 自动抽取（未写当前版本段则 fail fast），发版不再需要手动维护亮点列表

### Highlights (en)

- 🆕 **About panel**: new sixth tab in the settings page showing plugin metadata (name / repo / author), plugin version, DSH version and platform, with Star / Docs / Issues quick links derived from the repo URL (single source, no concatenation bugs)
- ⬇️ **Silent export download**: exported ZIPs now download straight to the browser's download directory via Blob + `<a download>` (no save dialog); opt into the system save dialog with saveDialog mode when a location choice is needed
- 🔀 **Sync config schema v3**: git and WebDAV namespaces now coexist — switching channels no longer drops the other channel's repoUrl/url, and the status route can backfill the inactive channel config
- 🐛 **Fix zipPath loss after unlocking encrypted backups**: the import wizard keeps the recorded container path when unlocking an encrypted archive, so the patched zipPath in the store is no longer overwritten to null
- ⚙️ **Release workflow improvement**: GitHub Release highlights are now auto-extracted from CHANGELOG.md (fail fast when the current version section is missing), no more hand-maintained highlight lists

## [v0.1.33] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🔐 **加密快照同步**：手动推送时可将整个同步快照的 sections 载荷用 AES-256-GCM **整体加密**后上传远端（`manifest.encrypted=true`），拉取/一键同步时输入密码解密——密码仅内存使用，绝不落盘/落日志
- 🛡️ **凭据随同步通道携带（可选）**：手动推送可导出真实凭据值（`includeSecrets`），但**强制要求同时加密**（安全不变量：密钥绝不明文进入同步通道）；自动同步恒不携带凭据
- 🚫 **自动同步智能跳过加密快照**：远端最新快照为加密 → 自动同步无密码无法解密，记录 `skipReason='encrypted'` 整体跳过（不误判失败），提示走手动输入密码同步
- ⚙️ **同步配置保存路由（sync/config）**：UI 表单自动保存 /「保存配置」按钮落盘同步通道配置，凭据走 DSH credentials 槽位；WebDAV `username` 留空时从持久化配置自动回填（挂载/刷新后不再因空用户名失败）
- ⏱️ **WebDAV 通道独立超时**：单请求放宽至 120s（适配坚果云等慢速 WebDAV 上传大快照/读写索引），错误消息携带实际毫秒数便于判断
- 🐛 **修复导入「解锁加密备份」阶段渲染让位**：decrypt-archive 阶段发生时不再停留在文件选择页，正确显示密码输入界面（import-decrypt-archive-render 回归）

### Highlights (en)

- 🔐 **Encrypted snapshot sync**: on manual push, the whole sync snapshot payload can be **encrypted with AES-256-GCM** before upload (`manifest.encrypted=true`); a password is asked on pull / one-click sync to decrypt — kept in memory only, never persisted or logged
- 🛡️ **Credentials may travel with the sync channel (opt-in)**: manual push can export real credential values (`includeSecrets`) but **requires encryption at the same time** (security invariant: secrets never enter the sync channel in plaintext); auto-sync never carries credentials
- 🚫 **Auto-sync skips encrypted snapshots**: when the remote latest snapshot is encrypted and no password is available, the sync records `skipReason='encrypted'` and skips the whole run (not a failure), prompting manual password-based sync
- ⚙️ **Sync config save route (`sync/config`)**: the UI autosaves / the "Save config" button persists channel config; credentials go to DSH credential slots; empty WebDAV `username` is backfilled from persisted config after mount/refresh
- ⏱️ **WebDAV channel timeout**: per-request timeout widened to 120s (for slow WebDAV like Jianguoyun uploading large snapshots / index I/O); error messages carry the actual milliseconds
- 🐛 **Fix import "unlock encrypted backup" step rendering**: the decrypt-archive stage now correctly shows the password input instead of staying on the file-selection page (import-decrypt-archive-render regression)