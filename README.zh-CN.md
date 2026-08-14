# DSH Config Manager

**Backup · Export · Import · Migrate · Restore** —— DSH 配置备份 / 导出 / 导入 / 迁移管理器。

[English](README.md) | [简体中文](README.zh-CN.md)

在一台 DSH 中一键导出主要配置为 ZIP，在另一台 DSH 中导入并尽可能恢复原来的使用环境。

> ⚠️ **安全第一：默认不导出任何 Secret（API Key / Token / 密码）。** 详见 [Security](#security)。

---

## What it does

DSH 的配置是「一个集中 `settings.yaml` + 多个独立文件 + 插件自有文件」的混合模型（见 `Docs/research/dsh-architecture.md`）。
本插件**不整包复制 `~/.dsh`**，而是按真实配置类别分区收集、打包为带清单（manifest）与校验和（checksums）的 ZIP 备份，并在导入端执行

```
Analyze → Preview → Snapshot → Apply → Validate → Rollback(if needed)
```

的安全导入流程。

## Features

- **Export**：Quick Export（推荐配置一键导出）与按分区选择导出。
- **Import**：ZIP 校验 → manifest 读取 → 完整性校验 → schema 检查 → 兼容性检查 → 内容扫描 → 导入计划预览 → 用户确认 → 自动快照 → 执行 → 校验 → 结果（失败自动回滚）。
- **Dry Run / Preview**：`analyzeImport()` + `createImportPlan()` 纯计算零写入，导入前完整预览。
- **冲突处理**：`merge`（默认）/ `replace` / `skipExisting` 全局策略 + 逐项 `Keep Current / Use Imported / Review`。
- **路径映射**：跨设备绝对路径检测与批量前缀映射（workspace 路径 / MCP cwd / 插件配置路径）。
- **Secret 安全**：默认剥离所有敏感字段；加密完整备份（scrypt + AES-256-GCM）为可选高级功能。
- **自动快照与回滚**：导入前备份将被修改的目标，失败时逆序补偿恢复。
- **Schema 版本与迁移**：`schemaVersion` 独立演进，迁移逻辑集中在 `src/migrations/`。
- **幂等**：同一 ZIP 重复导入不产生重复数据（按 Plugin ID / MCP serverName / Prompt name / Workspace id / Credential ref 识别）。
- **兼容性评分**：Excellent / Good / Partial / Unsupported（规则驱动）。
- **Profiles（配置 Profile）**：保存当前配置为 Profile / 切换 / 复制 / 重命名 / 导出 / 导入 / 删除；切换带 Preview + 快照 + 回滚（`src/profiles/`）。

## Installation

本插件是标准的 **DSH bundle 插件**（仿 dsh-ssh 工程范式，见研究报告 §5.1）：`package.json` 声明
`dsh.bundle.patch`（指向 `cordis.patch.yml`，CLI 的 bundle 硬判据）与 `dsh.client`（浏览器半声明），
`npm run build` 产出双半产物（`lib/index.js` Host 半 + `lib/client.js` 浏览器半，后者以
`window.__ModuleLoader__.load(...)` 装载进 Web GUI）。

两种安装方式（二选一）：

```bash
# ① 推荐 —— 从 npm registry 安装
dsh plugin --profile web add dsh-config-manager --config.auto-install-peers=false

# ② 备选 —— 本地 tgz / 目录安装（开发与测试）
npm run build
npm pack                       # 产出 dsh-config-manager-0.1.0.tgz
dsh plugin --profile web add file:/absolute/path/to/dsh-config-manager-0.1.0.tgz
```

> **`--legacy-peer-deps` 说明**：peerDependencies 中的部分 DSH 核心包（如
> `@deepseek-ai/dsh-plugin-marketplace`、`dsh-host-plugin-inventory`）尚未发布到公共 npm registry，
> 只在本地 DSH profile 环境存在。安装时若 npm/pnpm 尝试解析 peer 依赖并失败，请跳过 peer 自动安装：
> - npm 直接安装：`npm install --legacy-peer-deps`
> - `dsh plugin add`（内部转发 pnpm）：`dsh plugin --profile web add <spec> --config.auto-install-peers=false`
>
> 运行时这些包由 DSH profile 自身提供（peerDependencies 语义），插件不重复安装。

> **本地验证提示**：可用 `$DSH_HOME=<临时目录>` 环境变量隔离测试，完全不触碰 `~/.dsh`：
> ```bash
> $env:DSH_HOME = "D:\tmp\dsh-home"        # Windows PowerShell
> dsh plugin --profile test add file:<tgz> --config.auto-install-peers=false
> dsh --profile test --dump-config | Select-String config-manager   # 应看到挂载行
> ```

## Export

两种方式：

- **Quick Export**：一键导出推荐分区（settings / ui / providers / plugins / mcp / prompts / skills / agentPresets / workspaces / credentialsStatus）。
- **Custom Export**：按分区逐项选择（可选 `pluginFiles`、`sessions`；`sessions` 默认关闭）。

导出产物：`dsh-config-<yyyy-MM-dd>.zip`，含 `manifest.json` + 各分区数据 + `integrity/checksums.json`（SHA-256）。

## Import

```
Select ZIP → Validate ZIP → Read Manifest → Check Integrity → Check Schema
→ Check Compatibility → Scan Contents → Generate Import Plan → Show Preview
→ User Confirms → Create Backup (Snapshot) → Import → Validate → Show Result
```

导入流程强制：**未确认不执行任何写入**；**导入前必须生成快照**；失败按 `rollbackOnError` 决定整体回滚或单项如实记录。

## Security

> **默认备份不包含任何 Secret 值。** 这是硬性安全不变量，由 `Exporter` 强制：

- 所有结构化分区数据在写入 ZIP 前经过敏感字段扫描（字段名黑名单：password / token / apiKey / secret / credential / authorization / cookie / privateKey / clientSecret 等，大小写不敏感），命中即剥离。
- `ctx.settings.describe({ redactSecrets: true })` 作为第一道防线剥离 DSH 已知秘密；敏感字段扫描器作为第二道防线兜底插件自定义字段。
- 凭据（`.credentials.yaml`）**永不导出值**，只导出状态（`{ref, required, configured, hasValue:false}`），导入后生成「N credentials need attention」补录清单。
- **加密完整备份（可选）**：显式勾选「Include secrets」时，要求设置备份密码，使用 `node:crypto`（scrypt 派生 + AES-256-GCM 加密），**密码绝不写入 manifest**；`secrets.enc` 只有解密后经 `ctx.credentials.set()` 写回。
- 无加密提供者时 `includeSecrets: true` 会被拒绝（绝不明文泄密）。
- 日志系统全部经过 redaction，Secret 值永不进入日志。
- ZIP 属于不可信输入：防御 Zip Slip / 绝对路径 / 符号链接 / zip bomb（条目数 / 压缩体积 / 解压体积 / 压缩比上限）/ 畸形 ZIP / checksum 不匹配，任何一条触发即整体拒绝。

## What is NOT exported

默认**不**导出（规范 §34.19/20）：

- API Key / Password / Token / Cookie / Session / 认证凭据（值）
- `~/.dsh/.anonymous-user-id`（设备唯一 ID）
- 会话历史（`sessions/`，默认关闭；v1 仅支持文件级复制）
- Logs / Cache / 临时文件
- 浏览器 localStorage 中的 UI 状态（Host 侧无通道，仅导出 `uiMigrationNotes` 说明）
- 插件二进制（绝不打包，只迁移清单并走官方安装机制）

## Secrets

| 备份类型 | 导入行为 |
|---|---|
| 普通备份（无 secrets.enc） | 全部凭据 → `MissingSecret`，导入后由用户补录 |
| 加密备份 + 正确密码 | 自动解密并经 `credentials.set()` 恢复（预览时可逐条确认） |
| 加密备份 + 不输密码 | 同普通备份：状态补录 |

## Compatibility

| 状态 | 规则 |
|---|---|
| Excellent | 同平台、无分区缺失、schema 受支持 |
| Good | 备份来自更旧 DSH（目标向后兼容） |
| Partial | 跨平台 / 分区缺失 / 备份比目标新 |
| Unsupported | schema 超出支持范围 |

## Backup format

```
dsh-config-2026-08-14.zip
├── manifest.json                  # schemaVersion / exporter / source / sections / security
├── config/settings.json           # 非 UI settings namespace（redacted + revision）
├── config/ui.json                 # UI namespace + uiMigrationNotes
├── ai/providers.json              # llm-* providers/models（同 section 不拆分）
├── plugins/plugins.json + patch.json
├── mcp/servers.json               # 组合 patch 提取的 dsh-mcp-client 条目
├── custom/prompts.json + skills/
├── agents/presets/
├── workspaces/workspaces.json
├── plugin-files/                  # 可选
├── security/credentials.json      # 凭据状态（永不含值）
├── security/secrets.enc           # 仅加密备份
└── integrity/checksums.json       # SHA-256
```

## Development

```bash
npm install --legacy-peer-deps   # peer 含未发布公共 registry 的 DSH 核心包，见 Installation
npm run typecheck                # tsc --noEmit
npm run build                    # tsc -p tsconfig.build.json（Host 半 lib/）+ tsdown（client bundle lib/client.js）
npm run bundle                   # 仅重新构建 client bundle（tsdown）
npm test                         # node --test "src/**/*.test.ts" "tests/**/*.test.ts"
```

架构：核心引擎（`src/core`）只依赖 `ConfigAdapter` / `HostContext` 接口（与 DSH 运行时解耦，可用内存 mock 测试）；`src/adapters` 实现各配置类别；`src/security` 提供秘密扫描 / 加密 / 完整性 / ZIP 安全 / redaction；`src/migrations` 集中 schema 迁移。

## Publishing（GitHub Actions · npm Trusted Publishing / OIDC）

推送版本标签会触发 `.github/workflows/publish.yml` 的 CI 流水线：typecheck → 测试 → 构建 → 自动发布到 npm。发布使用 **npm Trusted Publishing（OIDC）**——仓库不存储任何长期令牌，npm CLI 通过 GitHub Actions 的 OIDC 与 registry 交换短期身份。

```bash
npm version patch          # 0.1.0 → 0.1.1（同时创建 tag）
git push origin main --tags
```

npmjs.com 一次性配置（首次 OIDC 发布前必须完成）：

1. 打开包页面：https://www.npmjs.com/package/dsh-config-manager → **Settings → Publishing access**。
2. **Add trusted publisher**（添加可信发布方）：
   - Provider：**GitHub Actions**
   - GitHub owner：`xiajiajun516`
   - Repository：`dsh-config-manager`
   - Workflow filename：`publish.yml`
3. 无需 `NPM_TOKEN` 仓库密钥——之前配置的令牌可以撤销。

说明：

- `package.json` 中的版本须与 tag 一致（`npm version` 会自动同步）。
- 流水线会先升级 npm（`npm install -g npm@latest`），因为 OIDC 发布要求 npm ≥ 11.5.1。
- 也可在 Actions 页面点 **Run workflow** 手动触发。

## Testing

测试框架为 **node:test（Node 内置，零依赖）**，沿用核心模块的既有选择（不引入 vitest）。测试位于 `src/**/*.test.ts` 与 `tests/**/*.test.ts`。

覆盖矩阵（规范 §33 + 验收场景 A-G）：

| 组 | 覆盖 |
|---|---|
| Export | 正常 / 空配置 / 大配置(1MB+) / Unicode / 特殊字符 / Secret 过滤 |
| Import | 正常 / Merge / Replace / Skip（不删目标独有 §32）/ Conflict / Missing plugin / Missing dependency / Missing secret / 未确认拒绝 |
| Rollback（场景 E） | 多 adapter 混合中途失败 → 整体恢复（settings / 文件 blob / workspace / patch 行）；`rollbackOnError=false` 对照；部分回滚诚实报告 |
| Migration（场景 G） | `migrateToCurrent` 机制级：同版本 / 过新 / 低于最低 / 无路径 / 注册重叠 / 链式推进（**如实说明：当前 v1 即最新，无真实 v2 可端到端验证**） |
| Security（场景 F） | 畸形 ZIP / 超大条目数 / checksum 不匹配与缺失 / Zip Slip / 绝对路径 |
| Cross-platform（场景 B） | win32→darwin / darwin→win32 / linux→win32 批量前缀映射 |
| Redaction | 日志消息 / meta / 全链路不泄 Secret 值 |
| Schema | manifest 结构校验 / 版本判定函数 |

当前测试结果：**186 tests, all passing**（`npm test`），`npm run typecheck` 与 `npm run build` 均通过。

## Known limitations

1. **Workspace 只能建/改标题**：DSH 的 workspace 服务没有「整体覆盖」写通道——导入时可创建 workspace 与更新标题；path 与会话列表由 DSH 依真实目录自行维护，跨设备路径通过路径映射适配。
2. **部分 DSH 核心包未发布公共 npm registry**（如 `@deepseek-ai/dsh-plugin-marketplace`、`dsh-host-plugin-inventory`）：依赖其 API 的功能只在本地 profile 环境可用；安装本插件需跳过 peer 自动安装（见 [Installation](#installation) 的 `--legacy-peer-deps` 说明）。
3. **MCP 无管理 API**（研究报告 §4.3）：MCP 以组合 patch 行导入，需重启 DSH 生效；无增删改 API。
4. **插件安装需重启**：`pluginMarketplace.installPlugin` 只返回 `needsRestart`，重启依赖 DSH Desktop。
5. **浏览器 localStorage UI 状态不迁移**（任务看板数据、面板宽度等）：Host 无通道。
6. **keybindings / workflows 配置 / commands / rules 文件**：DSH 当前无这些概念，不实现分区（不发明）。
7. **凭据值无法回滚**：DSH 不回读凭据值，导入中覆盖的凭据在回滚时只能标记 `manualHint` 人工补录。
8. **新建项无法删除回滚**：DSH settings 无删除语义，导入新建的 namespace 在回滚时只能人工处理（如实报告 partial）。
9. **Schema 迁移**：v1→v2 为占位（当前 `CURRENT_SCHEMA_VERSION=1`），机制已就绪但无真实 v2 可验证。
10. **历史会话迁移**：默认关闭，v1 仅文件级复制。
11. **加密备份**：依赖用户设置强密码；密码丢失则 `secrets.enc` 无法解密（设计使然）。

## Manual Test（最短人工测试流程）

> 前提：两台 DSH（或同一台的两份配置目录）；本插件已按 [Installation](#installation) 打包并安装。

```
DSH A
→ 打开 Config Manager → Export Configuration
→ 选择 Quick Export → 导出 dsh-config-<date>.zip（确认报告中 Secret 均被排除）
→ 将 ZIP 复制到 DSH B

DSH B
→ 打开 Config Manager → Import Configuration
→ 选择 ZIP → 等待 Analyzing... → 查看 Import Preview（分区/插件/路径映射/凭据补录清单）
→ 如有路径问题 → 选择映射目录（批量前缀映射）
→ 解决冲突（Keep Current / Use Imported / Review）
→ 确认 Import → 观察进度 → 查看结果报告
→ 补充缺失凭据（N credentials need attention）
→ Verify：确认 settings / 插件 / MCP / Prompts / Skills / Workspaces 已恢复；
   若导入中途失败 → 确认已自动回滚、原配置可正常使用
```

---

**产品原则**：宁可少迁移一个配置，也不要破坏用户现有配置。任何 Import 都遵循 `Analyze → Preview → Backup → Modify → Validate → Rollback`；任何 Secret 都遵循 `不默认导出 / 不记日志 / 不暴露 / 不静默转移`。
