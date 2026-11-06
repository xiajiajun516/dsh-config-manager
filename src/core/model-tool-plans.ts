/**
 * Agent 工具面的「计划句柄」表（planId → 预览时算出的指纹与重放材料）。
 *
 * 为什么 agent 侧需要这张表，而不能只让模型把整个计划回传：
 *   - 计划正文可能很大（导入计划动辄上百条 item），塞进模型上下文既贵又容易被截断/改写；
 *   - 模型改写过的计划不构成「用户确认过的计划」，服务端必须能从**当前磁盘**重算同一份计划。
 * 于是：预览时返回 planId（= 计划指纹），执行时只带 planId，服务端重算 → 比对指纹 →
 * 不一致就拒绝（plan-changed）并且零写入。等价于 GUI 恢复路由的 409。
 *
 * 存放纪律（安全不变量）：
 *   - 只在进程内存，绝不落盘、绝不进响应、绝不进日志；
 *   - payload 只放「重放所需的最小材料」（快照 id / 通道 / ZIP 路径 / 决策 JSON），
 *     **绝不存密码、凭据值、解密明文**；
 *   - TTL 30 分钟、上限 8 条：模型隔了很久才执行时应当重新预览，而不是拿到一份
 *     早已过期的确认去写盘。
 */
import { createHash } from 'node:crypto'
import type { ImportDecisions, ImportPlan } from './types.ts'

/**
 * 指纹只消费三方合并预览的这几个字段 —— 这里用结构化最小类型声明，
 * 而不是 import `../sync/sync-engine.ts` 的 MergePreview：
 * core 不得反向依赖 sync 层（架构边界），且指纹只需要「结论 + 冲突位置」。
 */
interface MergePreviewShape {
  readonly ok: boolean
  readonly snapshotId?: string | null
  readonly hasAncestor?: boolean
  readonly sections: readonly {
    readonly id: string
    readonly decision: string
    readonly autoMerged?: number
    readonly conflicts: readonly {
      readonly path: string
      readonly kind: string
      readonly reason?: string | null
    }[]
  }[]
}

export type ModelPlanKind = 'restore' | 'sync-merge' | 'import'

export interface ModelPlanRecord {
  /** planId = 指纹本身（同一计划重复预览得到同一个 id，天然幂等） */
  id: string
  kind: ModelPlanKind
  fingerprint: string
  /** 重放材料：只放 id / 路径 / 决策，绝不放密码或凭据值 */
  payload: Record<string, string>
  createdAt: number
  expiresAt: number
}

/** 计划句柄存活时长（与同步会话的 30 分钟同档）。 */
export const MODEL_PLAN_TTL_MS = 30 * 60 * 1000
/** 同时在册的计划上限（超出淘汰最旧的一条）。 */
export const MODEL_PLAN_MAX = 8

export class ModelPlanStore {
  private readonly records = new Map<string, ModelPlanRecord>()
  private readonly now: () => number

  constructor(now: () => number = () => Date.now()) {
    this.now = now
  }

  /** 登记一份预览过的计划；返回 planId（= fingerprint）。同一指纹重复登记只刷新时间。 */
  set(kind: ModelPlanKind, fingerprint: string, payload: Record<string, string>): string {
    const ts = this.now()
    // Map 的迭代序 = 插入序；先删再插让「刚预览的」排到最新，淘汰时才不会把刚发的 id 挤掉。
    this.records.delete(fingerprint)
    this.records.set(fingerprint, {
      id: fingerprint,
      kind,
      fingerprint,
      payload,
      createdAt: ts,
      expiresAt: ts + MODEL_PLAN_TTL_MS,
    })
    this.evict(ts)
    return fingerprint
  }

  get(id: string): ModelPlanRecord | undefined {
    const record = this.records.get(id)
    if (record === undefined) return undefined
    if (record.expiresAt <= this.now()) {
      this.records.delete(id)
      return undefined
    }
    return record
  }

  delete(id: string): void {
    this.records.delete(id)
  }

  get size(): number {
    return this.records.size
  }

  /** 惰性清理过期项 + 按插入序淘汰最旧（不做定时器：无人调用时不需要清理）。 */
  private evict(ts: number): void {
    for (const [id, record] of this.records) {
      if (record.expiresAt <= ts) this.records.delete(id)
    }
    while (this.records.size > MODEL_PLAN_MAX) {
      const oldest = this.records.keys().next()
      if (oldest.done === true) break
      this.records.delete(oldest.value)
    }
  }
}

/* ------------------------------------------------------------ 指纹 */

/** 稳定序列化：对象键按字典序，保证同一份材料在任何构造顺序下得到同一个指纹。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function digest(kind: ModelPlanKind, material: unknown): string {
  return createHash('sha256').update(kind).update('\n').update(stableStringify(material)).digest('hex')
}

/**
 * 同步合并计划的指纹：只取「分区 id + 结论 + 冲突位置」。
 *
 * **刻意不含三侧预览文本**（localPreview / remotePreview / ancestorPreview）：那是给人看的，
 * 同一份计划在不同时刻被截断/脱敏的方式可能变，纳入指纹会让「什么都没变的计划」被误判成变化。
 * 反过来，冲突多出一处路径 = 远端或本机真的动了，必须重新确认。
 */
export function syncMergeFingerprint(preview: MergePreviewShape): string {
  return digest('sync-merge', {
    ok: preview.ok,
    snapshotId: preview.snapshotId,
    hasAncestor: preview.hasAncestor,
    sections: preview.sections.map((section) => ({
      id: section.id,
      decision: section.decision,
      autoMerged: section.autoMerged ?? 0,
      conflicts: section.conflicts.map((conflict) => [conflict.path, conflict.kind, conflict.reason ?? '']),
    })),
  })
}

/**
 * 导入计划的指纹：取「每条 item 的身份 + 结论」与用户决策。
 *
 * 不含 description / detail 文案（改文案不该让预览失效），但含 target.ref 与 kind ——
 * 计划项从 Create 变成 Conflict、或目标路径变了，都是用户需要重新看一眼的变化。
 */
export function importPlanFingerprint(plan: ImportPlan, decisions: ImportDecisions): string {
  return digest('import', {
    strategy: decisions.strategy,
    pathMappings: decisions.pathMappings.map((mapping) => [mapping.oldPrefix, mapping.newPrefix, mapping.appliesTo.join(',')]),
    items: plan.items.map((item) => [
      item.id,
      item.kind,
      item.adapter,
      item.target?.ref ?? '',
      item.target?.file ?? '',
    ]),
    missingSecrets: plan.missingSecrets.map((secret) => secret.ref),
  })
}
