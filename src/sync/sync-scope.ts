/**
 * 同步作用域（per-profile sync scope）：哪个档案（profile）同步到哪个仓库、用哪份凭据。
 *
 * ## 问题
 * `$DSH_HOME/dsh-config-manager` 是全机共用的一份插件数据根 —— 全局写锁
 * （`createHostMutationLock`）、SAFE MODE 落盘态（`bootStateDir`）、崩溃可续跑事务日志
 * （`JournalStore`）都长在这棵树上，拆开 = 拆锁 / 拆 SAFE MODE / 拆事务日志。
 * 但「同步到哪个仓库 / 用哪个 GitHub token / 勾了哪些分区 / 自动同步开没开」是**某个档案
 * 自己的决定**：共用一份时，在 web 里配的仓库会连 desktop 一起推；两个档案还共用同一份
 * `sync/work/` git 工作副本与同一份祖先指针，会把对方的写操作判成冲突。
 *
 * ## 结论：只分「同步作用域」，不分数据根
 * 1. `syncRootDir = <dataDir>/sync` —— 历史位置；它同时是**默认档案**（`web`）的作用域，
 *    所以只有一个档案的老用户升级后路径逐字节不变（零迁移）。其下 `backup-schedule.json`
 *    仍是**全机一份**的定时备份配置（定时备份是宿主行为，不是某个档案的同步态）；
 * 2. `syncDir(profile) = profile === 'web' ? syncRootDir : <dataDir>/sync-profiles/<profile>`；
 *    同步引擎的全部状态（sync-config / cloud / state / selection / history / autosync /
 *    ui-prefs / work / incoming / snapshots）跟着它走；
 * 3. 凭据：默认档案沿用历史 ref 名（跨版本、跨机器、既有用户已配置的槽位都不动），
 *    其它档案追加 `__<PROFILE>` 后缀。值仍在 DSH credentials 里，文件里永不出现 token。
 *
 * ## 已知限制
 * - 分作用域不等于分权限：两个档案指向同一个仓库时仍会互相覆盖 —— 那是用户的配置选择；
 * - `config.dataDir` 可配置 ≠ 隔离手段：那会拆掉全局锁 / SAFE MODE / 事务日志，
 *   因此本模块**不**按 dataDir 分档。
 */
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { CLOUD_SECRET_REFS, CLOUD_SYNC_PROVIDERS, SYNC_CHANNELS } from '../utils/shared-constants.ts'
import { isENOENT } from '../utils/guards.ts'
// 导入即注册本域追加目录（zh/en 两本）；宿主日志文案不走字面量
import { engineMsg } from './messages.ts'

/** 默认档案名：只有它使用历史根 `<dataDir>/sync`（零迁移） */
export const SYNC_DEFAULT_PROFILE = 'web'

/** 非默认档案的作用域父目录（在 dataDir 下与历史 `sync/` 平级） */
export const SYNC_SCOPES_DIR_NAME = 'sync-profiles'

/**
 * 同步 token 的 DSH credentials 引用名（POSIX env-var 形态，满足 CredentialRef 品牌要求）。
 * token 只经 credentialRef 读写（写入由请求体触发，读取在每次 git 网络操作时 resolve），
 * 永不进 repoUrl / argv / commit / 同步文件 / 日志。
 */
export const SYNC_CREDENTIAL_REF = 'DSH_CONFIG_MANAGER_SYNC_TOKEN'

/**
 * WebDAV 通道口令的独立 DSH credentials 引用（与 git token 槽位分离）。
 * 口令只经 credentialRef 读写，永不进 URL / 请求头 / 日志。
 */
export const SYNC_WEBDAV_CREDENTIAL_REF = 'DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD'

/**
 * 同步快照「加密密码 / 解密密码」的 DSH credentials 引用名前缀（按通道各自独立）。
 *
 * 为什么放 DSH credentials：加密/解密密码跨会话必须可用（否则每次推送都要重新输入），
 * 但**绝不允许**写进 sync-selection.json 一类同步文件（那等于把密码推上远端）。
 * 引用名形如 DSH_CONFIG_MANAGER_SYNC_ENCRYPT_PASSWORD_GIT。
 */
export const SYNC_ENCRYPT_PASSWORD_REF_PREFIX = 'DSH_CONFIG_MANAGER_SYNC_ENCRYPT_PASSWORD'
export const SYNC_DECRYPT_PASSWORD_REF_PREFIX = 'DSH_CONFIG_MANAGER_SYNC_DECRYPT_PASSWORD'

/** 作用域后缀分隔符（`__` 在 env-var 形态里合法，且不可能与历史槽位名撞车） */
const SCOPE_SUFFIX_SEP = '__'

/** 档案名的合法形态：既做目录段，也做凭据后缀（拒绝空、'..'、分隔符与空白） */
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * 归一档案名：非法 / 缺省一律回落默认档案。
 *
 * 为什么回落而不是抛错：档案名来自宿主（`host.profile`）；一个坏名字不该让插件在
 * 启动期炸掉，写出历史根（默认作用域）也仍是一致的状态，最多是「没分档」。
 */
export function normalizeSyncProfile(raw: unknown): string {
  if (typeof raw !== 'string') return SYNC_DEFAULT_PROFILE
  const name = raw.trim()
  if (!PROFILE_NAME_RE.test(name)) return SYNC_DEFAULT_PROFILE
  return name
}

/** 档案名 → 凭据后缀（`Test1` → `__TEST1`；默认档案 → 空串，保持历史槽位名） */
export function syncScopeSuffix(profile: unknown): string {
  const name = normalizeSyncProfile(profile)
  if (name === SYNC_DEFAULT_PROFILE) return ''
  return SCOPE_SUFFIX_SEP + name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

/**
 * 把「历史（不带后缀）」凭据槽位名映射到某档案。
 *
 * 只接受已经算好的历史名（调用点仍是 `SYNC_CREDENTIAL_REF` / `cloudSecretRef(x)` 那些常量），
 * 因此全仓槽位名仍然一处声明，不会出现第二套命名规则。
 */
export function scopedSyncRef(ref: string, profile: unknown): string {
  const suffix = syncScopeSuffix(profile)
  return suffix === '' ? ref : ref + suffix
}

/** ('ENCRYPT'|'DECRYPT', 'git'|'webdav'|...) → 该通道的凭据引用名（可按档案加后缀）。 */
export function syncPasswordRef(kind: 'ENCRYPT' | 'DECRYPT', channel: string, profile?: unknown): string {
  const prefix = kind === 'ENCRYPT' ? SYNC_ENCRYPT_PASSWORD_REF_PREFIX : SYNC_DECRYPT_PASSWORD_REF_PREFIX
  return scopedSyncRef(prefix + '_' + channel.toUpperCase(), profile)
}

/** 一个档案的同步作用域（由 `syncScopeFor` 产出，纯数据 + 派生槽位名）。 */
export interface SyncScope {
  /** 归一后的档案名（非法名回落默认档案） */
  profile: string
  /** 是否默认档案（= 历史根，路径零迁移） */
  isDefault: boolean
  /** 全机一份的同步根：只用来读 `backup-schedule.json`，**不要**用它读同步配置 */
  rootDir: string
  /** 本档案的同步作用域目录：同步引擎的全部状态都在这里 */
  dir: string
  /** 本档案的 git / GitHub token 槽位 */
  tokenRef: string
  /** 本档案的 WebDAV 口令槽位 */
  webdavPasswordRef: string
  /** 历史槽位名 → 本档案槽位名（云端点密钥等按需映射） */
  scopeRef(ref: string): string
  /** 本档案的加密 / 解密密码槽位 */
  passwordRef(kind: 'ENCRYPT' | 'DECRYPT', channel: string): string
}

/**
 * 由插件数据根与档案名算出同步作用域。
 *
 * @param dataDir 插件数据根（`$DSH_HOME/dsh-config-manager` 或 `config.dataDir`）
 * @param profile 宿主给的档案名（`host.profile`）；缺省 / 非法 = 默认档案
 */
export function syncScopeFor(dataDir: string, profile?: unknown): SyncScope {
  const name = normalizeSyncProfile(profile)
  const isDefault = name === SYNC_DEFAULT_PROFILE
  const rootDir = join(dataDir, 'sync')
  const dir = isDefault ? rootDir : join(dataDir, SYNC_SCOPES_DIR_NAME, name)
  return {
    profile: name,
    isDefault,
    rootDir,
    dir,
    tokenRef: scopedSyncRef(SYNC_CREDENTIAL_REF, name),
    webdavPasswordRef: scopedSyncRef(SYNC_WEBDAV_CREDENTIAL_REF, name),
    scopeRef: (ref: string) => scopedSyncRef(ref, name),
    passwordRef: (kind, channel) => syncPasswordRef(kind, channel, name),
  }
}

/**
 * 只有作用域目录、没有档案作用域的装配面（测试夹具 / 手工装配）→ 历史单作用域语义。
 *
 * 语义是**等价**而非猜测：历史布局里「作用域目录」就是默认档案的作用域（rootDir === dir），
 * 槽位名也就是历史槽位名。因此这里给出的是「默认档案」这一确定的解释，不碰档案判定。
 * 生产路径一律走 `syncScopeFor(dataDir, profile)`；类型上 `RoutesEnv.syncScope` 是必填的，
 * 漏传只可能出现在 `as never` 之类的未类型化夹具里。
 */
export function syncScopeOrDefault(syncDir: string, scope?: SyncScope): SyncScope {
  if (scope !== undefined) return scope
  return {
    profile: SYNC_DEFAULT_PROFILE,
    isDefault: true,
    rootDir: syncDir,
    dir: syncDir,
    tokenRef: SYNC_CREDENTIAL_REF,
    webdavPasswordRef: SYNC_WEBDAV_CREDENTIAL_REF,
    scopeRef: (ref: string) => ref,
    passwordRef: (kind, channel) => syncPasswordRef(kind, channel),
  }
}

/**
 * 首次启用某档案的作用域时，从历史根继承的文件。
 *
 * 继承哪些：同步目标与「怎么同步」的配置（sync-config / cloud / selection / autosync / ui-prefs）
 * —— 这些档案在此前就是共用历史根的配置，不继承 = 升级后同步「凭空未配置」。
 *
 * **不继承**：`work/`（git 工作副本，按新目标重克隆即可；复制一份反而会指向旧 origin）、
 * `incoming/`、`snapshots/`（远端内容缓存）、`sync-state.json` 与 `sync-history.json`
 * （那是本机同步流水；复制等于伪造「我在另一档案里同步过」）。
 */
export const SYNC_SCOPE_ADOPT_FILES = [
  'sync-config.json',
  'sync-cloud-config.json',
  'sync-selection.json',
  'sync-autosync.json',
  'ui-prefs.json',
] as const

/** 历史槽位名 → 新档案槽位名（采纳时按「值只在进程内搬一次」复制，绝不落盘）。 */
export function syncScopeLegacyCredentialRefs(scope: SyncScope): Array<{ from: string; to: string }> {
  if (scope.isDefault) return []
  const pairs: Array<{ from: string; to: string }> = [
    { from: SYNC_CREDENTIAL_REF, to: scope.tokenRef },
    { from: SYNC_WEBDAV_CREDENTIAL_REF, to: scope.webdavPasswordRef },
  ]
  for (const channel of SYNC_CHANNELS) {
    for (const kind of ['ENCRYPT', 'DECRYPT'] as const) {
      const base = (kind === 'ENCRYPT' ? SYNC_ENCRYPT_PASSWORD_REF_PREFIX : SYNC_DECRYPT_PASSWORD_REF_PREFIX) + '_' + channel.toUpperCase()
      pairs.push({ from: base, to: scope.scopeRef(base) })
    }
  }
  for (const provider of CLOUD_SYNC_PROVIDERS) {
    // 云端点密钥 base 名仍由 CLOUD_SECRET_REFS 派生（唯一声明处），此处只加后缀
    const base = CLOUD_SECRET_REFS[provider]
    pairs.push({ from: base, to: scope.scopeRef(base) })
  }
  return pairs
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch (error) {
    if (isENOENT(error)) return false
    throw error
  }
}

/**
 * 采纳历史根：非默认档案首次启动、自己的作用域目录还不存在时，把历史配置复制一份过来。
 *
 * 幂等：目录一存在就跳过（采纳前先 `mkdir`，因此「空目录」也是已采纳的标记，
 * 不需要额外的 marker 文件）。任何单个文件复制失败都只记日志、不影响其它文件 ——
 * 采纳是尽力而为的兼容动作，绝不能让插件启动失败。
 *
 * @returns 实际复制过来的文件名（未采纳 / 已采纳时为空数组）
 */
export async function adoptLegacySyncScope(
  scope: SyncScope,
  log?: (message: string) => void,
): Promise<string[]> {
  if (scope.isDefault) return []
  if (await pathExists(scope.dir)) return []
  const copied: string[] = []
  try {
    await mkdir(scope.dir, { recursive: true })
  } catch (error) {
    log?.(engineMsg('sync.scopeDirCreateFailed', { dir: scope.dir, reason: String(error) }))
    return copied
  }
  for (const name of SYNC_SCOPE_ADOPT_FILES) {
    const from = join(scope.rootDir, name)
    if (!(await pathExists(from))) continue
    try {
      await copyFile(from, join(scope.dir, name))
      copied.push(name)
    } catch (error) {
      log?.(engineMsg('sync.scopeAdoptFailed', { file: name, reason: String(error) }))
    }
  }
  if (copied.length > 0) {
    log?.(engineMsg('sync.scopeAdopted', { profile: scope.profile, files: copied.join(', ') }))
  }
  return copied
}
