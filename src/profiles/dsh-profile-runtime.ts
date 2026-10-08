/**
 * 档案**运行注册表**（心跳）—— 「这台机器上哪些 profile 正跑着」的唯一事实来源之一（node）。
 *
 * 为什么需要它（用户实测的真问题）：从 web 里启动 cmtest 之后，在 **cmtest 的界面里还能再启动 web** ——
 * 因为「哪个档案在跑」此前只有**启动方的台账**知道，而手动敲 `dsh web` 起来的那个实例不在任何台账里，
 * 于是同一个 profile 会被反复拉起（同名多开：端口/会话/浏览器 cookie 全是坑）。DSH 自己不认识插件
 * 启动的进程，也没有任何「profile 是否在跑」的运行时状态，所以只能由**每个加载本插件的实例自报心跳**：
 *
 *   <dataDir>/running/<profile>.json   { schemaVersion, name, pid, port, startedAt, updatedAt }
 *
 * 设计要点：
 *  - **一 profile 一文件**（不共用一个 JSON）：多个实例各写各的，天然没有 read-modify-write 竞争；
 *  - **不写认证 token**：URL 里的 token 一旦落盘就等于把该实例的 DSH RPC 交给本机任意进程（安全降级），
 *    所以别的实例只能「看到它在跑 + 停掉它」，看不到它的可登录 URL；
 *  - **判活 = pid 存活 ∧ 心跳未过期**：进程被硬杀时不会有人来删文件，过期即视为死实例并顺手清理；
 *    过期阈值是刷新间隔的 3 倍（20s 刷 / 60s 判死），避免刚启动/忙时误判成可重复启动；
 *  - **只能停别人**（`stopExternal`）：停自己会死在响应途中；当前实例由用户关窗口/终端结束。
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../utils/atomic-write.ts'
import { readTextSafe, sanitizeFilePart } from './dsh-profile-io.ts'
import { DshProfileError } from './dsh-profile-manager.ts'
import { profilesMsg } from './messages.ts'
import { resolveProcessControl, stopPid, type ProcessControlDeps } from './process-control.ts'
import type { DshProfileStopResult } from './dsh-profile-launcher.ts'

/** 心跳目录名（`<dataDir>/running`）。 */
export const RUNTIME_DIR_NAME = 'running'
/** 心跳文件 schema 版本（改结构时递增；解析端只认自己认识的版本）。 */
export const RUNTIME_SCHEMA_VERSION = 1
/** 心跳刷新间隔（20s；判死阈值是它的 3 倍）。 */
export const RUNTIME_REFRESH_MS = 20_000
/** 心跳过期阈值（超时即视为死实例——进程被硬杀时没人来删文件）。 */
export const RUNTIME_STALE_MS = 60_000

/** `<dataDir>/running/<profile>.json` 的内容。 */
export interface DshProfileRuntimeRecord {
  schemaVersion: number
  /** profile 名 */
  name: string
  /** 该实例的进程 pid（判活 + 停止都靠它） */
  pid: number
  /** 该实例的 web 端口（无 webServer 的部署为 null；**不含 token**） */
  port: number | null
  /** 启动时刻（ISO，展示用） */
  startedAt: string
  /** 上次心跳时刻（epoch ms；判死用） */
  updatedAt: number
}

/** 容错解析心跳文件（坏 JSON / 版本不符 / 字段缺失 → null，绝不抛）。 */
export function parseRuntimeRecord(text: string): DshProfileRuntimeRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const raw = parsed as Record<string, unknown>
  if (raw['schemaVersion'] !== RUNTIME_SCHEMA_VERSION) return null
  const { name, pid, port, startedAt, updatedAt } = raw
  if (typeof name !== 'string' || name === '') return null
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    name,
    pid,
    port: typeof port === 'number' && Number.isInteger(port) ? port : null,
    startedAt: typeof startedAt === 'string' ? startedAt : '',
    updatedAt,
  }
}

/** 心跳是否代表一个活着的实例：pid 存活 **且** 未过期（两者缺一不可）。 */
export function runtimeRecordLive(
  record: DshProfileRuntimeRecord,
  opts: { isAlivePid: (pid: number) => boolean; now: number; staleMs?: number },
): boolean {
  const staleMs = opts.staleMs ?? RUNTIME_STALE_MS
  if (!opts.isAlivePid(record.pid)) return false
  return opts.now - record.updatedAt <= staleMs
}

export interface DshProfileRuntimeOptions {
  /** 插件 dataDir（心跳落在 <dataDir>/running/） */
  dataDir: string
  /** 本实例跑的 profile 名 */
  name: string
  /** 自己的 web 端口（惰性；webServer 还没就绪时为 undefined → null） */
  port?: () => number | null
  /** 自己的 pid（缺省 process.pid；测试可注入） */
  pid?: number
  deps?: ProcessControlDeps
  staleMs?: number
  refreshMs?: number
  /** 定时器注入（测试用；返回取消函数） */
  schedule?: (fn: () => void, ms: number) => () => void
}

/** 心跳注册表：announce（自报）/ withdraw（自撤）/ listActive（看别人）/ stopExternal（停别人）。 */
export class DshProfileRuntimeRegistry {
  private readonly dataDir: string
  private readonly name: string
  private readonly pid: number
  private readonly port: () => number | null
  private readonly staleMs: number
  private readonly refreshMs: number
  private readonly schedule: (fn: () => void, ms: number) => () => void
  private readonly proc: ReturnType<typeof resolveProcessControl>
  private readonly startedAt: string

  constructor(options: DshProfileRuntimeOptions) {
    this.dataDir = options.dataDir
    this.name = options.name
    this.pid = options.pid ?? process.pid
    this.port = options.port ?? (() => null)
    this.staleMs = options.staleMs ?? RUNTIME_STALE_MS
    this.refreshMs = options.refreshMs ?? RUNTIME_REFRESH_MS
    this.schedule = options.schedule ?? ((fn, ms) => {
      const timer = setInterval(fn, ms)
      return () => { clearInterval(timer) }
    })
    this.proc = resolveProcessControl(options.deps)
    this.startedAt = new Date(this.proc.now()).toISOString()
  }

  /** 心跳目录（`<dataDir>/running`） */
  dir(): string {
    return join(this.dataDir, RUNTIME_DIR_NAME)
  }

  /** 某个 profile 的心跳文件绝对路径 */
  fileFor(name: string): string {
    return join(this.dir(), `${sanitizeFilePart(name)}.json`)
  }

  /** 自报/刷新心跳（幂等；apply 时写一次，之后由 startHeartbeat 定期刷）。 */
  announce(): DshProfileRuntimeRecord {
    const record: DshProfileRuntimeRecord = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      name: this.name,
      pid: this.pid,
      port: this.port(),
      startedAt: this.startedAt,
      updatedAt: this.proc.now(),
    }
    mkdirSync(this.dir(), { recursive: true })
    atomicWriteFileSync(this.fileFor(this.name), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 })
    return record
  }

  /** 撤回自己的心跳（dispose 时；正常退出的实例不留垃圾文件）。 */
  withdraw(): void {
    rmSync(this.fileFor(this.name), { force: true })
  }

  /**
   * 定时刷新（返回停止函数；调用方必须用 ctx.effect 绑定生命周期）。
   * 不刷新也不会「变成别人可启动」——只是过期后会被别的实例当成死实例。
   */
  startHeartbeat(): () => void {
    const stop = this.schedule(() => { this.announce() }, this.refreshMs)
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      stop()
    }
  }

  /** 当前活着的实例（含自己；死实例/坏文件的记录顺手清掉）。 */
  listActive(): DshProfileRuntimeRecord[] {
    const dir = this.dir()
    if (!existsSync(dir)) return []
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return []
    }
    const now = this.proc.now()
    const out: DshProfileRuntimeRecord[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const file = join(dir, entry)
      const record = parseRuntimeRecord(readTextSafe(file) ?? '')
      if (record === null || !runtimeRecordLive(record, { isAlivePid: this.proc.isAlivePid, now, staleMs: this.staleMs })) {
        // 坏文件 / 死实例：清理（写入端总是原子写合法 JSON，所以坏文件不可能是在写的实例）
        rmSync(file, { force: true })
        continue
      }
      out.push(record)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 停掉**别的**实例（按它的心跳 pid）。
   *  - 没有活心跳 → notRunning；
   *  - 心跳就是自己 → currentProfile（停自己会死在响应途中，UI 也不给这个按钮）；
   *  - 强杀后仍活着 → stopFailed。
   * 成功后删掉那个心跳文件（对方已死，不会自己撤）。
   */
  async stopExternal(name: string): Promise<DshProfileStopResult> {
    const record = this.listActive().find((r) => r.name === name)
    if (record === undefined) throw new DshProfileError('notRunning')
    if (record.pid === this.pid) throw new DshProfileError('currentProfile')
    const outcome = await stopPid(record.pid, this.proc)
    if (outcome === 'failed') {
      throw new DshProfileError('stopFailed', profilesMsg('profiles.stopFailed', { pid: record.pid }))
    }
    rmSync(this.fileFor(name), { force: true })
    return { name, result: outcome, port: record.port ?? undefined }
  }
}

