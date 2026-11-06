/**
 * dsh-config-manager — agent 工具面的依赖装配（从 src/index.ts 下沉）。
 *
 * 为什么单列：src/index.ts 有体量棘轮，且「同一批依赖来源」这条口径（D3 凭据槽 /
 * D5 只放行 'auto' 档分区 / D6 受控路径根）最好与路由层代码放在一起看。
 * index.ts 只保留一次 makeRoutes 解构与一次 registerModelTools 调用。
 *
 * 安全不变量（与 model-tools.ts 一致，勿在此处放宽）：
 *   - syncPassword 只把宿主内存里的密码值交给本次引擎调用，绝不进工具返回 / render / 日志；
 *   - optInSections 固定走 selectionOptInSections(channel, true)（'auto' 档），
 *     sessions 由 model-tools 再永久剔除；
 *   - roots 与 /analyze、/plan 同一判据（isControlledPath），缺省空集 = fail-closed。
 */
import type { ConfigAdapter, HostContext, SecretScanner } from '../core/types.ts'
import type { Importer } from '../core/importer.ts'
import type { ModelToolsDeps } from '../core/model-tools.ts'
import type { SectionId } from '../schema/types.ts'
import type { SyncConfig, SyncTransportType } from '../sync/sync-config.ts'
import type { SyncEngine } from '../sync/sync-engine.ts'

export interface AgentToolDepsInput {
  host: HostContext
  adapters: ConfigAdapter[]
  exportsDir: string
  snapshotsDir: string
  syncDir: string
  makeSyncEngine: (cfg: SyncConfig, opts?: { optInSections?: readonly SectionId[] }) => SyncEngine
  /** 宿主侧按 DSH credentials 槽位读取（值只在内存里过一手）。 */
  resolveSyncPassword: (ref: string) => Promise<string | undefined>
  /** 槽位引用构造（ENCRYPT / DECRYPT + 通道），与 /sync/apply-items 同源。 */
  syncPasswordRef: (kind: 'ENCRYPT' | 'DECRYPT', channel: SyncTransportType) => string
  /** onlyAuto = true 时只放行「自动档」可选分区（agent 侧恒 true）。 */
  selectionOptInSections: (channel: SyncTransportType, onlyAuto?: boolean) => SectionId[]
  makeImporter: () => Importer
  roots: readonly string[]
  scanner?: SecretScanner
  exporterVersion?: string
}

/** 组装 9 个模型工具所需的依赖；纯映射，无副作用、不读盘、不触网。 */
export function createAgentToolDeps(input: AgentToolDepsInput): ModelToolsDeps {
  return {
    host: input.host,
    adapters: input.adapters,
    exportsDir: input.exportsDir,
    snapshotsDir: input.snapshotsDir,
    syncDir: input.syncDir,
    makeSyncEngine: input.makeSyncEngine,
    ...(input.exporterVersion === undefined ? {} : { exporterVersion: input.exporterVersion }),
    ...(input.scanner === undefined ? {} : { scanner: input.scanner }),
    syncPassword: async (kind, channel) => await input.resolveSyncPassword(input.syncPasswordRef(kind, channel)),
    optInSections: (channel) => input.selectionOptInSections(channel, true),
    makeImporter: input.makeImporter,
    roots: input.roots,
  }
}
