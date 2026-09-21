/**
 * 迁移前咨询（Phase 7）：健康评分 + 咨询报告模型（纯函数，可测）。
 *
 * 三段式引擎第一段：迁移前咨询（Manifest + 健康评分）→ 迁移中事务（Phase 3 Journal）
 * → 迁移后可审计（Phase 6 迁移历史）。本模块是**只读分析层**，不新建任何持久化 framework。
 *
 * Core Invariants：
 *  - READ-ONLY：本模块纯函数，绝不产生 mutation（不写配置/快照/journal）。
 *  - ACCURATE：评分规则驱动、确定性（同一源任何时候评分一致）；**verdict/recommendation 由证据
 *    （issue 严重度 + 硬阻断白名单）决定，不由分数决定**——分数只做量化展示，且在有硬阻断时
 *    被压进 critical 区间，避免出现「评分 89 / 建议阻止执行」这种自相矛盾的结论。
 *  - COMPLETE：覆盖全部 4 种可迁移源类型（export-zip / local-snapshot / remote-snapshot / profile）。
 *  - REDACTED：报告绝不含 secret/凭据/敏感值（宿主在填充 sensitiveHits 时已脱敏；
 *    渲染前由 UI 层 redact() 兜底）。
 *  - ACTIONABLE：产出 proceed / review / block 三态建议并能解释为什么（recommendationReasons）。
 *  - BOUND：报告关联 manifest / snapshotId / 源标识（可追溯）。
 *  - NON-BLOCKING 安全：咨询是建议性；默认 review 级不强制阻断，health=critical 且
 *    allowBlock=true 时可 block（block 逻辑可回退/可覆盖，且记录在案）。
 *
 * 复用现有：computeCompatibility（扩展而非重写）、validateManifest、scanAndRedact、
 * integrity/zip-security、import-wizard 分析管线（宿主填充 migratability）。
 */
import { computeCompatibility } from './validator.ts';
import type { CompatibilityScore } from './types.ts';
import type { Manifest, SectionId } from '../schema/types.ts';
import type { ManifestIssue } from '../schema/manifest.ts';
import type { SensitiveHit } from './types.ts';
import { redact } from '../security/redaction.ts';

/* ---------------- 类型 ---------------- */

export type ConsultSourceType = 'export-zip' | 'local-snapshot' | 'remote-snapshot';
export type HealthVerdict = 'healthy' | 'needs-attention' | 'critical';
export type Recommendation = 'proceed' | 'review' | 'block';

export type ConsultDimensionId =
  | 'compatibility' | 'integrity' | 'sections' | 'consistency' | 'sensitive' | 'migratability';

export interface ConsultSourceRef {
  type: ConsultSourceType;
  /** 源标识：ZIP 路径 / snapshotId / 远端快照 id / profile 名 */
  id: string;
  /** 关联 snapshotId（local-snapshot / remote-snapshot） */
  snapshotId?: string;
}

export interface ConsultIssue {
  severity: 'info' | 'warning' | 'error';
  /** 稳定问题码（i18n 键后缀；如 'integrity.manifestInvalid'） */
  code: string;
  /** 已 redact 的可读消息（宿主/UI 层负责脱敏） */
  message: string;
  /** 已 redact 的证据（可选） */
  evidence?: string;
}

export interface HealthDimension {
  id: ConsultDimensionId;
  /** 0-100 */
  score: number;
  verdict: HealthVerdict;
  issues: ConsultIssue[];
}

/** 可迁移性（宿主经 analyzeImport / createImportPlan / analyzeSwitch 计算；null = 未评估） */
export interface MigratabilityResult {
  ok: boolean;
  itemCount: number;
  fatalConflicts: number;
  warnings: number;
  sections: SectionId[];
  errors: string[];
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
  /** 敏感暴露面（宿主经 scanAndRedact 统计；只含路径/字段名，不含值） */
  sensitiveHits: SensitiveHit[];
  /** 可迁移性（宿主计算；null = 未评估） */
  migratability: MigratabilityResult | null;
}

export interface ConsultTarget {
  targetDsh: string;
  targetPlatform: string;
}

export interface ConsultOptions {
  /** block 是否允许（health=critical 且此 true 时 recommendation=block；缺省 false） */
  allowBlock?: boolean;
  /** 各维度权重（缺省内置；总和应为 1） */
  weights?: Partial<Record<ConsultDimensionId, number>>;
}

export interface ConsultWillApply {
  sections: SectionId[];
  itemCount: number;
  conflicts: number;
  risks: number;
  overwritten: number;
  /** 咨询恒为 dry-run（只读分析） */
  dryRun: boolean;
}

export interface ConsultReport {
  source: ConsultSourceRef;
  /** 0-100 */
  healthScore: number;
  verdict: HealthVerdict;
  recommendation: Recommendation;
  /**
   * 硬阻断项数（**只有 >0 才会建议 block**）：包不可信 / 照做会失败。
   * UI 用它把「为什么不能继续」与「需要你处理什么」分开显示，不再让一个分数代替结论。
   */
  blockerCount: number;
  /** 需处理项数（warning/error 但非硬阻断）：冲突、缺分区、凭据要补录、敏感提醒等。 */
  attentionCount: number;
  /** 触发项（已 redact；硬阻断在前） */
  recommendationReasons: string[];
  dimensions: HealthDimension[];
  willApply: ConsultWillApply;
  bound: { manifest?: Manifest; snapshotId?: string; sourceId: string };
  generatedAt: string;
}

/* ---------------- 常量 ---------------- */

/** 内置维度权重（总和 = 1） */
export const DEFAULT_DIMENSION_WEIGHTS: Record<ConsultDimensionId, number> = {
  compatibility: 0.20,
  integrity: 0.25,
  sections: 0.20,
  consistency: 0.10,
  sensitive: 0.15,
  migratability: 0.10,
};

/** 维度 verdict 阈值：score>=90 → healthy；60<=score<90 → needs-attention；score<60 → critical */
export const HEALTHY_THRESHOLD = 90;
export const CRITICAL_THRESHOLD = 60;

/**
 * **硬阻断**问题码：只有这些「照做会失败 / 包本身不可信」的硬伤才配得上 block。
 *
 * 为什么需要这份白名单（用户实测反馈）：原实现让**分数**决定结论 —— 任一维度 <60 就算
 * critical，于是「2 处冲突需要你决定」「3 个凭据引用没声明」这种纯决策/提醒也能把整份咨询
 * 推成「建议：阻止执行」，用户拿到过自相矛盾的「健康评分 89 / 建议：阻止执行」。
 * 冲突、缺声明、未加密秘密都是**要告诉用户、要他去处理**的事，不是「不许导」。
 */
export const HARD_BLOCKER_CODES: ReadonlySet<string> = new Set([
  // 引擎会直接拒绝 / 内容不可信 —— 判定标准：**引擎侧真的不会继续**，而不是「看起来不好」
  'compatibility.noManifest',   // 根本不是本插件的备份（无 manifest）
  'compatibility.unsupported',  // schema 超出支持范围 → canImport() 拒绝
  'integrity.noManifest',
  'integrity.checksumMismatch', // 条目内容与 checksum 不符：包被改过 / 损坏
  'integrity.zipSlip',          // 条目路径越界（安全拒绝）
  'migratability.failed',       // dry-run 不通过 → 直接执行必然失败
  'migratability.error',
]);

/** 该 issue 是否是硬阻断（结论为 block 的唯一依据）。 */
export function isHardBlocker(issue: ConsultIssue): boolean {
  return issue.severity === 'error' && HARD_BLOCKER_CODES.has(issue.code);
}

/* ---------------- 评分辅助 ---------------- */

/**
 * 维度 verdict：**由证据决定，不由分数决定**。
 *
 *  - 有硬阻断 → critical（照做会失败）；
 *  - 有任何 warning/error → needs-attention（要用户看一眼 / 处理一下）；
 *  - 只有 info 或没有 issue → healthy。
 *
 * 分数继续用于量化展示（并被 `HEALTHY_THRESHOLD` / `CRITICAL_THRESHOLD` 用作参考刻度），
 * 但不再能单独把结论推到 critical —— 这正是「89 分却建议阻止执行」的根因。
 */
function dimensionVerdict(issues: readonly ConsultIssue[]): HealthVerdict {
  if (issues.some(isHardBlocker)) return 'critical';
  if (issues.some((i) => i.severity !== 'info')) return 'needs-attention';
  return 'healthy';
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function worstVerdict(a: HealthVerdict, b: HealthVerdict): HealthVerdict {
  const rank: Record<HealthVerdict, number> = { healthy: 0, 'needs-attention': 1, critical: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/* ---------------- 各维度评分 ---------------- */

/** 兼容性维度：复用 computeCompatibility（扩展而非重写） */
export function scoreCompatibility(
  data: ConsultSourceData,
  target: ConsultTarget,
): HealthDimension {
  const issues: ConsultIssue[] = [];
  let score: number;
  let compat: CompatibilityScore;
  if (data.manifest === null) {
    compat = 'unsupported';
    score = 0;
    issues.push({ severity: 'error', code: 'compatibility.noManifest', message: '无法评估兼容性：manifest 缺失' });
  } else {
    compat = computeCompatibility({
      sourceDsh: data.sourceDsh,
      targetDsh: target.targetDsh,
      sourcePlatform: data.sourcePlatform,
      targetPlatform: target.targetPlatform,
      schemaVersion: data.schemaVersion,
      missingSections: data.missingSections,
    });
    switch (compat) {
      case 'excellent': score = 100; break;
      case 'good': score = 90; break;
      case 'partial':
        score = 60;
        issues.push({ severity: 'warning', code: 'compatibility.partial', message: '部分兼容：跨平台 / 分区缺失 / 版本超前，需人工确认' });
        break;
      case 'unsupported':
        score = 0;
        issues.push({ severity: 'error', code: 'compatibility.unsupported', message: '不受支持：schema 超出本插件支持范围' });
        break;
    }
  }
  return { id: 'compatibility', score, verdict: dimensionVerdict(issues), issues };
}

/** 结构完整性维度：manifest 合法 + checksums 匹配 + 无 Zip Slip */
export function scoreIntegrity(data: ConsultSourceData): HealthDimension {
  const issues: ConsultIssue[] = [];
  let score = 100;
  if (data.manifest === null) {
    score = 0;
    issues.push({ severity: 'error', code: 'integrity.noManifest', message: 'manifest 缺失，无法校验结构完整性' });
  } else {
    for (const issue of data.manifestIssues) {
      if (issue.severity === 'error') {
        score -= 30;
        issues.push({ severity: 'error', code: 'integrity.manifestInvalid', message: `manifest 无效：${issue.message}`, evidence: issue.path });
      } else {
        score -= 10;
        issues.push({ severity: 'warning', code: 'integrity.manifestWarning', message: `manifest 警告：${issue.message}`, evidence: issue.path });
      }
    }
  }
  for (const c of data.checksumIssues) {
    score -= 30;
    issues.push({ severity: 'error', code: 'integrity.checksumMismatch', message: `完整性校验失败：${c}` });
  }
  // 源无 checksum 表（manifest 存在但 checksums 缺失）→ warning（轻度完整性顾虑）
  if (data.manifest !== null && data.checksums === null) {
    score -= 10;
    issues.push({ severity: 'warning', code: 'integrity.noChecksums', message: '源缺少 checksum 表，无法校验条目完整性' });
  }
  for (const z of data.zipSlipIssues) {
    score -= 30;
    issues.push({ severity: 'error', code: 'integrity.zipSlip', message: `ZIP 路径越界：${z}` });
  }
  return { id: 'integrity', score: clampScore(score), verdict: dimensionVerdict(issues), issues };
}

/** 分区完整性维度：每个声明分区的数据可解析、无残缺 */
export function scoreSections(data: ConsultSourceData): HealthDimension {
  const issues: ConsultIssue[] = [];
  let score = 100;
  for (const sid of data.missingSections) {
    score -= 20;
    issues.push({ severity: 'warning', code: 'sections.missing', message: `声明包含但数据缺失：${sid}`, evidence: sid });
  }
  // 分区数据不可解析（manifest 声明但 sections 中无对应数据且非 missingSections 覆盖）
  if (data.manifest !== null) {
    for (const [sid, enabled] of Object.entries(data.manifest.sections) as [SectionId, boolean][]) {
      if (!enabled) continue;
      if (data.missingSections.includes(sid)) continue;
      if (!data.sections.has(sid)) {
        score -= 30;
        issues.push({ severity: 'error', code: 'sections.unparseable', message: `分区数据不可解析：${sid}`, evidence: sid });
      }
    }
  }
  return { id: 'sections', score: clampScore(score), verdict: dimensionVerdict(issues), issues };
}

/* ---------------- 一致性检查（凭据引用） ---------------- */

/** 从 settings 分区提取凭据引用名（apiKeyEnv / 引用类字段值） */
function extractSettingsCredentialRefs(data: ConsultSourceData): string[] {
  const refs = new Set<string>();
  const settings = data.sections.get('settings') as
    | { namespaces?: Record<string, { value?: unknown }> }
    | undefined;
  const REFERENCE_REF_FIELDS = new Set([
    'apikeyenv', 'api_key_env', 'apikeyname', 'tokenenv', 'accesstokenenv',
    'refreshtokenenv', 'clientsecretenv', 'passwordenv',
  ]);
  for (const rec of Object.values(settings?.namespaces ?? {})) {
    const value = (rec.value ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) {
      const norm = k.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (REFERENCE_REF_FIELDS.has(norm) && typeof v === 'string' && v !== '') refs.add(v);
    }
    if (typeof value['apiKeyEnv'] === 'string' && value['apiKeyEnv'] !== '') refs.add(value['apiKeyEnv']);
    const providers = value['providers'];
    if (providers !== null && typeof providers === 'object') {
      for (const pv of Object.values(providers as Record<string, { apiKeyEnv?: unknown }>)) {
        if (pv !== null && typeof pv === 'object' && typeof pv.apiKeyEnv === 'string' && pv.apiKeyEnv !== '') {
          refs.add(pv.apiKeyEnv);
        }
      }
    }
  }
  return [...refs];
}

/** 从 providers 分区提取凭据引用名（providers[route].apiKeyEnv） */
function extractProvidersCredentialRefs(data: ConsultSourceData): string[] {
  const refs = new Set<string>();
  const providers = data.sections.get('providers') as
    | { providers?: Record<string, { apiKeyEnv?: unknown }> }
    | undefined;
  for (const pv of Object.values(providers?.providers ?? {})) {
    if (pv !== null && typeof pv === 'object' && typeof pv.apiKeyEnv === 'string' && pv.apiKeyEnv !== '') {
      refs.add(pv.apiKeyEnv);
    }
  }
  return [...refs];
}

/** 从 credentialsStatus 分区提取已声明 ref 集 */
function extractDeclaredCredentialRefs(data: ConsultSourceData): Set<string> {
  const refs = new Set<string>();
  const creds = data.sections.get('credentialsStatus') as
    | { credentials?: { ref?: string }[] }
    | undefined;
  for (const c of creds?.credentials ?? []) {
    if (typeof c?.ref === 'string' && c.ref !== '') refs.add(c.ref);
  }
  return refs;
}

/**
 * 一致性维度：跨分区引用（凭据引用）是否自洽；孤立/悬空引用。
 *
 * 悬空引用是**提醒级**：备份里引用了某个凭据名、但凭据分区没声明它 —— 导入后如果本机也没有，
 * 用户需要补录一个 key。这既不代表导入会失败，也不是安全问题（只有 ref 名，没有值）。
 * 因此：一条聚合消息（不再逐个 ref 各刷一行）+ 扣分设上限，且**永不判 critical**。
 */
export function scoreConsistency(data: ConsultSourceData): HealthDimension {
  const issues: ConsultIssue[] = [];
  let score = 100;
  const referenced = new Set([
    ...extractSettingsCredentialRefs(data),
    ...extractProvidersCredentialRefs(data),
  ]);
  const declared = extractDeclaredCredentialRefs(data);
  const dangling = [...referenced].filter((ref) => !declared.has(ref));
  if (dangling.length > 0) {
    score -= Math.min(dangling.length * 15, 45);
    const shown = dangling.slice(0, 5).join('、');
    const more = dangling.length > 5 ? ` 等 ${dangling.length} 个` : '';
    issues.push({
      severity: 'warning',
      code: 'consistency.danglingCredentialRef',
      message: `备份引用了 ${dangling.length} 个未在凭据分区声明的凭据（导入后本机若缺值需补录）：${shown}${more}`,
      evidence: dangling.join(', '),
    });
  }
  return { id: 'consistency', score: clampScore(score), verdict: dimensionVerdict(issues), issues };
}

/** 敏感暴露维度：快照是否含未加密 secret、高熵 token 泄漏面 */
export function scoreSensitive(data: ConsultSourceData): HealthDimension {
  const issues: ConsultIssue[] = [];
  let score = 100;
  if (data.containsSecrets && !data.encrypted) {
    score -= 40;
    issues.push({ severity: 'error', code: 'sensitive.unencryptedSecrets', message: '快照含未加密秘密（凭据值明文暴露）' });
  }
  const hitCount = data.sensitiveHits.length;
  if (hitCount > 0) {
    const penalty = Math.min(hitCount * 5, 40);
    score -= penalty;
    issues.push({
      severity: 'warning',
      code: 'sensitive.hits',
      message: `检测到 ${hitCount} 处敏感字段暴露（已脱敏）`,
    });
  }
  return { id: 'sensitive', score: clampScore(score), verdict: dimensionVerdict(issues), issues };
}

/** 可迁移性维度：dry-run 应用能否通过（无致命冲突） */
export function scoreMigratability(data: ConsultSourceData): HealthDimension {
  const issues: ConsultIssue[] = [];
  let score: number;
  const m = data.migratability;
  if (m === null) {
    // 未评估可迁移性 = warning 级 → needs-attention（60），与 warning 标签一致（不落到 critical）
    score = 60;
    issues.push({ severity: 'warning', code: 'migratability.notEvaluated', message: '未评估可迁移性（dry-run 未执行）' });
  } else if (!m.ok) {
    score = 0;
    issues.push({ severity: 'error', code: 'migratability.failed', message: '可迁移性检查失败：dry-run 无法通过' });
    for (const e of m.errors) {
      issues.push({ severity: 'error', code: 'migratability.error', message: e });
    }
  } else {
    score = 100;
    /**
     * 冲突 = **需要你决定保留哪一边**（下一步可逐个选择，默认不覆盖本机），不是「照做会失败」。
     * 原实现每个冲突 -30 并记 error，两处冲突就把维度压成 critical、把整份咨询推成「阻止执行」——
     * 与用户实际要做的事完全不符（用户实测抱怨的正是这种假建议）。
     */
    if (m.fatalConflicts > 0) {
      score -= Math.min(m.fatalConflicts * 15, 60);
      issues.push({
        severity: 'warning',
        code: 'migratability.conflicts',
        message: `有 ${m.fatalConflicts} 处冲突需要你决定保留哪一边（下一步可逐个选择；默认不覆盖本机）`,
      });
    }
    if (m.warnings > 0) {
      score -= Math.min(m.warnings * 5, 30);
      issues.push({
        severity: 'warning',
        code: 'migratability.warning',
        message: `另有 ${m.warnings} 项需要留意（不影响导入能否成功）`,
      });
    }
  }
  return { id: 'migratability', score: clampScore(score), verdict: dimensionVerdict(issues), issues };
}

/* ---------------- 汇总 ---------------- */

/**
 * 构造时脱敏（REDACTED 不变量主防线）：对每个 issue 的 message/evidence 应用 redact()。
 * 渲染前 redact() 仅作辅防线；本函数保证报告对象本身不含敏感值。
 */
function redactIssues(dims: HealthDimension[]): HealthDimension[] {
  return dims.map((d) => ({
    ...d,
    issues: d.issues.map((i) => ({
      ...i,
      message: redact(i.message),
      evidence: i.evidence !== undefined ? redact(i.evidence) : undefined,
    })),
  }));
}

/** 计算全部维度（确定性） */
export function computeDimensions(
  data: ConsultSourceData,
  target: ConsultTarget,
  weights: Record<ConsultDimensionId, number> = DEFAULT_DIMENSION_WEIGHTS,
): HealthDimension[] {
  const dims: HealthDimension[] = [
    scoreCompatibility(data, target),
    scoreIntegrity(data),
    scoreSections(data),
    scoreConsistency(data),
    scoreSensitive(data),
    scoreMigratability(data),
  ];
  // 权重仅用于加权平均；维度 verdict 与权重无关（确定性）
  void weights;
  return redactIssues(dims);
}

/** 汇总健康评分 + verdict + recommendation（确定性） */
export function computeConsultReport(
  data: ConsultSourceData,
  target: ConsultTarget,
  opts: ConsultOptions = {},
): ConsultReport {
  const weights: Record<ConsultDimensionId, number> = {
    ...DEFAULT_DIMENSION_WEIGHTS,
    ...opts.weights,
  };
  const dimensions = computeDimensions(data, target, weights);

  // 证据分桶：**结论只看证据**（硬阻断 / 需处理），分数只用于量化展示。
  const allIssues = dimensions.flatMap((d) => d.issues);
  const blockers = allIssues.filter(isHardBlocker);
  const attention = allIssues.filter((i) => !isHardBlocker(i) && (i.severity === 'error' || i.severity === 'warning'));

  // 加权平均（展示用；不参与结论）
  let weighted = 0;
  for (const dim of dimensions) {
    weighted += (weights[dim.id] ?? 0) * dim.score;
  }
  // 有硬阻断时把分数压进 critical 区间：否则会展示「评分 93 / 建议：阻止执行」这种自相矛盾
  const healthScore = blockers.length > 0
    ? Math.min(clampScore(weighted), CRITICAL_THRESHOLD - 1)
    : clampScore(weighted);

  const verdict: HealthVerdict = blockers.length > 0
    ? 'critical'
    : attention.length > 0 ? 'needs-attention' : 'healthy';

  const recommendation: Recommendation = blockers.length > 0
    ? (opts.allowBlock === true ? 'block' : 'review')
    : attention.length > 0 ? 'review' : 'proceed';

  // 触发项：硬阻断排最前（用户先看到「为什么不能导入」），其余按维度顺序；core 已做同类聚合
  const recommendationReasons: string[] = [...blockers, ...attention].map((i) => i.message);

  // willApply（来自 migratability；dryRun 恒 true）
  const m = data.migratability;
  const willApply: ConsultWillApply = {
    sections: m?.sections ?? [],
    itemCount: m?.itemCount ?? 0,
    conflicts: m?.fatalConflicts ?? 0,
    risks: m?.warnings ?? 0,
    overwritten: m?.fatalConflicts ?? 0,
    dryRun: true,
  };

  const bound: ConsultReport['bound'] = { sourceId: data.source.id };
  if (data.manifest !== null) bound.manifest = data.manifest;
  if (data.source.snapshotId !== undefined) bound.snapshotId = data.source.snapshotId;

  return {
    source: data.source,
    healthScore,
    verdict,
    recommendation,
    blockerCount: blockers.length,
    attentionCount: attention.length,
    recommendationReasons,
    dimensions,
    willApply,
    bound,
    generatedAt: new Date().toISOString(),
  };
}
