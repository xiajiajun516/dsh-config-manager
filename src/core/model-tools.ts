/**
 * dsh-config-manager — Agent 可调用的模型工具（P0-1）。
 *
 * 在 host 半注册 5 个 Cordis 模型工具，让 Agent 能自主驱动配置运维：
 *   config_backup           全量备份到 exports 目录（默认不含 secret；可选加密）
 *   config_list_snapshots   列出本地回滚快照
 *   config_restore          预览 / 执行恢复到某快照（默认只预览，confirm:true 才写入）
 *   config_sync_push        手动推送同步（写远端）
 *   config_sync_pull        拉取差异预览（零写入）
 *
 * 设计遵循 AGENTS.md 铁律：
 *   - 所有业务逻辑为可独立测试的纯编排函数（createModelTools），
 *     复用 src/core 已解耦引擎（Exporter / restore / SyncEngine），不重复实现；
 *   - React / HTTP 壳不参与；本文件是「引擎侧编排」，不放浏览器 src/ui/；
 *   - ctx.tools 服务用可选读取（ctx.get）守卫：未组合 tools 的部署不注册、不崩溃。
 *
 * 安全不变量（硬约束，勿破坏）：
 *   - secret 值永不进入工具入参/出参/render/日志；加密密码仅内存；
 *   - config_restore 是最危险写操作：缺省只 planRestore（零写入），真实执行必须 confirm:true；
 *   - config_sync_pull 零写入（只 analyze+plan 出差异）；落地需另走确认导入管道；
 *   - 分区/路径走既有白名单（SECTION_IDS 过滤；同步引擎 portable + FORBIDDEN_SECTIONS 双保险）。
 */
import { engineMsg } from './messages-core.ts';
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { Exporter } from './exporter.ts'
import { listSnapshots, planRestore, restore as executeRestore } from './restore.ts'
import type { RestorePlan, RestoreReport } from './restore.ts'
import type { SyncEngine } from '../sync/sync-engine.ts'
import { createEncryptionProvider } from '../security/encryption.ts'
import { SECTION_IDS } from '../schema/config.ts'
import type { SectionId } from '../schema/types.ts'
import { parseSyncChannel, readFullSyncConfig, readSyncConfigFor, SYNC_CHANNELS } from '../sync/sync-config.ts'
import type { SyncConfig, SyncTransportType } from '../sync/sync-config.ts'
import type { ConfigAdapter, HostContext, SecretScanner } from './types.ts'
import { runWithMutationLock } from '../utils/env-lock.ts'

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
  /** SyncEngine 工厂（git/webdav 按配置分支构造传输；与 host 路由同一来源） */
  makeSyncEngine: (cfg: SyncConfig) => SyncEngine
  /** 插件版本（manifest.exporter.version） */
  exporterVersion?: string
  /**
   * F2 强化 Secret 扫描器（含部署者 personalPatterns 个人规则；G-09 文件类分区文本级扫描）。
   * 必须与 HTTP 导出路由注入的是同一来源（src/index.ts 的 secretScanner 单一实例），
   * 否则两条导出路径的扫描档位不一致（个人规则 / 文件类分区凭据告警）。
   * 可选：缺省落回 Exporter 的 defaultSecretScanner()（无 scanText → 文件类分区不扫描，与修复前一致）。
   */
  scanner?: SecretScanner
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

/** 导出文件时间戳（YYYYMMDD-HHmmss），与 host 路由 dateStamp 同构。 */
function dateStamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** SECTION_IDS 白名单过滤（未知/非法分区 id 丢弃，与 host 路由语义一致）。 */
function filterSectionIds(ids: readonly string[]): SectionId[] {
  return ids.filter((id): id is SectionId => (SECTION_IDS as readonly string[]).includes(id))
}

/** 解析同步引擎：channel 缺省取已配置的活动通道（git/webdav），未配置则抛可操作错误。 */
async function resolveEngine(
  deps: ModelToolsDeps,
  channel?: SyncTransportType,
): Promise<{ engine: SyncEngine; channel: SyncTransportType }> {
  // 未显式指定通道 → 取已配置的活动通道（唯一判定口径 parseSyncChannel；缺省 git）
  const full = channel === undefined ? await readFullSyncConfig(deps.syncDir) : null
  const ch: SyncTransportType = channel ?? parseSyncChannel(full?.transport) ?? 'git'
  const cfg = await readSyncConfigFor(deps.syncDir, ch)
  if (cfg === null) {
    throw new Error(engineMsg('core.modelTools.syncChannelNotConfigured', { channel: ch }))
  }
  return { engine: deps.makeSyncEngine(cfg), channel: ch }
}

/* ------------------------------------------------------------ 纯编排函数 */

/** 5 个工具的纯编排实现（可独立测试，不依赖 Cordis ctx）。所有返回均为 JsonValue（可序列化、无 undefined）。 */
export function createModelTools(deps: ModelToolsDeps) {
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
      const outPath = join(deps.exportsDir, `dsh-config-${dateStamp()}-${randomBytes(3).toString('hex')}.zip`)
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
     * 恢复到指定快照。缺省只 planRestore（零写入）预览；
     * confirm:true 才真实执行 restore（覆盖/删除 $DSH_HOME 文件并卸载导入期间新增插件）。
     */
    async restore(input: { snapshotId: string; confirm?: boolean }): Promise<JsonValue> {
      const { snapshotId, confirm } = input
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
      if (confirm !== true) {
        return {
          dryRun: true,
          snapshotId: plan.snapshotId,
          createdAt: plan.createdAt,
          summary: {
            hostFileRestores: plan.summary.hostFileRestores,
            hostFileRemoves: plan.summary.hostFileRemoves,
            pluginRemoves: plan.summary.pluginRemoves,
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
      // Step 3 P0-A：真实 model-restore 在已持锁下创建 journal（不 double-acquire）
      const doRestore = async (): Promise<RestoreReport> => executeRestore(restoreOpts)
      const report: RestoreReport = await runWithMutationLock(
        deps.host.mutationLock,
        { op: 'model-restore', target: snapshotId, isBlocked: () => deps.host.safeModeIsBlocked?.() ?? false },
        async (lockCtx) => {
          if (deps.host.phase3Recovery !== undefined && lockCtx !== null) {
            const r = await deps.host.phase3Recovery.runJournaled({ operationType: 'model-restore', lockCtx, fn: doRestore })
            return r.result
          }
          return doRestore()
        },
      )
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

    /** 手动推送同步（写远端）。encrypt/includeSecrets 由引擎强制约束（密钥绝不明文进通道）。 */
    async syncPush(input: {
      channel?: SyncTransportType
      sections?: SectionId[]
      encrypt?: boolean
      includeSecrets?: boolean
      password?: string
    }): Promise<JsonValue> {
      const { engine } = await resolveEngine(deps, input.channel)
      const sections = input.sections === undefined ? undefined : filterSectionIds(input.sections)
      const encrypt = input.encrypt === true
      const includeSecrets = input.includeSecrets === true
      // Phase 2 锁：push 写远端 + 本地散文件 + sync-state，属 GLOBAL mutation。
      // Step 3 P0-A：外部 push 记 intent journal（crash 后不可证明 → NEEDS_ATTENTION，不自动重推）。
      const doPush = () => engine.push({
        ...(sections === undefined ? {} : { sections }),
        ...(encrypt || includeSecrets
          ? { encrypt: true, includeSecrets, password: input.password ?? '' }
          : {}),
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
        ...(report.message === undefined ? {} : { message: report.message }),
      }
    },

    /** 拉取差异预览（零写入：只下载 + analyze + plan 出差异报告）。 */
    async syncPull(input: {
      channel?: SyncTransportType
      snapshotId?: string
      strategy?: 'merge' | 'replace' | 'skipExisting'
      password?: string
    }): Promise<JsonValue> {
      const { engine } = await resolveEngine(deps, input.channel)
      const strategy = input.strategy === 'replace' || input.strategy === 'skipExisting' ? input.strategy : 'merge'
      const report = await engine.pull({
        strategy,
        ...(input.snapshotId === undefined || input.snapshotId === '' ? {} : { snapshotId: input.snapshotId }),
        ...(input.password === undefined || input.password === '' ? {} : { password: input.password }),
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
  }
}

/* ------------------------------------------------------------ 注册（defineTool 薄壳） */

type ModelTools = ReturnType<typeof createModelTools>

/** 把 5 个模型工具注册进 ctx.tools；tools 服务未组合时静默跳过（不崩溃）。 */
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
        description: engineMsg('core.modelTools.syncPushPasswordParam'),
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
    output: {
      schema: { type: 'json', description: engineMsg('core.modelTools.syncPullOutputDesc') },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return tools.syncPull(args)
    },
  }))

  ctx.effect(() => () => { for (const d of disposers) d() }, 'config-manager: model tools')
}
