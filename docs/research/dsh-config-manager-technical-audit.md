# DSH Config Manager 专项技术审计与升级方案

- 审计对象：`dsh-config-manager` v0.2.4（`D:\Projects\personal\dsh-config-manager`，分支 `main`，审计期间 HEAD `c671c98`）
- 审计方式：**只读源码审计**。未修改业务源码、`package.json`、lockfile、测试、数据库或用户配置；未执行真实 import/export/sync/restore；未执行 publish/push。
- 审计时间：2026-11-01
- 证据口径：所有结论标注 `文件:行`（仓库相对路径）。事实（代码可验证）/ 推断（需运行时验证）/ 建议（本报告提出）三类分开；无法验证一律写 **UNKNOWN**（§17.5）。
- 团队分工：Lead（基线 / 架构 / 核心链路 / 备份恢复 / 导入导出 / 回滚）、安全专项、同步专项、适配器·Profile·UI/CLI 专项、竞品源码专项。

> 阅读顺序建议：先看 §1 与 §13 差距矩阵；关注某域再看对应专项章（§5-§11）；要动手看 §14-§15（架构判定与排期）；要评估风险看 §16；要复核证据看 §20。

---

> **目录**：1 Executive Summary · 2 Project Baseline · 3 Existing Architecture · 4 Core Execution Flow · 5 Backup & Recovery · 6 Import & Export · 7 Sync · 8 Security · 9 Agent Adapter & Migration · 10 Profile & Workspace · 11 UI & CLI · 12 Competitor Source Analysis · 13 Architecture Gap Matrix · 14 Recommended Architecture · 15 Roadmap · 16 Compatibility & Migration Risks · 17 Testing Strategy · 18 Deferred Improvements · 19 Final Recommendations · 20 Source References

## 1. Executive Summary

### 1.1 一句话结论

**单机数据安全底座已经过硬，短板全在「出口」「闭环」「边界」这三件小事上。** 快照原子发布、逐动作 WAL、崩溃后可证续跑、ZIP 读侧硬化、凭据零回读——这五样就本轮读到的五个竞品源码而言没有一个仓库同时具备（未逐仓跑测）。但：**恢复链路的可撤销性只做后端不留出口**（写了反悔副本，界面零引用，还会被 prune 连带删除）、**导入的失败语义在四个调用点有两种缺省**、**跨 Agent 资产模型靠适配器各自为政且版本轴没有区间语义**。

### 1.2 已验证的能力（事实，非 README 声明）

| 能力 | 结论 | 关键证据 |
|---|---|---|
| 快照「durable + verified」发布 | FULL | `src/core/backup.ts:631` `FileSnapshotStore`；`finalizeSnapshot` 写 snapshot.json（READY 前为 CREATING）→ manifest（blobHashes+metadataHash）→ 从磁盘重读 `verifySnapshot` → 原子发布 READY → prune |
| 恢复逐动作 WAL | FULL | `src/core/restore-wal.ts:105` `createRestoreWal` 首写前 preRegister 全部动盘动作；续跑分支绝不重新 preRegister（`src/core/restore.ts:920-930`）|
| 崩溃后续跑判定 | FULL（fail-closed）| `src/core/restore-resume.ts:106` `judgeRestoreResume`；三入口只续自己的 operationType（`:38` `RESTORE_RESUME_OPERATION_TYPES`）|
| ZIP 读侧硬化 | FULL | `src/utils/zip.ts:41-47` 五道上限；`parseZip`（`:465`）拒 `../`/绝对路径/盘符/UNC/NUL、重复条目名、`S_IFLNK` 条目；`readEntry` 逐条 CRC32+尺寸+累计预算+压缩比 |
| 路径写穿防护（恢复）| FULL | `src/core/restore.ts:304` `createTargetSafetyChecker` + `:357` `assertPlanTargetsSafe`（`realpathSync.native` + `path.relative` + win32 折大小写），计划期整单拒绝、零写入 |
| 并发互斥 | FULL | `src/routes/snapshots.ts:69` restore 走 `runWithMutationLock` + `runs.register('restore')`；`src/sync/backup-scheduler.ts:266` 手动/自动备份同样过锁 |
| 凭据零回读 | FULL | `src/core/rollback.ts:63-70` credential `existed=true` 直接判不可补偿；凭据值不进 `sections`（`src/adapters/credentials.ts:87` `hasValue: false`），导出密码是独立密文凭据载荷（`src/core/backup.ts:402`）；`includeSecrets` 缺省 false（`src/core/backup.ts` 导出选项）|
| 启动期事务对账 | FULL（fail-closed）| `src/core/reconcile.ts:547` `inspectStartup` 内部 `:561` 调 `reconcileActive`；`src/core/startup-barrier.ts:44`、`src/index.ts:3984`（inspectStartup 抛错不默认 NORMAL）|
| Bundle 格式向后兼容留口 | FULL | `src/schema/manifest.ts:33` `buildManifest` 可选写 `sourceHome`/`foreign`；`:79-113` `validateForeignOrigin` 对未知/畸形 `foreign` **只告警不拒包** |

### 1.3 已验证的问题（决策切片，完整 58 条见 §13）

| ID | 问题 | 优先级 |
|---|---|---|
| SEC-01 | 导入包可改写同步目标：`self` 分区把 `sync/*.json` 当普通配置裸写，token 是独立槽位且不看 host 是否变过 ⇒ 下一轮同步把已存凭据发往包内 host | **P0** |
| BK-01 | 恢复的反悔副本（pre-restore）在生产代码里没有任何出口：`report.preRestoreDir` 生成后 `grep preRestoreDir src/client src/ui` 零命中 | P1 |
| BK-05 | `prune` 会销毁唯一的撤销材料：反悔副本写在快照目录内（`src/core/restore.ts:888`），整目录 `rm -rf`（`src/core/backup.ts:769`），`pinned` 只保护快照本身（`:758`）| P1 |
| IE-01 | 分区载荷版本要求「恰好相等」（`src/schema/versions.ts:69`）⇒ 任一分区结构升级即旧包全废 | P1 |
| IE-02 | `rollbackOnError` 缺省值四个调用点不一致：引擎 false / HTTP 路由 false / UI 向导 true / 同步通道 true（`src/sync/sync-engine.ts:1973`、`:2106`）⇒ 非 UI 调用方默认落进「半套导入」| P1 |
| SYN-01 | 同步状态形状损坏后没有自愈：`loadSyncState`（`src/sync/sync-state.ts:179`）抛 `sync.state.notObject` 后，全仓没有修复路径 ⇒ 只能手删 `sync-state.json`（连带丢 deviceId/ancestor 指针）| P2 |
| BK-02 | 选择性子集恢复缺失：只读 `/snapshots/file-diff`（`src/routes/snapshots.ts:293`）已能逐文件定位差异，但 `planRestore`/`RestoreOptions` 只能整快照 | P2 |
| BK-03 | 快照无跨快照内容去重：同内容 blob 按快照各存一份（对比回滚点域已用内容寻址载荷）| P2 |
| IE-05 | CLI 无「应用 bundle」命令（`src/cli/help.ts` 全表无此命令）⇒ 无头环境只能生成包、不能落地 | P2 |
| DOC-01 | 文档漂移：`docs/modules/architecture.md:15/19/42/44/50` 写 82 条路由与 `PLUGIN_VERSION '0.1.85'`，实测 83 条与 `'0.2.4'` | P3 |

（§13 给出全部 58 条的字段级规范：模块 / 当前实现 / 问题 / 证据 / 竞品参考 / 影响 / 建议 / 优先级 / 复杂度 / 兼容性风险。）

### 1.4 三条最该先做的事

1. **SEC-01：切断「导入包 → 改写同步目标 → 把 token 发出去」这条链**（P0，唯一 P0）。它不是理论漏洞：`self` 分区把同步配置当普通配置裸写，token 在独立槽位、不看 host 是否变过。改动面小（4 个文件），不做就是凭据外泄。
2. **BK-01 + BK-05：给「撤销这次恢复」一个出口，并停止销毁它**（P1）。反悔副本已经在写、已经在报告里返回，缺的只是暴露与一键复用；而 `prune` 会把它当快照目录内容一起删掉。改动面 = 一条只读路由 + 一条恢复计划来源 + prune 的排除规则，**不需要动恢复引擎**。
3. **IE-01：把分区载荷版本从「恰好相等」改成区间语义**（P1）。`isSupportedSectionDataVersion`（`src/schema/versions.ts:78-80`）要求分区 `dataVersion` 恰好等于注册表声明值 ⇒ 任何单个分区的结构升级都会让所有旧包整体不可导，而这是「bundle 能否当跨 Agent 内部标准」的硬前提。修复只改判定、不改 ZIP 结构与 manifest，兼容风险 Low。

> 三条横跨三个域、各自只需改 1-2 个文件，可并行、互不阻塞。结构性建议（先抽 Adapter Contract、后谈 Migration Engine）不是「先做项」，见 §14.4。

### 1.5 明确不做的事

- 不引入 Git Merge / diff3 / CRDT / 分布式同步协议（§7 结论：三方合并的基线纪律是对的，问题在通道能力差异与条件写，不在算法；§18 D1）。
- 不重写 Bundle 容器与加密容器格式（§6 结论：`manifest.foreign` 的可选扩展面已够用，改格式收益远小于兼容成本；§16.4）。
- 不建「统一 Asset Model」与通用 Storage Provider（§14.4：现有 `SectionId` + `ConfigAdapter` 已表达语义，新建模型要同步改快照/同步/迁移/UI 四处）。
- 不为「支持 Agent 数量」增加适配器（§9 结论：数量不是护城河，矩阵里的 PARTIAL 才是真实工作量）。
- 不做 UI 视觉重设计（任务边界；`DESIGN.md` 是唯一权威）。

## 2. Project Baseline

### 2.1 基本信息（实测）

| 项 | 值 | 证据 |
|---|---|---|
| 版本 | `0.2.4` | `package.json` `version`；`src/index.ts:183` `PLUGIN_VERSION = '0.2.4'` |
| Node 要求 | `^22.19.0 \|\| >=24.0.0` | `package.json` `engines` |
| 模块体系 | ESM（`"type": "module"`），`import` 一律带 `.ts` 后缀 | `package.json`；`AGENTS.md` |
| 包管理器 | npm 为主（`package-lock.json`），`pnpm-lock.yaml` 同时被跟踪 | 仓库根 |
| 构建 | `tsc -p tsconfig.build.json && tsdown` → 产物在 `lib/` | `package.json` `scripts.build` |
| 类型检查 | `tsc --noEmit`（源码） + `tsc -p tsconfig.tests.json`（测试） | `package.json` |
| 测试 | `node --test "src/**/*.test.ts" "tests/**/*.test.ts"`（`node:test` + `node:assert`，零测试框架依赖） | `package.json` |
| 无 lint/format | 有意的取舍，typecheck 兜底 | `AGENTS.md`「验证顺序」 |
| 运行时依赖 | 仅 `js-yaml ^5.4.1` | `package.json` `dependencies` |
| peer 依赖 | `@deepseek-ai/dsh-*` 一系列 + `react`/`react-dom`，全部 optional | `package.json` `peerDependencies(meta)` |
| 可执行 | `dsh-config-manager` 与 `dcm` → `./lib/cli/index.js` | `package.json` `bin` |
| 插件形态 | 双面包：`dsh.bundle.patch = ./cordis.patch.yml`，`client.platform = web` | `package.json` `dsh` 段 |
| 导出面 | `.` / `./core` / `./schema` / `./client` / `./locale/*.json` | `package.json` `exports` |

### 2.2 代码规模（实测）

| 维度 | 数值 |
|---|---|
| `src/` 下 `.ts/.tsx` | 867 |
| 同目录 `*.test.ts` | 367 |
| `tests/` 下 `*.test.ts` | 94 |
| `adapters/` | 45 |
| `client/` | 197 |
| `core/` | 149 |
| `foreign/` | 120 |
| `sync/` | 96 |
| `ui/` | 89 |
| `utils/` | 54 |
| `routes/` | 24 |
| `market/` | 24 |
| `cli/` | 24 |
| `security/` | 16 |
| `profiles/` | 12 |
| `schema/` | 11 |
| `migrations/` | 3 |

**巨型文件（`wc -l`）**：`src/core/rollback-point.ts` 5980、`src/core/rollback-ledger.ts` 1462、`src/core/analyzer.ts` 1500、`src/core/types.ts` 1310、`src/core/restore.ts` 1172、`src/core/messages.ts` 1055、`src/core/backup.ts` 888、`src/core/plugin-cli.ts` 823、`src/core/boot-rescue.ts` 794、`src/core/journal.ts` 730、`src/core/phase3-host.ts` 680、`src/core/reconcile.ts` 581、`src/core/rollback-undo-journal.ts` 571、`src/core/migration-consult.ts` 550、`src/core/exporter.ts` 543。

> 读法：单文件超 1k 行的有 6 个，其中 `rollback-point.ts` 近 6k 行是最大的维护风险点（已有 tech-debt #6 登记，仅加棘轮未拆分）。这不是性能问题，是改动成本与审查成本问题——见 §13 的对应用条目与 §14 的分层建议。

### 2.3 文档与治理基线

| 载体 | 作用 | 现状 |
|---|---|---|
| `AGENTS.md` | 全仓硬判据（预算 ≤28 KiB） | 存在且被维护；含安全不变量、路由计数、验证顺序 |
| `DESIGN.md` | UI/样式唯一权威 | 存在 |
| `DEVELOPERS.md` | 机制细则、发版阶段表 | 存在 |
| `docs/index.md` | 文档总索引，只收 `docs/{spec,modules,maintenance,decisions,components}` | 由 `scripts/check-doc-paths.mjs` 与 `scripts/doc-index-coverage.mjs` 校验 |
| `docs/spec/` | 对外契约 | `bundle-format-v1.md` 1347 行、`compat-matrix.md` 382、`headless-consumption.md` 313、`sync-channel-v1.md` 262、`market-index-v1.md` 247 |
| `docs/maintenance/` | 已知限制/技术债 | `known-gaps.md` 330、`known-limits.md` 81、`tech-debt.md` 68 |
| `docs/modules/` | 架构与模块说明 | `architecture.md` 111、`recovery.md` 190、`backup-restore.md` 171、`sync.md` 163、`foreign-import.md` 115 |
| `docs/research/` | **本报告新增目录** | 审计前不存在；不在 `docs/index.md` 收录范围（故不触发收录校验），但报告内引用的路径全部真实存在 |

**治理缺陷（P3）**：`docs/modules/architecture.md` 的三处计数已漂移——:15「声明 82 条 HTTP 路由」、:42/:44「82（7 + 75）」、:50「82」，:19 写 `PLUGIN_VERSION` 为 `'0.1.85'`；而 `tests/route/route-parity.test.ts` 与 `tests/route/route-fence.test.ts` 钉的是 **83 条**（实测 12 项全绿），版本真值是 `'0.2.4'`。次要文档缺 CI 校验，属「散文计数漂移」（tech-debt #21 已登记，未覆盖这份文档）。

### 2.4 工作区状态声明

审计开始时 `git status` 存在**他人/在途改动**（`D .codex-plugin/plugin.json`、`D .codexignore`、`D .dsh-rollback-ignore`、`M src/sync/git/git-transport.ts`、`M src/utils/git-fast-forward.ts`，对应 issue #122 方向的工作）。本次审计**未触碰**这些文件，也未执行整树提交。

---

## 3. Existing Architecture

### 3.1 双面插件形态

- **Host 面**：`src/index.ts`，Cordis 插件 `name = 'config-manager'`，`inject: ['settings', 'credentials']`，统一前缀 `/api/dsh-config-manager/*`。
- **Web 面**：`src/client/`（React），挂 `settings.section`，全部数据经 HTTP 回 host。
- **契约面**：`src/schema/`（零运行时依赖）跨两端共享；`src/profiles/dsh-profile-io.ts` 明确禁止被浏览器半 import（`AGENTS.md`「架构与路由」）。

这条边界是硬约束且有源码守卫：`tests/architecture-boundaries.test.ts` 维护 `KNOWN_VIOLATIONS`（5 条白名单），`src/client/bundle-selfcontained.test.ts` + `src/utils/bundle-scan.ts` 保证 client bundle 不出现 `require("node:*")`（实测事故：一旦漏进去，DSH loader 报 missed the module table，整个插件不加载）。

### 3.2 路由层：唯一声明入口 + 围栏

- 声明唯一入口：`src/routes/kit.ts` 的 `endpoint({ path, methods }, handler)`，统一做三件事：loopback 围栏（非本机 → 403）、方法白名单（405）、顶层 try/catch。
- `registerRoutes()` 对**未经 kit 的裸路由注册直接抛错**（结构性强制，不靠 review）。
- 路由总数 **83**：`src/index.ts` 7 条 + `src/routes/*.ts` 76 条（14 个组文件，`src/routes/index.ts:25-41` 装配，`buildRoutes(env)`）。`tests/route/route-parity.test.ts` 与 `route-fence.test.ts` 双钉（实测 12 项全绿）。
- **认证边界的真实语义**（易被误读，必须在报告里说清）：**围栏就是本插件的认证边界**，不是 DSH cookie。cookie 拒绝只挂在 `kind:'prefix'`/`path:'/api'` 的 RPC 路由上，且派发时 exact 表先命中 ⇒ 带正确 token 的本机进程可调全部路由。因此「经代理/隧道暴露」时必须在注册点自行加认证，而这在当前实现里是**部署责任而非代码默认**（WebUI 围栏已挡住远程/LAN/CSRF，但没有身份概念）。

### 3.3 分层与依赖方向

```
client → ui → core → utils / security / schema
              routes → core / adapters / security / sync
              adapters → core / security / utils
              sync → core / utils / security / adapters
              security → node:crypto / utils
              schema → （零运行时依赖）
```

- 业务逻辑放 `src/ui/`（不塞 React 壳），新功能优先 `src/core/`，适配器与 UI 做薄壳。
- DI 走 Cordis fiber：client 经 `ctx.slots.inject('settings.section')`；host 可选服务一律 `ctx.get()`（**绝不用 `ctx.<svc>`**——历史事故：未声明 inject 时属性访问抛错会让宿主启动崩溃）。

### 3.4 分区：单一事实源 + 编译期穷举

分区是整套数据的组织轴，共 **17 个 SectionId**：
`settings, ui, providers, plugins, mcp, prompts, skills, agentPresets, agentInstructions, workspaces, pluginFiles, credentialsStatus, secrets, sessions, self, pluginData, pluginAssets`（`src/schema/section-registry.ts`，每条含 `payload/zipPath/dataVersion/applyOrder/portability/syncOptIn/defaultIncluded/riskTier/configSnapshot`）。

**新增一个分区的真实成本**（注册表自己的注释 + 实测，非推测）：1 处类型登记 + **4 个生产强制点**（`SECTION_REGISTRY` 的 `Record<SectionId, SectionMeta>`、`core/backup.ts` 的 `const unhandled: never = target.adapter` 穷尽 switch、`client/common/section-labels.ts` 的 i18n 标签表、`ui/export-flow.ts` 的 `CATEGORY_DESCRIPTIONS`）+ 4 处测试夹具 + 1 个 adapter 实现。这是**编译期穷举换来的安全**：漏一处 tsc 直接报错，不会出现「某分区被静默按另一分区语义处理」。

> 但也正因如此，`section-registry.ts` 的注释自己记录了一个真实案例：`core/backup.ts` 的 `engineSnapshotEntry` default 分支会把未知分区静默记成 `settingsNamespace` ⇒ 该分区写入无法回滚。这是"分区语义散布在多处"的代价，§14 会给出收敛建议。

### 3.5 五条主数据流（文档声明，本报告逐条核实）

| 流 | 入口 | 核心约束 |
|---|---|---|
| 导出 | `POST /export` | 与预览共用 `FileCollectionAdapter.collect()`；明文临时 ZIP `finally` 必删；定时备份恒 `includeSecrets:false` |
| 导入 | `/upload → /decrypt-archive → /analyze → /plan → /execute` | 唯一改数据链路；强制先建快照；失败走 `core/rollback.ts` 补偿 |
| 恢复 | `POST /restore` | dryRun 零写入；`planFingerprint` 不一致 409；首写前落 journal；逐项可证才续跑否则 423 |
| 同步 | `SyncEngine` + Git/WebDAV/S3/Gist | 三方合并用 `state.ancestorId` + 分区 hash 双基线；无祖先不猜 |
| 对话回退 | 回滚点（`turn/start` 留点） | 两态（工作区 + 会话）；回退 = fork + 归档，不是就地截断 |

---

## 4. Core Execution Flow

> 每张流程图都对应实际源码调用，不是按函数名推断。

### 4.1 Export：采集 → ZIP → （可选）加密

```
POST /export  (src/index.ts:3375)
  └─ Exporter.export()                       src/core/exporter.ts:127
       ├─ adapter.collect()  ×N 分区         （与 preview 同一实现；FileCollectionAdapter）
       │    ├─ buildSectionFlags()           src/core/exporter.ts:526
       │    ├─ looksBinary()/BINARY_SNIFF_BYTES=4096   :125
       │    └─ 扫描预算：1MB/文件、16MB/分区、5 条告警/分区
       ├─ buildManifest()                    src/schema/manifest.ts:35（可选 sourceHome / foreign）
       ├─ buildChecksums() → checksums.txt   src/security/integrity.ts:37（上限 10_000 条，拒 __proto__/constructor/prototype）
       ├─ secrets.enc（独立密文凭据载荷，不进 sections）
       └─ 明文 ZIP 临时文件 finally 必删；定时备份恒 includeSecrets:false
```

**关键事实**：预览与导出共用 `collect()`（口径一致，避免"看到的和导出的不一样"）；凭据块不是分区，是独立加密载荷（`includeSecrets` 缺省 false）。

### 4.2 Import：分析 → 计划 → 执行 → 补偿

```
POST /upload → /decrypt-archive → /analyze → /plan → /execute   (src/routes/import.ts)
  └─ Importer.executeImportPlan()            src/core/importer.ts:96-109（门面，110 行）
       └─ Analyzer.executeImportPlan()       src/core/analyzer.ts（1500 行）
            ① 强制先建快照（snapshotBinding 写入 plan/journal）
            ② 每计划项一个 AbortController（可单项跳过）
            ③ applyOne() → 记 journal step（ok→done+afterFp / skipped→skipped / 其余→attention）  :1057-1077
            ④ adapter.finalizeApply（每分区） → adapter.finalizeImport（全写入后，按 APPLY_ORDER）  :1085-1145
               收尾抛错只降级为 warning，不升级为整体失败
            ⑤ 失败策略：rollbackOnError && anyFailed → break → rollbackApplied(...'failed')       :1216
               用户取消：cancelDecision='rollback' 复用同一补偿路径（:1150）
                        'keep'  把未执行项改 skipped + 跑 bootSafetyAudit（:1180-1210），快照不标 done
```

**补偿引擎能力边界**（`src/core/rollback.ts`，156 行，`rollback()` :124 / `compensateOne()` :28）：
按 `SnapshotEntry.kind` 分派 `settingsNamespace | credential | patchLine | file | workspaceRecord`，逆序执行、逐项 try/catch、单点失败不中断，结果只报 `full | partial`。

**三类不可自动补偿（如实报 failed + manualHint，不是 bug 而是 DSH 约束）**：

1. `credential` 且 `existed=true`（:63-70）—— 凭据值不可回读；
2. `settingsNamespace` 且 `existed=false`（:44-52）—— DSH settings 没有删除语义；
3. 未知 `kind` → `rollback.unknownEntry`。

### 4.3 Restore：计划 → 校验 → 逐动作 WAL → 执行

```
POST /restore  (src/routes/snapshots.ts:69)
  ├─ dryRun=true  → planRestore() + summarizeRestoreChanges() + restorePlanFingerprint()  （零写入）
  └─ dryRun=false
       ├─ probeRestoreResume()   （锁前只读探测，用于决定能否放过 SAFE MODE 门）
       └─ runWithMutationLock(op:'restore')
            ├─ runs.register('restore')   （同 kind running → 409）
            └─ restore()                  src/core/restore.ts:884
                 ├─ planRestore()（读快照 + validateSnapshotForRestore:493 + assertPlanTargetsSafe:357）
                 ├─ createRestoreWal()    src/core/restore-wal.ts:105（首写前 preRegister 全部动盘动作）
                 ├─ 逐动作：copyToPreRestore(:419/:962/974/982) → atomicCopyFile/删除 → WAL settle
                 ├─ 单项失败：catch 只 push failed + settleStatus=attention，继续后续动作（`:1022-1029`）
                 └─ 末尾 sweepRestoredSessions()（:1072，只报告幽灵会话，不自动清理）
```

**快照校验强度**（`validateSnapshotForRestore` `:493`）：`isValidSnapshotId` → snapshot.json/manifest symlink 检查（`assertNoSnapshotSymlink` `:468`，含 snapshotDir 自身与 blobs 目录 junction）→ blobs 子项 symlink 拒绝 → legacy 无 manifest 判 `LEGACY_REQUIRES_CONFIRMATION` → `verifySnapshot` → 环境指纹 → provenance 三档（`TRUSTED_OPERATION_SNAPSHOT` / `TRUSTED_MANUAL_LOCAL` / `LEGACY_REQUIRES_CONFIRMATION`）。**绝不把不可证明当 trusted**。

**崩溃恢复链**（这是本项目最强的一环，值得保留）：

```
启动 → inspectStartup()            src/core/reconcile.ts:547
         └─ reconcileActive()      :561（内部调用；处理 ACTIVE journal）
             ├─ LOCKED 且 heartbeat fresh → 视为 live，跳过 reconcile/move/quarantine
             └─ 非 live → 逐 step 指纹判定 → decision（needs-attention / quarantine / resume）
     ↓ 由 src/core/phase3-host.ts:257 与 src/core/startup-barrier.ts:44 消费
     ↓ 失败时 fail-closed：src/index.ts:3984（inspectStartup 抛错不默认 NORMAL，destructive 路由被阻断）
恢复续跑 → judgeRestoreResume()    src/core/restore-resume.ts:106
           条件：同快照 + 盘面只等于 beforeFp/afterFp + 不跨入口 + 不重建 WAL，否则 423
```

### 4.4 Backup：快照创建 → 原子发布 → 修剪

```
createSnapshot()                    src/core/backup.ts:465
  ├─ 只覆盖 plan 将要写入的目标（collectTargets）
  ├─ adapter.snapshot 优先，引擎兜底
  ├─ 文件类条目字节延后按需读（lazyBlobSources）；宿主整文件即时读
  ├─ snapshotBinding = { operationId, operationType, environmentFingerprint, ownerInstanceId }
  └─ FileSnapshotStore.finalizeSnapshot()   src/core/backup.ts:631
       ① 写 <id>/snapshot.json（readiness=CREATING）
       ② 写 <id>/manifest.json（blobHashes + computeMetadataHash）
       ③ 从磁盘重读 verifySnapshot()
       ④ 原子发布 readiness=READY
       ⑤ prune()（失败只 onWarn，绝不撤快照）
```

**修剪策略**：`SNAPSHOT_RETENTION_LIMIT = 10`（`:566`）；pinned 豁免、被 journal 引用的 `snapshotId` 豁免；**引用提供者抛错则放弃本轮清理**（不是当空集合）；目录名与内部 id 不一致则跳过并 `onWarn`。

### 4.5 Sync：基线 → 三方合并 → 条件写

（详细审计见 §7；此处只给主干，供流程完整性对照）

```
SyncEngine（src/sync/sync-engine.ts）
  ├─ 基线：state.ancestorId + 分区 hash（无祖先不猜）
  ├─ merge → merged plan（未裁决冲突时 lastSnapshotId 与祖先副本保持不动，只写 pendingMerge）
  ├─ apply → 导入执行（rollbackOnError 恒 true，:1973/:2106）
  └─ 基线取自"实际落地的本地导出"（重新 export 已应用分区），而非计划/远端载荷
```

### 4.6 Migration：外部 Agent → 标准 bundle

```
dcm import --from <source>           src/cli/import-source.ts
  └─ src/foreign/{read-*}（31 个 read-* 模块）→ 归一化为 session-ir / 分区载荷
       └─ 产出标准 bundle ZIP（读侧统一交给 GUI 的 Importer）
```

**真实缺口**：CLI 只做「外部 → bundle」的翻译，**没有「应用 bundle」命令**（`src/cli/help.ts` 命令表全表核对：`web / snapshots / verify / sessions / backup / import / restore / sessions repair / recover-stale-lock / reinstall / help`）。⇒ 无头环境无法完成迁移的最后一公里。

### 4.7 Security：凭据与加密在两端的边界

（详细见 §8）主干：`secrets` 分区不进 `sections`；加密包 `secrets.enc` 是独立密文凭据载荷；凭据值**永不回读/落盘/落日志/回传浏览器**；`redactValue` 在日志侧掩码，UI 侧 `ErrorBanner`/`ReportView` 渲染前再过 `redact()`；容器形态判定只有一份实现（`src/security/container-kind.ts`，前 4 字节）；未解锁一律 400 `encrypted-container`。

## 5. Backup & Recovery Audit

### 5.1 快照机制（事实）

| 维度 | 实现 | 证据 |
|---|---|---|
| 存储布局 | `<dir>/<id>/snapshot.json` + `manifest.json` + `blobs/*` | `src/core/backup.ts:631` `FileSnapshotStore` |
| 写入 | `writeBlob` 用 `target.startsWith(dir)` 前缀判定 + `atomicWriteFile` + 同遍 `sha256` | `src/core/backup.ts` `writeBlob` |
| 发布顺序 | CREATING → manifest(blobHashes + metadataHash) → **从磁盘重读** `verifySnapshot` → 原子 READY → prune | `finalizeSnapshot` |
| 双通道 | `save()`（内存聚合）与 `saveStreaming()`（能力探测，任一时刻只驻留一条 blob） | `src/core/backup.ts` |
| 捕获范围 | 只覆盖 plan 将要写入的目标（`collectTargets`），不是整目录盲拷 | `createSnapshot` `:465` |
| 绑定信息 | `operationId / operationType / environmentFingerprint / ownerInstanceId` | `snapshotBinding` |
| 保留 | `SNAPSHOT_RETENTION_LIMIT = 10`（:566）；pinned 豁免；journal 引用豁免；引用提供者抛错 ⇒ 放弃本轮清理；目录名与内部 id 不一致 ⇒ 跳过 + `onWarn` | `prune()` |

**为什么要强调「从磁盘重读再发布 READY」**：这是把「写成功」与「可读回且校验通过」分开，避免出现"metadata 说成功、字节其实写坏"的快照。这条不变量是本项目最值得保留的设计之一。

### 5.2 六个核心问题的答案

**Q1 是否可以恢复单个文件而不影响同目录其他文件？**
→ **引擎层面可以，产品层面不行**。`planRestore` 生成的是**逐动作**列表（`RestoreActionKind` = `hostFileRestore | hostFileRemove | pluginRemove | fileRestore | fileRemove | credentialHint | skip`，`src/core/restore.ts:48-56`），执行也是逐动作 `atomicCopyFile`，单个文件互不牵连。但 `RestoreOptions`（:104-158）**没有任何"只恢复部分路径"的入参**，唯一入口按整快照生成动作。
→ 结论：能力已具备、入口缺失 → **BK-02（P2）**。廉价实现：只读的 `/snapshots/file-diff`（`src/routes/snapshots.ts:293`）已经能逐文件列出差异，缺的只是把选中子集作为过滤条件传给 `planRestore`。

**Q2 是否能够防止恢复过程中断导致数据损坏？**
→ **能，且是全项目最强的一环**。三重机制叠加：
1. 每个落盘动作走 `atomicCopyFile`（临时文件 + fsync + rename，`src/utils/atomic-write.ts:304`），**不存在半写文件**；
2. 首写前 `createRestoreWal` 把**全部**动盘动作 preRegister（planned + `beforeFp`），逐项 settle（done/attention + `afterFp`，删除类用 `ABSENT_FINGERPRINT`，定义在 `src/core/journal.ts:101`、由 `src/core/restore-wal.ts:66` 使用）；
3. 崩溃后再点恢复，`judgeRestoreResume`（`src/core/restore-resume.ts:106`）只在「同快照 + 盘面只等于 beforeFp/afterFp + 不跨入口 + 不重建 WAL」四条同时成立时放行续跑，否则 **423 `transaction-recovery-required`**；续跑分支**绝不重新 preRegister**（`src/core/restore.ts:920-930`）。
→ 注意区分：这是**逐项可证的续跑**，不是整笔事务。中间态（部分 done、部分 planned）是允许存在的，但它是**可判定的**，不是"未知的半截状态"。

**Q3 是否存在快照与实际文件不一致的情况？**
→ 存在两种真实不一致，都有检测手段：
- **创建后文件又变了**：执行时用 `planFingerprint` 比对（dryRun 下发、执行时带回），不一致 → **409 `plan-changed`**；
- **环境变了**（DSH 版本/档案）：`environmentFingerprint` + `currentDshVersion`（`src/routes/snapshots.ts:90` 注入宿主权威版本）→ 只产生可见告警，不阻断恢复。
→ 未发现"快照声称包含但实际没捕获"的路径：`createSnapshot` 按 plan 目标收集，"存在但读不出"在文件类分区是显式失败而非静默跳过（`AGENTS.md`「会话 / 导入导出 / 外部来源」第 1 条）。

**Q4 是否有足够信息判断快照是否完整？**
→ 够。三层证据：`manifest.blobHashes`（逐 blob）、`computeMetadataHash`（元数据整体）、`readiness` 状态机（CREATING/READY）；校验不信任内存，`finalizeSnapshot` 是**从磁盘重读**后 `verifySnapshot`。恢复侧再独立跑一次 `verifySnapshot`（`validateSnapshotForRestore` `:493`）。
→ 补充：**没有跨快照的内容级校验**（例如"这 10 个快照里哪些 blob 完全相同"），也没有快照索引文件，列出快照需要逐目录读 `snapshot.json`。规模到几百个快照时会变慢（未实测，标 **UNKNOWN**）。

**Q5 是否可以安全地撤销一次恢复？**
→ **后端有数据、没有出口**。每次执行的覆盖/删除前都会 `copyToPreRestore` 到 `<snapshotId>/pre-restore/<yyyyMMdd-HHmmss-SSS>/`（`src/core/restore.ts:172, 388-419, 962-986`），报告里通过 `report.preRestoreDir` 返回。
→ 但 `grep preRestoreDir src/client src/ui` **零命中**：UI 不展示、没有"撤销这次恢复"动作、CLI 也没有对应命令，用户只能去磁盘上人工翻目录再手工拷回。
→ 这是本次审计**最典型的"做了 90% 却没闭环"**：**BK-01（P1）**。最小闭环 = ① 报告/快照列表暴露 attempt 目录；② 把 attempt 目录登记成只读快照或直接作为 `restore` 的替代源（`pre-restore` 目录结构就是 home 相对路径树，不需要格式转换）。

**Q6 是否存在不必要的重复存储？**
→ 存在。blob 落在**每个** `<id>/blobs/` 下，同内容跨快照重复存一份；而同一仓库的回滚点域（`src/core/rollback-point.ts`）已经用**内容寻址载荷**。两套存储策略并存。
→ **BK-03（P2）**：收益是磁盘（尤其 sessions 分区，会话日志大且大量未变），成本是快照格式变更 + `verifySnapshot` 与 prune 的引用计数逻辑。建议先做**只读测量**（统计同 sha256 的重复字节占比）再决定是否值得，不要先写实现。

### 5.3 恢复失败处理与可逆性（事实汇总）

| 场景 | 实际行为 | 证据 | 评价 |
|---|---|---|---|
| 单动作失败 | catch → `report.failed` + `settleStatus=attention`，**继续后续动作** | `src/core/restore.ts:1022-1029`（`:1025` settleStatus）| 与 tech-debt #4 一致：无整笔回滚 |
| 计划期路径不安全 | `assertPlanTargetsSafe` 整单拒绝（realpath + relative + win32 折大小写） | `:304/:357` | 正确，零写入 |
| 快照被篡改（snapshot.json 写 `../`） | `blobAbs` 拒绝 | `:244` | 正确 |
| symlink 快照 | `assertNoSnapshotSymlink` 含 snapshotDir 自身与 blobs junction | `:468` | 正确 |
| legacy 无 manifest | `LEGACY_REQUIRES_CONFIRMATION`，需显式确认 | `validateSnapshotForRestore` | 正确（诚实分级） |
| 插件卸载失败 | 记 attention，不中断 | restore 主循环 | 可接受（DSH 需重启） |
| 幽灵会话（恢复了文件但目录未登记） | `sweepRestoredSessions` 只报告不自动清理 | `:1072` | 有意保守 |
| SAFE MODE 激活时恢复 | 被锁门挡住（423）；唯一例外 = 探针证明可续跑 | `src/routes/snapshots.ts` 锁内再判 | 正确（fail-closed + 有限放行） |

### 5.4 备份域结论

- **必须保留**：`FileSnapshotStore` 的"写→重读→校验→发布"顺序、逐动作 WAL、`judgeRestoreResume` 的四条判据、`assertPlanTargetsSafe` 的 realpath 围栏、provenance 三档分级。这五样任何一项被"简化"，都会把可判定状态变成不可判定状态。
- **需要补**：反悔副本的出口（BK-01）与「不再被 prune 连带销毁」（BK-05）、选择性子集恢复（BK-02）。
- **值得量化再决定**：跨快照去重（BK-03）、快照索引（避免逐目录读）。

---

## 6. Import & Export Audit

### 6.1 Bundle 格式的稳定性判断（核心问题）

**结论：现有 bundle 格式足以承担"跨 Agent 资产交换的内部标准"，不建议改格式；扩展应走 `manifest.foreign` + 适配器。**

证据链：

1. **版本轴极简且有意的**：`CURRENT_SCHEMA_VERSION = 1`、`MIN_SUPPORTED_SCHEMA_VERSION = 1`（`src/schema/versions.ts:18/:21`）；`needsMigration`（`:44`）在 v1 下恒 false。
2. **格式自带扩展位**：`buildManifest`（`src/schema/manifest.ts:35`）可选写 `sourceHome` 与 `foreign`；`validateForeignOrigin`（`:81-101`）对 `manifest.foreign` **只产 warning、绝不拒包**——旧包无此键可继续导入，新包畸形值也不阻断。这是「加元数据而不破兼容」的现成证据。
3. **完整性独立于格式**：`checksums.txt` + `verifyChecksums`（`src/security/integrity.ts:78`），解析侧带原型污染防护（`DANGEROUS_KEYS`，`:27`），条目上限 10_000（`:24`）。
4. **凭据不进 sections**：`secrets` 是独立的加密凭据载荷。

**但有一个真实的演进障碍（IE-01，P1 前瞻）**：`isSupportedSectionDataVersion`（`src/schema/versions.ts:78-80`）要求分区 `dataVersion` **恰好等于**注册表声明值（known-gaps G-05 已登记「部分修复」）。含义是：**任何单个分区（例如 `sessions` 或 `pluginFiles`）的载荷结构升级，都会让所有旧包整体不可导**，因为版本判定没有「向上兼容一个区间」的余地。这与全局 schema 版本轴（当前恒 1、迁移链从未被真实数据走过）形成了不对称：全局轴有迁移机制但用不上，分区轴需要迁移却没有机制。

**最小合理改进**（不改格式、只改判定）：分区版本从"等于"改为"落在 `minSupported..current` 区间"，并在读取侧对**新增的可选字段**做缺省填充；破坏性变更才提升 `minSupported`。这一步不需要改 ZIP 结构，也不需要动 `manifest`，兼容风险 Low。

### 6.2 导入链路审计

| 环节 | 实现 | 评价 |
|---|---|---|
| 上传 | `POST /api/dsh-config-manager/upload` | loopback 围栏 |
| 解密 | `/decrypt-archive` | 容器形态判定唯一实现（`src/security/container-kind.ts`，前 4 字节） |
| 分析 | `/analyze` → `Analyzer` | 生成 plan，检测冲突与凭据需求 |
| 计划 | `/plan` | 只读预览（Dry Run 零写入是硬约束） |
| 执行 | `/execute` | 唯一改数据链路；强制先建快照 |
| 补偿 | `src/core/rollback.ts` | 见 4.2；三类不可补偿如实上报 |

**IE-02（P1）细节——`rollbackOnError` 四个调用点缺省值不一致**：

| 入口 | 默认值 | 证据 |
|---|---|---|
| 引擎 `Importer.executeImportPlan` | `false` | `src/core/importer.ts:45`（注释明写"默认 false：单项失败如实记录并继续"） |
| HTTP 路由 `/execute` | `opts['rollbackOnError'] === true` ⇒ 不传 = `false` | `src/routes/import.ts:255` |
| UI 向导 | `true`（文案 "失败时整体回滚（推荐）"） | `src/ui/import-wizard.ts:285` |
| 同步通道 | 恒 `true` | `src/sync/sync-engine.ts:1973, 2106` |

风险场景：脚本、第三方集成、未来的 model tool 只要不显式传参，就会拿到**与产品推荐相反的**"半套导入"，而且失败后返回的是 `partial` 报告——调用方很可能不去读报告，直接把半应用状态当成功。修复方向二选一（**不要两处都改**，否则又造出第四种口径）：把引擎默认改为 `true`（与 UI 一致），或把路由改为"未显式传即 400 拒绝"。推荐后者——默认安全且不改变既有引擎语义。

**导入执行期的正确设计（值得保留）**：
- 每个计划项独立 `AbortController`（可单项跳过，不必整笔放弃）；
- journal step 状态与 `applyOne` 结果严格映射（ok→done+afterFp / skipped→skipped / 其余→attention，`:1057-1077`），只有 `status==='failed'` 计入 `anyFailed`，**warning 不算失败**（这条区分避免了"告警导致整笔回滚"的误伤）；
- 两阶段收尾 `finalizeApply`（每分区）→ `finalizeImport`（按 `APPLY_ORDER`，处理"会话登记进工作区"这类跨分区依赖，`:1085-1145`），且收尾抛错只降级为 warning——这是正确的取舍：收尾失败不该让学生整笔数据回滚；
- 用户取消分两种语义（rollback 复用补偿路径 / keep 保持可手动回滚），且 `keep` 分支会把快照**故意不标 done**。

### 6.3 ZIP 读侧安全（事实）

`src/utils/zip.ts`（557 行）默认即最严：

| 限制 | 值 | 位置 |
|---|---|---|
| 条目数 | 10_000 | `:41-47` `DEFAULT_ZIP_SAFETY_LIMITS` |
| 解压总量 | 500 MiB | 同上 |
| 压缩总量 | 200 MiB | 同上 |
| 单条目 | 100 MiB | 同上 |
| 压缩比 | 200 | 同上 |

`parseZip`（`:465`）拒绝：EOCD/中央目录越界、条目数超限、`isPathSafe` 不通过（`../`、绝对路径、盘符、UNC、NUL）、**重复条目名**、**`S_IFLNK` symlink 条目**、本地文件头越界。`readEntryAsync`（`:390`）逐条 CRC32 + 尺寸 + 累计预算 + 压缩比。

**两个新发现的小瑕疵**：

- **IE-06（P3）**：`accept()` 把 `out.length` 累加到**实例级** `totalUncompressed`（`:439`）。同一归档内重复读取同一条目会**重复计入**，可能把"多次读取"误判成"超总量"。这是假阳性（DoS 自己的分析流程），不是安全问题。
- **SEC-11（P3）**：`safeExtract`（`src/utils/zip.ts:538`）与 `safeExtractHardened`（`src/security/zip-security.ts:72`）**全仓无调用方**（只有导出）。`safeExtract` 文件头宣称"任何越界/损坏即整体拒绝（不部分落盘）"，但 CRC/比例校验发生在 `readEntry` 的逐条惰性阶段 ⇒ 中途失败会留下已写出的部分文件，与声明不符。生产导入路径走**内存解析、不落盘**，故不影响现网；但这是一颗"未来有人调它就会中"的雷。

### 6.4 导出链路

- 预览与导出共用 `FileCollectionAdapter.collect()`（口径一致）；
- 扫描预算：`FILE_SECTION_SCAN_MAX_BYTES = 1MB`、`FILE_SECTION_SCAN_TOTAL_BUDGET_BYTES = 16MB`、`MAX_FILE_SECTION_WARNINGS_PER_SECTION = 5`、`BINARY_SNIFF_BYTES = 4096`（`src/core/exporter.ts:125` `looksBinary`）；
- 明文临时 ZIP `finally` 必删；定时备份恒 `includeSecrets: false`；
- **离线 CLI 是第二套收集器**：`collectBackupEntries`（`src/core/backup-plan.ts:289`）+ `OFFLINE_EXCLUDED_SECTIONS = ['pluginData','pluginAssets']`（`:81`）+ 敏感文件名/扩展名过滤（`SENSITIVE_FILE_BASENAMES` `:107`、`isSensitiveFileName` `:120`）+ 自检 `verifyBackupZip`（`src/core/backup-verify.ts:140`，verdict `OK|MISSING|CORRUPT|UNSUPPORTED|VERIFY_ERROR`）。
→ 这是**有意的取舍**（离线无 `HostContext`，无法走 adapter），代价是两套枚举需要同步维护：**新增分区必须同时改两处**，否则 CLI 备份会静默漏掉该分区。属真实维护成本，建议在分区注册表里标注"是否可离线收集"，由守卫测试钉住（见 §13 AUD 条目）。

## 7. Sync Audit

范围：`src/sync/**`（96 个 .ts / 33 282 行）+ `src/routes/sync.ts`（24 个端点）+ `src/index.ts` 的 `makeSyncEngine`/scheduler 接线 + 契约 `src/sync/transport.ts`。lead 对四条关键判断做了独立复核（标注「复核」）。

### 7.1 结论速览

1. **三方合并是真的，但真的不是任务书假设的那种**：base 不是 `lastSnapshotId`，而是**本地祖先副本** `state.ancestorId`（`src/sync/sync-state.ts:17`、`:216` 的 v2→v3 迁移 `ancestorId ?? lastSnapshotId`；`src/sync/sync-engine.ts:1500` 附近 → `tryLoadAncestor` → :1552 `mergeSections(local, remote, ancestor)`）。祖先缺失/解不开 → **降级为两方**并把整分区判 `conflict reason=no-ancestor`（`src/sync/merge.ts:350`）。⇒「能三方」与「有基线」两件事耦合在本机磁盘上，祖先副本被 prune 或丢失即降级；界面上有 `merge.noAncestor` 告警（`src/client/sync/MergePreviewView.tsx:105`），自动同步路径不展示。
2. **合并决策是闭集，没有「猜」**：`mergeSectionTriple`（`merge.ts:289`）对形状不合、形态互换、仅单侧存在、双侧改等分支逐个短路；双侧都改时文件走字节三方（`mergeFilesSectionGranular` :217 → `mergeBytesThreeWay`），JSON 走行级三方（`mergeJsonValues` :378）。1 MiB 以上、纯二进制、无共同祖先一律如实报 reason（`src/sync/text-merge.ts:20`），不伪装成功。
3. **数据安全面的真短板是墓碑与 blob GC，不是条件写**（条件写已相当到位）：墓碑只在本机累积、生成侧从不与远端 `manifest.deletedSessions` 求并集（`sync-engine.ts:1109-1138`、:959）⇒ 换设备后旧快照可复活已删会话；webdav/s3 的 GC 引用集只来自 `index.json`，引用者 `404` 被当成「无引用」（`webdav-transport.ts:676`、`s3-transport.ts:719-720`）⇒ 删在用的 blob 且不可恢复。
4. **缺省行为会覆盖远端**：`conflictPolicy` 缺省 `'local'`（`src/sync/autosync-config.ts:56-63`，类型只有 `'ask'|'local'`）⇒ 有冲突时 Phase C 用 `force=true` 推（`autosync-scheduler.ts:731`），跳过 `remoteAdvancedCheck`，把本机版本推成远端最新（远端值只留在历史快照）。
5. **`sync-state.json` 是原子写的，但形状损坏后没有自愈**（复核纠偏）：`saveSyncState` 的 `fsx` 缺省 `createSnapshotFs()`（`sync-state.ts:258`），而 `src/sync/fs.ts:35` 就是 `await atomicWriteFile(p, data)`，生产唯一构造点 `src/index.ts:2968` 也不传 `fsx` ⇒ **不存在半截 JSON**。真实残留是 `loadSyncState`（`:179`）在形状不对时抛 `sync.state.notObject` 且全仓无修复路径：用户只能手删状态文件（连带丢 deviceId/ancestor 指针）。

### 7.2 base / local / remote 三要素的实际定义

| 要素 | 本项目定义 | 存储 | 证据 |
| --- | --- | --- | --- |
| base | 上次**成功落地**那一轮的明文（或密文）分区副本 | `dataDir/sync/snapshots/<id>`（`localSnapshotsDir`，`src/index.ts:2974` + `:3834` `syncDir`）| `src/sync/ancestor.ts`（`writeAncestor`/`tryLoadAncestor`/`pruneAncestors`，`:132`）、`sync-state.ts:17` |
| local | 当轮 `adapter.export()` 的结果，且与 push **同口径**（sections 过滤 + secret 剥离） | 内存 | `sync-engine.ts:1477-1560`、`portableAdapters()` |
| remote | `transport.download(targetId)` → `prepareSnapshot`（解密）→ `stripTombstonedSessions` | 内存 | `sync-engine.ts:1448-1452`、:688 |

判据是**分区哈希**（`hashSection`：文件类按 `relativePath` 排序后拼 `"path\0"+sha256(data)`；JSON 走 `canonicalJson`），不是快照 id，也不是 mtime。这解释了为什么"仅两侧 hash 相等"就能推 `skip`（`merge.ts:340`）。

### 7.3 任务书列的十种场景 —— 逐条实际行为

| # | 场景 | 实际行为 | 判定 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 仅本地修改 | `remote==ancestor` → `keepLocal`，写回本机并推进基线；文件级逐路径取本地 | 正确 | `merge.ts:358`、:217-286 |
| 2 | 仅远端修改 | `local==ancestor` → `useRemote` | 正确 | `merge.ts:357` |
| 3 | 双方修改 | JSON 行级三方成功→`merge`；文件字节三方成功→并入且 `mergePoints+1`；失败如实记 `both-modified`/`binary`/`too-large` | 正确 | `merge.ts:378`、:251-261、`text-merge.ts:19` |
| 4 | 本地删除（分区） | 远端未改 → `skip`（尊重删除）；**远端改过 → `useRemote`，分区整体复活且无提示** | 部分正确 | `merge.ts:332-341` |
| 5 | 本地删除（单文件） | 远端字节==祖先 → 跟随删除；远端改过 → `conflict(delete-modify)` | 正确 | `merge.ts:276-281` |
| 6 | 远端删除（分区） | 本地未改 → `skip`；本地改过 → `conflict` | 正确 | `merge.ts:314-330` |
| 7 | 远端删除（单文件） | 对称 `modify-delete` 冲突 | 正确 | `merge.ts:269-274`（:273）|
| 8 | 双方新增 | 整分区两侧都新（祖先无该分区）→ `conflict('no-ancestor')`，先于逐项比较 | 正确（保守） | `merge.ts:350` |
| 9 | 重命名 | **未建模**：A 机 `a→b`、B 机 `a→c` ⇒ `a` 双侧缺失跟随删除，`b`/`c` 各判"纯新增" ⇒ **两份副本并存、零冲突** | 缺口 | `merge.ts:271-273`、:332；`merge.test.ts` 无 rename 用例（grep 零命中） |
| 10 | 文件类型改变（file→dir） | `FilesSection` 无类型元数据（只有 `relativePath + data`）⇒ 等价"删该文件 + 新增若干"，按 #5/#8 处理，不崩不提示 | 缺口（低危） | `src/adapters/file-collection.ts:426`、collect 侧 :247-257 |
| 11 | 冲突解决后再次同步 | 全部裁决 → 推进基线 + 删 `pendingMerge`；仍有未决 → `preserveAncestor:true` + 写 `pendingMerge`（下一轮已裁决分区 `local==remote` → `skip`） | 正确 | `sync-engine.ts:1680-1729`、`sync-engine.test.ts:2607/2646` |
| 12 | 同步中崩溃 | `upload` 成功后崩溃 → 远端已推进、基线未动 → 下次 push 恒被 `remoteAdvancedCheck` 拦成 `sync.pushRemoteAdvanced`（零写入），**无续跑入口**；apply 阶段崩溃有本地 journal 可续 | 部分（协议层无 journal） | `sync-engine.ts:975`、:982、:1220-1233；`src/core/journal.ts` |

额外一条任务书没列但用户会遇到的：**"远端删了整个分区"选 `useRemote` 永不收敛**（`sync-engine.ts:1655-1660` 直接进 `pendingConflicts`，:1608 注释自认"导入计划表达不了删除"）⇒ 基线不推进，下一轮同一冲突再来，只有改选 `keepLocal` 才能脱身（SYN-09）。

### 7.4 四通道能力真值（契约层没有能力声明）

| 通道 | 条件写 | blob 外置 | 并发失败判定 | 证据 |
| --- | --- | --- | --- | --- |
| webdav | 真 `If-Match` / `If-None-Match` | 支持 | 412 → `concurrentWrite` 中止；无 ETag 时退化无条件写但不判失败 | `webdav-transport.ts:94`、:415-417、:481-483 |
| s3 | `if-match` | 支持 | 409 仅在确实带条件头时算冲突 | `s3-transport.ts:66`、:72-74、:301-307 |
| git | 否（靠非快进拒绝） | 支持 | push 非快进即拒 | `git-transport.ts:504` |
| gist | 否（`PATCH` 不带任何条件头） | **刻意不支持**（G-34） | 写后复核 + ≤3 轮重做，仍失败抛 `index-conflict` | `gist-transport.ts:57`、:267、:291-296、:421-422、:528-529 |

`SyncTransport` 契约（`src/sync/transport.ts:123-140`）只有 `list/upload/download/delete/probe?`，**没有任何能力字段**（`supportsConditionalWrite`/`blobExternalize`/`maxPayloadBytes` 都不存在）⇒ 文档里的通道能力矩阵无处可被代码校验，只能靠人记。同时 `isPreconditionFailedStatus`（`transport.ts:117-121`）**全仓零调用者**，两条 HTTP 通道各写自己的判定（SYN-12）。

### 7.5 墓碑与 GC：本次同步域唯一触及"数据可能消失"的地方

- **墓碑生成侧不跨设备传播**：`computeSessionBookkeeping()` 只吃本机 `state.sessionUnits/deletedSessions`（`sync-engine.ts:1109-1138`），从不与远端 `manifest.deletedSessions` 求并集。远端墓碑**是有读取方的**（`:1146` 读 `snapshot.manifest.deletedSessions`，pull/preview/merge 在 `:1253`/`:1318`/`:1450`/`:1496` 使用），缺的是「生成侧把远端墓碑并入本机」。⇒ 设备 B 从没见过删除历史，推上去的快照 `deletedSessions` 为空，A 的墓碑链在最新快照上断裂，任何一端按最新快照拉取都能复活已删会话。
- **GC 引用集只来自索引、404 视为无引用**：两个通道的「索引缺失 + 远端有过内容 ⇒ 零写入抛 protocol」已 fail-closed（`webdav-transport.ts:415-417`、`s3-transport.ts:301-307`），因此只剩两种形态：① upload 两步之间失败留下孤儿快照，其 blob 不在引用集 → 被删；② 引用者 GET **假 404**（`webdav-transport.ts:676`）→ 同一 blob 被删。**结果不可恢复**（快照文件在，读回即 `sync.blobMissing`）。git 通道反而安全（`git-transport.ts:1340-1357` 枚举目录）。

必须如实写一条**台账纠偏**：G-35 里"upload 侧仍待 t66"已过时 —— `webdav-transport.ts:377-394` 与 `s3-transport.ts:277-287` 的三态（`indexMissing && remoteHasPriorContent → 零写入抛 protocol`）已经落地，注释显式标注 t66。条目主体（GC 两形态）仍成立，但描述需要更新。

### 7.6 缺省策略与状态文件

- **缺省覆盖远端**：`DEFAULT_AUTOSYNC_CONFLICT_POLICY = local`（`src/sync/autosync-config.ts:67`），类型刻意不提供 `remote`（注释理由：走 `applyMergeResolutions` 会绕过风险分级，audit-sync sync-F5）。副作用是 `force=true` 推（`autosync-scheduler.ts:731`）跳过 `remoteAdvancedCheck`。这与「索引条件写绝不覆盖别人」的直觉直接冲突 —— 同一个产品里两个方向的默认值不同。
- **`firstSync` 安全档从未接线**（复核：`autosync-scheduler.ts:678`、:954、`sync-engine.ts:1578` 全是 `firstSync: false`；`firstSync: true` 只出现在 `risk.test.ts`）⇒ `risk.ts:11` 注释承诺的"首次同步全部进 review"在生产路径上不存在。
- **`pendingMerge` 的清理不完整**（复核纠偏）：`writeMergeBaseline` 在 `pending === undefined` 时确实会删掉 `state.pendingMerge`（`sync-engine.ts:1702`/`:1704` 清、`:1852-1853` 覆盖），所以「只写不读」不成立；残留问题是 **push（`:982-991`）与一键同步 `applyItems`（`:2152-2159`）都不清该字段** ⇒ 走这两条路径留下的陈旧记录永不清除，而 `:1723` 注释承诺的界面提示仍然不存在（`src/routes/**`、`src/ui/**`、`src/client/**` grep 零命中）。

### 7.7 问题表

| ID | 模块 | 当前实现 | 问题 | 证据 | 竞品参考 | 影响 | 建议 | 优先级 | 复杂度 | 兼容风险 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SYN-01 | sync/state | `saveSyncState` 原子写；`loadSyncState` 形状不对即抛 | 状态文件不可解析后无自愈路径 | `src/sync/sync-state.ts:171-232`（:179 抛 `sync.state.notObject`）、:258；`src/sync/fs.ts:35` | dsh-backup-sync baseline 落盘 | 一次外部损坏 = 同步永久不可用，清理即丢 deviceId/ancestor 指针 | 坏形状时备份改名 + 重建空状态（保留 deviceId），并给只读诊断 | P2 | S | Low |
| SYN-02 | sync/tombstone | 墓碑只吃本机 state | 不跨设备传播，旧快照复活已删会话 | `sync-engine.ts:1109-1143`、:959、:988-990；`sync-state.ts:81` | undo-savepoint 的全局 blob 台账（§12） | 隐私/正确性：删除无法在多设备间生效 | `computeSessionBookkeeping` 入参加 `remoteTombstones`（来自远端 manifest，去重后减去本机现存），并把合并数进 warnings | P1 | M | Low |
| SYN-04 | sync/webdav,s3 | 引用集只来自索引，引用者 404 当无引用（索引缺失已 fail-closed）| 假 404 / 孤儿快照会让在用 blob 被删，不可恢复 | `webdav-transport.ts:676`；`s3-transport.ts:719-720`；`:488` | undo-savepoint 的 `pruneOrphanBlobs`（先写 manifest 再 GC，§12） | 快照不可读（`sync.blobMissing`），G-35 已登记 | 404 也放弃本轮 GC（现在是「忽略该引用」）；中期补列举原语（PROPFIND/ListObjectsV2） | P1 | S / XL | Low |
| SYN-05 | sync/autosync | 缺省 `conflictPolicy='local'` + `force` 推 | 缺省覆盖远端最新 | `autosync-config.ts:56-63`；`autosync-scheduler.ts:731-739`；`sync-engine.ts:877` | dsh-cloud-sync 的 2-way 语义（§12，反而更差） | 远端最新改动只在历史快照可见 | 首轮或远端有新快照时强制 `ask`；历史记录标 `forced=true` | P1 | M | Medium |
| SYN-06 | sync/engine | 无协议层 journal | upload 后崩溃只能靠拦截 | `sync-engine.ts:975`→:982、:1220-1233 | — | 用户看到"远端已推进"但无续跑/确认入口 | push 前写 `inflight{snapshotId,startedAt}`，成功后清；命中时提示"上次可能已完成" | P2 | M | Low |
| SYN-07 | sync/engine | `writeMergeBaseline` 会清 `pendingMerge`，push 与 applyItems 不清 | 注释承诺的界面不存在；两条路径留下陈旧记录 | 写/清 `sync-engine.ts:1683/:1702/:1743/:1852-1853`；读仅 `sync-state.ts:222`；push `:982-991`、applyItems `:2152-2159` 不清 | — | 文档/注释与实现对不上 | 要么接线（status 暴露 + 同步页提示），要么删字段并撤承诺；两条路径补清理 | P2 | S | Low |
| SYN-08 | sync/merge | 只按 `relativePath` 比较 | 无 rename 语义 → 两份副本零冲突 | `merge.ts:271-273`、:332；`merge.test.ts` 无 rename 用例 | dsh-backup-sync 同样无（§12） | 用户看到"多一份"不知哪份新 | `mergeFilesSectionGranular` 加"同内容异路径"检测（祖先路径消失 + 另一侧新路径字节==祖先 → 判 rename），先补测试 | P2 | L | Medium |
| SYN-09 | sync/engine | `useRemote` + 远端缺分区 → `pendingConflicts` | 该组合永不可解，基线不推进 | `sync-engine.ts:1655-1660`、:1608 注释 | — | 用户只能改选 `keepLocal` 才能脱身 | 裁决层把该组合降级为"整分区删除"计划项（需 adapter 支持删除），或 UI 禁用该组合并说明 | P2 | M | Medium |
| SYN-10 | adapters/self | 载荷即"剔除运行态后"的字节，apply 直写 | 应用远端 `self` 会清掉本机 `lastRun*`/`consecutiveFailures` | `src/adapters/self.ts:221`、:91-100、:80 注释；`file-collection.ts:247-257`、:426 | — | 自动同步间隔门控与失败计数归零（可能立刻多跑一轮、丢告警） | 二选一：导出保留完整字节只在 hash 前剔除；或 apply 对调度配置做"保留本机运行态键"的合并写 | P2 | M | Medium |
| SYN-11 | sync/engine | `catch { continue }` | 导出失败被当成"没变化" | `sync-engine.ts:1414-1425` | — | 读不出的分区改动静默不上行 | 收集 failures，非空即返回"有变化"+告警码 | P2 | S | Low |
| SYN-12 | sync/transport | 条件写判定三处各写；`isPreconditionFailedStatus` 零调用者 | 契约无能力声明，口径易漏 | `transport.ts:117-121`；`s3-transport.ts:72-74`；webdav 内联 412 | — | 新增通道靠人记 | 收进 `isConcurrentWrite(status, sentConditional)` 唯一实现；`SyncTransport` 增只读 `capabilities` 并由一致性测试钉住 | P3 | S | Low |
| SYN-13 | sync/risk | `firstSync` 参数存在但生产恒 false | 首轮无额外保护（注释/文档承诺不存在） | `risk.ts:11`、:56、:104-107；`autosync-scheduler.ts:678`、:954；`sync-engine.ts:1578` | — | 安全档位形同虚设 | 实现"基线为空 ⇒ 全进 review"，或删分支与注释 | P3 | S | Low |
| SYN-14 | sync/merge | `advanceRemoteId` 只改 `lastSnapshotId/lastSyncAt` | 本地删分区 + 远端未改 → 后续恒判"有本地改动" | `merge.ts:332`；`sync-engine.ts:1680-1691`、:1744-1747 | — | 多一轮无谓上行/自动同步触发（自愈） | 推进基线时同步重算受影响分区 hash 或清除该分区记录 | P3 | S | Low |
| SYN-15 | sync/git | GC 的 push 未带 `requirePushToken` | 只读权限 token 走 GC 时错误分类不同 | `git-transport.ts:1364` vs :504、:573 | — | 错误提示误导 | 与 upload/delete 对齐 | P3 | S | Low |

计数：**P0 = 0**、P1 = 3（SYN-02/04/05）、P2 = 7（SYN-01/06/07/08/09/10/11）、P3 = 4（SYN-12…15），合计 14 条。

关于"为什么同步域没有 P0"：本次逐条追了"数据会不会消失"的四条路径（覆盖写、删远端、GC、墓碑），只有 SYN-04 能让文件不可读，但它需要"孤儿快照 + 索引残留"或"假 404"的低概率组合，且台账已登记、代码里已有 fail-closed 的最小修法 ⇒ 记 P1 而不是 P0。**不把"没有 git merge 级别的一致性"当问题**：本项目的三态 + 闭集决策 + 落地后重导出记基线（`exportAppliedSections` → `null` 则不推进基线，`sync-engine.ts:1998-2016`）已经在正确方向上，缺的是协议层 journal 与墓碑传播，不是替换合并算法。

### 7.8 UNKNOWN（未验证，不写成缺陷）

1. 旧版插件读新版 `blobRefs` 快照的实际降级行为（G-19）：旧实现不在本仓库，无法证实台账所述"降级空分区不崩"。
2. 真实 WebDAV/S3 服务端对 `If-Match`/`If-None-Match` 的支持度与 ETag 稳定性：只有单测，无真机取证；"服务端不给 ETag ⇒ 退化无条件写"的实际发生率未知。
3. WebDAV 服务端是否归并空路径段（`webdav-transport.ts:495-498` 注释称不归并会让 sessions 外置整体不可用）：未真机验证。
4. gist 单文件截断阈值与文件数上限的实际值：代码只在响应 `truncated:true` 时回落 `raw_url`，GitHub 具体阈值未知。
5. 多设备并发写同一索引的端到端行为：412/409 单测覆盖，真机两实例并发未复现；gist 残余窗口命中概率未知。
6. 自动同步与手动操作的跨进程互斥强度：进程内 `runs.register('autosync')`（`autosync-scheduler.ts:483`）+ 环境锁（:512），跨进程真机并发未取证。

### 7.9 测试证据（teammate 实跑，lead 未复跑）

| 批次 | 命令要点 | 结果 |
| --- | --- | --- |
| 合并语义 | `merge / session-tombstones / sync-state / risk / text-merge / blob-store` | exit 0，111 pass（含无共同祖先 `ok=false`、≥1 MiB `too-large`、纯二进制 `binary`、`pendingMerge` 往返） |
| 通道条件写 | `webdav/s3/gist conditional-write` + `gist-overwrite-semantics` + `retention-policy` | exit 0，52 pass（含索引 404 且远端有内容 → 零写入中止） |
| 引擎 | `sync-engine / autosync-scheduler / sync-engine-download-tombstone / sync-device-identity` | exit 0，126 pass（含"未裁决 → 基线不推进 + pendingMerge"、"写回失败 → 整体回滚 + 基线不变"） |

环境：`TEMP/TMP` 指向 `.tmp/testtmp`，全程不触真实远端。未跑全量 `npm test`/`typecheck`/`build`（只读审计范围外）。

## 8. Security Audit

本章结论全部来自源码阅读，并由 lead 对关键链条独立复核（复核点在图注中单独标出）。凡是需要真实导入/同步/恢复才能证实的，一律列在 7.9 的 UNKNOWN，不写成缺陷。

### 8.1 结论速览

1. **静态安全底座是硬的**：AES-256-GCM + scrypt、无 AAD 但由 manifest 逐字比对替代、凭据值结构性不可回读、ZIP 硬化解析（条目上限/总量/压缩比/重复名/symlink/CRC 全部在默认解析器里）、导入前强制快照 + 确认门 + Dry Run 零写入 —— 这些不是文档承诺，是默认代码路径（见 7.2–7.4 的证据表）。
2. **真正的弱点在「包内数据被当作低风险配置」这条链上**：`self` 分区白名单含 `sync/sync-config.json` 与 `sync/sync-autosync.json`（`src/adapters/self.ts:55-65`），而导入写盘在 `FileCollectionAdapter.applyItem` 里是裸 `writeFile`（`src/adapters/file-collection.ts:414-430`，:426），读取侧 `readSyncConfig`/`readSyncConfigFor` 也只解析不校验（`src/sync/sync-config.ts:176`、:299）⇒ 一旦这份文件被替换，git 通道会把 token 注入到**包内指定的 host**（`src/sync/git/git-transport.ts:1224-1246`、`repoHost` :1256-1263）。
3. **URL 校验只到 scheme/userinfo，不看 host**：`validateRepoUrl`（`src/sync/sync-config.ts:438-458`）只对 `/^https?:\/\//i` 才解析，非 http(s) 直接放行；host 侧不拒环回/链路本地/私网 ⇒ 与第 2 条叠加时，"改目标"这一步没有任何一层会拦。
4. **完整性承诺弱于字面表述**：checksum 只做正向校验（表内条目逐个核），反向"表外条目"只 warning（`src/core/analyzer.ts:334-347`），而文件类分区落盘按 `archive.names()` 前缀遍历、不看校验表（`src/core/analyzer.ts:407-413`）⇒ 攻击者可以投放校验表外的文件，这恰好是第 2 条的投送面。

### 8.2 信任边界模型（代码事实，不是叙述）

| 边界 | 本项目的定义 | 决定它的代码 | 后果 |
| --- | --- | --- | --- |
| 浏览器 ↔ 宿主 | loopback + Host 白名单 + `sec-fetch-site` + Origin 同源 | `src/routes/kit.ts:159-179`（Host 判定 :162-170） | 挡 LAN、挡跨站、也挡 DNS rebinding（攻击者域名解析到 127.0.0.1 会因 Host 不在白名单被拒） |
| 本机任意进程 ↔ 宿主 | **无凭据**（无 cookie/token） | `kit.ts:188` 的 `endpoint()` 只做围栏与方法白名单 | 设计取舍，已登记在 `docs/maintenance/known-limits.md:52`；不是漏配，但意味着"本机即可信" |
| 导入包 ↔ 目标机 | 包是不可信输入；写入前必须快照 + 确认 | `src/core/analyzer.ts:895-898`（confirm）、:900-905（加密未解密拒绝）、:921-939（快照+journal 先于首个写） | 这一层成立，问题出在"写什么内容"没有第二次判定 |
| 远端快照 ↔ 本机 | 分区风险分级 + `syncOptIn` + firstSync 强制人工 | `src/sync/risk.ts:60-90`（`classifyMergePlan`）、`tierWithinAutoApply` :72-73 | 分级是类型化必填字段，新增分区漏填直接编译失败（`risk.ts:36-44` 注释） |
| 救急台（`dcm web`）↔ 浏览器 | 一次性 token → HttpOnly+SameSite=Strict cookie → 精确 path 查表 | `src/cli/web/server.ts:84-207`、`routes.ts:277-283`（写路由先 `consumeActionToken`） | 认证确实先于读写；无静态文件服务 ⇒ 零路径穿越面（`server.ts:175-179`） |

一处必须写清楚的实现取向：**"本机即可信"是显式取舍而不是疏漏**。`kit.ts` 的围栏里没有任何凭据校验代码，也没有被注释掉的 token 分支；同时 `known-limits.md:52` 明确登记了"唯一认证边界 = loopback 围栏"。把它报成"缺少认证"是误报；真问题是这个取舍与第 2 条的叠加（本机任意进程能把 sync 目标改成任意 host）。

### 8.3 加密与凭据

| 项 | 实际实现 | 证据 | 判定 |
| --- | --- | --- | --- |
| 凭据密文 | AES-256-GCM，12 B 随机 IV、16 B tag、53 B 头（magic `DSC1` + version + salt + iv + tag） | `src/security/encryption.ts:82-165`、:89-90 | FULL |
| KDF | scrypt N=16384/r=8/p=1/keyLength=32（`SCRYPT_PARAMS`） | `encryption.ts:44`、:26-31 | FULL（参数上界见 SEC-07） |
| AAD | 无 `setAAD` 调用 | 全文件无 | UNSUPPORTED（有意）：头字段由 manifest 逐字比对覆盖（`encryption.ts:139-145`），改参数 → `TAMPERED` |
| 整包密文 | `DCA1`，kdf 参数固定取常量、不采信 manifest | `encryption.ts:194-274`（比对 :251-256） | FULL |
| 认证失败语义 | 篡改 → `TAMPERED`；口令错 → `BAD_PASSWORD`；格式不支持 → `UNSUPPORTED_FORMAT` | `encryption.ts:139-145`、:162-164、:126-133 | FULL |
| 口令强度 | 不做强度校验（注释明确禁止再加闸门） | `encryption.ts:87-88`、:199-200 | UNSUPPORTED（产品决策） |
| 凭据值回读 | `hasValue` 恒 false；sync-config 无 getter | `src/adapters/credentials.ts:98`、`src/sync/sync-config.ts:546-549` | FULL（结构上不可回读） |
| 敏感值形状判定 | 单一来源 `matchSecretValuePattern`，厂商前缀保持大小写敏感、`bearer` 不敏感 | `src/security/secret-scanner.ts:175`、:62-72、:132-133 | FULL（G-36 部分修复仍成立） |
| 脱敏 | `redact`/`redactValue`/`createRedactor`，含 URL userinfo 段 | `src/security/redaction.ts:122`、:139`、:55 | FULL |

**实测（lead 复跑）**：`KDF` 上界收紧问题不构成内存 DoS。`validateKdfParams`（`encryption.ts:63-70`）允许 128·N·r 达 4 GiB，但 `deriveKey`（:73-79）没传 `maxmem`，Node 默认 32 MiB 在 KDF 之前就抛 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`（`N=65536,r=8` 实测抛 `memory limit exceeded`），而 `decryptCredentials:147-152` 把这个异常归成 `BAD_PASSWORD` ⇒ 只算错误码语义问题（SEC-07，P2）。这条**不要**写成内存炸弹。

### 8.4 ZIP 与导入包

读侧 hardening 是默认路径，不是可选开关：

| 防护 | 证据 | 判定 |
| --- | --- | --- |
| 条目数 10 000 / 总量 500 MiB / 单条 100 MiB / 压缩比 200 | `src/utils/zip.ts:41-47`、`accept` :432-446 | FULL |
| EOCD/中央目录越界、本地头越界 | `zip.ts:465-509` | FULL |
| 路径穿越（`..`/绝对/盘符/UNC/NUL） | `zip.ts:503` → `src/utils/paths.ts:33-42` | PARTIAL（Windows 语义缺口见 SEC-06） |
| 重复条目名拒绝 | `zip.ts:506` | FULL |
| symlink 条目拒绝（`S_IFLNK`） | `zip.ts:508` | FULL |
| 逐条 CRC32 + 尺寸校验 | `zip.ts:359-430` | FULL |
| 安全落盘复核（`isSameOrChild` + `lstat isFile` + 异常整树 `rm`） | `src/security/zip-security.ts:86-107` | FULL |

**缺口在"落盘名单"这一层**：`verifyChecksums` 只遍历校验表（`src/utils/hashing.ts:36-38`，注释 :27-28 自认单向），表外条目在 analyzer 里只 warning（`src/core/analyzer.ts:334-347`），而文件类分区写入时按前缀遍历归档名（`analyzer.ts:407-413`）⇒ 表外文件仍会落盘。这条单独看是"完整性承诺打折"，与 7.5 叠加才是攻击面（SEC-05）。

另一处需要如实标注：`src/utils/zip.ts:538` 的 `safeExtract` 与 `src/security/zip-security.ts:72` 的 `safeExtractHardened` 全仓无调用方（只有导出与测试）。`safeExtract` 的文件头宣称"任何越界/损坏即整体拒绝、不部分落盘"，但 CRC/比例校验发生在 `readEntry` 惰性阶段 ⇒ 中途失败会留下已写出的部分文件。生产导入路径走内存解析不落盘，所以**现网不受影响**，但这是"声明与实现不符"的潜伏缺陷（SEC-11，P3）。

### 8.5 凭据外送链条（P0，lead 独立复核）

这条链是本次审计唯一达到 P0 的安全问题，四跳全部有代码证据：

```
 恶意 bundle（可来自任意来源：他人导出、市场条目、备份站下载）
   └─ self/sync/sync-config.json  ── 落在 self 分区白名单内
      src/adapters/self.ts:55-65（:56）
        └─ FileCollectionAdapter.applyItem
           src/adapters/file-collection.ts:414-430（:426 writeFile 裸写，无内容校验）
             └─ 读取侧不校验
                src/sync/sync-config.ts:176（readSyncConfig）、:299（readSyncConfigFor）
                  └─ git 通道把 token 拼进 URL
                     src/sync/git/git-transport.ts:1224-1246（:1233-1237 写 credential 文件）
                     repoHost :1256-1263  ← host 直接取自包内 repoUrl
```

**触发条件必须如实写**（否则读者会把 P0 当成"点开就中"）：
- 冲突页默认策略是 `merge`（`src/ui/import-wizard.ts:260`、:591），未裁决的 Conflict 在 `applyItemResolution` 里保持 `Conflict` 而不写入（`src/core/conflict-decisions.ts:44-45`，:22-42 全分支可读）⇒ **默认不覆盖**成立；
- 但目标机尚无该文件时是 `Add`，会静默落盘；而 `ConflictList.tsx:116-118` 提供一键「全部使用备份配置」（`import.conflicts.useImportedAll`），**一次点击即可把整份同步目标替换成攻击者的**；
- `self` 的 `riskTier` 是 `low`（`src/schema/section-registry.ts:385`），`sync-autosync.json` 也在白名单里（`self.ts:57`），导入后自动同步档位可取缺省 `medium`（`src/sync/autosync-config.ts:53`、:129）⇒ 无需用户再手动开同步。

因此定级为 **P0（凭据外泄风险）**，但在表里写明"需用户点击批量采用或目标文件不存在"。修复成本 M、兼容风险 Medium：`applyItem` 对 `sync/*.json` 复用写路由同一校验（`validateRepoUrl`/`validateWebDavUrl`/`validateCloudEndpoint`，写路径调用点在 `src/index.ts:2267`、:2244`）+ host 策略 + token 与 host 绑定。

**已验证不属于本问题的两件事**（避免顺手误报）：① 包内 `self` 分区不能写内部 control-plane 目录（`isReservedInternalRel` `src/utils/paths.ts:99-106`，保留前缀 :59-72，且注释明确"不得整段保留 `dsh-config-manager/sync/`"）；② 凭据分区本身不可回读（`credentials.ts:98`），包内凭据永远是"缺失待填"。

### 8.6 SSRF 与协议面

| 项 | 实际情况 | 证据 | 判定 |
| --- | --- | --- | --- |
| 同步 URL 校验 | 只拒空白/userinfo/非 http(s) 的解析；host 完全不判 | `src/sync/sync-config.ts:438-458`、:465-486、:720-734、:784-808 | PARTIAL |
| 私网/环回/链路本地 | 无任何拦截（`localhost`、`127.0.0.1`、`169.254.169.254` 全部可用） | 同上 | UNSUPPORTED |
| git 协议白名单 | 无；`runGit` 把 `repoUrl` 原样作参数（数组传参、无 shell） | `src/sync/git/git-transport.ts:1159` | UNSUPPORTED |
| git 参数分隔 | 无 `--` 分隔，以 `-` 开头的 repoUrl 会被 git 当成选项（参数注入面比 `file://` 更宽）| `src/sync/git/git-transport.ts:586`、`:711`；无 `GIT_ALLOW_PROTOCOL`（grep 零命中）| UNSUPPORTED |
| token ↔ host 绑定 | 无；任意 host 都注入 | `git-transport.ts:1233-1237`、:1256-1263 | UNSUPPORTED |

单独使用时，"用户自己填了内网地址"属于用户自选（P1 而非 P0）；但它在 7.5 链条里是"没有任何一层会拦"的最后一环，所以修复建议与 7.5 合并成一次 host 策略改造，而不是两个独立需求。

### 8.7 并发、锁与配置写入

- **恢复/备份互斥是真的**：`/restore` 走 `runWithMutationLock`（`src/routes/snapshots.ts:69`），手动备份在 `BackupScheduler.runOnce` 内过同一把锁（`src/sync/backup-scheduler.ts:266`），锁被占则 `status='skipped'` + `skipReason='mutation-locked'`（:345）。
- **环境锁语义安全**：stale 不自动抢占，probe 失败不伪装死亡（`src/utils/env-lock.ts:14`、:17`、:1002-1038、:1051-1126）。
- **配置类写路由缺少条件写**：全仓 65 处写方法（POST/PUT/DELETE）只有 16 处过 mutation gate（`src/routes/backup.ts:184`/`:268`、`import.ts:179`、`prefs.ts:171`、`profiles.ts:130`/`:156`/`:189`/`:209`、`snapshots.ts:222`/`:266`、`sync.ts:291`/`:422`/`:815`/`:948`/`:1229`/`:1280`），余 49 处配置类写无锁/无条件写；`POST /sync/config`（`src/routes/sync.ts:321`）与 `/sync/selection`（`:1163`）都是无条件整文件写 ⇒ GUI 与 CLI/救急台并发时后写覆盖，且无版本/ETag 保护（SEC-09，P2）。gate 定义见 `src/index.ts:2729-2768`。

### 8.8 问题表

| ID | 模块 | 当前实现 | 问题 | 证据 | 竞品参考 | 影响 | 建议 | 优先级 | 复杂度 | 兼容风险 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SEC-01 | adapters/sync | `self` 白名单含 `sync/sync-config.json`；导入裸写；读取不校验 | 包可改写同步目标，下一轮同步把 token 发往包内 host | `src/adapters/self.ts:55-65`(:56)；`src/adapters/file-collection.ts:414-430`(:426)；`src/sync/sync-config.ts:176`/:299；`src/sync/git/git-transport.ts:1224-1246`；`src/ui/import-wizard.ts:260`（`strategy: merge`）；`src/core/conflict-decisions.ts:44-45` | dsh-backup 的"导入后不触碰传输凭据"取向（见 §12）；DSH-Portable 的"导入先落隔离区再显式提交" | 凭据外泄 + 后续拉取攻击者内容覆盖本机配置 | ① `applyItem` 对 `sync/*.json` 调与写路由同一校验；② host 策略（默认仅 github.com/gist/官方端点，自定义需显式确认并留审计）；③ token 与 host 绑定，host 变化即不注入且告警 | **P0** | M | Medium |
| SEC-02 | sync | URL 校验只看 scheme/userinfo | 环回/私网/链路本地可作同步目标 | `src/sync/sync-config.ts:438-458`、:465-486、:720-734、:784-808 | 无（竞品普遍同样薄） | 与 SEC-01 叠加即成包控 SSRF；单独使用属用户自选 | 并入 SEC-01 的 host 策略，一次改完 | P1 | S | Medium |
| SEC-03 | sync/git | 非 http(s) repoUrl 直接放行；无 `protocol.*` | `file://` 可指本机任意 git 仓 | `src/sync/sync-config.ts:446-456`；`src/sync/git/git-transport.ts:1159` | — | 本地仓库读取面；`ext::` helper 面未拦 | `validateRepoUrl` 改白名单 + git 恒带 `-c protocol.ext.allow=never` 与 `GIT_ALLOW_PROTOCOL` | P1 | S | Low |
| SEC-04 | sync/import | `sync-autosync.json` 在 `self` 白名单；`self` riskTier=low；缺省档 medium | 导入预置自动同步开关/档位（`reload()` 不在 import 路由，故当轮不生效；已开启者下一轮即按包内目标推送）| `src/adapters/self.ts:57`；`src/schema/section-registry.ts:385`；`src/sync/autosync-config.ts:53`、`:124`；`src/sync/autosync-scheduler.ts:672-680`；`src/routes/sync.ts:354` | dsh-backup 的「调度配置不随包迁移」（§12） | 已开启自动同步的用户会被包内目标接管 | 导入把「自动同步开关/档位」列为需人工确认项（或直接跳过） | P2 | S | Medium |
| SEC-05 | analyzer/integrity | checksum 只正向；表外条目仅 warning；文件分区按归档名写入 | 完整性承诺弱于声明，表外文件可落盘 | `src/utils/hashing.ts:36-38`（注释 :27-28）；`src/security/integrity.ts:75-76`；`src/core/analyzer.ts:334-347`、:407-413 | dsh-backup 的"包内条目必须与清单一一对应" | 完整性可被绕过；使 SEC-01 的投送不需要改校验表 | 文件类分区落盘前要求条目在 checksums 表内；`extraEntries` 升为阻断（可按分区配置） | P1 | S | Low |
| SEC-06 | utils/paths | `isPathSafe` 只判 `..`/绝对/盘符/UNC/NUL | Windows ADS（`a.txt:s`）、设备名（CON/NUL/COM1）、尾点尾空格不拦 | `src/utils/paths.ts:33-42`；`src/utils/zip.ts:503` | — | 恶意条目可写 NTFS 备用数据流/异常路径；`lstat` 复核只查 `isFile` | Windows 下追加拒绝 `:`、设备名表、尾点/尾空格 | P2 | S | Low |
| SEC-07 | security/encryption | `validateKdfParams` 上界宽于 `deriveKey` 实际能力（无 `maxmem`） | 越界参数被归成 `BAD_PASSWORD`（实测：Node 默认 maxmem 先拦） | `src/security/encryption.ts:63-70`、:73-79、:147-152 | — | 仅错误码语义；将来补 `maxmem` 才成真风险 | 收紧到 128·N·r ≤ 32 MiB，越界返 `UNSUPPORTED_FORMAT` | P2 | S | Low |
| SEC-08 | routes/kit | `writeJson` 只设 content-type + referrer-policy | 无 `nosniff`/CSP/frame-options，与救急台口径不一致 | `src/routes/kit.ts:96-103`；对照 `src/cli/web/http.ts:4-25` | — | 残余嗅探/嵌框风险（低） | `writeJson` 补 `x-content-type-options: nosniff` | P3 | S | Low |
| SEC-09 | routes | 65 处写方法仅 16 处过 mutation gate | 配置类写无并发保护/条件写 | `src/index.ts:2729-2768`（gate）；`src/routes/sync.ts:321`、:1163；`src/routes/me.ts` 7 条 POST | Gitea 类条件写（见 §12 的 baseline 思路） | 后写覆盖，无版本判据 | 对"会驱动后续网络/写盘"的配置引入 mtime/版本条件写或纳入锁 | P2 | M | Low |
| SEC-10 | docs/decisions | ADR-0002 用行号引用闸门 | 行号已漂移（实测指向 rollback 闭包与 rewind gate） | `docs/decisions/0002-encrypted-container-unlock-gate.md:28` vs `src/index.ts:3652`、:3691、`src/routes/import.ts:190` | — | 维护者按 ADR 找不到闸门 | 改符号引用而非行号 | P3 | S | Low |
| SEC-11 | utils/zip | `safeExtract`/`safeExtractHardened` 全仓无调用方 | 文件头宣称"整体拒绝"，实际 CRC 校验在惰性读阶段 | `src/utils/zip.ts:538`；`src/security/zip-security.ts:72-109` | — | 现网不受影响（导入走内存）；潜伏误用风险 | 要么删掉这两个导出，要么把校验前移到落盘之前 | P3 | S | Low |
| SEC-12 | sync/git | `validateRepoUrl` 只看 scheme/userinfo；repoUrl 直接进 git argv | 以 `-` 开头的 repoUrl 被 git 当选项（参数注入），非 http(s) 也未拦 | `src/sync/sync-config.ts:438-459`；`src/sync/git/git-transport.ts:586`（ls-remote）、`:711`（clone）| dsh-backup 的传输层不拼 user 输入 | 可让 git 读任意本地仓/触发 helper | scheme 白名单 + argv 恒带 `--` + `-c protocol.ext.allow=never` | P1 | S | Low |

计数：P0 = 1、P1 = 4（SEC-02/03/05/12）、P2 = 4（SEC-04/06/07/09）、P3 = 3（SEC-08/10/11），合计 12 条。其中 SEC-12 为本轮复核新增；SEC-04 由 P1 下调为 P2（缺省即 `enabled:false`，且导入路由不 reload）。

### 8.9 UNKNOWN（未验证，不写成缺陷）

1. `ext::` 远端 helper 是否真的会被执行：`git-transport.ts:1159` 原样传 `repoUrl`，未设 `protocol.ext.allow`；Git 默认 `protocol.ext.allow=user`，本轮禁跑真实 clone ⇒ UNKNOWN（若默认允许，SEC-03 从"本地仓库读取"升为"命令执行"）。
2. 远端索引 ETag/If-Match 条件写的实际覆盖：AGENTS 声明"远端改过即中止"，本轮未逐条读 `src/sync/**` 的条件头实现 ⇒ UNKNOWN。
3. 明文 ZIP 临时文件的生命周期与清理点：AGENTS 声明"密码仅内存、明文 ZIP 用完即清"，本轮未定位 `src/routes/import.ts` 的生成/删除点 ⇒ UNKNOWN。
4. `/execute` 侧是否存在第三个 encrypted-container 闸门：`CLIENT_DEPENDENCIES.md:73` 声称三处；本轮确认 `src/index.ts:3652`、:3691、`src/routes/import.ts:190` 三处写码点，未逐条对齐路由清单 ⇒ 部分 UNKNOWN。
5. 跨版本同步快照兼容（G-19）：契约登记"要求两端同版本"，禁真实 sync ⇒ UNKNOWN。
6. 83 条路由中是否有未走 `kit.endpoint()` 的注册：grep 只见 `src/index.ts:4374` 一处 `registerRoutes`，未逐条闭合 76 个 `endpoint()` 调用与计数 ⇒ 统计口径问题，非安全结论。

### 8.10 与既有台账的核对（不照抄）

| 台账条目 | 台账说法 | 本轮源码实况 | 判定 |
| --- | --- | --- | --- |
| G-05 | 部分修复（不对称） | `src/core/analyzer.ts:426-435` 只对"数字且 > 1"的 `data.version` 跳过；`version < 1` 或非数字仍硬错（:437-441） | 仍如台账 |
| G-11 | 未修：条目不拒中段反斜杠 | `paths.ts:33-42` 只 `split(/[\\/]+/)` 判 `'..'` | 仍如台账，且缺口比台账更宽（SEC-06） |
| G-36 | 部分修复：bearer 不敏感、厂商前缀刻意敏感 | `secret-scanner.ts:72`、:132-133、:62-66（前缀 `startsWith` 无 `i`） | 仍如台账 |
| `known-limits.md:52` | "82 条路由的唯一认证边界是 loopback 围栏" | `src/routes/kit.ts:12` 计数为 **83**（76 + 7） | 判定正确，**计数漂移**（§2 已记） |
| ADR-0002 | 行号引用闸门 | 已漂移（SEC-10） | 新增 |
| AGENTS"ZIP 视为不可信 / 强制快照 / Dry Run" | 三条不变量 | `zip.ts:465-509`、`analyzer.ts:921-939`、:895-898 | 成立 |

## 9. Agent Adapter & Migration Audit

> 证据口径：本节所有编号均已由 lead 亲自 grep/read 复核到行。标注 **事实** 的是源码可直接读出；标注 **推断** 的给出推断链；标注 **UNKNOWN** 的是本轮无法验证。

### 9.1 分层与规模

| 项目 | 内容 |
|---|---|
| 实际位置 | `src/adapters/`（23 个非测试文件）、`src/foreign/`（外部来源，120 文件）、`src/schema/`（分区注册表与版本）|
| 主要职责 | 把每个分区（section）的「读 / 分析差异 / 写 / 校验 / 收尾」实现成统一契约，供 Exporter / Analyzer / Importer 三引擎无差别调度 |
| 关键接口 | `ConfigAdapter`（`src/core/types.ts:1171-1272`，**17 个成员：8 个必填 + 9 个可选钩子**）；抽象基类 `FileCollectionAdapter`（`src/adapters/file-collection.ts:69`）|
| 依赖关系 | 只依赖 `core/types.ts` 的类型与 `HostContext` 门面；不 import `routes/` / `client/`；`index.ts` 负责注册与挂载顺序 |
| 数据流 | 导出：`export(ctx, options)` → `ExportSection`；预览：`preview()` → `SectionPreview`；导入：`analyzeImport()` → `PlanItem[]` → 引擎调度 `applyItem()` → `finalizeApply()`（分区内）→ `finalizeImport()`（全分区后）|
| 状态管理 | 无内部状态（纯函数式，状态全在宿主 `HostContext` 的 fs 门面里）；顺序语义由 `section-registry.ts` 的 `applyOrder` 决定 |
| 测试覆盖 | 同目录 `*.test.ts` 覆盖 17 分区中的绝大多数；`src/adapters/file-collection.test.ts`、`plugins.test.ts` 为最厚（本轮未跑全量测试，见 §17.1）|
| 主要问题 | ①`ConfigAdapter.snapshot()`/`rollback()` 两个钩子零覆写（AD-01）；②`pluginFiles` 未复用基类的单文件字节闸门（AD-03）；③可选钩子只有单一实现者（`listAllUnitIds`/`unitActivityTimes`/`finalizeApply` 均在 sessions）|

**事实**：17 个分区 id 全部登记在 `src/schema/section-registry.ts:190-420`：settings、ui、providers、plugins、mcp、prompts、skills、agentPresets、agentInstructions、workspaces、pluginFiles、credentialsStatus、secrets、sessions、self、pluginData、pluginAssets。

**事实**：适配器类是 15 个，覆盖 16 个分区（`secrets` **没有适配器**，由 exporter/importer/backup 的独立密文凭据载荷处理：`src/core/backup.ts:402` `case secrets`；`credentials.ts:87` 导出时 `hasValue: false`）：

| 载体类型 | 适配器类 | 分区 |
|---|---|---|
| 继承 `FileCollectionAdapter`（6）| `SkillsAdapter` `src/adapters/skills.ts:166`、`AgentPresetsAdapter` `:agent-presets.ts:9`、`AgentInstructionsAdapter` `:agent-instructions.ts:22`、`SessionsAdapter` `:sessions.ts:49`、`SelfAdapter` `:self.ts:152`、`PluginDataAdapter` `:plugin-data.ts:68` | skills、agentPresets、agentInstructions、sessions、self、pluginData |
| 直接 `implements ConfigAdapter`（9）| `SettingsAdapter` `:settings.ts:167`、`UiAdapter` `:ui.ts:63`、`ProvidersAdapter` `:providers.ts:45`、`PluginsAdapter` `:plugins.ts:354`、`McpAdapter` `:mcp.ts:170`、`PromptsAdapter` `:prompts.ts:125`、`WorkspacesAdapter` `:workspaces.ts:86`、`PluginFilesAdapter` `:plugin-files.ts:27`、`CredentialsAdapter` `:credentials.ts:75` | 其余 10 个分区 |

### 9.2 契约面覆盖矩阵

这一节回答「Adapter 接口是否足够通用」。判据不是「有多少方法」，而是**每个可选钩子有没有人用、没用的代价是什么**。

| 契约成员 | 必填 | 覆写适配器数 | 空缺的真实代价 |
|---|---|---|---|
| `export()` | 是 | 12 个文件（基类实现 + 11 处）| — |
| `analyzeImport()` | 是 | 12 | — |
| `applyItem()` | 是 | 12 | — |
| `validate()` | 是 | 10（基类兜底其余）| — |
| `preview()` | 否 | **3**（`file-collection.ts`、`plugin-data.ts`、`plugins.ts`）| 其余分区预览退回 `export()`，JSON 分区代价可忽略；**文件类分区不实现 `preview` 就等于预览时真的读一遍内容**（体积与时间口径分叉）|
| `listUnits()` | 否 | 10 | 未实现 = 不可细分（UI 只给整体开关）|
| `unitActivityTimes()` | 否 | **1**（仅 `sessions`）| 其他分区导出选择器只能按 id 排序 |
| `listAllUnitIds()` | 否 | **1**（仅 `sessions`）| 未实现 = 该分区跳过删除检测（宁可漏报，绝不误标）|
| `finalizeApply()` | 否 | **1**（仅 `sessions`）| 分区内多代际文件的「写后归位」必须等整分区写完 |
| `finalizeImport()` | 否 | **1**（仅 `workspaces`）| attachSession 必须等会话已落盘 |
| `snapshot()` | 否 | **0** | 见 AD-01 |
| `rollback()` | 否 | **0** | 见 AD-01 |
| `fileCollection` 标记 | 否 | 1（基类置 true）| 见 `src/core/types.ts:1176-1184` 的注释：前缀映射绝不能套到文件集合分区，否则 sessions 位置错位会让目标机下次启动直接失败（issue #45 ④）|

**判断（事实 + 推断）**：契约面本身**不缺抽象**。它已经覆盖了「读 / 预览 / 单元切分 / 判定差异 / 逐项写 / 分区内收尾 / 全分区收尾 / 校验 / 快照 / 补偿」十个环节，且两端入口（GUI 与 CLI）都吃同一份契约。真正的缺口只有两处：**快照钩子零实现**、**若干可选钩子只有单一实现者**（说明它们本质上是「sessions 专属语义」被误放进通用契约，但代价只是没人用，不是错误抽象）。

### 9.3 DSH 内部分区能力矩阵

等级：**FULL** = 读写 + 删除/重命名检测齐备且有测试（本轮只有 `sessions` 达到：删除检测依赖 `listAllUnitIds()`，唯一实现 `src/adapters/sessions.ts:116`）；**PARTIAL** = 能读能写但缺一类判定（无删除检测、无字节闸门）；**DETECT** = 只能识别不能写；**NONE** = 不支持；**UNKNOWN** = 本轮未验证。

| 分区 | 载体 | 读 | 写 | 单元级选择 | 专属收尾 | 等级 | 备注 / 证据 |
|---|---|---|---|---|---|---|---|
| settings | JSON | ✅ | ✅ | ✅ `listUnits` | — | PARTIAL | `settings.ts:167` |
| ui | JSON | ✅ | ✅ | ✅ | — | PARTIAL | `ui.ts:63` |
| providers | JSON（含凭据引用）| ✅ | ✅ | ✅ | — | PARTIAL | `providers.ts:45`；凭据值不在此分区 |
| plugins | JSON + 档案 manifest/patch 层 | ✅ | ✅ | ✅ | — | PARTIAL | `plugins.ts:354`；覆盖 `profiles/<p>/cordis.patch.yml`（`:116`）、package.json、pnpm-workspace、patches/*.patch |
| mcp | JSON（connector store）| ✅ | ✅ | ✅ | — | PARTIAL | `mcp.ts:170`；`:10` 复用 profile manifest ref |
| prompts | 文件/JSON | ✅ | ✅ | ✅ | — | PARTIAL | `prompts.ts:125` |
| skills | 文件集合 | ✅ | ✅ | ✅ | — | PARTIAL | `skills.ts:166`（基类）|
| agentPresets | 文件集合 | ✅ | ✅ | ✅ | — | PARTIAL | `agent-presets.ts:9` |
| agentInstructions | 文件集合 | ✅ | ✅ | ✅ | — | PARTIAL | `agent-instructions.ts:22` |
| workspaces | JSON + 会话登记 | ✅ | ✅ | ✅ | ✅ `finalizeImport` | PARTIAL | `workspaces.ts:86`、`:246`；无删除检测 |
| pluginFiles | 文件集合 | ✅ | ✅ | ✅ | — | PARTIAL | `plugin-files.ts:27` 自实现；**已复用**链接告警（`:12`/`:92`）与保留路径防线（`:157`），只缺基类的单文件字节闸门（`file-collection.ts:48` `MAX_FILE_SECTION_BYTES`）（AD-03）|
| credentialsStatus | 元数据 | ✅ | ✅ | ✅ | — | PARTIAL | `credentials.ts:75`；值层走 DSH credentials 槽位；无删除/重命名概念 |
| secrets | 密文凭据载荷 | ✅ | ✅ | — | — | PARTIAL | 导出独立载荷（不进 sections）；导入写回槽位；**值不可回读**（技术限制）|
| sessions | 文件集合（.jsonl.zstd）| ✅ | ✅ | ✅ | ✅ `finalizeApply` + `unitActivityTimes` + `listAllUnitIds` | FULL | `sessions.ts:49`；默认不挂载，需 `includeSessions`（`src/adapters/index.ts:53-78`）|
| self | 文件集合 | ✅ | ✅ | ✅ | — | PARTIAL | `self.ts:152` |
| pluginData | 文件集合（按插件声明）| ✅ | ✅ | ✅ | — | PARTIAL | `plugin-data.ts:68`；只收内置来源 + 已安装插件自述 `dsh.dataDirs`；`cache` 永不收录 |
| pluginAssets | 文件集合 | ✅ | ✅ | ✅ | — | PARTIAL | 同 `pluginData` 口径；离线 CLI 不收集该分区 |

**事实**：`sessions` 与 `pluginData`/`pluginAssets` 在离线 CLI 侧有额外限制 —— `src/cli/help.ts` 的命令面与 `--sections` 提示把这两个分区指向 GUI；离线 CLI 不收集 `pluginData`/`pluginAssets`。

### 9.4 跨 Agent 外部来源矩阵（`src/foreign/`）

这里才是本项目的「跨 Agent 迁移」。它不是「往 30 个 Agent 写」，而是**从 30 个 Agent 读**：读别的 Agent 的历史会话与配置，合成为 DSH 能接受的分区数据。因此能力矩阵的列只能是「读 + 合成」，没有「写回原 Agent」。

**事实**：`ForeignSourceId` 30 项在 `src/foreign/registry.ts:81-86` 冻结；每源元数据 = `id` / `defaults`（三平台令牌化根）/ `envKeys`（`mode: replace|append`、`absoluteOnly`、`platforms`）/ `autoRoots` / `evidence` / `refs` / `dynamic`，定义在 `src/foreign/truth-table.ts`。

| 等级 | 语义 | 计数 | 来源 |
|---|---|---|---|
| measured | 真机跑过、布局实测 | **5** | claude-code `truth-table.ts:128`、hermes `:153`、antigravity `:204`、dsh4 `:386`、dsh `:452` |
| documented | 有官方文档依据、未真机验证 | **2** | copilot `:189`、chatgpt `:317` |
| fixture | 仅有夹具（构造样本）验证 | **23** | cursor `:158`、codex `:170`、gemini `:210`、reasonix `:219`、opencode `:232`、mimocode `:241`、zcode `:249`、grokbuild `:257`、openclaw `:266`、pi `:275`、kimi `:284`、kilocode `:296`、qoder `:304`、workbuddy `:322`、qwen `:331`、continue `:339`、cline `:348`、goose `:369`、zed `:391`、crush `:404`、teleagent `:416`、trae `:425`、vibe `:439` |

按资产类型分（事实，依 `defaults` / `dynamic` 字段）：

| 资产类型 | 源数 | 代表 | 迁移能力等级 |
|---|---|---|---|
| 配置类（config/skills/plugins/mcp 指令面）| 6 | claude-code、hermes、cursor、codex、copilot、antigravity | **PARTIAL**（读得进、转成 DSH 分区，但反向不可回写）|
| 会话历史类 | 24 | gemini、dsh4、dsh、zed、trae、cline、goose、continue、crush、vibe、qwen、kimi … | **PARTIAL**（dsh/dsh4 为**逐字节直通**，其余为格式转换）|
| 反向写回原 Agent | 0 | — | **NONE**（设计上就不做，符合「DSH 侧管理器」定位）|

**推断（证据链见 §12）**：README/界面上的「支持 30 个 Agent」与「23 个源只跑过夹具」是两件事。前者是 id 数量，后者是可信度分布。报告不把 fixture 级说成已验证 —— 这也是 AD-05 的全部内容。

**未支持 / 只检测的资产类别（事实）**：外部来源不读 workspace 元数据、不读原 Agent 的凭据、不读 subagent 定义、不读 hooks。这四类在 30 个源里没有任何一个实现了读入（`src/foreign/` 下无对应解析器）。

### 9.5 该不该造 Asset Model / Migration Engine

用户任务书把这两项列为候选架构升级。逐条给结论与证据。

**结论一：不需要新造统一 Asset Model。**

证据：
1. 统一模型其实已经存在，只是名字叫 `SectionId` + `ExportSection<T>` + `PlanItem`（`src/core/types.ts`）。17 个分区、15 个适配器（`secrets` 无适配器）、导出/预览/分析/写入/校验五条链路全部走这一套类型。
2. 真正的抽象缺口是**快照知识没进契约**：`snapshot()`/`rollback()` 在契约里（`types.ts:1269-1272`），引擎侧也确实接线了（`src/core/backup.ts:484-485`、`src/core/rollback.ts:137`），但 15 类适配器零覆写。结果分区快照知识落在引擎的 `engineSnapshotEntry` 按 adapter id 的 switch 里（`src/core/backup.ts:309-431`，约 120 行；含 pnpm-workspace / `PLUGIN_PROFILE_MANIFEST_REF` / `MCP_CONNECTOR_STORE_REL` 整文件特判、`secrets` 显式 throw、`default: never` 穷举）。
3. 再造一层 Asset Model 会把这三份知识变成四份，且必须同时改动 ExportSection 与 PlanItem —— 那是破 `docs/spec/` 的 MAJOR 改动，收益不成比例。

⇒ 应采取的最小改进是 **AD-01：把 switch 各分支下沉成 `adapter.snapshot()`**，引擎只留兜底（P2，M，Low）。这不是「新架构」，是把已经设计好的钩子接上。

**结论二：不需要新造 Migration Engine，但现有迁移链今天结构性不可达。**

证据：
1. `src/schema/versions.ts:18` `CURRENT_SCHEMA_VERSION = 1`、`:21` `MIN_SUPPORTED_SCHEMA_VERSION = 1` ⇒ `:45` `needsMigration` 恒为假。
2. `src/core/analyzer.ts:351` 的 isTooNew / !isSupported 硬失败发生在 `:361` 的 `runSchemaMigration(manifest, manifest.schemaVersion, CURRENT_SCHEMA_VERSION, this.msg)` 之前 ⇒ 迁移分支不可达（台账 G-07 的「不可达」判断属实）。
3. `src/migrations/v1-to-v2.ts` 的 `migrate()` 恒等返回 ⇒ 一旦把 CURRENT 升到 2，会产出「已迁移」的假告警，而不是真的改文档。

⇒ **AD-02**：不是造引擎，而是补两道断言 ——「升版本必须真的改文档」+「v1→v2 端到端用例」（P2，S，Low）。迁移框架本身（版本轴、`runSchemaMigration` 调度、`needsMigration` 判据）设计正确、保留。

### 9.6 问题清单（AD 域）

| ID | 模块 | 当前实现 | 问题 | 证据 | 竞品参考 | 影响 | 建议 | 优先级 | 复杂度 | 兼容性风险 |
|---|---|---|---|---|---|---|---|---|---|---|
| AD-01 | adapters / backup | 快照知识集中在引擎 switch | 契约有 `snapshot()/`rollback()，15 类适配器零覆写 | `types.ts:1269-1272`、`backup.ts:309-431`、`backup.ts:484-485`、`rollback.ts:137`；grep `async snapshot(` 零命中 | dsh-backup 的快照逻辑按模块归属 | 新增分区必须在引擎 switch 里加分支，漏改则静默不进快照 | 各分支下沉为 `adapter.snapshot()`；引擎只留 default 兜底 + `never` 穷举 | P2 | M | Low |
| AD-02 | migrations | 迁移分支不可达；v1-to-v2 恒等 | 升版本会产出假告警 | `versions.ts:18/21/45`、`analyzer.ts:351/361`、`migrations/v1-to-v2.ts` | dsh-backup-sync 的显式 schema 迁移 + 断言 | 未来升 v2 时迁移「看起来成功」 | 补「必须改文档」断言 + 端到端用例 | P2 | S | Low |
| AD-03 | adapters/pluginFiles | 自实现 186 行 | 未复用基类的**单文件字节闸门**（`MAX_FILE_SECTION_BYTES`）；链接告警与保留路径防线已复用 | `plugin-files.ts:12`/`:92`（链接告警）、`:157`（保留路径）、`file-collection.ts:48`（闸门，全仓仅基类引用）| DSH-Portable 的统一文件收集器 | 单插件文件超限时基类会拦、本分区不会 | 把字节闸门抽成共享工具（链接/保留路径不必动）| P3 | S | Low |
| AD-04 | adapters/workspaces | `finalizeImport` 里 `attachSession`，在所有 `applyItem` 之后执行 | 未挂载 `sessions`（`includeSessions=false`）时工作区↔会话关联登记不上 | `workspaces.ts:235-248`（jsdoc 自陈顺序与「绝不静默失败」）、`:258-263`（`note.failed > 0` ⇒ `warning`）| — | 关联缺失，但**按 warning 上报、不阻断导入**（可见，非静默）| 保持现状；补一条「未挂载 sessions 时提示」的界面说明 | P2 | S | Low |
| AD-05 | foreign | 30 源，measured 5 / documented 2 / fixture 23 | 23 源仅夹具验证，真机布局一变即 nothing-to-import | `registry.ts:81-86`、`truth-table.ts` 各行 | — | 「支持 30 个 Agent」的可信度被高估 | 逐源真机 smoke 把 `evidence` 升 measured；未升的界面文案按 fixture 口径 | P2 | L | Low |
| AD-06 | foreign / model-tools | GUI + CLI 两入口同源 | model-tools 面零入口 | `routes/foreign.ts:89/101`、`cli/import-source.ts:156`；`grep -n foreign src/core/model-tools.ts` 零命中 | — | Agent 无法自行调用外部来源导入 | 视需要在 model-tools 暴露只读 sources 列举 | P3 | S | Low |
| AD-07 | routes | 计划项默认值写三处 | `createImportPlan` 默认参数重复 | `routes/consult.ts:83-84`、`routes/market.ts:211-212`、`routes/sync.ts:983`（注释自陈镜像）| — | 默认值漂移 | 抽 `planWithDefaults()` | P2 | S | Low |
| AD-08 | schema | 两条版本轴各写一半 | 无「改版本要同时改哪两处」的书面耦合 | `versions.ts:69`、`section-registry.ts:137` | — | 改分区 dataVersion 易漏一侧 | 两处各写死耦合注释 + 触发测试名 | P3 | S | Low |

**计数**：AD 域 8 条，P0=0 / P1=0 / P2=5（AD-01/02/04/05/07）/ P3=3（AD-03/06/08）。

### 9.7 未验证（UNKNOWN）

| 项 | 原因 |
|---|---|
| `src/foreign/sqlite.ts` 三态只读计划（direct / immutable / copy，1 GiB 上限）| 本轮未读实现，不推断其正确性 |
| 23 个 fixture 源是否有「升 measured」计划 | `docs/modules/foreign-import.md` 未逐段读 |
| 离线 CLI 与 GUI 导出产物是否曾逐字节对账 | 未找到用例（IE-03 只断言两者装配路径不同）|
| `pluginFiles` 自实现部分是否已覆盖基类的全部防线 | 未逐行对照基类 |

## 10. Profile & Workspace Audit

### 10.1 Profile 的存储机制（事实）

| 项目 | 内容 |
|---|---|
| 实际位置 | `src/profiles/dsh-profile-manager.ts`（管理器）、`dsh-profile-launcher.ts`（启动）、`dsh-profile-shared.ts`（共享口径）、`dsh-profile-io.ts`（IO）|
| 主要职责 | 枚举 / 创建 / 复制 / 改名 / 删除 / 启动 DSH 档案（profile = 一份独立的 DSH 安装面：插件树 + 补丁层 + 依赖锁）|
| 关键接口 | `DshProfileManager`（`:107`）：`profilesRoot()` `:117`、`list()` `:122`、`detail()` `:148`、`create(name, templateId='base')` `:161`、`copy()` `:213`、`rename()` `:273`、`remove(name,{allowCurrent})` `:357`、`listIncompleteCopies()` `:456`、`listIncompleteCopiesScan()` `:471`；错误类型 `DshProfileError`（`:48`，码表 `dsh-profile-shared.ts:277` 含 `managedProfile`）|
| 依赖关系 | 文件系统直连（`node:fs` 的 `rmSync`/`renameSync`/`readdirSync`）；不经过宿主 fs 门面 ⇒ **不受备份分区/宿主 fs 门面统一约束** |
| 数据流 | 磁盘目录 → `readMeta()` `:549` → `DshProfileMeta`（含 `readManifestObject()` `:524` 与 `readProfileDshVersion()` `:537`）→ GUI/CLI 展示 |
| 状态管理 | 目录即状态 + 复制标记文件（`copyMarkerPath()` `:383`、`readCopyMarker()` `:391`）|
| 测试覆盖 | `src/profiles/dsh-profile-manager.test.ts` 等；本轮实跑含 1 个 profile 用例文件，全绿 |
| 主要问题 | 删除不可逆且无快照（PW-01）；档案不进任何分区/同步（PW-02）|

**事实**：`desktop` 是 Electron 独占保留档案名，`remove()` `:358` 与 `rename()` `:276` 都以 `managedProfile` 拒绝；同一字面量在 `src/utils/desktop-carrier.ts` 另有一份（`dsh-profile-shared.ts:238` 注释说明宿主侧不能 import 本模块）。

**事实**：DSH 没有「默认档案 / 下次启动档案」状态，档案只由启动参数决定；本项目不写 `<dataDir>/next-profile`（AGENTS.md 硬规则，源码侧 `dsh-profile-launcher.ts` 只做启动）。

### 10.2 Profile 与备份的真实关系（lead 复核后的边界）

任务书要求判断「Profile 是否应该成为独立的一等资产」。要回答这个，先得知道**今天档案树里到底有多少东西被备份覆盖**。这一条在 teammate 的初稿里被写成「profiles 完全不在备份体系之外」，复核后需要修正 —— 覆盖是**部分**的，靠的是 `plugins` 分区而不是 profiles 分区。

| 档案树内的内容 | 是否进备份 / 同步 | 证据 |
|---|---|---|
| `profiles/<p>/cordis.patch.yml` | **进**（`plugins` 分区）| `src/adapters/plugins.ts:3`/`:6`（patch 层说明）、`src/core/patch-layers.ts`（实现）、`src/adapters/mcp.ts:10` |
| `profiles/<p>/package.json`（含 `dsh.profile.bundles`）| **进** | `src/adapters/plugins.ts` 的 profile manifest 读写；`plugins.test.ts` 用例 |
| `profiles/<p>/pnpm-workspace.yaml` | **进**（机器路径键整行剥离）| `plugins.test.ts:784-801`（`MACHINE_WS` → `PORTABLE_WS` 断言）|
| `profiles/<p>/patches/*.patch` | **进** | `plugins.ts` 的 patch 层收集 |
| `profiles/<p>/node_modules` | **不进**（按设计不收）| `plugins.test.ts:530-552`（`dropped` 用例）|
| `profiles/<p>/pnpm-lock.yaml` | **不进** | `src/adapters` 下 grep `pnpm-lock` 零命中 |
| 其余运行态（cache、日志、tmp）| **不进** | 17 分区注册表无对应项（`section-registry.ts:190-420`）|

**结论（事实）**：档案的**声明面**（补丁层、插件声明、workspace、patch 文件）已经在备份与同步的覆盖内；**载荷面**（`node_modules`、锁文件、运行态）不在，且 `node_modules` 的排除有明确体量理由（285 MB / 1.7 万文件）。所以 PW-01 的正确表述不是「档案完全没备份」，而是：**档案的目录级整体身份（哪份档案 = 哪套插件树 + 哪个锁版本）没有备份通道，且删除档案是不可逆的物理删除。**

### 10.3 删除的可逆性（事实）

`DshProfileManager.remove()`（`:357-368`）的实现是：先校验非保留名（`:358`）→ `rmSync(dir, { recursive: true, force: true })`（`:363`）。头注释（`:21`、`:348`）写明「物理删除 profile 目录（rmSync recursive；目录内 junction 只删链接本身）」。**删除前不做快照、不进回收站、不写墓碑。**

唯一的「留一份」手段是 `copy()`（`:213`），但那是**创建新档案**（新目录、新名字），不是可回滚快照；且复制本身也带中断残留问题 —— 复制前先落 `.dcm-copy-in-progress.json` 标记，`listIncompleteCopies()` `:456` / `listIncompleteCopiesScan()` `:471` 认这个标记才能列出半截副本供清理（台账 tech-debt #5 记的正是这件事，代码已比台账描述更新）。

### 10.4 Workspace 资产（事实）

| 项目 | 内容 |
|---|---|
| 分区 | `workspaces`（`section-registry.ts:313`），适配器 `WorkspacesAdapter` `src/adapters/workspaces.ts:86` |
| 单元级 | 实现 `listUnits()`，可按工作区勾选 |
| 收尾 | `finalizeImport()` `:246` 调 `attachSession`，把会话登记进工作区 |
| 顺序 | `applyOrder` workspaces=10 < sessions=14 ⇒ 收尾必须等**全部分区**写完（见 §9.6 AD-04）|
| 跨 Agent 路径映射 | `pathMappings` 在计划期生效；但 `fileCollection` 分区（含 sessions）**绝不**套用前缀映射（`src/core/types.ts:1176-1184` 注释：位置错位会让目标机下次启动直接失败，issue #45 ④ 实测）|

**判断**：Workspace 已经是事实上的「一等资产」（可勾选、可映射、有专属收尾），它的问题不是缺地位，而是**依赖声明不在注册表里**（AD-04）。

### 10.5 Profile 是否应该成为一等资产

**结论：应该升级为「可快照、可回退」的一等资产，但不应该把整个档案目录纳入备份分区。**

支持升级的证据：
1. 删除是物理不可逆（9.3），而档案是本项目 UI 里唯一的「一键生成整套环境」入口（`copy()`）—— 用户把它当迁移手段，却没有回滚点。
2. `pnpm-lock.yaml` 与 `node_modules` 不在覆盖内，导致「同一份 bundle 声明 + 不同锁版本」在跨机迁移后可能装出不同插件树；声明面进备份、载荷面不进，会让用户误以为「包里有整套环境」。
3. 档案不进同步分区白名单（`syncSectionCatalog` 由注册表派生，注册表无 profiles）⇒ 档案跨机只能走 GUI 导出包，没有自动通道。

反对整体纳入的证据：
1. `node_modules` 体量（285 MB / 1.7 万文件）会被每个快照与每次同步复制一遍，直接顶掉「快照便宜」这个当前最大优势。
2. 档案目录含 junction/symlink（`:21` 注释），跨机复制必须重链（`relinkCopiedTree()` `:302`），纳入通用文件集合分区会把「重链」这个专属语义挤进通用契约。

⇒ 最小合理升级：**给 `remove()` 加「删除前快照」**（复用现有 `SnapshotEngine`，快照目标 = 档案声明面 + 锁文件），而不是新造 profiles 分区。这条路 PW-01 与 PW-02 同时收口，且不动 bundle 格式。

### 10.6 问题清单（PW 域）

| ID | 模块 | 当前实现 | 问题 | 证据 | 竞品参考 | 影响 | 建议 | 优先级 | 复杂度 | 兼容性风险 |
|---|---|---|---|---|---|---|---|---|---|---|
| PW-01 | profiles | `remove()` 直接 `rmSync(recursive, force)` | 删除档案不可逆，删除前无快照 | `dsh-profile-manager.ts:357-364`（`:363` 删除）、头注释 `:21`/`:348` | dsh-undo-savepoint 的 undo 点即删除前快照 | 用户删错档案 = 整套插件树与补丁层消失 | 删除前调 `SnapshotEngine` 落一份「档案声明面 + 锁文件」快照；UI 提供「撤销删除」入口 | P1 | L | Medium |
| PW-02 | profiles / sync | 声明面由 `plugins` 分区覆盖；锁与载荷不覆盖；无 profiles 分区 | 「整机迁移 = 完整环境」的预期与实现不符；档案无自动同步通道 | `src/core/patch-layers.ts`、`plugins.test.ts:530-552/784-801`、`section-registry.ts:190-420`（无 profiles）、`src/adapters` grep `pnpm-lock` 零命中 | DSH-Portable 的「环境封装」思路 | 跨机迁移后插件树可能与源机不同；用户不知情 | 导出包 manifest 显式声明「未含锁文件与 node_modules」并在 UI 提示；锁文件作为**可选**条目（默认不勾）| P2 | M | Low |
| PW-03 | profiles | 复制中断靠残留标记识别（`listIncompleteCopies`）| 台账 tech-debt #5 的严重度描述未随代码更新（代码已能列/删半截副本）| `dsh-profile-manager.ts:383/391/456/471`、`docs/maintenance/tech-debt.md:20`（tech-debt #5）；`src/routes/recovery.ts:293`/`:339-344` | — | 维护者按台账低估现状 | 更新台账严重度并指向 `listIncompleteCopies` | P3 | S | Low |

**计数**：PW 域 3 条，P0=0 / P1=1 / P2=1 / P3=1。

### 10.7 未验证（UNKNOWN）

| 项 | 原因 |
|---|---|
| profiles 被排除在备份分区之外是否有设计决策记录 | `docs/design/` 未逐篇读；只看到体量理由（285 MB / 1.7 万文件）|
| `copy()` 在大档案上的实际耗时与中断行为 | 未实跑（属写操作，只读审计范围外）|
| 档案与 DSH 版本（`readProfileDshVersion`）不一致时的启动行为 | `dsh-profile-launcher.ts` 未逐行读 |

## 11. UI & CLI Architecture Audit

> 本节不做视觉评估（任务书明确排除）。只审：分层是否干净、GUI 与 CLI 是否同源、长操作状态是否一致、写入门是否唯一、错误是否可理解、i18n 是否有单一来源。

### 11.1 三层结构与真实依赖方向（事实）

| 层 | 位置 | 文件数 | 职责 | 规模极值 |
|---|---|---|---|---|
| 引擎 | `src/core/`、`src/sync/`、`src/security/`、`src/schema/`、`src/adapters/` | core 149 / sync 96 | 无 UI 依赖的纯逻辑 | — |
| 视图模型 | `src/ui/` | 89 | 纯 view-model + i18n，**零 import `src/client/`** | `rollback-view.ts` 1558 行、`selection-model.ts` 1323、`i18n.ts` 1052、`sync-settings-view.ts` 939、`session-inventory-view.ts` 628、`import-wizard.ts` 611、`types.ts` 513 |
| React 壳 | `src/client/` | 197 | 装配 + 交互 | 目录分布：`common` 50 / `sync` 39 / `market` 18 / `recovery` 16 / `chat` 15 / `import` 14 / `about` 10 / `library` 9 / `environment` 3 |

**事实**：反向依赖（`src/ui` → `src/client`）共 5 处，**全部在 `src/ui/*.test.ts`**（测试期借用 `http.ts` 的错误类、`history-model.ts` 的工具函数、`recovery-locales.ts` 的字典：`i18n.test.ts:31`、`import-wizard.test.ts:18`、`mid-ellipsis.test.ts:26`、`session-inventory-view.test.ts:34`、`session-layout-view.test.ts:43`）；`src/ui` 生产代码零反向 import，方向是干净的。

**事实（文档漂移）**：AGENTS.md 写「业务逻辑放 `src/ui/`，React 壳只装配」，但实际业务逻辑在 `src/core/` 与 `src/sync/`，`src/ui` 是 view-model 层。这属文档与代码不符，不属代码错误 ⇒ DOC-02。

### 11.2 GUI 与 CLI 是否同源（逐能力对账）

| 能力 | GUI 路径 | CLI 路径 | 同源？ | 证据 |
|---|---|---|---|---|
| 会话体检 | `routes/` → `scanSessionHealth` | `sessions doctor --json` | ✅ 同源 | 共用 `src/core/` 体检器 |
| 快照恢复 | `routes/` → `core/restore` | `restore` 子命令 | ✅ 同源（含 `restore-resume` 判据）| `core/restore.ts`、`restore-resume` |
| 磁盘占用 / 清理 | `routes/backup.ts:78`/`:108` | `cli/actions.ts:205`（`readDiskUsage`）/`:835`（`cleanupCaches`），无独立子命令，供 `dcm web` 救急台复用 | ✅ 同源 | `src/core/disk-usage.ts`、`src/core/cache-cleaner.ts` |
| 档案管理 | `DshProfileManager` | 同一类 | ✅ 同源 | `src/profiles/dsh-profile-manager.ts` |
| 外部来源导入 | `routes/foreign.ts:89/101` | `cli/import-source.ts:156` | ✅ 同源（同一 registry + `foreignSourceContext()` `src/routes/foreign-context.ts:57`）| 已复核 |
| 会话修复规划 | `core/session-repair` 编排器 | 同一规划器、不同编排层 | ✅ 规划同源 | — |
| **备份导出装配** | `core/exporter.ts:494` `writeZip(outPath, entries)` | `cli/index.ts:1396` 与 `cli/actions.ts:1389` 各自 `writeZip` | ❌ **三份**（另有 `src/foreign/bundle.ts:140` 与 `src/sync/sync-engine.ts:2224` 装配的是外部来源 bundle 与加密快照，不属同类）| 已复核 |
| **备份校验** | **无端点** | `verifyBackupZip`（`cli/actions.ts:143`、`:1391`、`cli/import-source.ts:220`、`cli/index.ts:1407`）| ❌ 仅 CLI | `src/routes/*` 对该函数零引用 |
| 应用 bundle（对已有 ZIP 执行导入）| 有（`/execute` 系列）| **无命令** | ❌ 仅 GUI | `src/cli/help.ts` 命令表：web / snapshots / verify / sessions / backup / import / restore / sessions repair / recover-stale-lock / reinstall / help |

**结论**：同源做得比预期好 —— 8 类能力里 6 类真同源。不同源的三处集中在备份链路（导出装配 3 份、校验只在 CLI、apply-bundle 只在 GUI），这正是 IE-03 / UI-04 / IE-05 的来源。

### 11.3 长操作状态与取消（两个独立缺口）

**缺口一：状态覆盖不全（UI-02，P1）**

`src/client/run-store.ts:94` 只定义 6 个 `TaskKind`（export / import / market / runs / history / about）+ 6 个切片，统一轮询口是 `watchRunning(kind, 500)`（`:1922`）。**不在其中**的写盘动作：

| 动作 | 规模 | 现状实现 | 证据 |
|---|---|---|---|
| 档案复制 | 285 MB / 约 30 s | 组件内 `useState(busy)` | `dsh-profile-manager.ts:213`、`RecoveryPanel.tsx:417` |
| 快照恢复 | 全分区写盘 | 组件内 `useState(busy)` | `RecoveryPanel.tsx:660` |
| 会话修复 / 布局归位 | 多文件改写 | 组件内 `useState(busy)` | `RecoveryPanel.tsx:700`（`batchBusy`） |
| 磁盘清理 | 删除可重建区 | 组件内 `useState(busy)` | `client/environment/maintenance/DiskUsageCard.tsx:51` |
| 插件自更新 | 下载 + 重启 | 组件内 `useState(busy)` | `client/about/PluginUpdateDialog.tsx:69` |

后果：切页/刷新后进度丢失，且这些操作在「关于」页或侧栏看不到正在跑 —— 与 export/import 的体验不一致。

**缺口二：取消不可达（UI-03，P2）**

`AbortController` 接进**run 取消语义**的只有两个路由族：`src/routes/import.ts:224/229/388` 与 `src/routes/session-export.ts:157/235`。其余出现点（`src/core/analyzer.ts:1022-1024`、`src/core/rollback-point.ts:5764`/`:5959`、`src/core/update-check.ts:104`、`src/client/common/http.ts:147`/`:162`/`:228`、`src/sync/webdav/webdav-transport.ts:147`）是网络超时或项级跳过，不是用户可取消。`src/core/run-registry.ts:27` 登记了 8 种 `RunKind`，其中 **6 种**没有 abort 入口（`autosync` 与 `sync-apply` 属自动路径，用户面本就无按钮）。⇒ 手动长操作里只有导入与导出可取消。

**判读（事实）**：`/execute/skip`（项级跳过）与 `/runs/cancel/decision`（整 run 取消后 rollback|keep）是两套不同信号，`src/index.ts:2608-2617` 注释明确禁止合并 ⇒ **不是重复 API**，不计入问题。

### 11.4 写入门（两套，判定口径需统一）

| 入口 | 实现 | 检查项 | 拒绝码 |
|---|---|---|---|
| GUI | `src/index.ts:2729-2768` `withMutationGate` | `isBlocked: host.safeModeIsBlocked` + 环境锁 + 可选 journal | 由宿主服务给出 |
| CLI / 救急台 | `src/cli/actions.ts:438-505` `checkWriteGates` | `readSafeMode`（`:254`）→ 残留锁 `readLockState`（`:278`）→ `readRunningInstances`（`:68`）| `safe-mode` / `stale-lock` / `dsh-running` |

**判断**：这是**有意的差异**（GUI 在 DSH 运行中也要能写非关键分区；CLI 必须停 DSH），但「是否 SAFE MODE / 有无残留锁」这两个判据本身应当只有一个纯函数实现。今天两处各读一次 ⇒ UI-05（P3→ 实为 P2，S，Low）。

### 11.5 i18n 与错误链

| 项 | 现状 | 判断 |
|---|---|---|
| 字典 | 三套并行：`src/client/locales.ts`（1788 行，键数随在途改动漂移、本轮不可复现）、`src/ui/i18n.ts`（1052 行 / 924 键）、`src/core/messages-core.ts`（665 行 / 542 键，另有 `sync/messages.ts`、`schema/messages.ts`）| 引擎与界面分离是合理设计；真正的成本是**新增文案要写三处**且键指纹冻结（`src/core/engine-locale.test.ts`，只许追加）⇒ UI-01（P2，L，Medium）|
| 错误链 | `src/ui/errors.ts:79` `toActionableError()` / `:95` `formatActionableError()` → `ErrorBanner` / `ReportView`，展示前各过一次 `redact()`（幂等）| 设计正确，无需改动 ⇒ UI-07（P3，仅记录）|
| 持久化 | `run-store.ts:1472` 注释自陈 `1 s` 节流；`toPersistedState()` `:1001` 白名单；`watchRunning` 每 500 ms patch 都整份 stringify 进 sessionStorage | 有界但偏重 ⇒ UI-06（P3，S，Low）|

### 11.6 问题清单（UI 域）

| ID | 模块 | 当前实现 | 问题 | 证据 | 竞品参考 | 影响 | 建议 | 优先级 | 复杂度 | 兼容性风险 |
|---|---|---|---|---|---|---|---|---|---|---|
| UI-01 | i18n | 三套字典 + 键指纹冻结 | 新增文案要写三处；引擎键只许追加 | `client/locales.ts`、`ui/i18n.ts`、`core/messages-core.ts`、`core/engine-locale.test.ts` | — | 维护成本，易漏译 | 保留分层，加「同一 key 三处齐全」守卫测试 | P2 | L | Medium |
| UI-02 | client/run-store | 6 个 TaskKind 覆盖 6 类长操作 | 复制/恢复/修复/清理/自更新用组件内 `useState(busy)` | `run-store.ts:94/1922`、`RecoveryPanel.tsx:417/660/700` | — | 切页丢进度、跨页状态不一致 | 把这 5 类纳入 `RunKind` + `watchRunning`，先在 recovery 面板接 `restore` | P1 | M | Low |
| UI-03 | core/run-registry | 只有 import / session-export 把 AbortController 接进 run 取消语义 | 8 种 RunKind 里 6 种无 abort 入口 | `routes/import.ts:224/229/388`、`session-export.ts:157/235`、`core/run-registry.ts:27` | dsh-undo-savepoint 的可中断采集 | 手动长操作只有导出/导入可取消 | 为 restore 增加 abort → 走 `judgeRestoreResume` 的续跑语义，而不是硬中断 | P2 | M | Medium |
| UI-04 | routes | `verifyBackupZip` 无 HTTP 入口 | GUI 导出的包无法在 GUI 里验证 | `core/backup-verify.ts:140`；调用者全在 `src/cli/*` | dsh-backup 的 verify 命令 | 用户必须开终端才知道包能不能恢复 | 加只读端点 `/verify-backup`（无写路径，过只读围栏）| P2 | S | Low |
| UI-05 | 写入门 | GUI 与 CLI 各读一次 SAFE MODE / 锁 | 判据两处实现 | `src/index.ts:2729-2768`、`cli/actions.ts:254/278/438-505` | — | 两处口径漂移风险 | 抽纯函数 `readWriteGateState()`；门的差异留调用层 | P2 | S | Low |
| UI-06 | client/run-store | `watchRunning` 每 500 ms 整份 stringify | sessionStorage 写放大 | `run-store.ts:1472/1751/1001` | — | 长任务期间主线程抖动 | 改为脏字段增量 patch | P3 | S | Low |
| UI-07 | ui/errors | `toActionableError` → redact 幂等 | 无问题，仅记录设计正确 | `ui/errors.ts:79/95` | — | — | 保持 | P3 | S | Low |
| DOC-02 | 文档 | AGENTS.md 称业务逻辑在 `src/ui/` | 与实际分层不符（业务在 core/sync）| AGENTS.md「业务逻辑放 src/ui/」；`src/ui` 零 import client、纯 view-model | — | 新维护者按文档找错地方 | 改为「view-model 放 `src/ui/`，业务放 `src/core/` / `src/sync/`」 | P3 | S | Low |
| DOC-03 | docs/台账 | 已知缺口中部分条目已修复但未回填 | 台账与代码不同步（G-05 标「部分修复」、tech-debt #5 严重度失真等）| `docs/maintenance/tech-debt.md:20`、`docs/maintenance/known-limits.md` 与 `src/` 实际行为逐条对照（§5-§11）| — | 维护者按文档低估或高估现状 | 本轮审查结束后一次性回填（`fixed` / 降级 / 保留并写明理由）| P3 | S | Low |

**计数**：UI 域 7 条（+ DOC-02 归文档域）。P0=0 / P1=1（UI-02）/ P2=4（UI-01/03/04/05）/ P3=2（UI-06/07）。

### 11.7 未验证（UNKNOWN）

| 项 | 原因 |
|---|---|
| 同步页与市场下载的取消在客户端是否可达（`/sync/cancel` 存在，触发点未定位）| 未追客户端调用链 |
| 离线救急台 `src/cli/web/` 是否复用 `src/client/` 组件 | 只确认它调 `cli/actions.ts` |
| 体量棘轮脚本是否覆盖 `src/ui/rollback-view.ts` 等巨型文件 | `scripts/` 未逐个读 |

### 11.8 本节结论

UI/CLI 层**不是**本次升级的重点：分层干净、6/8 能力同源、错误链设计正确。需要补的只有两件事 —— **长操作状态覆盖（UI-02）** 与 **备份链路的三人称（导出 3 份 / 校验只在 CLI / apply-bundle 只在 GUI，后者已计入 IE-05，不在此重复）**。这两个都属于「补一条路径」的量级，不需要架构级改动。

## 12. Competitor Source Analysis

> **方法声明**：本节全部结论来自**实际拉取 GitHub 仓库文件**（GitHub API 读原始文件内容），不引用任何二手竞品报告。每个仓库给出「可读性 / 关键文件 / 机制 / 优点 / 限制 / 与本仓比较 / 是否采用」。
> 5 个仓库均在 `main` 分支可访问；文件均为可读 JS/MJS（无压缩混淆），不存在「仓库无法访问 / 版本无法确认」的情形。

### 12.1 xiaoyuyu6420/dsh-backup — 备份、加密、ZIP、安全、救援

| 项 | 内容 |
|---|---|
| 仓库结构 | `lib/{index,encrypt,zip,gfs,oplock,sync-channels,client}.js`、`rescue/rescue.mjs`、`src/{client,tab,locales,styles}`、`docs/` |
| 可读性 | **完全可读**（中文注释、零依赖 JS，非压缩产物）|

**机制（逐文件）**

| 文件 | 行数 | 实际做的事 |
|---|---|---|
| [lib/encrypt.js](https://github.com/xiaoyuyu6420/dsh-backup/blob/main/lib/encrypt.js) | 235 | `KDF_PARAMS = {algorithm:'scrypt', N:16384, r:8, p:1, keyLen:32}`、`CIPHER='aes-256-gcm'`、`NONCE_BYTES=12 / SALT_BYTES=16 / TAG_BYTES=16`；**密文只存 ciphertext，nonce/tag/salt/kdf 参数全在 `.encrypted.json` 边车**；`maxmem = 128*N*r*2 + 1MiB`（`:55`）；边车 `version` 未知一律拒绝（`:16-17` 注释：宁可不恢复，也不拿不认识的参数猜着解）|
| [lib/zip.js](https://github.com/xiaoyuyu6420/dsh-backup/blob/main/lib/zip.js) | 402 | 自写 PKZIP：**导出用 STORE（method 0）**，**导入同时支持 STORE 与 DEFLATE**；Zip Slip 判据 = 绝对路径 / 盘符 / `..` 段（先反斜杠归一）后再 `resolve` 包含性校验；symlink/设备条目一律拒；bomb 上限 `ZIP_MAX_ENTRIES=100_000`、`ZIP_MAX_ENTRY_BYTES=4 GiB`、`ZIP_MAX_RATIO=1000`、`ZIP_MAX_CENTRAL_BYTES=256 MiB`；解压后 CRC32 校验 |
| [lib/oplock.js](https://github.com/xiaoyuyu6420/dsh-backup/blob/main/lib/oplock.js) | 124 | 锁 = `{pid, token, startedAt, heartbeatAt, operation}`；心跳 30 s；**死锁判定只在 `process.kill(pid,0)` 报 ESRCH 时成立**，EPERM 一律判活（`:28-36`：绝不误踢活锁优先于尽快回收）；锁文件损坏 ⇒ 返回伪锁**阻塞** acquire；回收只能显式 `reclaim(force)` |
| [lib/gfs.js](https://github.com/xiaoyuyu6420/dsh-backup/blob/main/lib/gfs.js) | 53 | 在 keep-N 之外补 GFS **月/年**两层（`monthly`/`yearly` 缺省 0 = 行为不变），受保护集 = `tierProtectedSet ∪ gfsProtectedSet` |
| [rescue/rescue.mjs](https://github.com/xiaoyuyu6420/dsh-backup/blob/main/rescue/rescue.mjs) | 1006 | **进程外救援通道**（零依赖单文件，只用 Node 内置 + 系统 tar）：`list` / `verify` / `restore` / `doctor --repair`；恢复语义 = 先校验 → 路径穿越防护 → 现有数据先快照再挪旁（`.dsh.pre-restore-*`）→ 解压（失败自动回滚）→ vault 凭据还原；**每次备份把自身复制进备份目录**（备份在哪，救援工具就在哪）；老归档无边车静默降级 |

**优点**：①加密边车把参数与密文分离，未知 `version` 拒绝恢复 —— 比猜参数更诚实的失败方式；②`maxmem` 显式给两倍余量，避免参数升级后被 Node 默认 32 MB 上限误杀；③ZIP 写侧 STORE、读侧全解，方向正确（自产最小化、外部输入最大化兼容）；④锁模型把「绝不误踢活锁」写进注释并落到判据；⑤救援脚本随包旅行。

**限制**：①ZIP 上限偏松（4 GiB 单条目 / 1000 倍压缩比）；②导出不压缩 ⇒ 包体积大；③救援依赖系统 `tar`（旧 Windows 不可用）；④GFS 只做月/年两层，且与 `index.js` 的 `tierProtectedSet` 分处两文件各自维护。

**与本仓比较**

| 维度 | 本仓 | dsh-backup | 判断 |
|---|---|---|---|
| ZIP 上限 | 条目 10 000 / 解压总 500 MiB / 压缩总 200 MiB / 单条目 100 MiB / 比 200（`src/utils/zip.ts:41-47`）| 100 000 / 4 GiB / — / — / 1000 | **本仓严格更紧**，保留 |
| 加密 | AES-GCM + KDF 参数校验；但 `validateKdfParams` 上界宽于 `deriveKey` 实际能力（SEC-07）| 同算法 + `maxmem` 显式两倍余量 | **借鉴 `maxmem` 那一行**，直接收口 SEC-07 |
| 恢复可撤销 | 有 pre-restore 副本，但产品无出口（BK-01）| 恢复前挪旁 `.dsh.pre-restore-*`，救援台可再恢复 | 两者都是「有数据、无产品出口」；它的挪旁目录在救援台可见 |
| 崩溃续跑 | `judgeRestoreResume` 四判据（强）| 无逐项 WAL | **本仓领先**，保留 |
| 锁 | 环境锁 + 残留锁回收（`cli/actions.ts` / `index.ts`）| 独立 `oplock` + 显式 reclaim | 判据可对齐，见 §14 |

**是否采用**：①`maxmem` 两倍余量（**采用，S**，收口 SEC-07）；②加密边车版本拒绝语义（**已等价**，无需改）；③救援工具随包（**P3 可选**）；④GFS 月/年层（**待量化**，见 §18）。

### 12.2 WSL043/DSH-Portable — 环境封装、迁移、导入回滚

| 项 | 内容 |
|---|---|
| 仓库结构 | `launcher/`（60+ 模块）、`app/`、`installer/`、`desktop-bridge/`、`channels/`、`tests/`、`docs/`；`upstream.lock.json` / `stable-release-readiness.json` 等发布闸门文件 |
| 可读性 | **完全可读**（ESM + 英文注释）|

**机制（关键文件）**

| 文件 | 行数 | 实际做的事 |
|---|---|---|
| [launcher/data-import-journal.mjs](https://github.com/WSL043/DSH-Portable/blob/main/launcher/data-import-journal.mjs) | 164 | 导入日志 `data/runtime/data-import.json`；**`importEntryIdentity()` 用 `lstat({bigint:true})` 取 `{dev, ino, birth, hash, kind}`（源码字段名 birth/hash，即 birthtimeNs/sha256）** 作为条目身份（`:18-25`）；注释写明「同一文件系统条目在回滚中被重命名后身份不变 —— **绝不因为备份不见了就推断恢复成功**」（`:20-21`）；`hasIdentity()` 逐字段比对（`:27-31`）；`assertImportProfilesIdle()` 检查 `profiles/<p>/package.json.lock` 存在即拒（`:10-16`，码 `DSH_DATA_IMPORT_PROFILE_BUSY`）；所有失败统一 `DSH_DATA_IMPORT_RECOVERY_REQUIRED` |
| `launcher/data-import-preflight.mjs` / `data-paths.mjs` | — | 路径归一 + `safeDataTarget` + `writeDataFileAtomic`；导入前预检 |
| `launcher/profile-compatibility.mjs` / `startup-profile-recovery.mjs` / `repair-core.mjs` / `runtime-capsule.mjs` | — | 档案兼容性判定、启动期档案恢复、修复核心、运行时胶囊（把运行环境打成一份）|

**优点**：①**导入可续跑的可判定性**做到条目级身份（dev+ino+birth+hash），比「文件存在就算成功」严格得多；②档案锁存在即拒，不猜；③错误码把「必须人工恢复」与普通失败分开。

**限制**：①它是**宿主启动器**（Electron 周边），不是 DSH 插件，代码量与安装体积不可比；②身份方案依赖 `birthtimeNs`，Windows/网络盘上不可靠，需要回落路径；③`tests/` 覆盖面未逐一核对。

**与本仓比较**

| 维度 | 本仓 | DSH-Portable | 判断 |
|---|---|---|---|
| 恢复续跑 | `judgeRestoreResume`：同快照 + 盘面只等于 beforeFp/afterFp + 不跨入口 + 不重建 WAL（`src/core/restore-resume.ts:106`）| 条目身份 journal | **本仓整盘面判据更强；但它多出条目身份这一层，更适合「单个大文件已部分写入」的情形** |
| 导入续跑 | **无**（IE-04）| 有（identity journal）| **借鉴点**：见 §14.4 |
| 档案锁 | 本仓 `readLockState` 读锁状态 | 判 `package.json.lock` 存在即拒 | 等价，无需改 |

**是否采用**：**导入 journal 的条目身份判据（采用，M）** —— 正是 IE-04 的具体实现形状。其余（Electron 启动器、runtime capsule）与本仓定位无关，不采用。

### 12.3 Arlenman/dsh-backup-sync — Baseline / Diff / Three-way Merge / Apply

| 项 | 内容 |
|---|---|
| 仓库结构 | `lib/{baseline,diff,apply,archive,guard,hash,modules,paths,scan,settings,cloud,webdav,schedule,scheduler,service,routes,plugins,skills,client,fileview,index}.js`、`test/` |
| 可读性 | **完全可读**，且把设计理由写在文件头（本节引用的一手材料就在这里）|

**机制（核心四件）**

| 文件 | 行数 | 机制 |
|---|---|---|
| [lib/baseline.js](https://github.com/Arlenman/dsh-backup-sync/blob/main/lib/baseline.js) | 158 | 基线 `{version:1, machine, lastSyncAt, archives:{}, files:{}}`；文件键 = 模块id:相对路径（`keyOf` `:27-29`）；文件头论证：只看包与本地无法区分「本地改过」与「另一台机器改过」，唯一解法是三方比较；且**基线库自身必须进备份包**，否则换机后基线为空，第一次导入把所有差异都判成冲突 |
| [lib/diff.js](https://github.com/Arlenman/dsh-backup-sync/blob/main/lib/diff.js) | 165 | 六种动作 `import / keep / delete / conflict / same / skip`；**`diffFiles` 必须收到归档声明的模块清单 `modules`，范围外一律 `skip`** —— 否则选择性备份会被误判成「包删了该文件」→ 删掉本地记忆/配置/对话；`shaOf` 刻意容忍两种哈希形状，因为只认一种会**静默把每个文件判成本地已删** |
| [lib/apply.js](https://github.com/Arlenman/dsh-backup-sync/blob/main/lib/apply.js) | 347 | 唯一写用户数据的模块，三条不变量：①动手前先把原件复制到 `<DSH_HOME>/backup-sync/pre-restore-<时间戳>/`（布局与包含一致，本身可还原）；②**冲突未裁决 = 一个字都不改**（记入 `conflictsUnresolved`）；③写完必须回算哈希，不过就回滚并计入 `failed`。附加：**裁决「保留本地」之后基线要记下本地哈希**，否则下次导入同一个包还会冲突 |
| [lib/guard.js](https://github.com/Arlenman/dsh-backup-sync/blob/main/lib/guard.js) | 227 | 凭据双闸：文件名闸（`SECRET_BASENAMES` 含 `.credentials.*` / `.env*` / `id_rsa` / **`.npmrc`**）+ 内容闸（高信号特征串）；命中一律剔除并列入 `credentials` 由界面提示，**刻意不静默跳过** |

**优点**：①三方合并的**语义边界**写得很清楚（模块范围外 skip、冲突未决零写入、写完回算）；②「基线记下裁决后的本地哈希」解决了「同一个冲突反复问用户」的产品性缺陷；③凭据双闸且不静默跳过。

**限制**：①**同样没有 rename 语义**（按 key 比较，重命名 = 一删一增）；②基线是单文件 JSON（大仓库会膨胀，未实测）；③冲突解决是**全文件级**，无行级合并；④`webdav.js`/`cloud.js` 传输能力弱于本仓（无 S3、无条件写）。

**与本仓比较**

| 维度 | 本仓 | dsh-backup-sync | 判断 |
|---|---|---|---|
| 三方合并 | `src/sync/merge.ts` 有 base/local/remote；**rename 无语义**（SYN-08）；`pendingConflicts` 组合不可解（SYN-09）| 同缺 rename；但「未裁决零写入」是硬不变量 | **借鉴「冲突未决零写入 + 基线记本地哈希」两条**（对应 SYN-05/SYN-09）|
| 自动同步缺省 | `conflictPolicy='local'` + `force` 推（SYN-05）| 未裁决即不动 | **本仓更激进**，见 §14 |
| 选择性范围保护 | 墓碑检测用 `listAllUnitIds` 缺席即跳过 | `modules` 声明范围外 skip | **已等价**，无需改 |
| 凭据闸 | `matchSecretValuePattern` 单一来源 + `includeSecrets` 缺省 false | 文件名闸 + 内容闸 | 本仓单一来源更整洁；**其 `.npmrc` 案例值得补进本仓敏感名单**（真实事故：Windows `store-dir` 随包进 Linux）|
| 传输 | git / webdav / s3 / gist + 条件写 | webdav / cloud | **本仓领先** |

**是否采用**：①「冲突未裁决 = 零写入」作为自动同步缺省（**采用，S**，收口 SYN-05）；②裁决后基线记本地哈希（**采用，S**，收口 SYN-09 的一半）；③`.npmrc` 类包管理器配置进敏感名单（**采用，S**）；④基线单 JSON 存法（不采用，本仓已有 `sync-state` 形态，SYN-01 要修的是原子性而非结构）。

### 12.4 dickpy/dsh-cloud-sync — Provider / Snapshot / 云存储 / 同步策略

| 项 | 内容 |
|---|---|
| 仓库结构 | `lib/{core,index,client}.js`、`test/`、`docs/`、`.dshsyncignore.example` |
| 可读性 | **可读但集中**：provider、加密、快照、历史、OAuth 全在 `lib/core.js`（**1774 行**），无模块拆分 |

**机制（`lib/core.js`）**

| 常量/函数 | 值 / 行为 | 意义 |
|---|---|---|
| `SCHEMA` | `'dsh-cloud-sync/v1'`（`:10`）| 顶层格式标识 |
| `CONFIG_FILES` | `['package.json','pnpm-lock.yaml','cordis.patch.yml','cordis.yml','pnpm-workspace.yaml','.npmrc']`（`:11`）| **锁文件与档案声明面列为同步对象** —— 正对本仓 PW-02 的缺口 |
| `DEFAULT_IGNORES` | `node_modules/.pnpm/.git/.env/.credentials.yaml` 等（`:12`）| 忽略面 |
| `MAX_SOURCE_BYTES` | 100 MiB（`:13`）| 单次同步源上限 |
| gist 约束 | 对象 700 KB、文件 200 个、前缀 `dsh-cloud-sync-v1-`、标记文件（`:14-17`）| 小分片协议写进常量 |
| OAuth | GitHub **device flow**：`login/device/code` + `login/oauth/access_token`，硬编码 `DEFAULT_GITHUB_OAUTH_CLIENT_ID`（`:19-21`）| 零配置云认证 |
| 历史 | `HISTORY_INDEX='snapshots/history/index.json'`、`HISTORY_LIMIT=30`、`MAX_LOCAL_BACKUPS=10`（`:28-30`）| **本地快照有索引文件** |
| 加密 | `scryptSync` + `createCipheriv`，`ENCRYPTED_FORMAT='dsh-cloud-sync/encrypted/v1'`，`encryptionKeys` Map 缓存派生密钥（`:32,35`）| 同步快照加密 |

**优点**：①**快照历史有索引文件**（+ 上限 30），列举历史不必逐目录读 —— 正对 §5 Q4 的「无索引」缺口；②锁文件与 `.npmrc` 显式纳入同步对象，迁移后环境一致；③device flow 让云通道零配置。

**限制**：①**单文件 1774 行**，provider / 加密 / 历史 / OAuth 全耦合，可测性差；②device flow 需自建 OAuth 应用（硬编码 client id）；③未见条件写/并发保护（历史是覆盖式写入）；④只用 gist/单云，无 S3/WebDAV 抽象。

**与本仓比较**：①**快照索引**：本仓无索引（逐目录读 `snapshot.json`）⇒ 借鉴「一个索引文件 + 上限」的形状（**采用，S**），但落点应在备份域而非同步域；②传输抽象：本仓 4 通道 + 条件写 + 祖先副本，**明显领先**；③单文件巨型模块：本仓按域拆分（`sync/` 近百文件），**不采用**。

**是否采用**：①快照历史索引文件（**采用，S**，见 §14.3）；②锁文件纳入同步（**部分采用**：可选、默认不勾，见 PW-02）；③device flow（不采用：本仓已有 4 通道 + 凭据槽位，多一条认证面不划算）。

### 12.5 lire1131/dsh-undo-savepoint — Blob / Snapshot / Undo-Redo / 离线恢复

| 项 | 内容 |
|---|---|
| 仓库结构 | `lib/{base,core,snapshot,instances,scan,session,health,zip,i18n,client}`、`spec.json`、`tools/` |
| 可读性 | **完全可读**（ESM + 中文注释）|

**机制**

| 文件 | 行数 | 机制 |
|---|---|---|
| [lib/snapshot.mjs](https://github.com/lire1131/dsh-undo-savepoint/blob/main/lib/snapshot.mjs) | 263 | 快照创建/列举/跨机预检/自动清理；**载荷走 `writeBlob` 内容寻址**（`blobDir`）+ `writeManifest` + `writeVault`；`SENSITIVE_DESTS` + `REDACTED_PLACEHOLDER` 在**收集期**就脱敏敏感 env/yaml；`preflightSnapshot` 解析 `profile-cordis.patch.yml` 判跨机可移植 |
| [lib/instances.mjs](https://github.com/lire1131/dsh-undo-savepoint/blob/main/lib/instances.mjs) | 304 | 多实例（端口 × home × profile）：优先级 `--home > --instance > DSH_HOME > settings.current > 默认`；名字只允许 `^[A-Za-z0-9._-]{1,64}$`；**「端口只承担身份与存活探测；快照数据一律从 home 读，不做离线代理写」** |
| [lib/zip.mjs](https://github.com/lire1131/dsh-undo-savepoint/blob/main/lib/zip.mjs) | 187 | 零依赖 ZIP（`deflateRawSync`/`inflateRawSync`），**明确声明不支持 ZIP64 / 加密 / 分卷 / 数据描述符**，理由是快照 5M/50M 门禁用不到 |

**优点**：①快照用**内容寻址 blob**（与本仓 `rollback-point.ts` 同思路）⇒ 天然去重；②敏感目标在收集期脱敏（本仓靠「凭据不进 sections + 导出密钥独立载荷」，等价但落点不同）；③多实例寻址把「库在哪」写成分级优先级并禁止隐式写；④ZIP 能力边界诚实声明。

**限制**：①不支持 ZIP64 ⇒ 单包上限 4 GiB，与本仓同类；②无逐项 WAL/续跑（撤销靠包重放）；③`spec.json` 之外文档较少。

**与本仓比较**

| 维度 | 本仓 | dsh-undo-savepoint | 判断 |
|---|---|---|---|
| 内容寻址 | 仅回滚点域（`core/rollback-point.ts`）；快照域逐快照整存（BK-03）| 快照域即内容寻址 | 借鉴「统一 blob store」形状；**但先量化**（BK-03）|
| 多实例寻址 | 档案（profiles）+ 运行时登记；快照按 home 单根 | 端口 × home × profile 多实例浏览 | **P3 候选**：只有真的跑多 home 才值 |
| 脱敏时机 | 收集后按 `includeSecrets` + 凭据分区排除 | 收集期按目标名脱敏 | 本仓「值不进 sections」更彻底，**无需改** |
| 崩溃续跑 | 有（四判据）| 无 | **本仓领先** |

**是否采用**：①快照 blob store 统一（**待量化，P2**）；②多实例浏览（**P3 可选**）；③ZIP 能力边界声明（**采用，写成文档一行**）。

### 12.6 竞品设计评估（结论）

**明显优于本仓、值得立刻采用的（4 条）**

| # | 设计 | 来源 | 落地到本仓哪条问题 |
|---|---|---|---|
| 1 | scrypt `maxmem = 128*N*r*2 + 1MiB` 显式放宽 | dsh-backup `lib/encrypt.js:55` | **SEC-07** |
| 2 | 导入 journal 用条目身份（dev/ino/birth/sha256）判续跑，绝不以「备份不存在」推断成功 | DSH-Portable `launcher/data-import-journal.mjs:18-31` | **IE-04** |
| 3 | 冲突未裁决 = 零写入；裁决后基线记本地哈希 | dsh-backup-sync `lib/apply.js:12-22` | **SYN-05 / SYN-09** |
| 4 | 快照历史索引文件 + 上限 | dsh-cloud-sync `lib/core.js:28-30` | BK 域「无索引」缺口（§5 Q4）|

**先进但不适合本仓（3 条）**

| # | 设计 | 为什么不采用 |
|---|---|---|
| 1 | Electron 启动器 / runtime capsule / 发布闸门 json | 本仓是 **DSH 插件**，不是宿主发行版；引入会把插件变成发行工程（不可逆的定位变化）|
| 2 | GitHub device flow 硬编码 client id | 需自建 OAuth 应用；本仓已有 4 通道 + 凭据槽位，多一条认证面不划算 |
| 3 | 单文件 1774 行的「全在 core」结构 | 与本仓按域分层相反；作为负面样例记录 |

**值得局部借鉴（3 条）**

| # | 设计 | 用在哪 |
|---|---|---|
| 1 | 救援脚本随备份包旅行 | 本仓已有 `dcm web` 救急台；只差把入口写进包内 manifest 一步（P3）|
| 2 | 包管理器配置进敏感名单（含真实事故说明）| 补进「文件名闸」（本仓当前只有值形状闸）|
| 3 | 锁的「绝不误踢活锁」判据（只认 ESRCH）| 本仓 `readLockState` 的回收判据可对齐（UI-05 同域）|

**会增加不必要复杂度的（2 条）**

| # | 设计 | 判断 |
|---|---|---|
| 1 | 引入 Git Merge 语义做行级三方合并 | 本仓冲突是**文件级 + 用户裁决**；加行级合并要引入 diff3 与 hunk 模型，收益只在「同一文件两端都改」这一小类；不做（§18）|
| 2 | GFS 月/年分层立刻上 | 本仓保留策略是 `SNAPSHOT_RETENTION_LIMIT=10` + pinned 豁免；先量化增长再决定（§18）|

**本仓已经领先的领域（4 条，保留）**

1. **恢复崩溃续跑**（`judgeRestoreResume` 四判据 + 逐动作 WAL）：5 个竞品无一具备同等判据。
2. **传输层**：git / webdav / s3 / gist 四通道 + 条件写 + 祖先副本只落密文 + 会话 GFS 保留。
3. **ZIP 读侧上限**：条目 10 000 / 总 500 MiB / 比 200，全部比竞品严格。
4. **凭据纪律**：`includeSecrets` 缺省 false + 凭据值零回读 + 导出密钥独立载荷 + 全链路 `redact`。

**未来可能形成实际威胁的（2 条）**

| # | 威胁 | 依据 |
|---|---|---|
| 1 | DSH-Portable 的**整环境封装**（runtime capsule + 档案级迁移）| 它解决「换机 = 整套环境起来」，本仓只覆盖数据面；一旦用户接受「装个启动器」的形态，本仓迁移价值被压到数据层 |
| 2 | dsh-cloud-sync 的**零配置云同步**（device flow）| 用户对「登录即用」的容忍度高于「填 WebDAV/S3 凭据」；本仓通道更强但门槛更高 |

**事实边界**：以上 5 仓均在 `main` 可读；未核对各自 release 版本与 CI 状态，未运行其测试，未做许可证兼容性判断（本节只做设计比较，不做采购/合规结论）。

## 13. Architecture Gap Matrix

### 13.0 汇总

| 域 | 前缀 | 条数 | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| 备份与恢复 | BK | 5 | 0 | 2 | 3 | 0 |
| 导入导出 / Bundle | IE | 6 | 0 | 3 | 2 | 1 |
| 安全 | SEC | 12 | **1** | 4 | 4 | 3 |
| 同步 | SYN | 14 | 0 | 3 | 7 | 4 |
| 适配器 / 迁移 / 外部来源 | AD | 8 | 0 | 0 | 5 | 3 |
| Profile / Workspace | PW | 3 | 0 | 1 | 1 | 1 |
| UI / CLI | UI | 7 | 0 | 1 | 4 | 2 |
| 文档与台账 | DOC | 3 | 0 | 0 | 0 | 3 |
| **合计** | — | **58** | **1** | **14** | **26** | **17** |

**优先级判据（与任务书一致）**：P0 = 数据安全 / 数据丢失 / 严重漏洞 / 核心操作可靠性；P1 = 核心架构瓶颈 / 同步正确性 / 迁移准确性 / 明显维护成本；P2 = 性能、扩展性、可维护性、UX；P3 = 非必要优化与长期探索。

**两条纪律**：①**没有一条 P0/P1 是「尚未实现的新功能」** —— 58 条全部对应已存在的代码行为、已存在的承诺缺口或已存在的错误语义；②UNKNOWN 不进本矩阵，凡证据不足者已在 §5-§11 各自标 UNKNOWN，不在此计分。

**复杂度口径**：S ≈ 半天内、单文件 + 测试；M ≈ 1-3 天、跨 2-4 文件 + 测试；L ≈ 1-2 周、跨模块 + 兼容性分析；XL ≈ 需要新的数据格式或新的协议语义。

### 13.1 备份与恢复（BK，5 条：P1×2 / P2×3）

核心数据安全域。**BK-01 / BK-05 是本域两条 P1**：不是缺功能，而是数据已经在盘上却没有出口（BK-01），而唯一能撤销那次恢复的副本又被 `prune` 连带销毁（BK-05）。

| ID | 模块 | 当前实现 | 问题 | 证据 | 竞品参考 | 影响 | 建议 | 优先级 | 复杂度 | 兼容性风险 |
|---|---|---|---|---|---|---|---|---|---|---|
| BK-01 | core/backup, restore | 恢复前把原文件复制到 `pre-restore-<ts>/` 反悔目录，结构 = home 相对路径树 | **数据在、产品无出口**：恢复完成后前端/`src/client`/`src/ui` 无任何入口列出或回到该目录 | `src/core/restore.ts (attempt 目录)`；`grep preRestoreDir src/client src/ui` 零命中 | dsh-backup 恢复前挪旁 `.dsh.pre-restore-*` 并由救援台 `list/restore` 可见；dsh-backup-sync `lib/apply.js:35-38` 的 pre-restore 目录本身是可还原的包 | 一次错误恢复只能在文件管理器里手工找目录，普通人等于没有撤销 | ① 报告与快照列表暴露 attempt 目录；② 把它登记成只读快照或作为 `restore` 的替代源（目录结构已是 home 相对树，无需格式转换） | P1 | M | Low |
| BK-02 | restore | `planRestore` 支持 targets 过滤，但所有入口都传全集 | 无选择性恢复入口（单文件/子目录） | `src/routes/snapshots.ts:293` 的 `/snapshots/file-diff` 已能逐文件列差异；`planRestore` 接收 targets | dsh-undo-savepoint 的快照按 dest 分单元，天然可选 | 恢复一个配置文件必须恢复整个快照 | 只读端点 `/snapshots/file-diff` 的下钻结果直接作为 `planRestore` 的 targets 入参 | P2 | M | Low |
| BK-03 | core/backup | 每个快照独立整存 blob，无跨快照内容寻址 | 同一份大文件（sessions 日志）在 10 个快照里存 10 份 | `src/core/backup.ts` snapshot 写入路径；保留上限 `SNAPSHOT_RETENTION_LIMIT=10` | dsh-undo-savepoint `lib/snapshot.mjs` 用 `writeBlob` 内容寻址 + manifest | 磁盘放大（尤其会话分区） | **先做只读测量**（统计同 sha256 的重复字节占比），再决定是否引入 blob store；不先写实现 | P2 | L | Medium |
| BK-04 | core/backup | 快照列举逐目录读 `snapshot.json` | 无索引文件，快照多时列举是 O(n) 次 IO 且无法按时间/标签查询 | `src/core/backup.ts` 列举与 `prune()` 路径 | dsh-cloud-sync `HISTORY_INDEX='snapshots/history/index.json'` + `HISTORY_LIMIT=30` | 列表页变慢；无法做跨快照查询 | 加一个 `index.json`（写入时 append、启动时校验、缺失即重建），不改快照内部格式 | P2 | S | Low |
| BK-05 | core/backup | `prune()` 按保留数整目录 `rm(recursive)` | `pinned` 只保护快照本身；同一目录下的 `pre-restore` 反悔副本被**连带删除** | `src/core/backup.ts:725` `prune()`、`:758` `pinned` 跳过、`:769` `fs.rm(target,{recursive:true,force:true})` | dsh-backup 把反悔目录放在快照之外（`.dsh.pre-restore-*`） | BK-01 的反悔副本有有效期上限且不可见，超期后撤销能力消失 | 反悔副本独立保留策略（数量 + 天）并移出快照目录；删除前在报告里列出 | P1 | S | Low |

### 13.2 导入导出与 Bundle（IE，6 条：P1×3 / P2×2 / P3×1）

格式与判定语义域。IE-01 是唯一带前瞻性的 P1（现在不出事，但挡下一次分区结构升级）。

| ID | 模块 | 当前实现 | 问题 | 证据 | 竞品参考 | 影响 | 建议 | 优先级 | 复杂度 | 兼容性风险 |
|---|---|---|---|---|---|---|---|---|---|---|
| IE-01 | schema/versions | `isSupportedSectionDataVersion` 要求分区 `dataVersion` **恰好相等** | 版本轴不对称：全局 schema 轴有迁移机制但恒 1 用不上；分区轴需要迁移却没有机制 ⇒ 任一分区结构升级即旧包整体不可导 | `src/schema/versions.ts:69`；known-gaps G-05 已登记「部分修复」；`src/core/analyzer.ts` 调用点 | dsh-backup-sync 显式 schema 迁移 + 断言 | 未来升 `sessions`/`pluginFiles` 载荷结构时用户旧包全废 | 改为「区间兼容 + 每分区迁移函数表」：`min..max` 可接受区间，越界才拒；迁移函数复用 `src/schema/migrations/` | P1 | M | Medium |
| IE-02 | import 执行 | `rollbackOnError` 三处默认值不一致（plan 侧 / route 侧 / 引擎侧） | 同一字段三处缺省不同 ⇒ 同一包不同入口行为不同 | `src/core/import-planning`、`src/routes/import.ts`、`src/core/import*` 三处默认参数（§6.2 表） | — | 「导入失败自动回滚」的承诺取决于入口，难解释 | 单一常量 + 一处默认；三处引用同一符号并由测试钉住 | P1 | S | Medium |
| IE-03 | export 装配 | 导出路径三处装配 + 离线 CLI 第二套收集器 | 同一语义两套实现，收窄收集面时易漏（`listRelPaths` 覆写要求） | `src/core/exporter*`、`src/routes/export*.ts`、`src/cli/export.ts` 的独立收集 | — | 新增分区或改收集口径时离线包与 GUI 包不一致 | 抽出唯一的 `collectForExport()`；CLI 只做参数映射 | P1 | M | Medium |
| IE-04 | import 执行 | 导入无 journal、无续跑入口；崩溃后靠启动对账兜底 | 「导入中断」没有可判定的续跑/回滚入口 | `src/core/import*` 无 WAL（对照 restore 域 `src/core/restore-resume.ts:106`） | DSH-Portable `launcher/data-import-journal.mjs:18-31` 的条目身份（dev/ino/birth/sha256）判续跑 | 中断后用户不知处于何处，只能重导 | 复刻 restore 域思路：导入前写 journal（条目身份 + 计划摘要），启动时按同一判据择「续跑 / 回滚 / 人工」；不可判定即 fail-closed | P2 | M | Low |
| IE-05 | cli | `dcm` 有 export/backup/restore/verify 等子命令 | 无 `import --plan/--apply` | `src/cli/help.ts` 命令表 | DSH-Portable 的离线导入 | 无 GUI 环境无法导入包 | 加 `import --plan/--apply`（复用 `core/import-planning`，写路径过 CLI 同一道门） | P2 | M | Low |
| IE-06 | utils/zip | `accept()` 把 `out.length` 累加到实例级 `totalUncompressed` | 同一归档内重复读同一条目会重复计入 ⇒ 可能误判超总量（假阳性） | `src/utils/zip.ts:439` | — | 极端情况下自己拒绝自己的合法包 | 按条目 id 记已计入字节；或改为按中央目录声明的解压总量一次判定 | P3 | S | Low |

### 13.3 安全（SEC，12 条：P0×1 / P1×4 / P2×4 / P3×3）

**全报告唯一 P0**。SEC-01 是「导入包 → 改写同步目标 → 发出凭据」的完整链路，四段都有源码证据。

| ID | 模块 | 当前实现 | 问题 | 证据 | 竞品参考 | 影响 | 建议 | 优先级 | 复杂度 | 兼容性风险 |
|---|---|---|---|---|---|---|---|---|---|---|
| SEC-01 | adapters/sync | `self` 白名单含 `sync/sync-config.json`，导入裸写；读取不校验 | 包可改写同步目标 ⇒ 下一轮同步把 token 发往包内 host | `src/adapters/self.ts:55-65`；`src/adapters/file-collection.ts:414-430`；`src/sync/sync-config.ts:176`/:299；`src/sync/git/git-transport.ts:1224-1246`；`src/ui/import-wizard.ts:260`（`strategy: merge`）；`src/core/conflict-decisions.ts:44-45` | dsh-backup「导入不触碰传输凭据」取向 | 凭据外泄 + 后续拉取覆盖本机配置 | ① `applyItem` 对 `sync/*.json` 调用与写路由同一校验；② host 策略（默认仅官方/gist 端点，自定义需显式确认并留审计）；③ token 与 host 绑定，host 变化即不注入并告警 | P0 | M | Medium |
| SEC-02 | sync | URL 校验只看 scheme/userinfo | 环回/私网/链路本地可作同步目标 | `src/sync/sync-config.ts:438-458`、:465-486、:720-734、:784-808 | 无（竞品同样薄） | 与 SEC-01 叠加即成包控 SSRF | 并入 SEC-01 的 host 策略一次改完 | P1 | S | Medium |
| SEC-03 | sync/git | 非 http(s) `repoUrl` 直接放行；无 `protocol.*` 配置 | `file://` 可指本机任意 git 仓 | `src/sync/sync-config.ts:446-456`；`src/sync/git/git-transport.ts:1159` | — | 本地仓库读取面；`ext::` helper 面未拦 | `validateRepoUrl` 改白名单 + git 调用恒带 `-c protocol.ext.allow=never` 与 `GIT_ALLOW_PROTOCOL` | P1 | S | Low |
| SEC-04 | sync/import | `sync-autosync.json` 在 `self` 白名单且 `self` 风险档 low | 导入预置自动同步开关/档位（当轮不生效，重启或下次改设置才装载）| `src/adapters/self.ts:57`；`src/schema/section-registry.ts:385`；`src/sync/autosync-config.ts:124`；`src/routes/sync.ts:1148`；`src/routes/backup.ts:231` | dsh-backup「调度配置不随包迁移」 | 已开启自动同步者下一轮按包内目标推送 | 导入把自动同步开关/档位列需人工确认项（或直接跳过） | P2 | S | Medium |
| SEC-05 | analyzer/integrity | checksum 只正向校验；表外条目仅 warning；文件分区按归档名写入 | 完整性承诺弱于声明；表外文件可落盘 | `src/utils/hashing.ts:36-38`；`src/security/integrity.ts:75-76`；`src/core/analyzer.ts:334-347`、:407-413 | dsh-backup「包内条目必须与清单一一对应」 | 完整性可绕过，且使 SEC-01 的投送不需改校验表 | 文件类分区落盘前要求条目在 checksums 表内；`extraEntries` 升为阻断（可按分区配置） | P1 | S | Low |
| SEC-06 | utils/paths | `isPathSafe` 只判 `..`/绝对/盘符/UNC/NUL | Windows ADS（`a.txt:s`）、设备名（CON/NUL/COM1）、尾点尾空格不拦 | `src/utils/paths.ts:33-42`；`src/utils/zip.ts:503` | — | 恶意条目可写 NTFS 备用数据流/异常路径 | Windows 下追加拒绝 `:`、设备名表、尾点/尾空格 | P2 | S | Low |
| SEC-07 | security/encryption | `validateKdfParams` 上界宽于 `deriveKey` 实际能力（无 `maxmem`） | 越界参数被归成 `BAD_PASSWORD`（实测 Node 默认 maxmem 先拦） | `src/security/encryption.ts:63-70`、:73-79、:147-152 | dsh-backup `lib/encrypt.js:55` 显式 `maxmem = 128*N*r*2 + 1MiB` | 当前仅错误码语义；补 maxmem 后若不收紧即真风险 | 收紧到 128·N·r ≤ 32 MiB 越界返 `UNSUPPORTED_FORMAT`；`deriveKey` 显式传两倍余量 maxmem | P2 | S | Low |
| SEC-08 | routes/kit | `writeJson` 只设 content-type + referrer-policy | 无 `nosniff`/CSP/frame-options，与救急台口径不一致 | `src/routes/kit.ts:96-103`；对照 `src/cli/web/http.ts:4-25` | — | 残余嗅探/嵌框风险（低） | `writeJson` 补 `x-content-type-options: nosniff` | P3 | S | Low |
| SEC-09 | routes | 65 处写方法仅 16 处过 mutation gate | 配置类写无并发保护/条件写 | `src/index.ts:2729-2768`；`src/routes/sync.ts:321`、:1163；`src/routes/me.ts` 7 条 POST | Gitea 类条件写 | 后写覆盖，无版本判据 | 对「会驱动后续网络/写盘」的配置引入 mtime/版本条件写或纳入锁 | P2 | M | Low |
| SEC-10 | docs/decisions | ADR-0002 用行号引用闸门 | 行号已漂移（实测指向 rollback 闭包与 rewind gate） | `docs/decisions/0002-encrypted-container-unlock-gate.md:28` vs `src/index.ts:3652`、:3691、`src/routes/import.ts:190` | — | 维护者按 ADR 找不到闸门 | 改符号引用而非行号 | P3 | S | Low |
| SEC-11 | utils/zip | `safeExtract`/`safeExtractHardened` 全仓无调用方 | 文件头宣称「整体拒绝」，实际 CRC/比例校验在惰性读阶段 ⇒ 中途失败留部分文件 | `src/utils/zip.ts:538`；`src/security/zip-security.ts:72-109` | dsh-backup 的 zip 读侧统一入口 | 现网不受影响（导入走内存）；潜伏误用 | 要么删除两个导出，要么把校验前移到落盘之前 | P3 | S | Low |
| SEC-12 | sync/git | `validateRepoUrl` 只看 scheme/userinfo；repoUrl 直接进 git argv | 以 `-` 开头的 repoUrl 被 git 当选项（参数注入），非 http(s) 也未拦 | `src/sync/sync-config.ts:438-459`；`src/sync/git/git-transport.ts:586`（ls-remote）、`:711`（clone）| dsh-backup 的传输层不拼 user 输入 | 可让 git 读任意本地仓/触发 helper | scheme 白名单 + argv 恒带 `--` + `-c protocol.ext.allow=never` | P1 | S | Low |

### 13.4 同步（SYN，14 条：P1×3 / P2×7 / P3×4）

条目最多的域。P1 全部落在「正确性」（墓碑跨设备、GC 安全、缺省覆盖）。

| ID | 模块 | 当前实现 | 问题 | 证据 | 竞品参考 | 影响 | 建议 | 优先级 | 复杂度 | 兼容性风险 |
|---|---|---|---|---|---|---|---|---|---|---|
| SYN-01 | sync/state | `saveSyncState` 走原子写（`createSnapshotFs` → `atomicWriteFile`）；`loadSyncState` 形状不对即抛 | 状态文件不可解析后**无自愈路径**（全仓无修复代码，只读诊断）| `src/sync/sync-state.ts:171-232`（:179 抛 `sync.state.notObject`）、`:258`；`src/sync/fs.ts:35` | dsh-backup-sync 的 baseline 落盘与坏形状处理 | 一次外部损坏 = 同步永久不可用；手删即丢 deviceId 与 ancestor 指针 | 坏形状时把原文件改名备份 + 重建空状态（保留 deviceId），并给只读诊断端点 | P2 | S | Low |
| SYN-02 | sync/tombstone | 墓碑只吃本机 state | 不跨设备传播，旧快照复活已删会话 | `src/sync/sync-engine.ts:1109-1138`、:959、:988-990；`src/sync/sync-state.ts:81` | undo-savepoint 的全局 blob 台账（§12）| 隐私/正确性：删除无法在多设备间生效 | `computeSessionBookkeeping` 入参加 `remoteTombstones`（远端 manifest 去重后减去本机现存），合并数进 warnings | P1 | M | Low |
| SYN-04 | sync/webdav,s3 | 引用集只来自索引；引用者 404 当无引用（索引缺失分支已 fail-closed）| 假 404 / 孤儿快照让在用 blob 被删，不可恢复 | `src/sync/webdav-transport.ts:676`；`src/sync/s3-transport.ts:719-720` | undo-savepoint `pruneOrphanBlobs`（先写 manifest 再 GC） | 快照不可读（`sync.blobMissing`），G-35 已登记 | 404 也放弃本轮 GC；中期补列举原语（PROPFIND/ListObjectsV2） | P1 | S / XL | Low |
| SYN-05 | sync/autosync | 缺省 `conflictPolicy='local'` + `force` 推 | 缺省覆盖远端最新 | `src/sync/autosync-config.ts:56-63`；`autosync-scheduler.ts:731-739`；`sync-engine.ts:877` | dsh-backup-sync「冲突未裁决 = 零写入」（`lib/apply.js:12-19`） | 远端最新改动只在历史快照可见 | 首轮或远端有新快照时强制 `ask`；历史记录标 `forced=true` | P1 | M | Medium |
| SYN-06 | sync/engine | 无协议层 journal | upload 后崩溃只能靠拦截 | `src/sync/sync-engine.ts:975`→:982、:1220-1233 | DSH-Portable 的 journal 形状 | 用户看到「远端已推进」但无续跑/确认入口 | push 前写 `inflight{snapshotId,startedAt}`，成功后清；命中时提示「上次可能已完成」 | P2 | M | Low |
| SYN-07 | sync/engine | `writeMergeBaseline` 会清 `pendingMerge`，push 与 applyItems 不清 | 注释承诺的界面不存在；两条路径留下陈旧记录 | 写/清 `sync-engine.ts:1683/:1702/:1743/:1852-1853`；读仅 `sync-state.ts:222`；push `:982-991`、applyItems `:2152-2159` 不清 | — | 文档/注释与实现对不上 | 接线（status 暴露 + 同步页提示）或删字段撤承诺；两条路径补清理 | P2 | S | Low |
| SYN-08 | sync/merge | 只按 `relativePath` 比较 | 无 rename 语义 ⇒ 两份副本零冲突 | `src/sync/merge.ts:271-273`、:332；`merge.test.ts` 无 rename 用例 | dsh-backup-sync 同样无 | 用户看到「多一份」不知哪份新 | 加「同内容异路径」检测（祖先路径消失 + 另一侧新路径字节等于祖先 ⇒ 判 rename），先补测试 | P2 | L | Medium |
| SYN-09 | sync/engine | `useRemote` + 远端缺分区 ⇒ `pendingConflicts` | 该组合永不可解，基线不推进 | `src/sync/sync-engine.ts:1655-1660`、:1608 注释 | dsh-backup-sync「裁决后基线记本地哈希」 | 用户只能改选 `keepLocal` 才能脱身 | 裁决层把该组合降级为整分区删除计划项（需 adapter 支持删除），或 UI 禁用并说明 | P2 | M | Medium |
| SYN-10 | adapters/self | 载荷 = 剔除运行态后的字节，apply 直写 | 应用远端 `self` 会清掉本机 `lastRun*`/`consecutiveFailures` | `src/adapters/self.ts:221`、:91-100、:80 注释；`file-collection.ts:247-257`、:426 | — | 自动同步间隔门控与失败计数归零（可能立刻多跑、丢告警） | 导出保留完整字节只在 hash 前剔除；或 apply 对调度配置做「保留本机运行态键」的合并写 | P2 | M | Medium |
| SYN-11 | sync/engine | `catch { continue }` | 导出失败被当成「没变化」 | `src/sync/sync-engine.ts:1414-1425` | — | 读不出的分区改动静默不上行 | 收集 failures，非空即返回「有变化」+ 告警码 | P2 | S | Low |
| SYN-12 | sync/transport | 条件写判定三处各写；`isPreconditionFailedStatus` 零调用者 | 契约无能力声明，口径易漏 | `src/sync/transport.ts:117-121`；`s3-transport.ts:72-74`；webdav 内联 412 | — | 新增通道靠人记 | 收进 `isConcurrentWrite(status, sentConditional)` 唯一实现；`SyncTransport` 增只读 `capabilities` 并由一致性测试钉住 | P3 | S | Low |
| SYN-13 | sync/risk | `firstSync` 参数存在但生产恒 false | 首轮无额外保护（注释/文档承诺不存在） | `src/sync/risk.ts:11`、:56、:104-107；`autosync-scheduler.ts:678`、:954；`sync-engine.ts:1578` | — | 安全档位形同虚设 | 实现「基线为空 ⇒ 全进 review」，或删分支与注释 | P3 | S | Low |
| SYN-14 | sync/merge | `advanceRemoteId` 只改 `lastSnapshotId/lastSyncAt` | 本地删分区 + 远端未改 ⇒ 后续恒判「有本地改动」 | `src/sync/merge.ts:332`；`sync-engine.ts:1680-1691`、:1744-1747` | — | 多一轮无谓上行/自动同步触发（自愈） | 推进基线时同步重算受影响分区 hash 或清除该分区记录 | P3 | S | Low |
| SYN-15 | sync/git | GC 的 push 未带 `requirePushToken` | 只读权限 token 走 GC 时错误分类不同 | `src/sync/git/git-transport.ts:1364` vs :504、:573 | — | 错误提示误导 | 与 upload/delete 对齐 | P3 | S | Low |

### 13.5 适配器 / 迁移 / 外部来源（AD，8 条：P2×5 / P3×3）

无 P0/P1：契约已能表达现状，问题都是「引擎替适配器干活」与「证据等级虚高」。

| ID | 模块 | 当前实现 | 问题 | 证据 | 竞品参考 | 影响 | 建议 | 优先级 | 复杂度 | 兼容性风险 |
|---|---|---|---|---|---|---|---|---|---|---|
| AD-01 | adapters/backup | 快照知识集中在引擎 switch | 契约有 `snapshot()/rollback()`，15 类适配器零覆写 | `src/core/types.ts:1269-1272`；`src/core/backup.ts:309-431`、:484-485；`src/core/rollback.ts:137`；grep `async snapshot(` 零命中 | dsh-backup 的快照逻辑按模块归属 | 新增分区必须在引擎 switch 加分支，漏改即静默不进快照 | 各分支下沉为 `adapter.snapshot()`；引擎只留 default 兜底 + `never` 穷举 | P2 | M | Low |
| AD-02 | migrations | 迁移分支不可达；v1→v2 恒等 | 升版本会产出假告警 | `src/schema/versions.ts:18/21/45`；`analyzer.ts:351/361`；`migrations/v1-to-v2.ts` | dsh-backup-sync 显式 schema 迁移 + 断言 | 未来升 v2 时迁移「看起来成功」 | 补「必须改文档」断言 + 端到端用例 | P2 | S | Low |
| AD-03 | adapters/pluginFiles | 自实现 186 行 | 未复用基类的**单文件字节闸门**（`MAX_FILE_SECTION_BYTES`）；链接告警与保留路径防线已复用 | `src/adapters/plugin-files.ts:12`/`:92`（链接告警）、`:157`（保留路径）、`src/adapters/file-collection.ts:48`（闸门，全仓仅基类引用）| DSH-Portable 的统一文件收集器 | 单插件文件超限时无同口径拦截 | 继承基类或抽共享工具，只补字节闸门 | P3 | S | Low |
| AD-04 | adapters/workspaces | `finalizeImport` 在所有 `applyItem` 之后执行（jsdoc 自陈顺序），`note.failed > 0` 升级为 warning | 未挂载 `sessions` 时工作区↔会话关联登记不上（有 warning，不静默失败）| `src/adapters/workspaces.ts:235-248`、`:258-263`；`src/schema/section-registry.ts` applyOrder | — | 该组合下关联信息缺失 | 计划期用 `requiresSections` 前置校验（依赖 AD-01 的契约扩展）| P2 | S | Low |
| AD-05 | foreign | 30 源：measured 5 / documented 2 / fixture 23 | 23 源仅夹具验证，真机布局一变即 nothing-to-import | `src/foreign/registry.ts:81-86`；`truth-table.ts` 各行 | — | 「支持 30 个 Agent」的可信度被高估 | 逐源真机 smoke 把 `evidence` 升 measured；未升的界面文案按 fixture 口径 | P2 | L | Low |
| AD-06 | foreign/model-tools | GUI + CLI 两入口同源 | model-tools 面零入口 | `src/routes/foreign.ts:89/101`；`src/cli/import-source.ts:156`；`src/core/model-tools.ts:346-449` | — | Agent 无法自行调用外部来源导入 | 视需要在 model-tools 暴露只读 sources 列举 | P3 | S | Low |
| AD-07 | routes | 计划项默认值写三处 | `createImportPlan` 默认参数重复 | `src/routes/consult.ts:83-84`、`market.ts:211-212`、`sync.ts:983`（注释自陈镜像） | — | 默认值漂移 | 抽 `planWithDefaults()` | P2 | S | Low |
| AD-08 | schema | 两条版本轴各写一半 | 无「改版本要同时改哪两处」的书面耦合 | `src/schema/versions.ts:69`；`src/schema/section-registry.ts:137` | — | 改分区 `dataVersion` 易漏一侧 | 两处写死耦合注释 + 触发测试名 | P3 | S | Low |

### 13.6 Profile / Workspace（PW，3 条：P1×1 / P2×1 / P3×1）

PW-01 是唯一 P1：删档案 = 不可逆删树。

| ID | 模块 | 当前实现 | 问题 | 证据 | 竞品参考 | 影响 | 建议 | 优先级 | 复杂度 | 兼容性风险 |
|---|---|---|---|---|---|---|---|---|---|---|
| PW-01 | profiles | `remove()` 直接 `rmSync(recursive, force)` | 删除档案不可逆，删除前无快照 | `src/profiles/dsh-profile-manager.ts:357-364`（`:363` 删除）、头注释 `:21`/`:348` | dsh-undo-savepoint 的 undo 点即删除前快照 | 用户删错档案 = 整套插件树与补丁层消失 | 删除前落一份「档案声明面 + 锁文件」快照；UI 提供「撤销删除」入口 | P1 | L | Medium |
| PW-02 | profiles/sync | 声明面由 `plugins` 分区覆盖；锁与载荷不覆盖；无 profiles 分区 | 「整机迁移 = 完整环境」的预期与实现不符 | `src/core/patch-layers.ts`；`plugins.test.ts:530-552/784-801`；`section-registry.ts:190-420`（无 profiles）；`src/adapters` grep `pnpm-lock` 零命中 | DSH-Portable 环境封装思路；dsh-cloud-sync `CONFIG_FILES` 含锁文件 | 跨机迁移后插件树可能与源机不同，用户不知情 | 导出包 manifest 显式声明「未含锁文件与 node_modules」；锁文件作可选条目（默认不勾） | P2 | M | Low |
| PW-03 | profiles | 复制中断靠残留标记识别 | 台账 tech-debt #5 的严重度未随代码更新（代码已能列/删半截副本） | `dsh-profile-manager.ts:383/391/456/471`；`docs/maintenance/tech-debt.md:20`（tech-debt #5）；`src/routes/recovery.ts:293`/`:339-344` | — | 维护者按台账低估现状 | 更新台账严重度并指向 `listIncompleteCopies` | P3 | S | Low |

### 13.7 UI / CLI（UI，7 条：P1×1 / P2×4 / P3×2）

UI-02 是唯一 P1：长操作状态分散在组件本地 state。

| ID | 模块 | 当前实现 | 问题 | 证据 | 竞品参考 | 影响 | 建议 | 优先级 | 复杂度 | 兼容性风险 |
|---|---|---|---|---|---|---|---|---|---|---|
| UI-01 | i18n | 三套字典 + 键指纹冻结 | 新增文案要写三处；引擎键只许追加 | `src/client/locales.ts`；`src/ui/i18n.ts`；`src/core/messages-core.ts`；`src/core/engine-locale.test.ts` | — | 维护成本，易漏译 | 保留分层，加「同一 key 三处齐全」守卫测试 | P2 | L | Medium |
| UI-02 | client/run-store | 6 个 TaskKind 覆盖 6 类长操作 | 复制/恢复/修复/清理/自更新用组件内 `useState(busy)` | `src/client/run-store.ts:94/1922`；`src/client/RecoveryPanel.tsx:417/660/701` | — | 切页丢进度、跨页状态不一致 | 把这 5 类纳入 `RunKind` + `watchRunning`，先在 recovery 面板接 `restore` | P1 | M | Low |
| UI-03 | core/run-registry | AbortController 仅 import/session-export 接进取消语义 | 8 种 RunKind 里 6 种无取消入口 | `src/routes/import.ts:224/229/388`；`session-export.ts:157/235`；`src/core/run-registry.ts:27` | dsh-undo-savepoint 的可中断采集 | 手动长操作只能关窗口 | 为 restore 增加 abort，走 `judgeRestoreResume` 的续跑语义而非硬中断 | P2 | M | Medium |
| UI-04 | routes | `verifyBackupZip` 无 HTTP 入口 | GUI 导出的包无法在 GUI 里验证 | `src/core/backup-verify.ts:140`；调用者全在 `src/cli/*` | dsh-backup 的 verify 命令 | 用户必须开终端才知道包能不能恢复 | 加只读端点 `/verify-backup`（无写路径，过只读围栏） | P2 | S | Low |
| UI-05 | 写入门 | GUI 与 CLI 各读一次 SAFE MODE / 锁 | 判据两处实现 | `src/index.ts:2729-2768`；`src/cli/actions.ts:254/278/438-505` | — | 两处口径漂移风险 | 抽纯函数 `readWriteGateState()`，门的差异留调用层 | P2 | S | Low |
| UI-06 | client/run-store | `watchRunning` 每 500 ms 整份 stringify | sessionStorage 写放大 | `src/client/run-store.ts:1472/1751/1001` | — | 长任务期间主线程抖动 | 改为脏字段增量 patch | P3 | S | Low |
| UI-07 | ui/errors | `toActionableError` → redact 幂等 | 无问题，仅记录设计正确 | `src/ui/errors.ts:79/95` | — | — | 保持（作为正面样例） | P3 | S | Low |

### 13.8 文档与台账（DOC，3 条：均 P3）

只影响维护效率。

| ID | 模块 | 当前实现 | 问题 | 证据 | 竞品参考 | 影响 | 建议 | 优先级 | 复杂度 | 兼容性风险 |
|---|---|---|---|---|---|---|---|---|---|---|
| DOC-01 | docs/modules | `docs/modules/architecture.md` 的计数与版本句未随代码更新 | 文档写 82 条路由与 `PLUGIN_VERSION 0.1.85`，实测 83 条与 `0.2.4` | `docs/modules/architecture.md:15`/`:19`/`:42`/`:44`/`:50` vs `src/index.ts:183` | — | 维护者按文档判断路由数与版本边界 | 改为符号引用（路由数由 parity 测试钉住），删掉硬编码版本 | P3 | S | Low |
| DOC-02 | AGENTS.md | 称「业务逻辑放 `src/ui/`」 | 与实际分层不符（业务在 `src/core/`、`src/sync/`；`src/ui` 是 view-model） | `AGENTS.md`「业务逻辑放 src/ui」；`src/ui` 零 import client | — | 新维护者按文档找错地方 | 改为「view-model 放 `src/ui/`，业务放 `src/core/`/`src/sync/`」 | P3 | S | Low |
| DOC-03 | docs/台账 | 已知缺口中部分条目已修复但未回填 | 台账与代码不同步（G-05 标「部分修复」、tech-debt #5 严重度失真等）| `docs/maintenance/tech-debt.md:20`、`docs/maintenance/known-limits.md` 与 `src/` 实际行为逐条对照（§5-§11）| — | 维护者按文档低估或高估现状 | 本轮审查结束后一次性回填（`fixed` / 降级 / 保留并写明理由）| P3 | S | Low |

## 14. Recommended Architecture

### 14.1 一条总判断：不要建「统一 Asset Model」，要「补齐契约的三处缺口」

任务书把统一 Asset Model / Adapter Contract / Migration Engine / Snapshot Engine / Three-way Merge / Storage Provider / Recovery Transaction 列为候选设计，**不代表必须全做**。本报告的判定依据是：现有 `ConfigAdapter` 契约（`src/core/types.ts:1171-1273`）**已经能表达** 17 个分区、3 种载体（内存对象 / 文件集合 / 外部命令）、4 种冲突裁决，以及「未实现即跳过删除检测」的诚实降级语义。

真正缺的不是「模型」，而是三处**契约执行**的缺口：

| # | 缺口 | 证据 | 后果 |
|---|---|---|---|
| 1 | 快照语义没下沉到适配器 | `snapshot()` / `rollback()` 在契约里，15 类适配器**零覆写**，知识全在引擎 switch（AD-01）| 新增分区漏改引擎分支即静默不进快照 |
| 2 | 版本轴没有区间语义 | `isSupportedSectionDataVersion` 要求精确相等（IE-01）| 任一分区升结构即旧包全废 |
| 3 | 恢复/导入没有统一的「可判定事务」 | restore 有 `judgeRestoreResume`（强），import 什么都没有（IE-04）| 同一个词「中断」在两个域有完全不同的可靠性 |

结论：**Adapter Contract 补三处 → 不新建模型层**。理由是可逆性：新建 Asset Model 会让 15 类适配器 + 快照 + 同步 + 迁移四处同时改数据结构，而收益只是「描述更统一」；补契约只改契约与它的一处执行点，且**不改任何落盘格式**。

### 14.2 A. 保持现有架构（明确不改，及原因）

| 模块 | 为什么保留 |
|---|---|
| **双面插件分层**（host `src/index.ts` / web `src/client/`，业务在 `src/core` + `src/sync`，`src/ui` 只做 view-model）| 这是本仓最大的结构资产；§12 里 1774 行单文件的正面对照说明分层值得保留。唯一要改的是 AGENTS.md 的错误描述（DOC-02）|
| **路由只经 `kit.endpoint()` + `registerRoutes()` + 围栏** | SEC 审计里「认证边界 = kit 围栏」这条判据成立且被 83 条路由共用；不改成中间件，是因为围栏在注册点统一包装，替换成本远大于收益 |
| **17 分区注册表**（`src/schema/section-registry.ts`）| 分区元数据（`defaultIncluded`/`portability`/`riskTier`/`applyOrder`）是导入计划、同步放行、UI 勾选三处的单一事实源；拆成「资产模型」会失去 `applyOrder` 这种**顺序语义** |
| **同步四通道 + 条件写 + 祖先副本只落密文 + 会话 GFS** | §12 对照下这是领先项；SYN 域的问题全是正确性补丁，不是架构错误 |
| **恢复四判据**（`judgeRestoreResume`）| 5 个竞品无一具备；只需要把 import 域补上同类判据，**不要**反过来把 restore 改简单 |
| **凭据纪律**（`includeSecrets` 缺省 false / 零回读 / 导出密钥独立载荷 / `redact` 全链路）| 这是本仓最强的安全不变量集合；SEC-01 的问题恰恰是它被 `self` 分区绕过了一次，修法是「补一道」而非「重构」 |
| **ZIP 读侧五道上限** | 全面严于竞品（§12.1 对照表），无需调整 |
| **Bundle 格式本体**（`manifest.json` + 分区载荷 + `checksums`）| 只改「判定」（checksum 表外拒绝、分区版本区间），**不改容器结构** ⇒ 旧包继续可读，见 §16 |

### 14.3 B. 局部重构（5 处，全部是「搬家 + 单一实现」）

| # | 动作 | 现状 → 目标 | 接口影响 | 关联问题 |
|---|---|---|---|---|
| B1 | **快照语义下沉** | 引擎 switch（`src/core/backup.ts:309-431`）→ 各适配器 `snapshot()` / `rollback()`；引擎保留 default 兜底 + never 穷举 | 内部接口；15 类适配器各加 `snapshot`（可实现为继承基类默认实现）| AD-01 |
| B2 | **导出收集唯一化** | 三处装配 + CLI 第二套 → 唯一 `collectForExport()` | 内部函数抽取；CLI 只做参数映射 | IE-03 |
| B3 | **写入门纯函数化** | GUI（`src/index.ts:2729-2768`）与 CLI（`src/cli/actions.ts:254/278/438-505`）各读一次 → 纯函数 `readWriteGateState()` | 纯函数 + 两个调用点；语义不变 | UI-05 |
| B4 | **计划默认值收敛** | 三处默认参数（`consult.ts:83-84` / `market.ts:211-212` / `sync.ts:983`）→ `planWithDefaults()` | 内部 | AD-07 |
| B5 | **条件写能力声明** | 三处各写判定 → `isConcurrentWrite(status, sentConditional)` 唯一实现 + `SyncTransport.capabilities` 只读字段 | 通道接口**新增可选只读字段**（向后兼容）| SYN-12 |

### 14.4 C. 核心架构升级（逐候选判定）

| 候选 | 判定 | 理由 | 若采纳，最小形状 |
|---|---|---|---|
| **统一 Asset Model** | **不做** | 现有 `SectionId` + `ConfigAdapter` 已表达全部语义（含 `applyOrder`、`portability`、`riskTier`）；新建模型要同步改快照/同步/迁移/UI 四处，收益仅是描述统一 | — |
| **Adapter Contract 扩展** | **做（最小）** | 三处缺口之一，且是可逆的接口扩展 | ①`snapshot?/rollback?` 由基类提供默认实现并逐步下沉（B1）；②`requiresSections?: SectionId[]`（AD-04 的顺序依赖显式化）；③`capabilities?: {deletable}`（为 SYN-09 的「整分区删除」提供能力位）|
| **Migration Engine** | **做（收窄版）** | 不是新建引擎，而是把现有 `src/schema/versions.ts` + `src/schema/migrations/` 从「全局轴恒 1、分区轴精确相等」改成「分区轴区间 + 每分区迁移函数表」（IE-01 + AD-02）| `SectionRegistry` 增 `acceptsDataVersions: [min,max]` + `migrate(payload, from)`；`isSupportedSectionDataVersion` 改区间判定；越界才拒并给明确错误码 |
| **Snapshot Engine** | **部分做** | 不需要新引擎（`src/core/backup.ts` 已是引擎），但需要补两件：**清单元数据**（index.json，BK-04）与**反悔副本独立生命周期**（BK-05 + BK-01）| `snapshots/index.json`（可缺失即重建）+ 反悔目录移出快照目录并单独保留策略；**不改快照内部文件布局** |
| **Three-way Merge** | **只补两点，不引 diff3** | 现有 `src/sync/merge.ts` 已是三方（base/local/remote）；缺的是 **rename 语义**（SYN-08，L 成本）与 **裁决闭环**（SYN-05/09）| 不引 Git merge / diff3 / hunk 模型；只加「同内容异路径」启发式与裁决后的基线推进 |
| **Storage Provider** | **不做** | 4 通道 + 条件写已覆盖；该抽象会与 `SyncTransport` 重复，且 SYN-04 的根因是「缺列举原语」而不是「缺抽象」| — |
| **Recovery Transaction** | **做（概念复用，不新建模块）** | restore 已有可判定事务，缺的是 import 侧同类；做法是把 `judgeRestoreResume` 的**判据形状**（journal + 指纹 + fail-closed）复制到导入，而不是抽象成通用事务框架 | 新文件 `src/core/import-journal.ts`（形状对齐 `restore-resume.ts`）；条目身份取 dev/ino/birthtimeNs/sha256，不可判定即 fail-closed |

### 14.5 D. 数据格式与兼容性（任何改动都必须先过这张表）

| 变更 | 旧版能读新格式 | 新版能读旧格式 | 需要迁移脚本 | 版本标记 | 可能破坏用户数据 | 安全回滚 |
|---|---|---|---|---|---|---|
| 快照目录新增 `index.json`（BK-04）| **是**（旧版忽略未知文件）| **是**（缺失即按目录重建）| 否 | 文件内 `version:1` | 否（索引只是加速）| 删文件即回退 |
| 反悔副本移出快照目录（BK-05）| **是**（旧目录仍在）| **是**（读取时两处都查）| 可选（一次性搬移）| 目录名带 legacy 后缀 | **是** —— 搬移期间崩溃会「一半在一半在旧位置」；用「先复制 → 校验 → 再删旧」两步 | 副本不删，双读窗口保留一个版本周期 |
| 分区版本区间（IE-01）| **是**（旧版仍精确相等判定，只读自己那代包）| **是**（新区间包含旧值）| 否 | `acceptsDataVersions` 落注册表，不改包内 manifest | **否**（判定更宽松，不改变载荷）| 收窄区间即可回退 |
| checksum 表外条目由警告升阻断（SEC-05）| **是** | **是** | 否 | 无 | **可能是** —— 历史包若带表外条目会被拒；须提供按分区豁免开关且默认只对新包生效 | 关掉开关即回到当前行为 |
| 同步状态文件改原子写（SYN-01）| **是**（JSON 形状不变）| **是** | 否 | 无 | 否 | — |
| Bundle 容器结构 | **不改** | **不改** | 否 | 现有 manifest 已带 schema 版本 | 否 | — |

**结论**：本报告推荐的所有改动里，**没有一处需要改 Bundle 容器结构或加密容器格式**；风险最高的两处（反悔副本搬移、checksum 收紧）都给出了双读窗口或开关。

### 14.6 E. 升级路线 —— 五个阶段，每阶段可独立交付

> 排序原则：**先修「已经在发生的数据/凭据风险」，再修「会静默出错但还没出事」的正确性，最后才是结构性收敛与量化型优化**。每阶段的完成标准都必须能被命令或测试验证。

#### Phase 0 — 安全封口（SEC-01 / SEC-02 / SEC-03 / SEC-12）

| 项 | 内容 |
|---|---|
| 解决什么 | 「导入包 → 改写同步目标 → 下一轮同步把 token 发往包内 host」这条完整链路（§8 有逐段证据）；任意 scheme 的 `repoUrl` 放行且原样进 git argv（`-` 开头会被当选项）；导入可预置自动同步（当轮不生效，重启或下次改设置后才生效）|
| 改哪些模块与接口 | `src/adapters/self.ts`（`sync/*.json` 移出裸写白名单或走同校验）、`src/sync/sync-config.ts`（scheme 白名单 + host 白名单 + 私网判定）、`src/sync/git/git-transport.ts`（argv 恒带 `--` + `-c protocol.ext.allow=never`）、`src/sync/autosync-config.ts`（开关/档位进「需人工确认」集）|
| 依赖 | 无（可与任何阶段并行）|
| 测试要求 | ①带 `sync-config.json` 的包导入后被拒或将 host 标为待确认；②token 与 host 绑定后 host 变化即不注入；③`file://`、私网 URL、`-` 开头的 repoUrl 一律被拒且不进 argv；④`sync-autosync.json` 不因导入而开启。用例放 `src/adapters/*.test.ts` 与 `src/sync/*.test.ts` |
| 风险 | host 白名单可能挡住合法自建端点 ⇒ 必须「默认严格 + 自定义显式确认 + 审计留痕」，不能一刀切拒绝 |
| 完成标准 | 上述 4 个用例全绿；`node scripts/check-doc-paths.mjs` = 0；`src/adapters` / `src/sync` 现有测试无回归 |

#### Phase 1 — 正确性硬化（SYN-02/04/05、BK-01/05、IE-02、SEC-05）

| 项 | 内容 |
|---|---|
| 解决什么 | 墓碑不跨设备、GC 把假 404 当无引用而在用 blob 被删、自动同步缺省覆盖远端；恢复反悔副本无出口且被 prune 连带删除；导入失败语义四个调用点不一致；导出 checksum 表外条目只告警不阻断（凭据类分区可绕过校验）|
| 改哪些模块与接口 | `src/sync/sync-state.ts`（坏形状自愈：原文件备份改名 + 重建空状态并保留 deviceId）、`src/sync/sync-engine.ts`（远端墓碑入参、引用者 404 放弃本轮 GC、`inflight` 记录）、`src/sync/webdav-transport.ts` / `s3-transport.ts`（GC fail-closed）、`src/sync/autosync-scheduler.ts`（首轮/远端更新强制 ask）、`src/core/backup.ts`（prune 不删反悔副本）、`src/routes/snapshots.ts`（暴露 attempt 目录）、`src/core/import*`（`rollbackOnError` 单一缺省）、`src/core/exporter*`（checksum 表外条目按分区阻断，默认只对新包生效）|
| 依赖 | BK-01 的「出口」可先只做只读列举，不依赖 BK-02 的选择性恢复 |
| 测试要求 | ①状态文件不可解析 → 自愈重建，不再抛 `sync.state.notObject`；②墓碑跨设备剔除计数进 report；③WebDAV/S3 引用者 404 → 本轮不 GC；④缺省策略下远端有新快照时不覆盖；⑤prune 后反悔副本仍在；⑥四个 `rollbackOnError` 调用点同一行为（参数化测试跑同一份断言）；⑦表外条目在新包导出/导入上被阻断、历史包可豁免 |
| 风险 | 缺省从 local 改 ask 会改变现有体感 ⇒ 需在 CHANGELOG 明写，并保留旧行为的手动开关 |
| 完成标准 | 七个断言全绿；`src/sync` 全量测试无回归；`CHANGELOG.md` 有对应 Unreleased 条目 |

#### Phase 2 — 语义闭环（IE-01、IE-03、SYN-09、SYN-10、SYN-11、AD-01、AD-04、UI-02、UI-05）

| 项 | 内容 |
|---|---|
| 解决什么 | 分区版本精确相等（挡下一次结构升级）、导出双实现、`useRemote` + 远端缺分区不可解、`self` 应用清掉本机运行态、导出失败静默、快照逻辑不分层、workspaces 依赖会话顺序、长操作状态分散、写入门两处 |
| 改哪些模块与接口 | `src/schema/versions.ts` + `src/schema/section-registry.ts`（`acceptsDataVersions` + `migrate`）、`src/core/exporter*`（`collectForExport`）、`src/sync/sync-engine.ts`（裁决降级 + self 合并写 + failures 告警）、`src/adapters/*`（snapshot 下沉 + `requiresSections`）、`src/client/run-store.ts`（5 类操作纳入 RunKind）、`src/index.ts` / `src/cli/actions.ts`（`readWriteGateState`）|
| 依赖 | AD-01 依赖契约扩展（`requiresSections` 先落，再下沉 snapshot）|
| 测试要求 | ①旧 dataVersion 的包在新版可导（区间）+ 越界包给出明确错误码；②GUI 与 CLI 导出同一输入的收集面一致（快照对比）；③`useRemote` + 缺分区不再产生不可解裁决；④应用远端 self 后本机 `lastRun*` 保留；⑤新增分区未写 snapshot 时引擎 never 穷举编译期报错 |
| 风险 | 契约扩展是内部接口，但 16 类适配器（覆盖 17 分区）要逐个过一遍 ⇒ 用基类默认实现，只让确有差异的分区覆写 |
| 完成标准 | `npm run typecheck` 通过（never 穷举在此生效）；新增用例全绿；`docs/spec/` 若有格式描述需同轮更新 |

#### Phase 3 — 产品化与可观测（BK-02、BK-04、IE-04、IE-05、UI-03、UI-04、AD-03、AD-05、AD-07）

| 项 | 内容 |
|---|---|
| 解决什么 | 无选择性恢复、快照无索引、导入无续跑、CLI 无导入、长操作不可取消、GUI 无法验证包、pluginFiles 自实现、外部来源证据等级虚高、计划默认值三处 |
| 改哪些模块与接口 | `src/routes/snapshots.ts`（子集恢复）、`src/core/backup.ts`（index.json）、`src/core/import-journal.ts`（新）、`src/cli/import.ts`（新 plan/apply）、`src/core/run-registry.ts`（restore abort → 续跑语义）、`src/routes/verify.ts`（只读验证端点）、`src/adapters/plugin-files.ts`（复用基类）、`src/foreign/registry.ts`（evidence 升级流程）|
| 依赖 | IE-04 依赖 Phase 1 的 journal 形状约定；UI-03 依赖 IE-04（取消语义要落在可续跑之上）|
| 测试要求 | ①子集恢复只动选中文件（同目录其他文件 mtime 不变）；②删除 index.json 后列表仍正确；③导入中断后重启给出「续跑 / 回滚 / 人工」三态之一；④`dcm import --plan` 与 GUI 计划一致；⑤验证端点只读（写路径 0 次）|
| 风险 | 给导入加 journal 会引入新落盘文件 ⇒ 必须 0600、必须「删掉即无条件重来」；不可判定时 fail-closed 会让用户卡住 ⇒ 必须给「人工确认」出口 |
| 完成标准 | 五个断言全绿；`docs/research/` 与本报告同步更新 |

#### Phase 4 — 量化门禁后的探索（BK-03、SYN-08、UI-01、PW-01/02、UI-06）

| 项 | 内容 |
|---|---|
| 前置门禁 | **先测后做**：①BK-03 先统计同 sha256 重复字节占比（低于阈值即不做）；②SYN-08 先统计真实 rename 场景频次；③UI-01 先统计新增文案的实际落点数量 |
| 解决什么 | 磁盘放大、rename 两份副本、三套字典维护成本、删档案不可逆 |
| 改哪些模块与接口 | 取决于测量结果；PW-01 的「删前快照 + 撤销入口」可独立先做（不依赖测量）|
| 测试要求 | 每项都需「不做也安全」的现状用例，避免把未实现当已实现 |
| 风险 | 这四项都是「做了更好、不做也不坏」；不设门禁会挤压 Phase 0-3 的维护预算 |
| 完成标准 | 测量报告 + 明确的做/不做结论（写进 `docs/research/` 与本报告 §18）|

## 15. Technical Upgrade Roadmap（汇总视图）

| 阶段 | 覆盖问题 ID | 条数 | 预计工作量 | 前置 | 交付判定 |
|---|---|---|---|---|---|
| Phase 0 安全封口 | SEC-01/02/03/12 | 4 | 2-4 天 | 无 | 4 个回归用例绿；包导入不再能改同步目标；`-` 开头的 repoUrl 不进 argv |
| Phase 1 正确性硬化 | SYN-02/04/05、BK-01/05、IE-02、SEC-05 | 7 | 1-2 周 | 无（BK-01 只做只读出口）| 7 个断言绿 + CHANGELOG 条目 |
| Phase 2 语义闭环 | IE-01/03、SYN-09/10/11、AD-01/04、UI-02/05 | 9 | 2-3 周 | Phase 1 | typecheck 通过（never 穷举）+ 5 个断言 |
| Phase 3 产品化 | BK-02/04、IE-04/05、UI-03/04、AD-03/05/07 | 9 | 2-3 周 | Phase 1、Phase 2 | 5 个断言 + 文档同步 |
| Phase 4 探索 | BK-03、SYN-08、UI-01、PW-01/02、UI-06 | 6 | 视测量结果 | 测量报告 | 做/不做结论落档 |
| 不单列（随手修）| SEC-04/06/07/08/09/10/11、SYN-01/06/07/12/13/14/15、IE-06、AD-02/06/08、PW-03、UI-07、DOC-01/02/03 | 23 | 随阶段顺手 | — | 见 §18 |

**覆盖核对**：58 = 4 + 7 + 9 + 9 + 6 + 23，每条 ID 只出现在一个位置，无重复计数。

## 16. Compatibility & Migration Risks

### 16.1 风险总表（只列本报告推荐改动引入的风险；现状风险见 §13）

| ID | 风险 | 触发条件 | 影响面 | 缓解 | 剩余风险 |
|---|---|---|---|---|---|
| R1 | 反悔副本从快照目录搬出时中断，副本一半在旧位置一半在新位置 | 搬移过程中进程被杀 / 断电 | 恢复入口找不到该次恢复的反悔副本 | 先复制 → 逐文件校验 sha256 → 再删旧；读取侧在过渡期同时查两个位置（双读窗口保留一个 MINOR 周期）| 低（双读期间旧位置只读）|
| R2 | checksum 表外条目从警告升为阻断后，历史包被拒 | 用户用旧版导出过带表外条目的包 | 导入失败，用户以为包坏了 | 默认只对**新导出**的包阻断；历史包给「按分区豁免」开关并计入 report.failures | 中（判定口径变化必须进 CHANGELOG）|
| R3 | 自动同步缺省从 local 改为 ask 后，用户感觉「同步不动了」 | 现有用户依赖缺省覆盖远端 | 体感变化，非数据风险 | 变更写进 CHANGELOG 顶部；保留显式开关回到旧行为；首轮与远端有更新时提示一次 | 中（沟通风险大于技术风险）|
| R4 | `ConfigAdapter` 契约扩展导致 16 类适配器（覆盖 17 分区）逐个过一遍 | 新增 `requiresSections` / `capabilities` / 基类 snapshot 默认实现 | 改错一个分区即该分区数据不进快照 | 基类给默认实现，只让确有差异的分区覆写；引擎侧用 never 穷举把漏改变成编译错误 | 低（编译期可捕获）|
| R5 | 导入 journal 新落盘文件让导入在不可判定时 fail-closed | journal 写入成功但首次写入前后崩溃 | 用户被卡在「恢复 / 人工」二选一 | 「删掉 journal 即无条件重来」；提供人工确认出口；journal 0600 且不含内容载荷 | 中（必须给出口，不能只 fail-closed）|
| R6 | 分区版本改成区间后，旧版读新版包仍然被拒 | 用户降级回旧版 | 旧版报不支持，用户以为数据损坏 | 这是**既定**行为（旧版只认自己那代），文档与错误码必须写清「请用 ≥ 新版打开」；不尝试让旧版兼容 | 低（不可消除，只能解释清）|

### 16.2 双向兼容矩阵

| 变更 | 旧版读新版数据 | 新版读旧版数据 | 需要用户动作 |
|---|---|---|---|
| `snapshots/index.json` 新增 | 是（未知文件被忽略）| 是（缺失即重建）| 无 |
| 反悔副本目录位置变更 | 是（旧版只看旧位置，过渡期旧位置仍在）| 是（双读）| 无 |
| 分区 `acceptsDataVersions` 区间 | 否（旧版精确相等判定）| 是 | 无（新版读旧包照常）|
| 导出 checksum 收紧 | 是 | 是（历史包可豁免）| 仅当历史包被拒时勾豁免 |
| 同步状态原子写 | 是（JSON 形状不变）| 是 | 无 |
| 同步新增墓碑字段 | 是（旧版忽略未知字段）| 是（缺失即视为无墓碑）| 无 |
| 导入 journal 文件 | 是（旧版不读该文件）| 是（无 journal 即视为无在途导入）| 无 |
| Bundle 容器 / 加密容器 | 不改 | 不改 | 无 |

### 16.3 迁移脚本

整个方案里**只有一项**可能需要迁移脚本：反悔副本位置搬移。它是**可选**的 —— 不搬也能工作（只是 prune 仍会连带删除，BK-05 未修）。如果要搬，脚本必须满足：①先 dry-run 打印将搬的目录数与总字节；②复制后逐文件校验；③校验失败即不删旧；④可重入（重复执行不重复搬）。其余七项都不改落盘结构，无需脚本。

### 16.4 明确不引入的兼容性负担

| 不做 | 原因 |
|---|---|
| 改 Bundle 容器结构（如换 tar、加内容寻址清单）| 现有 `manifest.json` + 分区载荷 + `checksums` 已足够；换容器等于让全部历史包失效 |
| 改加密容器格式或 KDF 参数 | 与 dsh-backup 的 `scrypt N=16384,r=8,p=1` 同档，无证据表明不足；改参数即需版本协商 |
| 改快照内部文件布局 | BK-04 用边车索引解决，不动载荷 |
| 支持 ZIP64 | 现有读侧上限（单条目 100 MiB / 总 500 MiB）本就排除 ZIP64 场景 |
| 让旧版读新版包 | R6，成本远超收益 |

### 16.5 每个阶段的回退判据

| 阶段 | 回退方式 | 判据 |
|---|---|---|
| Phase 0 | 逐项 revert（4 个独立提交）| 任一真实同步端点在修复后被拒 |
| Phase 1 | 状态文件原子写可单点 revert；自动同步缺省值可开关回退 | 现有同步测试出现新回归且 24h 内无法定位 |
| Phase 2 | 契约扩展保留、下沉动作单独 revert（基类默认实现即旧行为）| typecheck never 穷举暴露未覆盖分区且工期不足 |
| Phase 3 | journal 可整体关闭（开关即回到当前行为）| 导入因 journal 卡死且人工出口无效 |
| Phase 4 | 只做测量，天然可退 | — |

## 17. Testing Strategy

### 17.1 本轮验证口径（诚实声明）

| 项 | 状态 | 说明 |
|---|---|---|
| 源码阅读 / grep / 类型与接口核对 | **已执行** | 全部结论的路径与行号来自 HEAD `c671c98` 的实际文件读取 |
| `git status` / `git log -1` / `package.json` 版本读取 | **已执行** | 仅读，未改工作区 |
| 定向只读测试（`tests/route/*`、`src/sync/*.test.ts` 等）| **部分已执行**（专项成员实跑，Lead 未复跑）| 这些用例不改业务状态；结果见 §2.3 与 §7.9，Lead 只核对输出、未重跑 |
| `npm run typecheck` | **NOT RUN** | 本轮不改代码，typecheck 无新增可验证目标；不跑也如实标注 |
| `npm test`（全量）| **NOT RUN** | 任务要求不执行可能改动状态的操作；且现有测试不覆盖本报告提出的缺口（这正是 §17.3 的由来）|
| `npm run build` / `npm run smoke` | **NOT RUN** | 同上层原因；client bundle 护栏需在 build 后单独跑，本轮无 build |
| 五竞品仓库 | **静态读取** | 仅读 GitHub 原始源码，未 clone、未 build、未跑其测试 |

**结论**：本报告的「已实现 / 部分实现 / 占位 / 不支持」除明确标注为「实跑」的定向用例（§2.3 / §7.9）外，判断全部来自静态源码证据，**没有一处依赖未执行的测试**；无法由静态证据判定的项一律进 §17.5 UNKNOWN，不推测。

### 17.2 现有测试资产（可直接复用的部分）

| 资产 | 位置 | 复用方式 |
|---|---|---|
| 单元测试框架 | `node:test` + `node:assert`，`*.test.ts` 与实现同目录 | Phase 0-3 的新用例沿用同目录同风格，零新增依赖 |
| 恢复相关 | `tests/core/restore.test.ts`（含 R-09 路径围栏坐标系统一）| BK-01/02 的选择性恢复用例挂在同文件 |
| 同步相关 | `src/sync/*.test.ts` | SYN-01..11 的断言直接并入 |
| 打包与版本契约 | `tests/packaging-contract.test.ts`（V-1 版本三处同步）| 版本轴改动（IE-01）必须让它继续绿 |
| 对外契约一致性 | `tests/conformance/` | 若改动触及包/同步格式行为，需在此补一条 |
| 静态守卫 | `scripts/check-doc-paths.mjs` / `check-doc-versions.mjs` / `check-agents-budget.mjs`、`tests/i18n-hardcoded-guard.test.ts`、`css-token-guard.test.ts`、`css-scale-guard.test.ts`、`src/client/bundle-selfcontained.test.ts` | Phase 0-3 每条都要跑对应守卫；改文档必须过 paths 守卫 |

### 17.3 各阶段必须新增的守卫测试

| 阶段 | 测试文件（建议）| 断言 |
|---|---|---|
| Phase 0 | `src/adapters/self.test.ts` | 含 `sync/sync-config.json` 的包被拒或 host 标待确认；`sync-autosync.json` 不因导入开启 |
| Phase 0 | `src/sync/sync-config.test.ts` | 非白名单 host 拒绝；私网/回环地址按策略拒绝；token 与 host 绑定后 host 变化不注入 |
| Phase 0 | `src/sync/git/git-transport.test.ts` | `validateRepoUrl` 拒绝 `file://` 与非白名单协议 |
| Phase 1 | `src/sync/sync-state.test.ts` | 半截 JSON 自愈为可继续状态，不抛 `sync.state.notObject` |
| Phase 1 | `src/sync/sync-engine.test.ts` | 远端墓碑剔除计入 report；`useRemote` + 缺分区降级为可裁决 |
| Phase 1 | `src/sync/webdav-transport.test.ts` / `s3-transport.test.ts` | 引用者 404 时本轮不 GC（fail-closed）|
| Phase 1 | `src/core/backup.test.ts` | prune 后反悔副本仍在；attempt 目录可被列举 |
| Phase 1 | `src/adapters/import-defaults.test.ts`（参数化）| 三处 `rollbackOnError` 入口对同一输入给出同一默认 |
| Phase 2 | `src/schema/versions.test.ts` | 区间内旧版本可导，越界给明确错误码；`migrate` 幂等 |
| Phase 2 | `src/core/exporter.test.ts` | GUI 与 CLI 导出收集面字节一致 |
| Phase 2 | `src/adapters/snapshot-contract.test.ts` | 每个分区都能产出快照条目（never 穷举的运行时对应）|
| Phase 3 | `src/routes/snapshots.test.ts` | 子集恢复只动选中文件；同目录其他文件 mtime 不变 |
| Phase 3 | `src/core/import-journal.test.ts` | 中断后三态之一；删 journal 即重来；不可判定 fail-closed |
| Phase 3 | `src/routes/verify.test.ts` | 验证端点写路径 0 次 |

### 17.4 需要新建的测试基建（工程量在 Phase 1 前投入）

| 能力 | 为什么必须 | 最小形状 |
|---|---|---|
| 时钟注入 | BK-01 的保留期、SYN 的墓碑过期都要验，不能靠 sleep | `now()` 参数化到 2-3 个模块，测试传固定钟 |
| 崩溃注入 | 状态文件半截 / journal 半截 / 搬移中断 | 一个 `writePartial(path, bytes)` 测试工具 + 直接构造坏文件 |
| 假 transport | SYN-01..11 不应依赖真实 WebDAV/S3/git | 复用现有 transport 接口做内存实现（看是否已有，若无需自建）|
| 双进程锁测试 | 恢复/CLI 的写入门需要「另一个进程持锁」| 用子进程跑 `dcm` 的最小命令 |

### 17.5 UNKNOWN 清单（本轮未验证、且不影响已下结论的部分）

| # | 未验证项 | 为什么没验 | 怎么补 |
|---|---|---|---|
| U1 | 真实 WebDAV / S3 / git 通道的端到端行为 | 需要外部服务与凭据，属禁止操作 | 在隔离环境用本地 WebDAV/S3 兼容服务跑同步用例 |
| U2 | 大包（>100 MiB / >10 000 条目）性能与内存曲线 | 不编造性能数据 | 用合成包做基准，记录吞吐与峰值内存 |
| U3 | 快照重复字节占比（BK-03 门禁所需）| 需要真实用户快照样本 | 在本机 `snapshots/` 上采样统计同 sha256 字节占比 |
| U4 | 真实 rename 场景频次（SYN-08 门禁所需）| 需要历史同步记录 | 统计 `sync-state` 里同内容异路径出现次数 |
| U5 | Windows / macOS 真实路径差异（8.3、junction、大小写）| 只在 Linux 侧读过代码与既有用例 R-09 | 在三平台各跑一次恢复用例 |
| U6 | 83 条路由逐条 handler 全审 | 读了路由表与关键守卫，未逐条读实现 | 按 SEC 域补一次路由清单核对 |
| U7 | 五竞品是否可运行、其测试是否通过 | 只读源码，未 clone | 如需，clone 后只跑只读检查 |
| U8 | `dsh-cloud-sync` 内置 OAuth client id 的归属与有效性 | 只能看常量，无法验证授权关系 | 不依赖该判断；本报告未据此提建议 |

## 18. Deferred Improvements

> 这一节是「**现在不做**」的清单，含触发条件。写它的目的不是备忘，而是防止以后有人把它们当既成需求加进路线图。

| ID | 不做的事 | 为什么现在不做 | 重新考虑的条件 |
|---|---|---|---|
| D1 | 引入 diff3 / Git merge / hunk 级三方合并 | 现有 `src/sync/merge.ts` 的整文件三方判定已覆盖真实场景；hunk 级合并会引入「合并结果既非本地也非远端」的第三态，与本仓「裁决必须可解释」的定位冲突 | 出现「同一文件里两人改不同段落」的真实高频场景，且整文件裁决导致反复冲突 |
| D2 | 统一 Asset Model 层 | 见 §14.4；`SectionId` + `ConfigAdapter` 已表达语义，新建模型要同步改四处 | 适配器数量翻倍且出现第三种载体类型 |
| D3 | 通用 Storage Provider 抽象 | 与 `SyncTransport` 重复；SYN-04 的真正缺口是列举原语，不是抽象 | 通道数超过 6 个且新增通道需改动引擎 |
| D4 | 跨快照内容寻址去重（blob store）| 磁盘放大未量化；改造会动快照内部布局（违反 §16.4）| U3 测量显示重复字节占比 > 30% 且单用户快照总量 > 2 GiB |
| D5 | 支持 ZIP64 / 分卷 / 加密 ZIP | 读侧上限本就把场景排除在外；加密已由独立容器承担 | 出现合法的 >4 GiB 单条目资产类型 |
| D6 | 进程外救援工具（对标 rescue.mjs 内置于备份目录）| 本仓已有离线 CLI 救急台（`dcm web`）与 SAFE MODE；再造一个独立救援二进制是第二套恢复通道 | 出现「DSH 完全无法启动」的真实事故且现有救急台不可用 |
| D7 | 多实例端口探测与离线代理写 | 属于另一产品形态（多实例管理），不在本插件职责内；`instances.mjs` 自己也声明「端口只承担身份与存活探测」 | 本插件被要求管理多 DSH 实例 |
| D8 | UI 视觉重设计 / 引入第二套图标或动效体系 | 任务明确不做视觉重设计；`DESIGN.md` 是唯一权威 | 有独立的设计任务 |
| D9 | 内置云端 OAuth 应用（自带 client id）| 需要维护第三方应用身份与合规责任，与「用户自带凭据」模型冲突 | 有官方支持的自建 OAuth 应用托管 |
| D10 | 把快照/同步索引迁到 SQLite | 当前规模下 JSON + 边车索引足够；引入 DB 会增加损坏面与迁移成本 | 索引条目数稳定超过 10 万且 JSON 解析成为瓶颈（需实测）|

## 19. Final Recommendations

### 19.1 最该先做的三件事（按「真实风险 × 修复成本」排序）

1. **SEC-01：导入包可以改写同步目标（P0，唯一 P0）**。链路完整：恶意包 → 写入 `sync/sync-config.json` → 下一轮同步把已存 token 发往包内 host。它不是理论漏洞 —— `self` 分区把同步配置当普通配置裸写，而 token 是独立槽位、不看 host 是否变过。修法很小（§14.6 Phase 0），但**不做就是凭据外泄**。
2. **BK-01 + BK-05：恢复的反悔副本既没有出口，还会被 prune 连带删除（P1）**。`restore` 的 `preRestoreDir` 在引擎里被写入、在 GUI/CLI 里零引用（`grep` 在 `src/client` / `src/ui` 零命中），而 `prune` 把整快照目录连同它一起 `rm -rf`。等于「留了撤不回来的保险，再定期把保险烧掉」。修法 = 暴露只读出口 + 把反悔副本移出快照目录各自定生命周期。
3. **IE-01：分区版本判定是「精确相等」，一次结构升级就会挡住所有历史包（P1）**。`isSupportedSectionDataVersion` 只接受当前那一个 `dataVersion`（`src/schema/versions.ts:78-80`），没有区间也没有 `migrate` 钩子 ⇒ 分区结构一升级，旧包在本版与新版之间双向不可读，且错误码只能笼统报「不支持」。修法 = 判定改成区间 + 每个分区可选 `migrate`（§14.6 Phase 2），纯 schema 层改动，不动 bundle 格式。

> 注：三条横跨三个域，**恰好各自只需要改 1-2 个文件**，可以并行，不会互相阻塞。

### 19.2 应该保留的四处架构（不要为了「统一」拆掉）

| 保留 | 一句话理由 |
|---|---|
| 双面插件 + `src/core` / `src/sync` / `src/ui` 三层 | 分层是本仓对竞品（1774 行单文件）的结构优势 |
| 17 分区注册表 + `applyOrder` | 顺序语义是资产模型容易丢掉的东西 |
| 恢复四判据（`judgeRestoreResume`）| 就本轮读到的五个仓库源码而言未见同时具备（未逐仓跑测）；要复制到导入域，不要反过来简化 |
| 凭据纪律（零回读 / 独立载荷 / 全链路 `redact`）| 最强的不变量集合；SEC-01 是它被绕过一次，不是它错了 |

### 19.3 战略判断

**这个项目的护城河不在功能数量，在「可判定的可靠性」**。对齐 §12 的结论：就本轮读到的五个仓库而言，未见一个同时具备「恢复可判定续跑 + 三方同步裁决闭环 + 分区级放行 + 凭据零回读」。所以接下来最该做的不是加适配器、加通道、加云能力，而是把已有可靠性**做成可解释、可撤销、可验证**的三件事 —— 也就是本报告 P1 的全部内容。

反过来，最该警惕的是**「静默错误」类问题**：快照没进、裁决不可解、导出漏收集、状态半截 —— 这些不会报错，只会让用户以为「同步好了」。本报告 58 条里，P1 的 14 条几乎全是这一类。

### 19.4 一句话结论

> 底座是对的，缺的是**出口**（撤销恢复）、**闭环**（裁决后的基线推进）与**边界**（导入能改什么、旧包还能不能读）—— 这三样都是小改动，但每一样不做，可靠性都只是「看起来有」。

## 20. Source References

### 20.1 审计基线

| 项 | 值 |
|---|---|
| 仓库 | `D:\Projects\personal\dsh-config-manager` |
| 版本 | `0.2.4`（`package.json`）|
| HEAD | 代码基线 `c671c98`（2026-11-01）；本报告落盘后 HEAD 为 `13b88e8`（仅新增 `docs/research/` 两文件与 `docs/index.md` 一行）|
| 审计方式 | 只读：源码阅读、`grep`、类型与接口核对、`git status` / `git log` 只读命令 |
| 未执行 | `npm run typecheck` / `npm test` / `npm run build` / `npm run smoke`（见 §17.1）|
| 工作区状态 | 审计期间未改动任何业务源码、测试、`package.json` 与 lockfile |

### 20.2 本仓关键路径（按域）

| 域 | 路径 | 用途 |
|---|---|---|
| 宿主入口 / 路由 | `src/index.ts`（含 7 条钉住路由、写入门 `:2729-2768`）、`src/routes/*.ts`（其余 76 条）| 路由总数 83、认证边界在 kit 围栏 |
| 契约 | `src/core/types.ts:1171-1273`（`ConfigAdapter`）| 适配器契约与降级语义 |
| 分区 | `src/schema/section-registry.ts:190-408`（17 个分区 id）、`src/schema/versions.ts:69`（`sectionDataVersion`）、`:78-80`（`isSupportedSectionDataVersion`）| 注册表与版本判定 |
| 适配器 | `src/adapters/file-collection.ts:69`、`skills.ts:166`、`agent-presets.ts:9`、`agent-instructions.ts:22`、`sessions.ts:49`、`self.ts:152`、`plugin-data.ts:68`、`settings.ts:167`、`ui.ts:63`、`providers.ts:45`、`plugins.ts:354`、`mcp.ts:170`、`prompts.ts:125`、`workspaces.ts:86`、`plugin-files.ts:27`、`credentials.ts:75` | 15 类覆盖 16 分区（`secrets` 无适配器，走契约外载荷）|
| 备份 / 恢复 | `src/core/backup.ts`（`prune` `:725`、pinned 跳过 `:758`、`rm -rf` `:769`）、`src/core/restore-resume.ts`（`judgeRestoreResume`）、`src/core/rollback-point.ts`、`src/core/rollback.ts`（导入补偿，勿与回滚点混用）、`src/core/boot-paths.ts` | BK 域全部结论 |
| ZIP / 安全 | `src/utils/zip.ts:41-47`（五道上限）、`:436`（重复累加）、`src/security/zip-security.ts`、`src/security/container-kind.ts` | IE 与 SEC 域 |
| 同步 | `src/sync/merge.ts`、`sync-state.ts`、`sync-engine.ts`、`sync-config.ts`、`autosync-config.ts`、`autosync-scheduler.ts`、`webdav-transport.ts`、`s3-transport.ts`、`git/git-transport.ts` | SYN 域 14 条 |
| Profile | `src/profiles/dsh-profile-manager.ts:107-549`（`remove` `:357`、`rmSync` `:363`）、`dsh-profile-shared.ts:238`（`DESKTOP_PROFILE_NAME`）| PW 域 |
| CLI | `src/cli/actions.ts:254` / `:278` / `:438-505`（写入门三处读取）| UI-05 与 IE-05 |
| 客户端 | `src/client/run-store.ts`、`src/client/common/ErrorBanner.tsx`、`src/client/common/ReportView.tsx` | 状态归属与错误脱敏 |
| 守卫脚本 | `scripts/check-doc-paths.mjs`、`check-doc-versions.mjs`、`check-agents-budget.mjs` | 文档治理 |
| 文档 | `AGENTS.md`、`DESIGN.md`、`docs/index.md`、`docs/spec/`、`docs/maintenance/known-limits.md`、`docs/maintenance/tech-debt.md` | 规范与台账（DOC 域）|

### 20.3 竞品源码（GitHub，分支不一：四仓读 main，`lire1131/dsh-undo-savepoint` 读 master —— 其 main 返回 404；2026-11-01）

| 项目 | 读取的关键文件 |
|---|---|
| [xiaoyuyu6420/dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup) | `lib/encrypt.js`（235 行）、`lib/zip.js`（402）、`lib/oplock.js`（124）、`lib/gfs.js`（53）、`rescue/rescue.mjs`（1006）|
| [WSL043/DSH-Portable](https://github.com/WSL043/DSH-Portable) | `launcher/data-import-journal.mjs`（164）、`data-import-preflight.mjs`、`data-paths.mjs`、`profile-compatibility.mjs`、`startup-profile-recovery.mjs`、`repair-core.mjs` |
| [Arlenman/dsh-backup-sync](https://github.com/Arlenman/dsh-backup-sync) | `lib/baseline.js`（158）、`lib/diff.js`（165）、`lib/apply.js`（347）、`lib/guard.js`（227）、`lib/hash.js`（28）|
| [dickpy/dsh-cloud-sync](https://github.com/dickpy/dsh-cloud-sync) | `lib/core.js`（1774，单体）|
| [lire1131/dsh-undo-savepoint](https://github.com/lire1131/dsh-undo-savepoint) | `lib/snapshot.mjs`（263）、`lib/instances.mjs`（304）、`lib/zip.mjs`（187）|

### 20.4 事实 / 推断 / 建议的边界

| 类型 | 本文如何标注 | 覆盖范围 |
|---|---|---|
| **事实** | 带文件路径 + 行号，或命令输出 | §2-§13 全部「当前实现」列与证据列 |
| **推断** | 明确写「推断：」「可能」，且给出推断依据 | 影响面评估、竞品威胁判断、U1-U8 之外的风险排序 |
| **建议** | 全部集中在 §14-§19，与事实分开成节 | 架构判定、路线、兼容策略 |
| **未验证** | §17.1 的 NOT RUN 表 + §17.5 UNKNOWN 表 | 任何未跑测试/未连外部服务的结论都不得写成已验证 |

> 本报告不含任何虚构的性能数字、竞品功能或漏洞断言：每个 SEC/SYN/BK/IE 条目都能按「证据」列在同一 HEAD 上复核。

---

*审计报告结束。按任务约定：报告完成后停止，不自动执行本方案中的任何开发任务，等待审阅与批准。*