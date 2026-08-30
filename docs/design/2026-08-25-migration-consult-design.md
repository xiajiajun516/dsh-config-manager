# 迁移前咨询（Migration Pre-flight Consultation）设计

> 三段式引擎第一段：迁移前咨询（Manifest + 健康评分）。迁移中事务 = Phase 3（Journal），迁移后可审计 = Phase 6（迁移历史）。
> 本设计是 Phase 7 的实现规格；上游依据 = PHASE7_PROMPT.md。

## 1. 目标

在任何 destructive/migration 操作（导入 / 恢复 / 同步应用 / 档案切换）真正执行前，对源（导出 ZIP / 本地快照 / 远端快照 / 配置档案）生成一份**可读、可审计、只读**的咨询报告：

- 源的健康评分（Health Score 0–100）：版本/平台兼容 + 完整性 + 分区完整性 + 一致性 + 敏感暴露面 + 可迁移性。
- 「将要发生什么」：将应用哪些分区、多少条目、哪些冲突/风险、哪些会被覆盖、哪些是 dry-run。
- 一个明确的建议（Recommendation）：proceed / review / block（可配置，block 时保守拦截）。

## 2. Core Invariants（硬约束）

- **READ-ONLY**：咨询绝不产生任何 mutation（纯读源 + dry-run 分析；不写配置、不建快照、不写 journal）。
- **ACCURATE**：健康评分规则驱动、确定性（同一源任何时候评分一致）；verdict 与评分/证据一致。
- **COMPLETE**：覆盖全部 4 种可迁移源类型；评分维度齐全。
- **REDACTED**：咨询报告绝不含 secret/凭据/敏感值。**构造时即脱敏（主防线）**：核心 `computeDimensions` 对每个 issue 的 message/evidence 应用 `redact()`；渲染前 `redact()` 仅作辅防线。`message`/`evidence` 只允许固定模板 + 计数 + 已脱敏标识符。
- **ACTIONABLE**：产出 proceed / review / block 三态建议并能解释为什么（列出触发项）。
- **BOUND**：报告关联 manifest / snapshotId / 源标识（可追溯）。
- **NON-BLOCKING 安全**：咨询是建议性；默认 review 级不强制阻断，但 health=critical 且配置允许时可 block（block 逻辑可回退/可覆盖，且记录在案）。

## 3. 架构

- **复用现有**：`computeCompatibility`（扩展而非重写）、`validateManifest`、`validateSections`、`scanAndRedact`、integrity/zip-security、import-wizard 的分析管线。
- **扩展优先**：健康评分在 `computeCompatibility` 之上叠加额外维度；不推倒现有兼容性评分。
- **不创建第二套 framework**：咨询是只读分析层，不新建 journal / transaction / lock / snapshot-trust。
- **新文件**：
  - `src/core/migration-consult.ts` —— 纯函数健康评分 + 咨询报告模型（可测）。
  - `src/ui/migration-consult-view.ts` —— 纯渲染模型（可测）。
  - 接线到 import-wizard / sync 预览 / restore 预览。
- **i18n**：所有展示文本走字典（zh 源 / en 镜像），复用 `config-manager` ns（新增 `consult.*` 键）。

## 4. 数据模型（src/core/migration-consult.ts）

```ts
export type ConsultSourceType = 'export-zip' | 'local-snapshot' | 'remote-snapshot' | 'profile';
export type HealthVerdict = 'healthy' | 'needs-attention' | 'critical';
export type Recommendation = 'proceed' | 'review' | 'block';

export interface ConsultSourceRef { type: ConsultSourceType; id: string; snapshotId?: string; }

export interface ConsultIssue { severity: 'info'|'warning'|'error'; code: string; message: string; evidence?: string; }

export interface HealthDimension { id: ConsultDimensionId; score: number; verdict: HealthVerdict; issues: ConsultIssue[]; }

export type ConsultDimensionId =
  | 'compatibility' | 'integrity' | 'sections' | 'consistency' | 'sensitive' | 'migratability';

export interface MigratabilityResult {
  ok: boolean; itemCount: number; fatalConflicts: number; warnings: number;
  sections: SectionId[]; errors: string[];
}

/** 归一化后的源数据（宿主按源类型读取填充；核心只做评分） */
export interface ConsultSourceData {
  source: ConsultSourceRef;
  manifest: Manifest | null;
  manifestIssues: ManifestIssue[];
  sections: Map<SectionId, unknown>;
  sectionFiles: Map<string, Uint8Array>;
  checksums: Record<string, string> | null;
  checksumIssues: string[];
  zipSlipIssues: string[];
  encrypted: boolean;
  containsSecrets: boolean;
  sourceDsh: string;
  sourcePlatform: string;
  schemaVersion: number;
  missingSections: SectionId[];
  sensitiveHits: SensitiveHit[];
  migratability: MigratabilityResult | null;
}

export interface ConsultTarget { targetDsh: string; targetPlatform: string; }

export interface ConsultOptions {
  allowBlock?: boolean;                       // 缺省 false
  weights?: Partial<Record<ConsultDimensionId, number>>;  // 缺省内置
}

export interface ConsultReport {
  source: ConsultSourceRef;
  healthScore: number;                        // 0-100
  verdict: HealthVerdict;
  recommendation: Recommendation;
  recommendationReasons: string[];            // 触发项（已 redact）
  dimensions: HealthDimension[];
  willApply: { sections: SectionId[]; itemCount: number; conflicts: number; risks: number; overwritten: number; dryRun: boolean };
  bound: { manifest?: Manifest; snapshotId?: string; sourceId: string };
  generatedAt: string;
}
```

## 5. 评分规则（确定性，可单测）

每个维度从 100 起扣分；`score = max(0, 100 - 惩罚)`。维度 verdict：`score>=90 → healthy`；`60<=score<90 → needs-attention`；`score<60 → critical`。

| 维度 | 权重 | 规则 |
|---|---|---|
| compatibility | 0.20 | 复用 `computeCompatibility`：excellent=100；good=90；partial=60（warning「跨平台/分区缺失/版本超前」）；unsupported=0（error「schema 超出范围」）；manifest 为 null → 0（error，短路不评分） |
| integrity | 0.25 | manifest 为 null → 0（error，短路）；manifestIssues 每个 error -30 / warning -10；checksumIssues 每个 -30；zipSlipIssues 每个 -30；manifest 存在但 checksums 为 null → -10（warning「源缺 checksum 表」） |
| sections | 0.20 | missingSections 每个 -20（warning）；「声明但数据缺失且非 missingSections」每个 -30（error）——**missing 与 unparseable 互斥**（missing 优先，不重复扣分） |
| consistency | 0.10 | 悬空凭据引用（settings/providers 引用但 credentials 分区未声明）每个 -15（warning）；提取规则固定：`apiKeyEnv` / `tokenEnv` / 引用类字段（apikeyenv/tokenenv/accesstokenenv/refreshtokenenv/clientsecretenv/passwordenv/apikeyname）值 |
| sensitive | 0.15 | containsSecrets && !encrypted → -40（error「未加密秘密」）；sensitiveHits 每个 -5（warning），**hits 部分封顶 -40**；两惩罚**叠加**（封顶仅作用于 hits 部分；同一批 secret 可能双重扣分到 score 20，属预期——未加密 + 命中都值得扣）；加密源（encrypted=true）sections 为密文，scanAndRedact 无法命中 → sensitiveHits=0，天然高分（受保护，符合预期）；**已知漏报**：短 token 逃逸双保险脱敏（Phase 6 权衡）会让「非敏感字段 + 短值」的含凭据源在 sensitive 维度报 healthy——仅影响评分，不破坏 REDACTED（值不进报告） |
| migratability | 0.10 | migratability 为 null → 60（warning「未评估可迁移性」，needs-attention 与 warning 标签一致）；!ok → 0（error，隐含致命冲突）；ok=true 时 fatalConflicts 应为 0，若 >0 每个 -30；warnings 每个 -10 |

**HealthScore** = `round(Σ weight_i × score_i)`。
**verdict** = 最差维度 verdict（critical > needs-attention > healthy）。
**recommendation**：
- verdict=critical → `allowBlock ? block : review`
- verdict=needs-attention → `review`
- verdict=healthy → `proceed`

**recommendationReasons** = 全部 error/warning issue 的 message（已 redact）。

**willApply**：sections/itemCount/conflicts 来自 migratability；overwritten 由宿主估算（冲突项数）；dryRun 恒 true（咨询只读）。

## 6. 一致性检查（consistency 维度）

纯函数 `checkConsistency(data)`：
1. 从 settings 分区 `namespaces[ns].value` 与 providers 分区 `providers[route].apiKeyEnv` 提取凭据引用名（apiKeyEnv / tokenEnv / 引用类字段值）。
2. 从 credentialsStatus 分区 `credentials[].ref` 提取已声明 ref 集。
3. 每个被引用但未声明的 ref → warning「凭据引用 X 未在 credentials 分区声明」。

## 7. 源读取（宿主接线，src/index.ts）

`/consult` 端点（**POST**，只读、loopback fence，复用代码库 `guard` helper 约定）接收 `{ type, id, snapshotId? }`，按类型读取并归一化为 `ConsultSourceData`：

| 源类型 | 读取方式 |
|---|---|
| export-zip | 复用 analyzer 的 ZIP 解析（manifest/checksums/sections），migratability 经 `analyzer.analyzeImport` + `createImportPlan` |
| local-snapshot | `SnapshotStore.load(id)` + `readBlob` 重建 sections；migratability 经重建 ZIP 的 analyze |
| remote-snapshot | `SyncEngine` 下载 → `snapshotToZip` → analyze |
| profile | `ProfileManager` 读 profile.json sections；migratability 经 `analyzeSwitch` |

敏感暴露面：对 sections 数据跑 `scanAndRedact`（**固定 `highEntropy: true`**，保证确定性）统计 hits；**文件类分区（pluginFiles/sessions/self，sectionFiles 为 Uint8Array）经 `scanText` 并入 sensitiveHits**（scanAndRedact 对 Uint8Array 原样放行，需宿主对文件文本跑 scanText）。

**READ-ONLY 磁盘边界界定**：
- **配置 / 快照存储 / journal 零写**（核心不变量）：consult 只调 analyze/plan，**禁止触达任何 execute/confirm/snapshot 路径**（`executeImportPlan` / `executeSwitch` / `createSnapshot` 均不调用）。
- **临时 ZIP 可写但必须净空**：local-snapshot「重建 ZIP 的 analyze」与 remote-snapshot「snapshotToZip」都需写临时 ZIP 喂给 analyzer。**必须采用 `pull()` 式 try/finally 立即删除临时目录**（禁用 `preview()` 的延迟清理语义），调用返回前临时目录净空。
- **git 同步工作目录的 clone/pull 属已排除边界**：git 通道 `download` 会 `ensureRepo()`（不存在则 clone）+ `pull --ff-only`，写入同步工作副本（含仓库级 `git config user.*`）。这不碰配置/快照/journal，属可接受的缓存语义；READ-ONLY 指纹比对范围**排除**同步工作目录。

**ACCURATE 不变量澄清**：评分确定性针对「同一源 + 同一目标环境快照」——migratability 是源 vs 目标对比，目标状态变化会改变冲突计数，属预期（咨询本质是「源应用到当前目标」的评估）。默认权重下评分确定；`ConsultOptions.weights` 覆盖后仅影响展示分，不影响 verdict/recommendation。

**block 的「可覆盖 + 记录在案」**：咨询本身只读、不记录；block 只是建议。若用户选择覆盖 block 继续执行，由**执行侧**（导入/恢复/同步/切换）在 Phase 6 迁移历史记录「用户覆盖 block 建议」——记录落在执行侧而非咨询侧，不破坏咨询 READ-ONLY。

## 8. UI 落位（src/ui/migration-consult-view.ts + src/client）

- 纯渲染模型 `migration-consult-view.ts`：把 `ConsultReport` 转成视图数据（健康评分徽章 + 维度明细 + 建议 + 触发项）。
- 接线点（4 处，覆盖全部源类型）：
  - **import-wizard「预览」页**（`preview` 步，非 compatibility 步——migratability 来自 `createImportPlan` 的 plan，只有 preview 步有 plan）插入咨询卡。
  - **sync 预览**（`SyncConfirmView` 差异确认前）插入咨询卡；consult 是独立只读调用，不复用 `POST /sync/sync` 差异会话数据（避免重复拉取分析，各自独立）。
  - **restore 预览**（`SnapshotsPanel` 恢复计划弹窗，非 RecoveryPanel——后者是 Phase 3 事务恢复）插入咨询卡。
  - **profile 切换预览**（`ProfilesPanel` 的 `SwitchPreviewCard` 弹窗）插入咨询卡。
- 复用公共原语：Badge / Banner / Card / SectionTitle；长维度明细限高内滚。
- 所有展示文本走 i18n 字典；渲染前 redact() 兜底。

## 9. 测试

- 评分规则各档（每维度 healthy/needs-attention/critical）。
- READ-ONLY：咨询不写任何文件/配置（对比快照前后目录/文件指纹）。
- REDACTED：报告含 secret 时 masked，读回无原值。
- COMPLETE：4 种源类型都能产出统一报告。
- Recommendation 三态 + 触发项解释。
- API / UI 纯函数。

## 10. 非目标

- 不改变 Phase 1–6 既有行为（只读分析层，只追加，不改写）。
- 不新增签名链 / MAC（Phase 6 已确认非对抗性边界）。
- 不新建持久化 framework。
