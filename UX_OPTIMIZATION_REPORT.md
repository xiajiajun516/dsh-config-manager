# UX_OPTIMIZATION_REPORT — dsh-config-manager 体验打磨（Phase 8 之后）

> 基线：`8aadf4c`（Phase 8 可靠性收尾）。本阶段纯 UX 打磨：**只改用户可见的界面结构、文案、错误提示，未改任何业务/安全语义**（锁、journal、recovery、迁移历史、咨询判定逻辑一律不动）。

## 0. 双视角评审结论（Step 0，先于动手）

按 §1.5 并行派了两个独立 subagent 审查当前 UX：**产品经理**（信息架构/任务流/可发现性）与**用户视角**（新用户可读性/错误友好度）。

### 产品经理 subagent 结论摘要
- **信息架构**：8 个一级 tab 过多（P1，超出设置页认知负荷），建议重组为 **6 个**；`关于/迁移历史/恢复` 均为低频面板，不应与核心任务域平级。
- **恢复归属**：恢复（Phase 5）与「备份与快照」语义相近（都是「恢复到某状态」），建议并入作第三子 tab。
- **迁移历史**：跨所有迁移操作的**横切审计视图**，不属于任何单一任务域，收进「更多」最合适。
- **可发现性（P1）**：恢复是事故驱动、多数时间空态，建议加**全局 SAFE MODE 横幅**作为跨 tab 可见的兜底。
- **业界惯例**：备份工具通常把「创建/恢复/定时/历史」收在一个备份域；本插件之前把备份分散在 4 个 tab，偏碎片化。

### 用户视角 subagent 结论摘要
- **术语黑话**：`incident / SAFE MODE / operation-bound / quarantine / journal / destructive / dry-run / pre-restore / secret / tombstone / append-only / checksum / v1` 等对非技术用户不可读。
- **状态值透出**：`RecoveryPanel.tsx` L350 直接渲染原始英文状态值（`RECOVERING / NEEDS_ATTENTION / ROLLED_BACK`），`decision/verdict` 兜底也返回原枚举。
- **锁错误**：`EnvironmentLockUnavailableError` 未区分「被占用」vs「锁不可用」，CLI 无条件追加「另一个 DSH 任务正在进行」会误导；423 把技术 message 原样回传。
- **文案一致**：`snapshots.execute` 在 locales 与 ui/i18n 两套字典动词不一致（「执行恢复」vs「立即恢复」）；`SnapshotsPanel.summary()` 硬编码中文串。
- **信任/安全感**：破坏性操作均有 `danger` + ConfirmDialog + 诚实后果说明，整体优秀；仅恢复弹窗技术动作偏多。

### 两者冲突点与裁决
| 冲突点 | 裁决 | 理由 |
|---|---|---|
| 恢复归属：并入「备份与快照」 vs 收进「更多」 vs 条件显示 | **并入「备份与快照」作第三子 tab** | 语义最贴近「恢复到某状态」；与用户 §1.A 建议一致；全局 SAFE MODE 横幅解决可发现性 |
| 「更多」命名 | 用「更多」（备用「其他」） | 业界惯例、语义清晰 |
| 同步历史 vs 迁移历史 粒度 | 保留现状（通道级 vs 全局审计，粒度不同） | 属产品取舍，登记待用户确认，不强行合并 |

### 最终改动清单（含来源标注）
| 项 | 来源 | 状态 |
|---|---|---|
| A：一级 tab 8→6 重组 | 用户反馈 + PM | ✅ 已实现（`e691ef9`） |
| B：全仓术语中文化 + 扫描 | 用户反馈 + 用户视角 | ✅ 已实现（`d79bb3e`） |
| C：锁错误分类 + 友好文案 | 用户反馈 | ✅ 已实现（`8789df5`） |
| 全局 SAFE MODE 横幅 | PM（P1） | ✅ 已实现（随 A） |
| `summary()/actionKindLabel()` 字典化 | 用户视角 | ✅ 已实现（随 B） |
| `snapshots.execute` 动词统一 | 用户视角 | ✅ 已实现（随 B） |
| 导出结果页「导入此文件」快捷按钮 | PM（P2） | 🕓 登记（本期控制范围，未改 ExportView） |
| 同步历史 vs 迁移历史 粒度甄别 | PM | 🕓 登记待用户确认 |
| `messages.ts adapter.pluginInstallFailed` 内部命令 | 用户视角 | 🕓 登记保留（actionable 手动路径，非安全泄漏；About 已文档化 CLI） |

---

## 1. 问题 A —— 一级 tab 过长（8 → 6）

### 方案（前后对比）
```
[前] 8 tab
导出与导入 | 备份与快照 | 远程同步 | 配置市场 | 配置文件 | 关于 | 恢复 | 迁移历史

[后] 6 tab
导出与导入 | 备份与快照 | 远程同步 | 配置市场 | 配置文件 | 更多
```

| 一级 tab | 内部结构 | 旧 panel/view 值迁移 |
|---|---|---|
| 导出与导入 | 子 tab：导出备份 / 导入恢复（不变） | `view: export/import` 不变 |
| 备份与快照 | 子 tab：快照恢复 / 备份文件 / **恢复** | `panel:'snapshots'` 不变；旧 `panel:'recovery'` → `panel:'snapshots'` + `snapshots.subTab:'recovery'` |
| 远程同步 | 不变 | `panel:'sync'` 不变 |
| 配置市场 | 不变 | `panel:'market'` 不变 |
| 配置文件 | 不变 | `panel:'profiles'` 不变 |
| **更多** | 子 tab：迁移历史 / 关于 | 旧 `panel:'about'`→`panel:'more'`+`moreSub:'about'`；旧 `panel:'history'`→`panel:'more'`+`moreSub:'history'`；新 `panel:'more'`+`more.moreSub` 往返 |

### runStore 状态持久化兼容性（硬约束）
- `PanelId` 收敛为 5 值（去除 `about/recovery/history`，新增 `more`）。
- 新增 `more: MoreStoreSlice`（`{ moreSub: 'history'|'about' }`），非敏感、可持久化。
- `SnapshotsSubTab` 扩展为 `'restore'|'files'|'recovery'`。
- `parsePersistedState` 增加**旧值迁移分支**（about/history→more、recovery→snapshots+subTab），解决原有 `'history'` 未被白名单接受导致刷新丢 tab 的缺陷。
- `applyPersisted` 对 `moreSub`/`subTab` 非法值归一（回退 about / restore）。
- **验证**：新增 `run-store.test.ts` 迁移测试（旧 recovery/about/history → 新结构往返），全量通过。

### 改动文件
- `src/client/run-store.ts`、`src/client/ConfigManagerSection.tsx`、`src/client/snapshots/SnapshotsPanel.tsx`、`src/client/locales.ts`、`src/client/recovery/recovery-locales.ts`（banner 键）、`src/client/run-store.test.ts`、`DESIGN.md`（§7.1 骨架）

### 可视化 / 交互（DESIGN.md 一致性）
- 复用现有 `viewTab`/`modeTab` 原语，未引入第二套视觉体系；「更多」与「备份与快照」子 tab 均复用既有 `modeTabs` 模式（DESIGN.md §14 模式切换）。
- 新增全局 SAFE MODE 横幅（`Banner kind=error` + 「去处理」按钮），复用现有 `Banner`/`Button` 原语，未新增样式类。

---

## 2. 问题 B —— 用户可见文案中文化（全仓术语扫描）

### 术语映射表（英文 → 中文）
| 英文 | 中文建议 | 位置 |
|---|---|---|
| incident | 恢复事项 / 待处理事项 / 需要处理的记录 | recovery-locales |
| SAFE MODE | 安全模式（会修改配置的操作已暂停） | recovery-locales |
| operation-bound | 与本次操作绑定 | recovery-locales（snapshot.verdict） |
| quarantine | 隔离保存 | recovery-locales（confirm.dismiss） |
| journal | 操作记录 | recovery-locales（confirm.dismiss） |
| verdict | 校验结果 / 建议 | recovery-locales（已中文「快照校验」/「建议」） |
| 补偿项 | 已完成的部分会自动跳过 | recovery-locales（rollbackContinue） |
| pre-restore 目录 | 安全位置 | recovery-locales + locales + ui/i18n（confirm） |
| destructive | 危险操作 | recovery-locales（confirm.message） |
| dry-run | 只读预览（不会改动任何设置） | locales / ui/i18n / market-locales |
| append-only | 只可追加、不可修改或删除 | history-locales |
| secret | 密钥 | sync-locales / locales |
| tombstone | （去英文括号） | ui/i18n |
| checksum / 校验和 | 文件完整性 | ui/i18n（progress） |
| v1（版本号） | 当前版本 | sync-locales / ui/i18n |
| RECOVERING / NEEDS_ATTENTION / ROLLED_BACK / RECOVERED / COMMITTED | 恢复中 / 需人工处理 / 已回滚 / 已恢复 / 已完成 | RecoveryPanel（incident.state） |

### 扫描到的全部术语及处理
- **已本地化（改）**：`incident / SAFE MODE / operation-bound / quarantine / journal / destructive / pre-restore / dry-run / append-only / secret / tombstone (括号) / checksum / 补偿项 / v1`。
- **保留（判断为不泄漏或域术语）**：
  - `rollback / restore / snapshot / sync / profile / verdict` —— 引擎消息 `messages.ts` 已全部中文（回滚/恢复/快照/同步/档案/校验）；`profile` 作为 DSH 域术语保留。
  - `operationId / snapshotId` 等字段名 —— API 标识符，非文案。
  - `pre-restore`（内部目录名）/ `operation-bound`（绑定字段名）—— 测试/内部断言依赖，属内部标识符，不改。
  - `AES-256-GCM / SHA-256 / MCP / JSON / Markdown / GitHub` —— 安全陈述或生态缩写/文件格式，保留。
  - `messages.ts adapter.pluginInstallFailed` 的 `dsh plugin --profile {profile} add {name}` —— actionable 手动路径，保留并登记（见 §0 裁决）。

### RecoveryPanel 状态值本地化
- `incident.state` 原始枚举值 → `stateLabel(t, state)` 映射中文标签，未知名回退「未知」（新增 `recovery.incident.state.*` 键）。
- `decisionLabel` / `verdictLabel` 兜底不再返回原枚举，分别回退 `recovery.decision.unknown` / `recovery.verify.verdict.unknown`。

### 文案一致性
- `snapshots.execute`：locales 与 ui/i18n 统一为「执行恢复」/「Restore now」。
- `SnapshotsPanel.summary()/actionKindLabel()` 硬编码中文字符串 → 走字典（新增 `snapshots.kind.*`/`snapshots.summary` 键，zh/en）。

### 改动文件
- `src/client/recovery/recovery-locales.ts`、`RecoveryPanel.tsx`、`locales.ts`、`history/history-locales.ts`、`sync/sync-locales.ts`、`market/market-locales.ts`、`src/ui/i18n.ts`、`snapshots/SnapshotsPanel.tsx`

---

## 3. 问题 C —— 进程锁/错误提示友好化（区分「占用」vs「不可用」）

### 锁错误分类与用户文案
| 分类 | 判定（LockState） | 用户可见文案（`error.message`） | 说明 |
|---|---|---|---|
| **locked** | `LOCKED` | 另一个任务正在运行，请稍后重试。 | 被另一进程/任务活跃持有 |
| **blocked** | Phase 3 SAFE MODE（`isBlocked` 谓词） | 配置修改已被保护，请先处理恢复事项后再继续。 | 不谎称「有进程」 |
| **unavailable** | `STALE_LOCK_DETECTED` / `UNKNOWN_STATE` / `LOCK_IO_ERROR` / `PERMISSION_ERROR` | 操作暂时无法执行，请稍后重试；若持续失败请查看日志。 | 诚实文案，不谎称「在运行」 |

### 实现
- `EnvironmentLockUnavailableError`（env-lock.ts）新增 `readonly reason: LockBlockReason` 与 `readonly op: string`；`message` 恒为用户可读的中文友好文案（`LOCK_BLOCK_MESSAGE[reason]`），**不再包含**「环境锁 / destructive / op 名 / 路径」等内部细节。
- `withMutationLock` 在 acquire 失败时把分类透出（`reason` 随返回），`runWithMutationLock` 据此构造错误（`reason ?? 'locked'`）。
- `index.ts` 三处 423 响应：`error.message` 已是友好文案；新增 `host.log.warn('mutation lock blocked: op=…')` 把 op 诊断写日志（内部诊断只进日志，不进用户响应）。
- `cli/index.ts` 两处：去掉技术化追加文案（不再硬编码「另一个 DSH 任务正在进行…」/ `--recover-stale-lock`），直接使用 `error.message`。

### 安全/正确性
- 锁被占用（LOCKED）≠ 锁不可用（IO/PERM/UNKNOWN/STALE）：现在两类分别给诚实话语，**不再把「另一个任务在运行」错配给 IO/权限类锁错误**。
- SAFE MODE（`isBlocked`）单独归为 `blocked`，给「配置修改已被保护」文案，与 423 `transaction-recovery-required` 路径语义对齐。

### 改动文件
- `src/utils/env-lock.ts`、`src/index.ts`、`src/cli/index.ts`、`src/core/phase3-consistency.test.ts`（同步更新断言正则 `/配置修改已被保护|拒绝执行/`）

---

## 4. 验证结果

### 全量（基线之上零回归）
| 命令 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 通过（多次，含 A/B/C 各阶段） |
| `npm test` | ✅ **1457/1457**（基线 1454 + 新增 2 迁移测试 + 1 偶发 env-lock 竞态重跑通过） |
| `npm run build` | ✅ 通过（tsdown client bundle：`lib/client.js` 720.80 kB，CSS Modules 正常） |
| `npm run smoke` | ✅ 12/12 |

### 测试断言说明
- `run-store.test.ts`：新增旧 panel 值迁移测试（`panel:'recovery'`→snapshots+subTab；`panel:'about'/'history'`→more+moreSub）；并把 2 处旧 `panel:'recovery'` 更新为 `panel:'snapshots'`（测的是 recovery 切片持久化，panel 仅导航字段）。
- `phase3-consistency.test.ts`：同步更新 `EnvironmentLockUnavailableError` 断言正则（旧 `/环境锁被占用|拒绝执行/` → 新 `/配置修改已被保护|拒绝执行/`）。
- 未放宽任何测试语义；内部标识符（`pre-restore`/`operation-bound`/校验字段）未被误改。

### 浏览器/交互验证
- DSH web GUI（`http://127.0.0.1:3080`）已启动可用。
- **NOT VERIFIED（如实说明）**：本会话运行的 DSH 加载的是**已发布 npm 0.1.54** 插件构建，而非本仓库本地 `lib/client.js` 新构建；未在互动 UI 层看到新 6-tab 结构 / 恢复面板中文化 / 锁冲突文案的真实渲染。**未重装/替换运行中插件**（避免破坏活动会话）。
- 单测/纯函数/编译/打包层面已充分验证：tab 结构逻辑（run-store 迁移测试）、恢复状态值映射（recovery-view 纯函数）、锁分类（phase3-consistency 断言）、typecheck（编译期 locale 缺键校验）、tsdown build（client bundle 可产出）。
- 真实跨进程锁冲突无法在当前单进程环境触发；其分类与文案经代码 + 单测验证。

**验证手段与结果汇总**：逻辑/编译/打包 = **PASS**（typecheck / 全量 test / build / smoke 全绿）；真实交互 UI + 跨进程锁冲突 = **NOT VERIFIED**（运行实例为发布构建，未重装；已记录验证方式与局限）。

---

## 5. 遗留事项
1. **导出结果页「导入此文件」快捷按钮**（PM P2）：本期控制范围未实现；建议后续在 ExportView 结果卡加「导入此文件」，复用`importBackup` 注入机制。
2. **同步历史 vs 迁移历史 粒度甄别**（PM）：建议在迁移历史标注「全局审计」、同步历史标注「本通道」，或迁移历史过滤纯同步项 —— 属产品取舍，待用户确认。
3. **`messages.ts adapter.pluginInstallFailed`**：保留内部 `dsh plugin --profile …` 命令（actionable 手动路径，非安全泄漏）。若希望彻底面向非技术用户，可改为「请在结果页重试或修复依赖后重新安装」，需用户拍板。
4. **全局 SAFE MODE 横幅触发时机**：当前按 `recovery.status()` 在 section 挂载时拉取一次；恢复面板内清除后横幅可能需刷新/切 tab 才消失（横幅只读状态，刷新正确）。
5. **DESIGN.md 其它过期骨架**：§7.1 已按新 6-tab 更新；后续若发现其它章节与代码不一致，按「代码为 Ground Truth」修正。
