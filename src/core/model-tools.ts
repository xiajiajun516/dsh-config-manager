/**
 * dsh-config-manager — Agent 可调用的模型工具（P0-1 / D2–D6）。
 *
 * 在 host 半注册 9 个 Cordis 模型工具，让 Agent 能自主驱动配置运维：
 *   config_backup           全量备份到 exports 目录（不含 secret；可选加密）
 *   config_list_snapshots   列出本地回滚快照
 *   config_restore          预览 / 执行恢复到某快照（预览给 planId；执行必须带回来）
 *   config_sync_push        手动推送同步（写远端）
 *   config_sync_pull        拉取差异预览（零写入）
 *   config_sync_preview     三方合并预览（只读：出 planId + 分区裁决清单）
 *   config_sync_apply       按分区裁决落地合并（必须带预览给的 planId）
 *   config_import_plan      分析备份归档并生成导入计划（只读：零写入）
 *   config_import_apply     执行导入计划（必须带 planId + confirm:true）
 *
 * 设计遵循 AGENTS.md 铁律：
 *   - 所有业务逻辑为可独立测试的纯编排函数（createModelTools），
 *     复用 src/core 已解耦引擎（Exporter / restore / SyncEngine / Importer），不重复实现；
 *   - React / HTTP 壳不参与；本文件是「引擎侧编排」，不放浏览器 src/ui/；
 *   - ctx.tools 服务用可选读取（ctx.get）守卫：未组合 tools 的部署不注册、不崩溃。
 *
 * 安全不变量（硬约束，勿破坏）：
 *   - secret 值与密码永不进入工具入参/出参/render/日志；agent 拿不到任何凭据值
 *     （config_sync_push 的 includeSecrets 恒 false 且传 true 直接拒绝，导入不接受 secretInputs）；
 *   - 同步密码优先从 DSH credentials 槽位读（入参 password 保留但 deprecated：模型不该把明文写进会话）；
 *   - 预览与执行必须同一份计划：预览返回 planId（= 计划指纹），执行时按当前磁盘/远端重算比对，
 *     不一致 → 拒绝且零写入（等价 GUI 恢复路由的 409 plan-changed）；
 *   - 恢复 / 合并落地 / 导入执行一律过 GLOBAL mutation lock（与 GUI 同一条锁）；
 *   - config_sync_pull / config_sync_preview / config_import_plan 零写入；
 *   - 同步侧永不触碰 sessions 分区（agent 构造引擎时永久剔除：会话内容不因一次工具调用被上下行）。
 */
import { engineMsg } from './messages-core.ts';
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'

import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { Exporter } from './exporter.ts'
import { listSnapshots, planRestore, restore as executeRestore } from './restore.ts'
import { probeRestoreResume, runRestoreWithResume } from './restore-resume.ts'
import type { RestorePlan, RestoreReport } from './restore.ts'
import type { RestoreJournalPort } from './restore-wal.ts'
import type { ApplyMergeResolutionsReport, MergePreview, MergeResolution, SyncEngine } from '../sync/sync-engine.ts'
import { createEncryptionProvider } from '../security/encryption.ts'
import { SECTION_IDS } from '../schema/config.ts'
import type { SectionId } from '../schema/types.ts'
import { parseSyncChannel, readFullSyncConfig, readSyncConfigFor, SYNC_CHANNELS } from '../sync/sync-config.ts'
import type { SyncConfig, SyncConfigIssue, SyncTransportType } from '../sync/sync-config.ts'
import type {
  ConfigAdapter,
  HostContext,
  ImportAnalysis,
  ImportDecisions,
  ImportPlan,
  ImportResult,
  ItemResolution,
  PathMapping,
  SecretScanner,
} from './types.ts'
import type { Importer } from './importer.ts'
import { runWithMutationLock } from '../utils/env-lock.ts'
import { formatDateStamp } from '../utils/time.ts'
import { isSameOrChild } from '../utils/paths.ts'
import { restorePlanFingerprint } from './restore-plan-fingerprint.ts'
import { importPlanFingerprint, ModelPlanStore, syncMergeFingerprint } from './model-tool-plans.ts'

/* ------------------------------------------------------------ 依赖与类型 */

/** 模型工具所需依赖（与 host 路由同一来源闭包）。 */
export interface ModelToolsDeps {
  /** HostContext 门面（homeDir / profile / msg / log） */
  host: HostContext
  /** 全部分区适配器 */
  adapters: ConfigAdapter[]
  /** 导出 ZIP 落盘目录（$DSH_HOME/dsh-config-manager/exports） */
  exportsDir: string
  /** 回滚快照目录（$DSH_HOME/dsh-config-manager/snapshots） */
  snapshotsDir: string
  /** 同步状态目录（$DSH_HOME/dsh-config-manager/sync） */
  syncDir: string
  /**
   * SyncEngine 工厂（git/webdav 按配置分支构造传输；与 host 路由同一来源）。
   * D5：agent 侧按工具决定 optInSections（仅合并类工具带用户放行的可选分区），
   * 推送/拉取仍走缺省（= 只 portable），与改动前的工具行为逐字节一致。
   */
  makeSyncEngine: (cfg: SyncConfig, opts?: { optInSections?: readonly SectionId[] }) => SyncEngine
  /** 插件版本（manifest.exporter.version） */
  exporterVersion?: string
  /**
   * F2 强化 Secret 扫描器（含部署者 personalPatterns 个人规则；G-09 文件类分区文本级扫描）。
   * 必须与 HTTP 导出路由注入的是同一来源（src/index.ts 的 secretScanner 单一实例），
   * 否则两条导出路径的扫描档位不一致（个人规则 / 文件类分区凭据告警）。
   * 可选：缺省落回 Exporter 的 defaultSecretScanner()（无 scanText → 文件类分区不扫描，与修复前一致）。
   */
  scanner?: SecretScanner
  /**
   * D3：按 DSH credentials 槽位读同步密码（ENCRYPT / DECRYPT + 通道）。
   * 值只在宿主内存里交给引擎，绝不进工具返回 / render / 日志。缺省 = 未接凭据服务。
   */
  syncPassword?: (kind: 'ENCRYPT' | 'DECRYPT', channel: SyncTransportType) => Promise<string | undefined>
  /**
   * D5：用户逐分区放行的可选分区（宿主 = selectionOptInSections(channel, true) 的 'auto' 档）。
   * 缺省 = 空集；agent 侧永远再剔除 sessions（会话内容不受工具调用摆布）。
   */
  optInSections?: (channel: SyncTransportType) => readonly SectionId[]
  /** D6：导入引擎工厂（与 HTTP 导入路由同一来源）。缺省 = 导入类工具返回 import-unavailable。 */
  makeImporter?: () => Importer
  /**
   * D6：受控路径根（导入 ZIP 必须落在其中；与 /analyze、/plan 同一判据 isControlledPath）。
   * 缺省 = 一律拒绝（fail-closed：宁可让用户走 GUI，也不让 agent 把任意路径交给解析器）。
   */
  roots?: readonly string[]
  /** 计划句柄表（单测可注入假时钟；缺省每次 createModelTools 新建一个进程内表）。 */
  planStore?: ModelPlanStore
}

/** 快照 id 校验：拒绝路径分隔符与 `.`/`..`（防 join(snapshotsDir, id) 越界）。 */
function assertValidSnapshotId(snapshotId: string): void {
  if (snapshotId === '' || snapshotId.includes('/') || snapshotId.includes('\\')) {
    throw new Error(engineMsg('core.modelTools.illegalSnapshotId', { id: JSON.stringify(snapshotId) }))
  }
}

/** 快照 id 校验：存在该快照目录才返回 true（供 restore 前置检查）。 */
async function snapshotDirExists(deps: ModelToolsDeps, snapshotId: string): Promise<boolean> {
  const metas = await listSnapshots(deps.snapshotsDir)
  return metas.some((m) => m.id === snapshotId)
}

/** SECTION_IDS 白名单过滤（未知/非法分区 id 丢弃，与 host 路由语义一致）。 */
function filterSectionIds(ids: readonly string[]): SectionId[] {
  return ids.filter((id): id is SectionId => (SECTION_IDS as readonly string[]).includes(id))
}

/**
 * SEC-03：把「读侧被白名单丢弃的配置」翻成一句可执行的补充说明。
 * 只挑本通道的 issue —— git 地址被拒不该出现在 webdav 的错误里。
 */
function describeConfigIssues(issues: readonly SyncConfigIssue[], channel: SyncTransportType): string {
  const own = issues.filter((issue) => issue.channel === channel)
  if (own.length === 0) return ''
  return own.map((issue) => `config issue ${issue.code} (${issue.channel}): ${issue.message}`).join('; ')
}

/** 解析同步目标（通道 + 配置）：channel 缺省取已配置的活动通道（git/webdav），未配置则抛可操作错误。 */
async function resolveSyncTarget(
  deps: ModelToolsDeps,
  channel?: SyncTransportType,
): Promise<{ cfg: SyncConfig; channel: SyncTransportType }> {
  // SEC-03：两处读取都收集 issues —— 否则「地址被安全校验拒掉」会被报成
  // 「sync-config.json 缺失或损坏」，让模型/用户反复重填同一个被拒地址。
  const issues: SyncConfigIssue[] = []
  // 未显式指定通道 → 取已配置的活动通道（唯一判定口径 parseSyncChannel；缺省 git）
  const full = channel === undefined ? await readFullSyncConfig(deps.syncDir, issues) : null
  const ch: SyncTransportType = channel ?? parseSyncChannel(full?.transport) ?? 'git'
  const cfg = await readSyncConfigFor(deps.syncDir, ch, issues)
  if (cfg === null) {
    const base = engineMsg('core.modelTools.syncChannelNotConfigured', { channel: ch })
    const detail = describeConfigIssues(issues, ch)
    // 无 issue = 真的没配（保持原文案）；有 issue = 说清成因，绝不吞掉
    throw new Error(detail === '' ? base : `${base} — ${detail}`)
  }
  return { cfg, channel: ch }
}

/** 解析同步引擎（推送 / 拉取：缺省只同步 portable 分区，与改动前行为逐字节一致）。 */
async function resolveEngine(
  deps: ModelToolsDeps,
  channel?: SyncTransportType,
): Promise<{ engine: SyncEngine; channel: SyncTransportType }> {
  const target = await resolveSyncTarget(deps, channel)
  return { engine: deps.makeSyncEngine(target.cfg), channel: target.channel }
}

/* ------------------------------------------------------------ 结构化结论与摘要 */

/** agent 侧永久排除的同步分区（sessions = 会话内容：路径/cwd/对话，绝不因一次工具调用被上下行）。 */
const AGENT_EXCLUDED_SECTIONS: readonly SectionId[] = ['sessions']

/**
 * 工具失败的统一形状：模型据此判断「能不能重试、下一步做什么」，不需要解析自然语言。
 * 成功路径保留各自业务字段（含 ok:true）。
 */
export interface ModelToolFailure extends Record<string, JsonValue> {
  ok: false
  code: string
  message: string
  retryable: boolean
  nextAction: string
}

function failure(
  code: string,
  messageKey: string,
  nextActionKey: string,
  retryable: boolean,
  params?: Record<string, string>,
): ModelToolFailure {
  return {
    ok: false,
    code,
    message: engineMsg(messageKey, params),
    retryable,
    nextAction: engineMsg(nextActionKey),
  }
}

/** agent 侧可用可选分区：用户放行的 'auto' 档 ∩ 非永久排除项（顺序不变，供引擎判档）。 */
function agentOptInSections(deps: ModelToolsDeps, channel: SyncTransportType): SectionId[] {
  const allowed = deps.optInSections?.(channel) ?? []
  return allowed.filter((id) => !AGENT_EXCLUDED_SECTIONS.includes(id))
}

/**
 * 导入 ZIP 必须落在受控根内：与 src/routes/route-support.ts 的 isControlledPath 同一判据
 * （resolve + isSameOrChild）。roots 缺失 = 一律拒绝（fail-closed）。
 */
function isControlledZipPath(zipPath: string, roots: readonly string[] | undefined): boolean {
  if (roots === undefined || roots.length === 0) return false
  const target = resolve(zipPath)
  return roots.some((root) => isSameOrChild(target, resolve(root)))
}

/** 导入计划摘要里返回的条数上限：整份 items 可能上百条，全量下发会淹掉模型上下文。 */
const MAX_PLAN_ITEMS_RETURNED = 50

/** 分析摘要：只出判定 + 计数 + 文案（凭据只出 ref 名，值从不出现）。 */
function summarizeAnalysis(analysis: ImportAnalysis): JsonValue {
  return {
    valid: analysis.valid,
    compatibility: analysis.compatibility,
    encrypted: analysis.encrypted,
    secretCount: analysis.secretCount,
    sectionsInZip: analysis.sectionsInZip,
    errorCount: analysis.errors.length,
    errors: analysis.errors,
    warnings: analysis.warnings,
    pathIssueCount: analysis.pathIssues.length,
    plugins: { installed: analysis.pluginSummary.installed, toInstall: analysis.pluginSummary.toInstall },
    ...(analysis.sessionFormats === undefined
      ? {}
      : {
          sessionFormats: {
            target: analysis.sessionFormats.target,
            unreadable: analysis.sessionFormats.unreadable.length,
            sampled: analysis.sessionFormats.sampled,
          },
        }),
  }
}

/** 计划摘要：按 kind 计数 + 前 MAX_PLAN_ITEMS_RETURNED 条 + 缺口计数（itemsTruncated）。 */
function summarizePlan(plan: ImportPlan): JsonValue {
  const counts: Record<string, number> = {}
  for (const item of plan.items) counts[item.kind] = (counts[item.kind] ?? 0) + 1
  const items = plan.items.slice(0, MAX_PLAN_ITEMS_RETURNED).map((item) => ({
    id: item.id,
    kind: item.kind,
    adapter: item.adapter,
    description: item.description,
    severity: item.severity,
    ...(item.target === undefined ? {} : { target: item.target.ref }),
  }))
  return {
    needsRestart: plan.needsRestart,
    estimatedActions: plan.estimatedActions,
    globalStrategy: plan.globalStrategy,
    counts,
    items,
    itemsTruncated: plan.items.length - items.length,
    missingSecrets: plan.missingSecrets.map((secret) => secret.ref),
  }
}

/** 执行结果摘要：ok/回滚/重启 + 计数（逐项明细留在 journal 与 GUI 运行中心）。 */
function summarizeImportResult(result: ImportResult): JsonValue {
  return {
    ok: result.ok,
    snapshotId: result.snapshotId ?? '',
    needsRestart: result.needsRestart,
    executedCount: result.executed.length,
    missingSecrets: result.missingSecrets.length,
    warnings: result.warnings,
    rolledBack: result.rollback !== null,
    ...(result.rollback === null ? {} : { rollbackFull: result.rollback.full }),
    ...(result.ineffective === undefined ? {} : { ineffectiveCount: result.ineffective.length }),
  }
}

/**
 * 合并预览摘要：**不下发** localPreview / remotePreview / ancestorPreview 三列 ——
 * 那是给 GUI 做逐键对比用的分段文本（每段 ≤2KiB），对模型只是噪声且可能带真实配置片段。
 * 只给路径 + 冲突种类 + 原因，模型据此向用户转述「哪些分区要人裁决」。
 */
function summarizeMergePreview(preview: MergePreview): JsonValue {
  return {
    snapshotId: preview.snapshotId,
    hasAncestor: preview.hasAncestor,
    summary: preview.summary,
    sections: preview.sections.map((section) => ({
      id: section.id,
      decision: section.decision,
      conflictCount: section.conflictCount,
      ...(section.autoMerged === undefined ? {} : { autoMerged: section.autoMerged }),
      conflicts: section.conflicts.map((conflict) => ({
        path: conflict.path,
        kind: conflict.kind,
        ...(conflict.reason === undefined ? {} : { reason: conflict.reason }),
      })),
    })),
    ...(preview.message === undefined ? {} : { message: preview.message }),
    ...(preview.reason === undefined ? {} : { reason: preview.reason }),
  }
}

/* ------------------------------------------------------------ 裁决值归一（D5/D6） */

const MERGE_ACTIONS = ['keepLocal', 'useRemote', 'useMerged', 'skip'] as const

function isMergeAction(value: string): value is MergeResolution['action'] {
  return (MERGE_ACTIONS as readonly string[]).includes(value)
}

const ITEM_RESOLUTIONS = ['keepCurrent', 'useImported', 'review'] as const

/** 只接受已知裁决值：乱填的键值一律丢弃（宁缺不乱，createImportPlan 按缺省语义处理）。 */
function normalizeResolutions(input: Record<string, JsonValue> | undefined): Record<string, ItemResolution> {
  const out: Record<string, ItemResolution> = {}
  if (input === undefined) return out
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') continue
    if (!(ITEM_RESOLUTIONS as readonly string[]).includes(value)) continue
    out[key] = value as ItemResolution
  }
  return out
}

const MAPPING_TARGETS = ['workspaces', 'mcp', 'pluginConfig', 'skills'] as const

type MappingTarget = (typeof MAPPING_TARGETS)[number]

function isMappingTarget(value: string): value is MappingTarget {
  return (MAPPING_TARGETS as readonly string[]).includes(value)
}

/** 只留非空映射，并丢弃非法的 appliesTo 取值（缺省 / 空 appliesTo 合法 = 不作用到任何分区）。 */
function normalizePathMappings(
  input: readonly { oldPrefix: string; newPrefix: string; appliesTo?: readonly string[] }[] | undefined,
): PathMapping[] {
  if (input === undefined) return []
  return input
    .filter((mapping) => mapping.oldPrefix !== '' && mapping.newPrefix !== '')
    .map((mapping) => ({
      oldPrefix: mapping.oldPrefix,
      newPrefix: mapping.newPrefix,
      appliesTo: (mapping.appliesTo ?? []).filter(isMappingTarget),
    }))
}

/* ------------------------------------------------------------ 纯编排函数 */

/** 9 个工具的纯编排实现（可独立测试，不依赖 Cordis ctx）。所有返回均为 JsonValue（可序列化、无 undefined）。 */
export function createModelTools(deps: ModelToolsDeps) {
  // 计划句柄表（D2/D5/D6）：进程内、30 分钟 TTL、上限 8。只存「重放材料」——
  // 恢复 → 快照 id；合并 → 通道 + 快照 id；导入 → ZIP 路径 + 决策 JSON。
  // 绝不放密码或凭据值：凭据只在宿主内单次调用栈上出现，不落表、不落盘。
  const plans = deps.planStore ?? new ModelPlanStore()
  return {
    /** 全量备份到 exports 目录（默认不含 secret；password 可选加密，仅内存）。 */
    async backup(input: { only?: SectionId[]; password?: string }): Promise<JsonValue> {
      const only = input.only === undefined ? undefined : filterSectionIds(input.only)
      const encryption = input.password !== undefined && input.password !== ''
        ? createEncryptionProvider(input.password)
        : null
      // P2-C（Phase 8）：config_backup 接入 GLOBAL mutation lock，与导入/恢复/同步/定时备份等
      // destructive 操作互斥（写 exports 产物期间确保 live config 不被并发改动，产物一致）。
      // 无锁环境（测试/mock）→ 不锁定直接执行；锁被占用 → 抛 EnvironmentLockUnavailableError。
      const outPath = join(deps.exportsDir, `dsh-config-${formatDateStamp()}-${randomBytes(3).toString('hex')}.zip`)
      return runWithMutationLock(
        deps.host.mutationLock,
        { op: 'model-backup', target: 'exports', isBlocked: () => deps.host.safeModeIsBlocked?.() ?? false },
        async () => {
          const exporter = new Exporter({
            ctx: deps.host,
            adapters: deps.adapters,
            encryption,
            exporterVersion: deps.exporterVersion,
            // M1（G-09 接线）：与 HTTP 导出路由同一个 scanner 实例；缺省 undefined → Exporter 落回默认扫描器。
            scanner: deps.scanner,
          })
          const { report } = await exporter.export({
            includeSecrets: false,
            ...(only === undefined ? {} : { only }),
            outPath,
          })
          return {
            ok: true,
            zip: report.file.name,
            sizeBytes: report.file.sizeBytes,
            sections: report.included.map((s) => s.section),
            excluded: report.excluded,
            encrypted: report.security.encrypted,
            containsSecrets: report.security.containsSecrets,
            redactedHits: report.security.redactedHits,
            warnings: report.warnings,
          }
        },
      )
    },

    /** 列出本地回滚快照（非敏感 meta，按 createdAt 倒序）。 */
    async listSnapshots(): Promise<JsonValue> {
      const metas = await listSnapshots(deps.snapshotsDir)
      return metas.map((m) => ({
        id: m.id,
        createdAt: m.createdAt,
        sourceZip: m.sourceZip,
        ...(m.status === undefined ? {} : { status: m.status }),
        entryCount: m.entryCount,
      }))
    },

    /**
     * 恢复到指定快照。缺省只 planRestore（零写入）预览并**返回 planId**；
     * 真实执行必须 confirm:true 且带回预览给的 planId —— 计划在预览后变了就拒绝（零写入）。
     */
    async restore(input: { snapshotId: string; planId?: string; confirm?: boolean }): Promise<JsonValue> {
      const { snapshotId, planId, confirm } = input
      assertValidSnapshotId(snapshotId)
      if (!(await snapshotDirExists(deps, snapshotId))) {
        throw new Error(engineMsg('core.modelTools.snapshotNotFound', { id: snapshotId }))
      }
      const snapshotDir = join(deps.snapshotsDir, snapshotId)
      // profile：host.profile 由宿主 resolveProfileName 保证非空（缺省 'web'，见 ConfigManagerHostContext），
      // 这里仅做类型层兜底，语义与 host 路由（restore 用 host.profile）一致。
      const profile = deps.host.profile ?? 'web'
      const restoreOpts = {
        snapshotDir,
        homeDir: deps.host.homeDir,
        profile,
        ...(deps.host.msg === undefined ? {} : { msg: deps.host.msg }),
        // Phase 4 统一恢复校验（与 Host/CLI 同强度）
        snapshotsRoot: deps.snapshotsDir,
        // T8-F3：宿主权威的「当前 DSH 版本」——不传就只能按磁盘依赖树 best-effort 猜，
        // 桌面端磁盘那份可能过期 → 误报「版本不同」。只影响告警，不阻断。
        currentDshVersion: deps.host.dshVersion,
      }
      const plan: RestorePlan = await planRestore(restoreOpts)
      const fingerprint = restorePlanFingerprint(plan)
      if (confirm !== true) {
        // 预览即登记计划（供执行侧比对）；同一份盘面重复预览 → 同一 planId（覆盖写入，幂等）。
        plans.set('restore', fingerprint, { snapshotId })
        return {
          dryRun: true,
          snapshotId: plan.snapshotId,
          planId: fingerprint,
          createdAt: plan.createdAt,
          summary: {
            hostFileRestores: plan.summary.hostFileRestores,
            hostFileRemoves: plan.summary.hostFileRemoves,
            pluginRemoves: plan.summary.pluginRemoves,
            // issue #132：undo 会反向装回跟删过的插件，计数单独给出（agent 不必自己数 actions）
            pluginInstalls: plan.summary.pluginInstalls,
            fileRestores: plan.summary.fileRestores,
            fileRemoves: plan.summary.fileRemoves,
            credentialHints: plan.summary.credentialHints,
            skips: plan.summary.skips,
          },
          actions: plan.actions.map((a) => ({
            kind: a.kind,
            description: a.description,
            ...(a.target === undefined ? {} : { target: a.target }),
            ...(a.detail === undefined ? {} : { detail: a.detail }),
          })),
        }
      }
      // D2 预览-执行一致性：执行必须带预览给的 planId（缺 = plan-required，不符 = plan-changed）。
      // 两处都在**写盘之前**判定；锁内还会按当前盘面重算一次（GUI 恢复路由 409 的同款语义）。
      if (planId === undefined || planId === '') {
        return failure('plan-required', 'core.modelTools.errPlanRequired', 'core.modelTools.nextRepreview', true)
      }
      if (planId !== fingerprint) {
        return failure('plan-changed', 'core.modelTools.errPlanChanged', 'core.modelTools.nextRepreview', true)
      }
      // Step 3 P0-A：真实 model-restore 在已持锁下创建 journal（不 double-acquire）
      // ctx = journal 上下文（可选）：交给 restore() 逐动作 WAL，崩溃后 reconcile 可判进度
      const doRestore = async (ctx?: RestoreJournalPort): Promise<RestoreReport> =>
        executeRestore(ctx === undefined ? restoreOpts : { ...restoreOpts, journal: ctx })
      const phase3 = deps.host.phase3Recovery
      // 续跑探测（锁前，只读）：崩溃后再跑一次同一快照的恢复时，「同一个恢复崩在中途」正是 SAFE MODE
      // 在等的结论 —— 判得出来就放过这道门；真正写盘的决定在锁内由 runRestoreWithResume 再判一次。
      const resumeProbe = phase3 === undefined
        ? null
        : await probeRestoreResume({ store: phase3.store, restoreOpts, allowedOperationTypes: ['model-restore'] })
      const resumeAllowed = resumeProbe !== null && resumeProbe.ok
      // 锁内重算：预览到执行之间盘面可能变了 —— 判定放在持锁之后（GUI 恢复路由 409 的同一位置）。
      type RestoreOutcome = { kind: 'ok'; report: RestoreReport } | { kind: 'changed' }
      const outcome: RestoreOutcome = await runWithMutationLock(
        deps.host.mutationLock,
        { op: 'model-restore', target: snapshotId, isBlocked: () => (deps.host.safeModeIsBlocked?.() ?? false) && !resumeAllowed },
        async (lockCtx): Promise<RestoreOutcome> => {
          const fresh = await planRestore(restoreOpts)
          if (restorePlanFingerprint(fresh) !== planId) return { kind: 'changed' }
          if (phase3 !== undefined && lockCtx !== null) {
            const out = await runRestoreWithResume<RestoreReport>({
              store: phase3.store, restoreOpts, operationType: 'model-restore',
              allowedOperationTypes: ['model-restore'], lockCtx, phase3,
            })
            return { kind: 'ok', report: out.report }
          }
          return { kind: 'ok', report: await doRestore() }
        },
      )
      if (outcome.kind === 'changed') {
        return failure('plan-changed', 'core.modelTools.errPlanChanged', 'core.modelTools.nextRepreview', true)
      }
      // 计划已消费：同一 planId 不能重放（否则「执行两次」与「执行一次」无法区分）。
      plans.delete(planId)
      const report = outcome.report
      return {
        dryRun: false,
        snapshotId: report.snapshotId,
        restored: report.restored,
        removedPlugins: report.removedPlugins,
        manualHints: report.manualHints,
        failed: report.failed.map((f) => ({ item: f.item, reason: f.reason })),
        skipped: report.skipped,
      }
    },

    /**
     * 手动推送同步（写远端）。密钥绝不明文进通道：
     * D4 起 includeSecrets 恒 false —— agent 传 true 直接拒绝（模型无权让凭据值上行）。
     */
    async syncPush(input: {
      channel?: SyncTransportType
      sections?: SectionId[]
      encrypt?: boolean
      includeSecrets?: boolean
      password?: string
      force?: boolean
    }): Promise<JsonValue> {
      // D4：agent 永不触发凭据上行。参数保留在 schema 只为给出**可读的拒绝**，
      // 而不是让模型猜「为什么 includeSecrets 没生效」。
      if (input.includeSecrets === true) {
        return failure(
          'include-secrets-forbidden',
          'core.modelTools.errIncludeSecrets',
          'core.modelTools.nextRetryWithoutSecrets',
          false,
        )
      }
      const { engine, channel } = await resolveEngine(deps, input.channel)
      const sections = input.sections === undefined ? undefined : filterSectionIds(input.sections)
      const encrypt = input.encrypt === true
      // D3：密码来源优先级 = 已保存的 DSH credentials 槽位 → 入参 password（deprecated）→ 缺失即拒绝。
      // 顺序刻意：模型不该把明文密码写进工具入参（那会进会话历史）；已存槽位才是常态来源。
      const stored = encrypt ? await deps.syncPassword?.('ENCRYPT', channel) : undefined
      const password = stored ?? (input.password === undefined || input.password === '' ? undefined : input.password)
      if (encrypt && password === undefined) {
        return failure(
          'sync-password-missing',
          'core.modelTools.errSyncPasswordMissing',
          'core.modelTools.nextSaveSyncPassword',
          true,
          { channel },
        )
      }
      // Phase 2 锁：push 写远端 + 本地散文件 + sync-state，属 GLOBAL mutation。
      // Step 3 P0-A：外部 push 记 intent journal（crash 后不可证明 → NEEDS_ATTENTION，不自动重推）。
      const doPush = () => engine.push({
        ...(sections === undefined ? {} : { sections }),
        ...(encrypt ? { encrypt: true, includeSecrets: false, password: password ?? '' } : {}),
        ...(input.force === true ? { force: true } : {}),
      })
      const report = await runWithMutationLock(deps.host.mutationLock, { op: 'model-sync-push', isBlocked: () => deps.host.safeModeIsBlocked?.() ?? false }, async (lockCtx) => {
        if (deps.host.phase3Recovery !== undefined && lockCtx !== null) {
          const r = await deps.host.phase3Recovery.runExternalIntent({
            operationType: 'model-sync-push',
            lockCtx,
            intent: { adapter: 'sync', ref: input.channel ?? 'default', kind: 'Push' },
            fn: doPush,
          })
          return r.result
        }
        return doPush()
      })
      return {
        ok: report.ok,
        snapshotId: report.snapshotId,
        sections: report.sections,
        warnings: report.warnings,
        // 前置检测拒绝（远端已被别的设备推进）不是通道故障：必须显式透传，
        // 否则模型会把它当成「推送成功但内容为空」继续往下走。
        ...(report.conflict === true ? { conflict: true } : {}),
        ...(report.adoptedBase === undefined ? {} : { adoptedBase: report.adoptedBase }),
        ...(report.message === undefined ? {} : { message: report.message }),
        ...(encrypt ? { passwordSource: stored === undefined ? 'argument' : 'stored' } : {}),
      }
    },

    /** 拉取差异预览（零写入：只下载 + analyze + plan 出差异报告）。解密密码同样优先取已存槽位（D3）。 */
    async syncPull(input: {
      channel?: SyncTransportType
      snapshotId?: string
      strategy?: 'merge' | 'replace' | 'skipExisting'
      password?: string
    }): Promise<JsonValue> {
      const { engine, channel } = await resolveEngine(deps, input.channel)
      const strategy = input.strategy === 'replace' || input.strategy === 'skipExisting' ? input.strategy : 'merge'
      const stored = await deps.syncPassword?.('DECRYPT', channel)
      const password = stored ?? (input.password === undefined || input.password === '' ? undefined : input.password)
      const report = await engine.pull({
        strategy,
        ...(input.snapshotId === undefined || input.snapshotId === '' ? {} : { snapshotId: input.snapshotId }),
        ...(password === undefined ? {} : { password }),
      })
      return {
        ok: report.ok,
        snapshotId: report.snapshotId,
        needsReview: report.needsReview,
        changes: report.changes.map((c) => ({
          id: c.id,
          adapter: c.adapter,
          kind: c.kind,
          description: c.description,
          severity: c.severity,
        })),
        ...(report.message === undefined ? {} : { message: report.message }),
      }
    },

    /* ---------------- D5：三方合并（落地开放，sessions 永久排除） ---------------- */

    /**
     * 三方合并预览（只读）：下载远端快照 + 分类 + 出裁决清单，零写入。
     * 返回的 planId 是这份预览的指纹：config_sync_apply 必须带回来，落地前在锁内重跑预览比对。
     * 刻意不下发 localPreview / remotePreview / ancestorPreview —— 那是 GUI 逐键对比用的分段文本。
     */
    async syncPreview(input: { channel?: SyncTransportType; snapshotId?: string; password?: string }): Promise<JsonValue> {
      const { cfg, channel } = await resolveSyncTarget(deps, input.channel)
      // D5：只按用户放行的 'auto' 档分区建引擎；sessions 已在 agentOptInSections 里永久剔除。
      const engine = deps.makeSyncEngine(cfg, { optInSections: agentOptInSections(deps, channel) })
      const stored = await deps.syncPassword?.('DECRYPT', channel)
      const password = stored ?? (input.password === undefined || input.password === '' ? undefined : input.password)
      const opts = {
        ...(input.snapshotId === undefined || input.snapshotId === '' ? {} : { snapshotId: input.snapshotId }),
        ...(password === undefined ? {} : { password }),
      }
      const preview = await engine.previewMerge(opts)
      const planId = syncMergeFingerprint(preview)
      plans.set('sync-merge', planId, {
        channel,
        ...(input.snapshotId === undefined ? {} : { snapshotId: input.snapshotId }),
      })
      return { ok: preview.ok, planId, preview: summarizeMergePreview(preview) }
    },

    /**
     * 落地三方合并：必须带 config_sync_preview 返回的 planId（缺失/过期 → plan-*，零写入）。
     * 锁内重跑预览比对指纹 —— 预览后远端或本机变了就拒绝，不把旧裁决硬套到新盘面。
     */
    async syncApply(input: {
      planId: string
      resolutions: { id: string; action: string }[]
      password?: string
    }): Promise<JsonValue> {
      const record = plans.get(input.planId)
      if (record === undefined || record.kind !== 'sync-merge') {
        return failure('plan-expired', 'core.modelTools.errPlanExpired', 'core.modelTools.nextRepreview', true)
      }
      const channel = parseSyncChannel(record.payload.channel ?? '')
      if (channel === null || channel === undefined) {
        return failure('plan-expired', 'core.modelTools.errPlanExpired', 'core.modelTools.nextRepreview', true)
      }
      const resolutions: MergeResolution[] = []
      for (const entry of input.resolutions) {
        if (!isMergeAction(entry.action)) {
          return failure(
            'invalid-resolution',
            'core.modelTools.errInvalidResolution',
            'core.modelTools.nextFixResolution',
            true,
            { action: entry.action },
          )
        }
        resolutions.push({ id: entry.id as SectionId, action: entry.action })
      }
      const { cfg } = await resolveSyncTarget(deps, channel)
      const engine = deps.makeSyncEngine(cfg, { optInSections: agentOptInSections(deps, channel) })
      const stored = await deps.syncPassword?.('DECRYPT', channel)
      const password = stored ?? (input.password === undefined || input.password === '' ? undefined : input.password)
      const snapshotId = record.payload.snapshotId
      const opts = {
        ...(snapshotId === undefined || snapshotId === '' ? {} : { snapshotId }),
        ...(password === undefined ? {} : { password }),
      }
      type ApplyOutcome =
        | { kind: 'changed' }
        | { kind: 'ok'; report: ApplyMergeResolutionsReport; ignored: string[] }
      const outcome: ApplyOutcome = await runWithMutationLock(
        deps.host.mutationLock,
        { op: 'model-sync-apply', target: channel, isBlocked: () => deps.host.safeModeIsBlocked?.() ?? false },
        async (): Promise<ApplyOutcome> => {
          const fresh = await engine.previewMerge(opts)
          if (syncMergeFingerprint(fresh) !== input.planId) return { kind: 'changed' }
          const known = new Set(fresh.sections.map((section) => section.id))
          const decisions = resolutions.filter((resolution) => known.has(resolution.id))
          const ignored = resolutions
            .filter((resolution) => !known.has(resolution.id))
            .map((resolution) => resolution.id as string)
          const report = await engine.applyMergeResolutions(decisions, opts)
          return { kind: 'ok', report, ignored }
        },
      )
      if (outcome.kind === 'changed') {
        return failure('plan-changed', 'core.modelTools.errPlanChanged', 'core.modelTools.nextRepreview', true)
      }
      plans.delete(input.planId)
      const report = outcome.report
      return {
        ok: report.ok,
        applied: report.applied,
        restoreId: report.restoreId,
        rolledBack: report.rolledBack,
        ...(report.rollbackFull === undefined ? {} : { rollbackFull: report.rollbackFull }),
        warnings: report.warnings,
        pendingConflicts: report.pendingConflicts,
        ...(outcome.ignored.length === 0 ? {} : { ignoredResolutions: outcome.ignored }),
      }
    },

    /* ---------------- D6：导入计划 + 执行（句柄 + 结构化决策，不接受密码/凭据值） ---------------- */

    /**
     * 生成导入计划（只读）：分析归档 + 合并冲突决策 / 路径映射，零写入。
     * 加密归档直接拒绝 —— 解密需要密码，而密码不进 agent 面（该场景走 GUI 导入）。
     */
    async importPlan(input: {
      zipPath: string
      strategy?: 'merge' | 'replace' | 'skipExisting'
      resolutions?: Record<string, JsonValue>
      pathMappings?: readonly { oldPrefix: string; newPrefix: string; appliesTo?: readonly string[] }[]
    }): Promise<JsonValue> {
      const importer = deps.makeImporter?.()
      if (importer === undefined) {
        return failure('import-unavailable', 'core.modelTools.errImportUnavailable', 'core.modelTools.nextUseGuiImport', false)
      }
      if (!isControlledZipPath(input.zipPath, deps.roots)) {
        return failure(
          'path-not-controlled',
          'core.modelTools.errPathNotControlled',
          'core.modelTools.nextPickControlledZip',
          false,
          { path: input.zipPath },
        )
      }
      const decisions: ImportDecisions = {
        strategy: input.strategy === 'replace' || input.strategy === 'skipExisting' ? input.strategy : 'merge',
        resolutions: normalizeResolutions(input.resolutions),
        pathMappings: normalizePathMappings(input.pathMappings),
      }
      const analysis = await importer.analyzeImport(input.zipPath)
      if (analysis.encrypted) {
        return failure('encrypted-archive', 'core.modelTools.errEncryptedArchive', 'core.modelTools.nextUseGuiImport', false)
      }
      if (!analysis.valid) {
        return {
          ok: false,
          code: 'archive-invalid',
          message: analysis.errors.join('; '),
          retryable: false,
          nextAction: engineMsg('core.modelTools.nextUseGuiImport'),
          analysis: summarizeAnalysis(analysis),
        }
      }
      const plan = await importer.createImportPlan(input.zipPath, decisions)
      const planId = importPlanFingerprint(plan, decisions)
      plans.set('import', planId, { zipPath: input.zipPath, decisionsJson: JSON.stringify(decisions) })
      return {
        ok: true,
        planId,
        zipPath: input.zipPath,
        analysis: summarizeAnalysis(analysis),
        plan: summarizePlan(plan),
      }
    },

    /**
     * 执行导入计划：必须带 config_import_plan 返回的 planId + confirm:true。
     * 执行前按存档决策重算计划比对指纹（归档被换 / 本机状态变了 → 拒绝，零写入）。
     */
    async importApply(input: { planId: string; confirm?: boolean; rollbackOnError?: boolean }): Promise<JsonValue> {
      if (input.confirm !== true) {
        return failure('confirm-required', 'core.modelTools.errConfirmRequired', 'core.modelTools.nextPassConfirm', true)
      }
      const record = plans.get(input.planId)
      if (record === undefined || record.kind !== 'import') {
        return failure('plan-expired', 'core.modelTools.errPlanExpired', 'core.modelTools.nextRepreview', true)
      }
      const importer = deps.makeImporter?.()
      if (importer === undefined) {
        return failure('import-unavailable', 'core.modelTools.errImportUnavailable', 'core.modelTools.nextUseGuiImport', false)
      }
      const zipPath = record.payload.zipPath ?? ''
      if (!isControlledZipPath(zipPath, deps.roots)) {
        return failure(
          'path-not-controlled',
          'core.modelTools.errPathNotControlled',
          'core.modelTools.nextPickControlledZip',
          false,
          { path: zipPath },
        )
      }
      let decisions: ImportDecisions
      try {
        decisions = JSON.parse(record.payload.decisionsJson ?? '') as ImportDecisions
      } catch {
        return failure('plan-expired', 'core.modelTools.errPlanExpired', 'core.modelTools.nextRepreview', true)
      }
      const fresh = await importer.createImportPlan(zipPath, decisions)
      if (importPlanFingerprint(fresh, decisions) !== input.planId) {
        return failure('plan-changed', 'core.modelTools.errPlanChanged', 'core.modelTools.nextRepreview', true)
      }
      const result = await runWithMutationLock(
        deps.host.mutationLock,
        { op: 'model-import-apply', target: zipPath, isBlocked: () => deps.host.safeModeIsBlocked?.() ?? false },
        async () => importer.executeImportPlan(zipPath, fresh, {
          confirm: true,
          ...(input.rollbackOnError === undefined ? {} : { rollbackOnError: input.rollbackOnError }),
        }),
      )
      plans.delete(input.planId)
      return summarizeImportResult(result)
    },
  }
}

/* ------------------------------------------------------------ 注册（defineTool 薄壳） */

type ModelTools = ReturnType<typeof createModelTools>

/** 把 9 个模型工具注册进 ctx.tools；tools 服务未组合时静默跳过（不崩溃）。 */
export function registerModelTools(ctx: Context, deps: ModelToolsDeps): void {
  const toolsSvc = ctx.get('tools')
  if (toolsSvc === null || toolsSvc === undefined || typeof toolsSvc !== 'object') {
    deps.host.log.warn?.(engineMsg('core.modelTools.toolsServiceUnavailable'))
    return
  }
  const tools: ModelTools = createModelTools(deps)
  const disposers: (() => void)[] = []
  // 注意：必须经 ctx.get('tools') 的结果注册，绝不能用 ctx.tools 属性访问——
  // Cordis 的属性访问要求插件声明 inject: ['tools']，未声明时即使服务存在也会抛
  // "cannot get property X without inject"（tools 是可选服务，不应进 inject）。
  const register = (def: Parameters<typeof ctx.tools.register>[0]): void => {
    disposers.push(toolsSvc.register(def))
  }

  register(defineTool({
    name: 'config_backup',
    description: engineMsg('core.modelTools.backupToolDesc'),
    parameters: {
      only: {
        type: 'array',
        items: { type: 'string', enum: [...SECTION_IDS] },
        description: engineMsg('core.modelTools.backupOnlyParam'),
      },
      password: {
        type: 'string',
        description: engineMsg('core.modelTools.backupPasswordParam'),
      },
    },
    output: {
      schema: {
        type: 'json',
        description: engineMsg('core.modelTools.backupOutputDesc'),
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return tools.backup(args)
    },
  }))

  register(defineTool({
    name: 'config_list_snapshots',
    description: engineMsg('core.modelTools.listSnapshotsToolDesc'),
    parameters: {},
    // 只读工具：并发调用安全（宿主可并行调度）。
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'json',
        description: engineMsg('core.modelTools.listSnapshotsOutputDesc'),
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      return tools.listSnapshots()
    },
  }))

  register(defineTool({
    name: 'config_restore',
    description:
      engineMsg('core.modelTools.restoreToolDesc'),
    parameters: {
      snapshotId: {
        type: 'string',
        required: true,
        description: engineMsg('core.modelTools.restoreSnapshotIdParam'),
      },
      planId: {
        type: 'string',
        description: engineMsg('core.modelTools.restorePlanIdParam'),
      },
      confirm: {
        type: 'boolean',
        description: engineMsg('core.modelTools.restoreConfirmParam'),
      },
    },
    output: {
      schema: { type: 'json', description: engineMsg('core.modelTools.restoreOutputDesc') },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return tools.restore(args)
    },
  }))

  register(defineTool({
    name: 'config_sync_push',
    description:
      engineMsg('core.modelTools.syncPushToolDesc'),
    parameters: {
      channel: {
        type: 'string',
        enum: [...SYNC_CHANNELS],
        description: engineMsg('core.modelTools.channelParam'),
      },
      sections: {
        type: 'array',
        items: { type: 'string', enum: [...SECTION_IDS] },
        description: engineMsg('core.modelTools.syncPushSectionsParam'),
      },
      encrypt: {
        type: 'boolean',
        description: engineMsg('core.modelTools.syncPushEncryptParam'),
      },
      includeSecrets: {
        type: 'boolean',
        description: engineMsg('core.modelTools.syncPushIncludeSecretsParam'),
      },
      password: {
        type: 'string',
        description: engineMsg('core.modelTools.syncPushPasswordDeprecatedParam'),
      },
      force: {
        type: 'boolean',
        description: engineMsg('core.modelTools.syncPushForceParam'),
      },
    },
    output: {
      schema: { type: 'json', description: engineMsg('core.modelTools.syncPushOutputDesc') },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return tools.syncPush(args)
    },
  }))

  register(defineTool({
    name: 'config_sync_pull',
    description:
      engineMsg('core.modelTools.syncPullToolDesc'),
    parameters: {
      channel: {
        type: 'string',
        enum: [...SYNC_CHANNELS],
        description: engineMsg('core.modelTools.channelParam'),
      },
      snapshotId: {
        type: 'string',
        description: engineMsg('core.modelTools.syncPullSnapshotIdParam'),
      },
      strategy: {
        type: 'string',
        enum: ['merge', 'replace', 'skipExisting'],
        description: engineMsg('core.modelTools.syncPullStrategyParam'),
      },
      password: {
        type: 'string',
        description: engineMsg('core.modelTools.syncPullPasswordParam'),
      },
    },
    // 只读工具：pull 只下载 + 分析，零写入（并发调用安全）。
    isConcurrencySafe: () => true,
    output: {
      schema: { type: 'json', description: engineMsg('core.modelTools.syncPullOutputDesc') },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return tools.syncPull(args)
    },
  }))

  register(defineTool({
    name: 'config_sync_preview',
    description:
      engineMsg('core.modelTools.syncPreviewToolDesc'),
    parameters: {
      channel: {
        type: 'string',
        enum: [...SYNC_CHANNELS],
        description: engineMsg('core.modelTools.channelParam'),
      },
      snapshotId: {
        type: 'string',
        description: engineMsg('core.modelTools.syncPreviewSnapshotIdParam'),
      },
      password: {
        type: 'string',
        description: engineMsg('core.modelTools.syncPreviewPasswordParam'),
      },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: { type: 'json', description: engineMsg('core.modelTools.syncPreviewOutputDesc') },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return tools.syncPreview(args)
    },
  }))

  register(defineTool({
    name: 'config_sync_apply',
    description:
      engineMsg('core.modelTools.syncApplyToolDesc'),
    parameters: {
      planId: {
        type: 'string',
        required: true,
        description: engineMsg('core.modelTools.syncApplyPlanIdParam'),
      },
      resolutions: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              required: true,
              description: engineMsg('core.modelTools.syncApplyResolutionIdParam'),
            },
            action: {
              type: 'string',
              required: true,
              enum: [...MERGE_ACTIONS],
              description: engineMsg('core.modelTools.syncApplyResolutionActionParam'),
            },
          },
          additionalProperties: false,
        },
        description: engineMsg('core.modelTools.syncApplyResolutionsParam'),
      },
      password: {
        type: 'string',
        description: engineMsg('core.modelTools.syncApplyPasswordParam'),
      },
    },
    output: {
      schema: { type: 'json', description: engineMsg('core.modelTools.syncApplyOutputDesc') },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return tools.syncApply(args)
    },
  }))

  register(defineTool({
    name: 'config_import_plan',
    description:
      engineMsg('core.modelTools.importPlanToolDesc'),
    parameters: {
      zipPath: {
        type: 'string',
        required: true,
        description: engineMsg('core.modelTools.importPlanZipPathParam'),
      },
      strategy: {
        type: 'string',
        enum: ['merge', 'replace', 'skipExisting'],
        description: engineMsg('core.modelTools.importPlanStrategyParam'),
      },
      resolutions: {
        type: 'object',
        additionalProperties: true,
        description: engineMsg('core.modelTools.importPlanResolutionsParam'),
      },
      pathMappings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            oldPrefix: {
              type: 'string',
              required: true,
              description: engineMsg('core.modelTools.importPlanMappingOldParam'),
            },
            newPrefix: {
              type: 'string',
              required: true,
              description: engineMsg('core.modelTools.importPlanMappingNewParam'),
            },
            appliesTo: {
              type: 'array',
              items: { type: 'string', enum: [...MAPPING_TARGETS] },
              description: engineMsg('core.modelTools.importPlanMappingAppliesToParam'),
            },
          },
          additionalProperties: false,
        },
        description: engineMsg('core.modelTools.importPlanPathMappingsParam'),
      },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: { type: 'json', description: engineMsg('core.modelTools.importPlanOutputDesc') },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return tools.importPlan(args)
    },
  }))

  register(defineTool({
    name: 'config_import_apply',
    description:
      engineMsg('core.modelTools.importApplyToolDesc'),
    parameters: {
      planId: {
        type: 'string',
        required: true,
        description: engineMsg('core.modelTools.importApplyPlanIdParam'),
      },
      confirm: {
        type: 'boolean',
        description: engineMsg('core.modelTools.importApplyConfirmParam'),
      },
      rollbackOnError: {
        type: 'boolean',
        description: engineMsg('core.modelTools.importApplyRollbackOnErrorParam'),
      },
    },
    output: {
      schema: { type: 'json', description: engineMsg('core.modelTools.importApplyOutputDesc') },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return tools.importApply(args)
    },
  }))

  ctx.effect(() => () => { for (const d of disposers) d() }, 'config-manager: model tools')
}
