# AGENTS.md — DSH Config Manager 仓库协作指南

> 面向在本仓库工作的 AI agent 与人类协作者。**完整架构/测试矩阵/限制清单见 [DEVELOPERS.md](DEVELOPERS.md)；用户文档见 [README.md](README.md)。**
> 本文只写「做改动前必须知道」的注意点——隐性约定与坑，避免重复造轮子或踩雷。

## 🗣️ 语言与交流

- 与用户交流一律用**中文**。
- 代码注释、commit message、文档以中文为主（与技术术语混排，如 `SyncEngine`、`adapter`）。

## 🔢 版本号：三处必须同步（最容易漏）

发版时 `version` 同时存在于三处，**漏改任何一处都会产生不一致**（历史上出现过 package.json=0.1.30 而 PLUGIN_VERSION=0.1.28、lockfile=0.1.26 的漂移，0.1.31 起已修复同步）：

1. `package.json` → `"version"`
2. `src/index.ts` → `const PLUGIN_VERSION`（约 L124，注释声明 "kept in sync with package.json"）
3. `package-lock.json` → 根对象 `"version"`（约 L3 **和** `packages[""]` 的 `"version"` 约 L9，两处都要改）

bump 后跑 `npm run typecheck` 即可确认无引用遗漏。

## 🚀 发布流程（打 tag 即全自动）

CI：`.github/workflows/publish.yml`，tag `v*` push 触发全自动流水线：

```
typecheck → npm test → build → npm pack → npm publish（Trusted Publishing/OIDC）→ 创建 GitHub Release
```

发版步骤（按序）：

1. **bump 三处版本号**（见上）
2. **更新 publish.yml 里的「手动亮点段」**：release 描述由 workflow 内硬编码的 heredoc 生成（`cat > /tmp/release-notes.md <<'EOF'` 段），**每次发版前必须手动改写**，否则 release 描述仍是上一版内容
3. 提交 + `git push origin main`
4. `git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z` —— **tag push 触发发布**

⚠️ 注意：
- `workflow_dispatch`（手动触发）**不会**创建 GitHub Release，只有 tag push 才会走 release 段
- npm 发布靠 OIDC trusted publishing，无长期令牌；workflow 会先 `npm install -g npm@latest`
- 历史版本号格式：`0.1.x`；commit 惯例 `chore: bump to X.Y.Z (...)`，功能提交用 conventional commits（`feat/fix/docs`）

## 🔐 安全不变量（硬约束，改动时不得破坏）

- **Secret 默认不导出**：`includeSecrets` 缺省 false；凭据值（token/password/密钥）**绝不**写入同步文件、日志或回传浏览器
- **凭据不可回读**：`ctx.credentials` 永不回读值（DSH 硬约束），只经 `HostContext.fs` 文件级读取 `.credentials.yaml`；`encryption.ts` 只做字节级加解密
- **日志全程脱敏**：`redactValue` 掩码 `=`/`:`/JSON 形态的敏感值；导出/导入全链路日志不泄 secret
- **ZIP 视为不可信输入**：zip bomb 条目数上限、checksum 校验、Zip Slip（`../` 与绝对路径）拒绝——`src/security/zip-security.ts`
- **导入前强制快照**（可回滚）、Dry Run 零写入、冲突不默认覆盖
- **加密备份**：密码仅内存传入、`secrets.enc`（DSC1）与整体容器（DCA1，AES-256-GCM 外层加密整个备份 ZIP）的密码不落盘/不落日志；解密出的明文 ZIP 为临时文件用完即清，磁盘不残留明文备份
- 同步凭据走 DSH credentials 槽位引用（`SYNC_CREDENTIAL_REF` 等），`passwordConfigured` 只是布尔标记

## 🏗️ 架构心智（改代码前先定位）

- 双面插件：**host 半**（`src/index.ts`，Cordis 入口 `name='config-manager'`，挂 `/api/dsh-config-manager/*` 路由）+ **web 半**（`src/client/`，React，`settings.section` 挂载，经 api 调 host）
- `src/core/` 与 DSH 运行时**解耦**：`ConfigAdapter`/`HostContext` 接口 + 内存 mock，可独立测试——**新功能优先加进 core，适配器/UI 只做薄壳**
- 12 个 adapter：`settings/ui/providers/plugins/mcp/prompts/skills/agentPresets/workspaces/credentials/pluginFiles/sessions`（`src/adapters/`）
- 同步体系：`SyncEngine` + `GitTransport`/`WebDavTransport` + `AutoSyncScheduler`（事件驱动：远端有新快照才拉、本地有改动才推）+ `sync-selection`（分区选择持久化，自动同步与手动推送共用）
- **import 一律带 `.ts` 后缀**（Deno-style，全仓统一，勿写成无后缀）
- 设计决策有上游文档：`docs/sync-auto-sync-design.md`、`docs/sync-redesign-spec.md`、`docs/design/` —— 改同步/安全相关功能先读，**设计文档是上游依据，实现规格在下游**

## 🧪 开发命令与测试

```bash
npm install --legacy-peer-deps   # 必须带 --legacy-peer-deps：部分 DSH 核心包只在 peerDependencies 且未发布公共 registry
npm run typecheck                # tsc --noEmit
npm run build                    # tsc（host 半 lib/）+ tsdown（client bundle lib/client.js）
npm test                         # node --test src/**/*.test.ts tests/**/*.test.ts（700+ 测试，零额外依赖）
npm run smoke                    # 仅核心引擎冒烟
```

- 测试用 `node:test` + `node:assert`（零依赖），测试文件与被测文件同名 `*.test.ts` 同目录
- 新功能必须带测试：加密/同步/安全类改动尤其——`src/security/security.test.ts`、`src/sync/sync-engine.test.ts` 等是现有覆盖样板

## 📌 常见坑（改动前记得）

- **pnpm 发布年龄策略**：`@latest` 装到旧版 ≠ 缓存问题，是 pnpm 11 `minimumReleaseAge`（发布不足 30 天的新版本被排除）；解决：精确版本装一次自动白名单，或在 `pnpm-workspace.yaml` 设 `minimumReleaseAge: 0`
- **MemFs 测试路径**：内存 fs 的 key 必须与宿主 path 解耦（POSIX 的 `path.resolve` 对 win32 home 会注入 cwd）
- **Windows LF→CRLF 警告**：git 提示 "LF will be replaced by CRLF" 为无害噪音，勿惊慌
- **根目录勿提交**：`lib/`、`dist/`、`node_modules/`、`outputs/`、`my-video/`、`.vibeskills/`、`.agent-teams/` 均已 gitignore
- `dist/` 目录需先创建再 `npm pack --pack-destination ./dist`（fresh checkout 上否则 ENOENT）

## ⛔ 技术限制（不要试图突破）

凭据值无法回滚（DSH 不回读值）、插件安装需重启、MCP 无管理 API（组合 patch 行导入）、浏览器 localStorage UI 状态不迁移、Schema 迁移 v1→v2 为占位（CURRENT=1）、历史会话默认不迁移、加密备份密码丢失无法解密（设计使然）。完整清单见 DEVELOPERS.md §「完整技术限制」。