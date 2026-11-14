/**
 * 通道配置表单的「用户正在输入」保护（纯函数，node 可测）。
 *
 * 真机缺陷 P9-4：loadStatus 是无条件回填 —— 挂载、GitHub 登录成功、断开通道、
 * 合并 / 回滚完成、工作副本变更都会重拉 /sync/status 并把宿主值写进表单。
 * 用户在输入框里打的字（600ms 自动保存防抖还没到）就这样被静默抹掉，输入框自己变回去。
 *
 * 口径（不得放宽）：
 *  ① **不硬编码字段白名单**：dirty 集合由用户**实际改过**的键（onFormChange 的 Object.keys(p)）
 *     动态构成，将来新增表单字段自动受保护；
 *  ② 回填只跳过 dirty 里出现的键；channel / statusInfo / catalog / 快照列表等非表单键不经此处，
 *     照旧写入；
 *  ③ 宿主回执（保存成功）即权威：落盘后整体 resetDirty()，之后的刷新可以正常回填。
 */
import { cloudFormFromStatus } from '../../ui/sync-settings-view.ts'
import type { CloudFormBackfill, CloudStatusLike } from '../../ui/sync-settings-view.ts'

/**
 * 把用户改动过的键并入 dirty 集合。返回**新 Set**（不改入参，调用方用 ref 整体替换）；
 * 空 keys 也返回等价副本 —— 恒返回新引用，调用点的赋值语句无需分支。
 */
export function markDirty(dirty: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const next = new Set(dirty)
  for (const key of keys) next.add(key)
  return next
}

/**
 * 丢掉补丁里**用户正在输入**的键（dirty 命中即剔除）。
 * 返回新对象、不修改入参；非 dirty 键与键序保持原样。
 */
export function pruneDirtyFields<T extends object>(
  patch: T,
  dirty: ReadonlySet<string>,
): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!dirty.has(key)) out[key] = value
  }
  // Object.entries 丢掉了键的精确类型；这里只可能少键、不会多键或换类型，故用 Partial 表达
  return out as Partial<T>
}

/** 只撤销**指定字段**的 dirty（该字段的写入已被宿主确认时用；整体落地见 resetDirty）。 */
export function clearDirtyFields(dirty: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const next = new Set(dirty)
  for (const key of keys) next.delete(key)
  return next
}

/** 清空 dirty（断开通道 / 宿主回执落地 / 切换激活通道时调用）。 */
export function resetDirty(): Set<string> {
  return new Set<string>()
}

/** /sync/status 里参与表单回填的字段（= 全部非密表单字段）。 */
export interface StatusFormFields extends CloudFormBackfill {
  /** git 通道：仓库地址 + 子目录前缀 */
  repoUrl: string
  gitSubdir: string
  /** webdav 通道：地址 + 用户名（口令永不回传） */
  webdavUrl: string
  webdavUsername: string
}

/** 回填来源：/sync/status 的非密视图（云端点部分与 ui 层的 CloudStatusLike 共用）。 */
export type StatusFormSource = CloudStatusLike & {
  repoUrl?: string
  subdir?: string
  webdav?: { url?: string; username?: string }
}

/**
 * /sync/status → 表单回填补丁，**丢掉用户正在输入的键**（P9-4 的唯一入口）。
 * 密钥类字段不在返回里（宿主本来就不回传值，只回 configured 布尔）。
 */
export function formPatchFromStatus(
  info: StatusFormSource,
  dirty: ReadonlySet<string>,
): Partial<StatusFormFields> {
  return pruneDirtyFields<StatusFormFields>({
    repoUrl: info.repoUrl ?? '',
    gitSubdir: info.subdir ?? '',
    webdavUrl: info.webdav?.url ?? '',
    webdavUsername: info.webdav?.username ?? '',
    ...cloudFormFromStatus(info),
  }, dirty)
}
