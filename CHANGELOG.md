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