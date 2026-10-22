# 备份 / 快照 / 恢复 / 导入导出

本文件描述「配置进出本机」这条主线的真实代码路径：谁负责收集、谁负责打包、谁负责写盘、哪一步会删文件。读者是接手维护的 AI agent 与人类维护者；每条断言都尽量钉到代码位置，未经验证的判断显式标「待验证」。

约定：路径全部相对仓库根；行号是写作时的快照，检索时以符号名（函数/常量名）为锚更可靠。

---

## 1. 职责与边界

| 层 | 位置 | 负责 | 不应在这里 |
|---|---|---|---|
| 导出引擎 | `src/core/exporter.ts` | 选分区、调适配器、打包 ZIP、checksums、manifest | 具体文件枚举 |
| 文件收集 | `src/adapters/file-collection.ts` | 按分区枚举与收集文件、告警 | 决定导出哪些分区 |
| 导入引擎 | `src/core/analyzer.ts` | 解析 ZIP、完整性校验、建计划、执行与回滚 | 读 HTTP 请求体 |
| 快照 | `src/core/backup.ts` | 建快照、快照存储、校验、保留清理 | 决定何时导入 |
| 恢复 | `src/core/restore.ts` | 计划恢复、逐动作还原、pre-restore 副本 | 起 HTTP 服务 |
| 加密 | `src/security/encryption.ts` | 凭据载荷（DSC1）与整包容器（DCA1） | 决定密码从哪来 |
| 安全边界 | `src/security/zip-security.ts`、`src/security/container-kind.ts` | ZIP 视为不可信；容器形态单点判定 | 业务决策 |
| 路由 | `src/routes/import.ts`、`src/routes/snapshots.ts`、`src/routes/backup.ts` | 参数校验、写入门、run 进度 | 复用引擎的收集逻辑 |
| 离线 CLI | `src/cli/index.ts`、`src/core/backup-plan.ts`、`src/core/backup-verify.ts` | 离线备份、自检、恢复 | 依赖 HostContext |

四条硬边界：

1. **收集口径只有一份（GUI 侧）**：`FileCollectionAdapter.collect`（`src/adapters/file-collection.ts:174`）同时被 `export()`（`:129`）与 `preview()`（`:146`）调用；需要收窄收集面时覆写 `listRelPaths`（`:286`），已在 `src/adapters/agent-instructions.ts:42`、`src/adapters/plugin-data.ts:187`、`src/adapters/self.ts:146`、`src/adapters/skills.ts:183` 使用。
2. **离线 CLI 备份是第二套收集器**：`collectBackupEntries`（`src/core/backup-plan.ts:289`）不走 `Exporter`，直接产出条目再配 `buildManifest` 与 `writeZip`（`src/cli/index.ts:1375`）。它与 GUI 共享 manifest/checksums 格式与分区语义，但收集代码独立——这是「离线进程没有 HostContext」的有意取舍，不是遗漏。
3. **快照只有一份实现**：`createSnapshot`（`src/core/backup.ts:463`）；导入路径在 `src/core/analyzer.ts:927` 调用它，同步引擎复用同一函数。不存在「snapshot 引擎」与「backup 引擎」两套。
4. **core 不反向依赖 sync**：保留策略的形状在 core 内声明（`src/core/backup.ts:542`），实现留在 `src/sync/retention-policy.ts`，由宿主注入；依赖方向由 `tests/architecture-boundaries.test.ts:47` 钉住。

---

## 2. 入口

### 2.1 HTTP 路由

| 方法 / 路径 | 声明位置 | 说明 |
|---|---|---|
| `POST /export` | `src/index.ts:3999` | 导出（可选密码 → DCA1） |
| `POST /export-preview` | `src/index.ts:4148` | 只读预览分区与条目数 |
| `POST /analyze` | `src/index.ts:4264` | 解析包、给兼容性报告 |
| `POST /plan` | `src/index.ts:4300` | 生成导入计划（加密包需解锁） |
| `POST /import/upload` | `src/routes/import.ts:98` | 收 ZIP 到临时目录并判定容器形态 |
| `POST /import/decrypt-archive` | `src/routes/import.ts:130` | DCA1 → 明文 ZIP（0600） |
| `POST /import/execute` | `src/routes/import.ts:179` | 真正写盘（过 mutation gate） |
| `GET /snapshots` | `src/routes/snapshots.ts:44` | 列出快照（含 unreadable） |
| `POST /snapshots/restore` | `src/routes/snapshots.ts:66` | 预览（dryRun）或执行恢复 |
| `POST /snapshots/delete` | `src/routes/snapshots.ts:182` | 删除快照（被恢复引用则拒绝） |
| `POST /snapshots/pin` | `src/routes/snapshots.ts:226` | 置顶保护，避免被自动清理 |
| `GET /backup-files` | `src/routes/backup.ts:259` | 列出导出目录里的备份 |
| `POST /backup-files/delete` | `src/routes/backup.ts:268` | 删除指定备份（只接受纯文件名） |
| `GET/PUT /backup-schedule` | `src/routes/backup.ts:209` | 定时备份配置 |
| `POST /backup-schedule/run` | `src/routes/backup.ts:246` | 手动触发一次定时备份 |
| `POST /disk-usage/cleanup` | `src/routes/backup.ts:184` | 清理可重建区与过期导出 |

写操作统一过 `withMutationGate`（`src/index.ts:3357`）。**唯一例外**是 `/snapshots/restore`：它自己组合 `runWithMutationLock` 与 `phase3Recovery.runJournaled`（`src/routes/snapshots.ts:101`、`:161`），并自行映射 423 错误（`:167`）——改 gate 时不要以为它自动跟随。

### 2.2 CLI

| 命令 | 实现 | 备注 |
|---|---|---|
| `snapshots` | `src/cli/index.ts:1051` | 只读；目录读不出来时非 0 退出 |
| `restore <id>` | `src/cli/index.ts:1089` | 预览在前（`:1099`），执行在后（`:1131`） |
| `verify [id]` | `src/cli/index.ts:1267` | 自检，与救急台共用 `collectVerifyResults` |
| `backup` | `src/cli/index.ts:1321` | 离线文件级备份，默认写入导出目录 |
| `import` | `src/cli/index.ts:270` | 外部来源转 bundle，供导入向导消费 |

CLI 破坏性命令的门禁与 GUI 同源：SAFE MODE → 残留环境锁 → DSH 未运行（`src/cli/actions.ts:438`）。`restore` 把三道门内联在锁之内（`src/cli/index.ts:1102`、`:1112`、`:1123`），因此「残留锁」先于「DSH 在跑」报出，且没有 `--force` 旁路。

---

## 3. 关键调用链

### 3.1 导出（GUI）

1. `POST /export` → 校验 `only` / `includeItems` / 文件名（`src/index.ts:4008`），密码取自请求体且只驻留内存（`:4041`）。
2. `Exporter.export`（`src/core/exporter.ts:127`）按 `adapters.filter` 定分区，逐分区 `await adapter.export(...)`；单分区失败降级为 warning 并排除，不拖垮整包。
3. 结构化分区内容过 `scanner.scanAndRedact` 剥离敏感值；文件类分区只做扫描告警、不改写原文（`src/core/exporter.ts` 的 `scanFileSectionText`）。`secrets.enc` 在有加密时恒生成：`includeSecrets` 为真才携带真实凭据，否则空串占位而 `encrypted` 仍为 true（`src/core/exporter.ts:480` 一带）。
4. `buildChecksums` → `CHECKSUMS_FILE` → `buildManifest` → `writeZip` 到临时明文包。
5. 有密码：`encryptArchive` 后 `atomicWriteFile`（`src/index.ts:4110`）；无密码：`rename`（`:4117`）。明文临时包在 `finally` 必删（`:4137`）。

### 3.2 备份快照（导入前）

`executeImportPlan` → `createSnapshot`（`src/core/analyzer.ts:927`）→ 引擎/适配器产出条目 → `saveSnapshotBlobs` → `finalizeSnapshot`（`src/core/backup.ts:656`）：写 `snapshot.json`（readiness=CREATING）→ 写 `manifest.json` → 从磁盘重读校验 → 原子发布 READY → 触发 prune。

### 3.3 恢复

1. `POST /snapshots/restore` → `buildRestoreBody`（`src/index.ts:2791`）。
2. `dryRun`：`planRestore` + 指纹，直接回 JSON，不登记 run、不写盘（`src/routes/snapshots.ts:90`）。
3. 执行：拿 GLOBAL 锁 → `planRestore`（`src/core/restore.ts:554`）→ 客户端指纹与服务端不符则 409 → `restore()`（`src/core/restore.ts:853`）。
4. 逐动作 WAL：`createRestoreWal()`（`src/core/restore-wal.ts:105`）在**首个写之前**预登记全部动盘动作（`planned` + beforeFp），每个动作结束 settle 成 `done`/`attention`（+ afterFp）；`hostFileRemove`/`fileRemove` 的期望态用 `ABSENT_FINGERPRINT` 哨兵表达。GUI/HTTP 执行器 `executeRestorePlan`（`src/routes/route-support.ts:580`，WAL 在 `:597`）与 core `restore()`（WAL 在 `:885`）同一实现。崩溃后 reconcile 据此判 recovered / needs-attention。
5. 覆盖/删除目标前先 `copyToPreRestore` 留副本（`src/core/restore.ts:924` 起），随后逐动作 `atomicCopyFile`。

### 3.4 导入

`upload`（`readContainerKind` 只读前 4 字节）→ 若为 DCA1：`decrypt-archive` 校验密码并落明文 ZIP（`src/routes/import.ts:161`）→ `/analyze` → `/plan` → `/execute`（`withMutationGate('import-apply', …, {deferredSnapshot:true})`）→ `Importer` 门面 → `Analyzer` 四段：`loadBundle`（`src/core/analyzer.ts:267`）、`analyzeImport`（`:626`）、`createImportPlan`（`:774`）、`executeImportPlan`（`:853`）→ 快照 → 逐项 apply → 收尾 → 失败/取消时 `rollback`（`src/core/rollback.ts`）。

`executeImportPlan` 内部固定顺序：`confirm !== true` 直接抛（`:899`）→ 加密包缺凭据密码抛（`:906`）→ 建快照（`:927`）→ WAL 预登记 planned + beforeFp（`:947`）→ 按相位执行 → 分区/全局收尾 → 结果或回滚。

### 3.5 离线备份与自检

`dsh-config-manager backup` → `collectBackupEntries`（`src/core/backup-plan.ts:289`）→ 空集合即失败（`src/cli/index.ts:1340`）→ `--dry-run` 只打印计划并在建目录前返回 0（`:1356`、`:1369`）→ 组装 entries（含 checksums 与 manifest，`:1388`）→ `writeZip`（`:1396`）→ 立刻 `verifyBackupZip` 自检（`:1407`）。

`dsh-config-manager verify` → `collectVerifyResults`（`src/cli/index.ts:1275`，与救急台同一实现）→ 任一非 OK 即退出码 1（`:1292`）。

---

## 4. 数据形态与落盘位置

| 产物 | 位置 | 证据 |
|---|---|---|
| 导出/备份 ZIP | 导出目录（`<dataDir>/exports`） | `src/index.ts:4455` |
| 导出备注 | `<dataDir>/exports/.backup-notes.json` | `src/sync/backup-files.ts:74` |
| 快照目录 | `<dataDir>/snapshots/<id>/` | `src/index.ts:3844` |
| 快照元数据 | `snapshot.json`（readiness）、`manifest.json`（entry 清单 + 哈希） | `src/core/backup.ts:656` |
| 快照 blob | `blobs/`（宿主整文件与文件类分区内容） | `src/core/backup.ts:119` |
| pre-restore 副本 | 快照目录下 `pre-restore/<本地时间戳>[-n]/`（**每次恢复一个 attempt 子目录**，重跑不覆盖上一次） | `src/core/restore.ts:364` |
| 导出明文临时包 | 临时目录 `export-plain-*`（失败也必删） | `src/index.ts:4137` |
| 解密明文包 | 临时目录 `decrypted-*`（0600，成功后删） | `src/routes/import.ts:27` |
| 加密容器 | DCA1（整包）；凭据槽 DSC1 在包内 `secrets.enc` | `src/security/encryption.ts:41` |

格式契约（哪些文件属于包、版本字段语义）以 `docs/spec/bundle-format-v1.md` 为准，本文件不重复。

---

## 5. 失败与回退语义

- **导入：快照强制、先于写入**。快照失败即中止导入（`src/core/analyzer.ts:927`）；没有「先写再说」的分支。
- **导入：取消只在计划项边界**（`src/core/analyzer.ts:1021`），不会在一个分区写到一半时撕开文件；取消后按用户决策整体回滚或保留半成品并标记。
- **导入：回滚是补偿引擎**。`rollbackApplied` 调 `rollback` 并把结果写回 journal（`src/core/analyzer.ts:1336`）；回滚失败时快照标 `rolled-back` 而不是 `done`。
- **恢复：没有整笔自动回滚**。`restore()` 逐动作 try/catch，单项失败只记 `failed` 并继续（`src/core/restore.ts:716`）；兜底是 `pre-restore` 副本 —— 每次恢复新建一个 attempt 子目录（`src/core/restore.ts:364`），重跑不会覆盖上一次的反悔副本，GUI/HTTP 恢复路径（`src/routes/route-support.ts` 的执行器）复用同一布局。删除快照只拦「被恢复流程引用」的那些（`src/routes/snapshots.ts:182`），**不保护 pre-restore 副本**。
- **恢复：目标侧防写穿**。计划期对每个写回目标做 realpath / 中间段解析，落在 home 外即整单拒绝（`src/core/restore.ts:317`，错误码 `restore.pathEscape`），不会写到 home 外的真实文件。
- **恢复：敏感文件不回滚**。回滚点采集默认排除 `.env`/私钥/证书等（`src/core/rollback-ignore-rules.ts` 的 `builtinSensitiveReason`），命中记 `skipped(reason='sensitive')` —— 这是**排除不是加密**。
- **Dry Run 零写入**：恢复预览分支不登记 run、不落盘（`src/routes/snapshots.ts:90`）；导入的 `analyze/plan` 只读 ZIP 字节（`src/core/analyzer.ts:1` 模块注释）。测试锚点见 §6。
- **冲突不默认覆盖**：计划项默认按 Skip/Merge 处理，覆盖必须由用户显式决策；快照与墓碑参与的判定在 `src/core/analyzer.ts:793` 与 `:799`。
- **加密容器未解锁一律拒绝**：三处闸门返回 400 与 `encrypted-container` 码（`src/index.ts:4276`、`:4315`、`src/routes/import.ts:190`）；形态判定只有 `src/security/container-kind.ts` 一份。
- **快照清理不会删用户数据**：上限 10 个（`src/core/backup.ts:566`）；`pinned` 与被 journal 引用的快照豁免（`:758`、`:759`）；引用集合读不到就放弃本轮清理（`:732`）；定时备份的 prune 只动 `auto` 前缀文件。
- **磁盘清理是分区白名单**：`snapshots`/`sync` 永不进候选，导出只在显式勾选「过期导出」时清理（`src/routes/backup.ts:95`、`:101`）。

---

## 6. 已知限制与测试锚点

| 限制 | 证据 | 现状 |
|---|---|---|
| 未解锁容器的路由闸门 | 三处闸门：`src/index.ts` 的 `/analyze`、`/plan` 与 `src/routes/import.ts` 的 `/execute` | 已补回归测试 `tests/route/encrypted-container-gate.test.ts`（含零写入断言） |
| 预览指纹可选，缺省不校验 | `src/routes/route-support.ts` 的 `buildRestoreBody`、`src/routes/snapshots.ts` 的 409 分支 | 带指纹才校验；已补 `tests/route/restore-plan-changed.test.ts` |
| 恢复中途进程崩溃 | `src/core/restore-crash-injection.test.ts` | 已覆盖：A-1（1 done + 2 planned）、A-4（真实 hooks 判 recovered）；残留 journal 仍会挡下一次恢复 |
| 条目名中段反斜杠不进 checksums | `src/utils/paths.ts:35`、`src/security/integrity.ts:63` | 已登记在 `docs/spec/known-gaps.md` |
| DCA1 不记录 KDF 参数 | `src/security/encryption.ts:194` | 换参数后旧容器不可解，无版本可判 |
| 解密明文包存活到导入成功 | `src/routes/import.ts:162`、`:307` | 失败/取消刻意保留；见 `tests/route/decrypt-plaintext-cleanup.test.ts` |
| 恢复目标侧 realpath 围栏 | `src/core/restore.ts` 的 `assertPlanTargetsSafe` | 已修（home 外整单拒绝）；硬链接 / UNC / 8.3 短名仍未覆盖，见 `docs/maintenance/known-limits.md` |
| 日期戳有三份实现 | `src/index.ts:2227`、`src/core/model-tools.ts:83`、`src/sync/backup-scheduler.ts:405` | 维护债，行为一致 |

测试锚点（改动前先跑这些）：

| 主题 | 测试 |
|---|---|
| 导出/预览口径 | `tests/core/exporter.test.ts` |
| 导入计划与执行 | `tests/core/importer.test.ts` |
| 恢复与信任判定 | `tests/core/restore.test.ts`、`tests/core/restore-trust.test.ts` |
| 恢复逐动作 WAL / 崩溃注入 | `src/core/restore-wal.test.ts`、`src/core/restore-crash-injection.test.ts` |
| 恢复目标侧防写穿 | `src/core/restore-target-symlink.test.ts` |
| 快照存储与清理 | `tests/core/snapshot.test.ts`、`tests/core/snapshot-trust.test.ts`、`tests/core/retention.test.ts` |
| schema 兼容 | `tests/schema-compat.test.ts`、`tests/schema/manifest.test.ts` |
| ZIP 与路径安全 | `tests/security/import-security.test.ts` |
| 加密往返 | `src/security/security.test.ts` |
| 跨平台路径 | `tests/core/cross-platform.test.ts` |
