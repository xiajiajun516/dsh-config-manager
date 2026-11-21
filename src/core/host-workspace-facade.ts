/**
 * DshWorkspaceFacade —— DSH `workspaceRegistry` → 引擎 `WorkspaceFacade` 的适配。
 *
 * 从 src/index.ts 下沉（体量棘轮）：本类只做「服务读取 + 形状转换」，不含任何路由或
 * 生命周期逻辑。边界同上：core 不 import `@deepseek-ai/*`，宿主入口传入真 ctx。
 */
import type { MsgFunc } from './messages.ts'
import { zhMsg } from './messages.ts'
import { readService, type ServiceGetter } from './host-service.ts'
import type { WorkspaceFacade } from './types.ts'
import type { WorkspaceRecord } from '../schema/types.ts'

export class DshWorkspaceFacade implements WorkspaceFacade {
  private readonly ctx: ServiceGetter
  private readonly msg: MsgFunc

  constructor(ctx: ServiceGetter, msg: MsgFunc = zhMsg) {
    this.ctx = ctx
    this.msg = msg
  }

  private registry(): {
    list(): { id: unknown; path: string; title: string; sessionIds: readonly unknown[]; createdAt: string; updatedAt: string }[]
    get(id: unknown): { title: string; setTitle(title: string): Promise<void>; attachSession(sessionId: string): Promise<void> } | undefined
    create(path: string, title?: string): Promise<unknown>
    delete(id: unknown): Promise<boolean>
    /** P2：注册表级归档集（getter；老宿主没有这个属性 → undefined） */
    readonly archivedSessionIds?: readonly unknown[]
    /** P2：归档一个会话（老宿主没有这个方法 → undefined） */
    archiveSession?(sessionId: string): Promise<void>
    /** P2-pin：注册表级置顶集（最近置顶在前；老宿主没有这个属性 → undefined） */
    readonly pinnedSessionIds?: readonly unknown[]
    /** P2-pin：置顶一个会话（宿主前插；老宿主没有这个方法 → undefined） */
    pinSession?(sessionId: string): Promise<void>
    /** P2：DOM insertBefore 语义的显示顺序调整 */
    insertBefore?(id: unknown, beforeId?: unknown): Promise<readonly unknown[]>
  } | undefined {
    return readService(this.ctx, 'workspaceRegistry')
  }

  async listRecords(): Promise<WorkspaceRecord[]> {
    const registry = this.registry()
    if (!registry) return []
    return registry.list().map((w) => ({
      id: String(w.id),
      path: w.path,
      title: w.title,
      sessionIds: [...w.sessionIds].map(String),
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    }))
  }

  async writeRecord(record: WorkspaceRecord): Promise<void> {
    const registry = this.registry()
    if (!registry) throw new Error(this.msg('host.workspaceUnavailable'))
    const existing = registry.get(record.id)
    if (existing) {
      // DSH API 没有「整体覆盖」写通道：标题可更新；path/会话由 registry 依真实目录维护
      if (record.title !== undefined && existing.title !== record.title) await existing.setTitle(record.title)
      return
    }
    await registry.create(record.path, record.title)
  }

  async removeRecord(id: string): Promise<void> {
    const registry = this.registry()
    if (!registry) return
    await registry.delete(id)
  }

  /**
   * 把一个已存储会话登记进工作区（issue #45 会话归位）。
   *
   * 走 DSH `workspaceRegistry` 的实体方法 `attachSession`：
   *  - DSH 自己读会话 header 并用 realpath 校验 cwd 必须等于该工作区 path（不匹配直接拒绝）；
   *  - 写入走 storage domain 的原子 update（内存权威与磁盘同时更新），并按 cwd 剪掉不属于
   *    本工作区的候选 —— 因此**不需要**插件做「注册表合并 / 去重 / 备份回滚」，
   *    更**不得**旁路直写 storages/workspace.json。
   */
  async attachSession(workspaceId: string, sessionId: string): Promise<void> {
    const registry = this.registry()
    if (!registry) throw new Error(this.msg('host.workspaceUnavailable'))
    const existing = registry.get(workspaceId)
    if (!existing) throw new Error(this.msg('host.workspaceMissingTarget', { id: workspaceId }))
    await existing.attachSession(sessionId)
  }

  /**
   * P2：读注册表级归档集。
   *
   * 「宿主没这个能力」与「归档集为空」必须分开：前者返回空数组但不会让导出侧写
   * `archivedSessionIds: []`（导出侧只看能力是否存在决定带不带这个字段）。
   */
  async listArchivedSessionIds(): Promise<string[] | undefined> {
    const registry = this.registry()
    // 宿主没暴露 getter ⇒ undefined（「读不到」），**不是**空数组（「确实为空」）：
    // 返回 [] 会让导出侧写出 `archivedSessionIds: []`，等于对用户声称「这台机器没有归档会话」。
    if (registry === undefined || registry.archivedSessionIds === undefined) return undefined
    const ids = registry.archivedSessionIds
    return Array.isArray(ids) ? ids.map(String) : undefined
  }

  /** P2：归档一个会话；宿主未暴露该能力时显式报错（由调用方降级为告警，绝不静默当成功）。 */
  async archiveSession(sessionId: string): Promise<void> {
    const registry = this.registry()
    if (!registry || typeof registry.archiveSession !== 'function') {
      throw new Error(this.msg('host.workspaceArchiveUnavailable'))
    }
    await registry.archiveSession(sessionId)
  }

  /**
   * P2-pin：读注册表级置顶集（最近置顶在前）。
   *
   * 与归档集同款边界：`undefined` = 宿主没暴露（导出侧不带字段），**不是**空数组
   * —— 返回 [] 会让导出侧写出 `pinnedSessionIds: []`，等于声称「这台机器没有置顶会话」。
   * 能力在 DSH 0.2.2-rc.5 的 `workspaceRegistry` 上（`pinnedSessionIds` / `pinSession`）。
   */
  async listPinnedSessionIds(): Promise<string[] | undefined> {
    const registry = this.registry()
    if (registry === undefined || registry.pinnedSessionIds === undefined) return undefined
    const ids = registry.pinnedSessionIds
    return Array.isArray(ids) ? ids.map(String) : undefined
  }

  /** P2-pin：置顶一个会话；宿主未暴露该能力时显式报错（调用方降级为告警，绝不静默当成功）。 */
  async pinSession(sessionId: string): Promise<void> {
    const registry = this.registry()
    if (!registry || typeof registry.pinSession !== 'function') {
      throw new Error(this.msg('host.workspacePinUnavailable'))
    }
    await registry.pinSession(sessionId)
  }

  /**
   * P2：按目标顺序重排工作区显示顺序。
   *
   * 宿主只给 `insertBefore(id, beforeId)`（DOM 语义），所以「变成目标顺序」由这里推出：
   * 从倒数第二个开始，把每个 id 挪到它后一个 id 前面，逐次收敛即为目标相对顺序。
   * 未知 id 直接过滤（别人删掉的工作区不该让整轮导入报错）；宿主没有该原语时静默跳过 ——
   * 顺序不是数据，丢了不影响可用性。
   */
  async reorderWorkspaces(orderedIds: readonly string[]): Promise<void> {
    const registry = this.registry()
    if (!registry || typeof registry.insertBefore !== 'function') return
    const known = new Set(registry.list().map((w) => String(w.id)))
    const ids = orderedIds.filter((id) => known.has(id))
    for (let i = ids.length - 2; i >= 0; i -= 1) {
      await registry.insertBefore(ids[i], ids[i + 1])
    }
  }
}
