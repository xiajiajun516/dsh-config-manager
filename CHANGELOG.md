# Changelog

本文档记录 dsh-config-manager 的发布亮点（中英双语）。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
This file records release highlights of dsh-config-manager (bilingual: 中文 + English). Format: [Keep a Changelog](https://keepachangelog.com/).

> **发布流程**：打 tag 发布时 CI（`.github/workflows/publish.yml`）自动抽取**当前版本段**作为 GitHub Release 描述亮点；
> 如果忘记写当前版本段，CI 会 **fail fast** 拒绝发版，避免漏写。
>
> **Release workflow**: on tag push, CI extracts the current version's section as the release notes highlights;
> the build fails fast if the section is missing, so you cannot forget to update it.

## [Unreleased]

### 🎯 亮点 / Highlights (zh)

- （待补充 / To be added）

### Highlights (en)

- (To be added)

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