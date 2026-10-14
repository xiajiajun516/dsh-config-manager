# 仓库参考（概览 / 结构 / 命令 / 验证）—— 下移自 AGENTS.md

> **不是规则**：本文件是 2026-10-14 从 `AGENTS.md` 下移的**参考材料**（用途与技术栈、目录结构、常用命令、本机环境注意、UI 自查清单）。
> 下移原因：AGENTS.md 每个会话都进模型上下文、受 workspace instruction 预算限制（超限时模型只能看到被截断的尾巴 → `.github/workflows/ci.yml` 的 budget guard 注释）。
> **规则与指针在 `AGENTS.md`**；新增内容若属「说明 / 清单 / 流程 / 示例」而不是「必须 / 绝不 + 判据」，一律进本目录（`README.md` 索引）。

## 用途与技术栈（下移自 AGENTS.md §📦 概览）

- 用途：DSH 配置的备份/导出/导入/迁移/远程同步/配置市场，双面 Cordis 插件。
- 技术栈：TS 5.9（strict + `verbatimModuleSyntax` + `noUncheckedIndexedAccess`）、Node≥22、React 18 + CSS Modules、`node:test` 零依赖、tsdown + lightningcss。
- 样式：唯一 CSS Modules 表 `src/client/config-manager.module.css`；颜色/字体/阴影走 DSH `--dsw-*`；默认不引入第二套视觉体系（→ `DESIGN.md §6`）。

## 目录结构（下移自 AGENTS.md §🗂️ 结构与分层）

```
src/cli/      离线 CLI（`dcm`）：snapshots/restore/reinstall/verify/backup/import/sessions/web；actions.ts=动作层 · help.ts=文案单一事实源 · web/=救急台
src/index.ts  host 入口（apply() 装配 + 保留的 7 条路由）· src/routes/ kit.endpoint() 围栏 + 按域组文件（10 组）
src/core/     引擎（exporter/importer/restore/rollback/rollback-point/run-registry/plugin-cli），与 DSH 解耦（ConfigAdapter/HostContext + 内存 mock）
src/foreign/  外部 agent 配置 → bundle v1（30 来源；会话转码经 IR；凭据值绝不进包）
src/schema/   类型/Manifest/版本 · src/security/ 安全内核 · src/migrations/ 迁移链
src/adapters/ 13 适配器（settings/ui/providers/plugins/mcp/prompts/skills/agentPresets/agentInstructions/workspaces/credentialsStatus/pluginFiles/self；includeSessions 时 +sessions）
src/sync/     SyncEngine + Git/WebDavTransport + AutoSyncScheduler + sync-selection · src/market/ 市场读写
src/profiles/ 档案（shared 零依赖 / manager / launcher / runtime 心跳 / process-control / io【宿主专用，走 node:fs】）
src/utils/    paths/zip/hashing/json/logger/atomic-write/env-lock/recursive-walk/guards/git-quote
src/ui/       框架无关 UI 逻辑（纯函数，node 可测） ← 业务逻辑必须在此 · src/client/ React 壳 ← 只做装配
tests/        node --test 集成测试 · docs/（design/spec/seo/handoff/lessons）· .dsh/skills/
```

## 常用命令（下移自 AGENTS.md §🧪 命令）

```bash
npm install --legacy-peer-deps   # 必须带：部分 DSH 核心只在 peerDependencies
npm run typecheck                # tsc --noEmit（根 config，只覆盖 src/**）
npm run typecheck:tests          # tsc -p tsconfig.tests.json（把 tests/** 一起纳入；CI 已接）
npm run build                    # tsc(host lib/) + tsdown(client lib/client.js)
npm test                         # node --test src/**/*.test.ts tests/**/*.test.ts
npm run smoke                    # 仅 core 冒烟
npm run bundle                   # 仅重建 client bundle
```
- 无 lint/format 脚本，只以 typecheck 兜底（历史 `eslint-disable` 是遗留）。
- CSS Modules 由 tsdown+lightningcss 编译为内联注入，单文件 `lib/client.js` 自带样式（硬规则「新增样式只能在 `config-manager.module.css`」在 AGENTS.md §🎨）。

## 本机环境注意（下移自 AGENTS.md §✅ Verification）

- `npm run build` 需先把 `TEMP`/`TMP` 指向工作区内（`.tmp/buildtmp`）否则 dts 阶段 `Access is denied` 致 build=1。
- `npm test` 必须用系统 TEMP（`foreign/qoder.test.ts` 用 `os.tmpdir()`）。

## UI 自查清单（下移自 AGENTS.md §✅ Verification）

- DESIGN.md 一致(token/组件/spacing/radius/状态语义)、响应式、Hover/Focus/Disabled/Loading/Empty/Error 齐全、Dark Mode 无 hardcode、未建重复组件、新样式进 css+DESIGN.md、新文案进 locale(zh/en)、敏感字段未落 storage/日志/回显。
