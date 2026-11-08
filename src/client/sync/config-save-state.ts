/**
 * 「保存通道配置」成功后的本机状态合并（纯函数，node 可测）。
 *
 * 抽成独立文件的原因与 ./SyncRepositoryPicker.tsx 相同：SyncPanel 有行数棘轮，
 * 而「清空已入库凭据 + 合并凭据徽章」是一段自包含的状态演算，
 * 留在组件里既挤占行数，也无法脱离 React 单测。
 *
 * 口径（不得放宽）：只清空**本次确实写出去**的 password / token / secret ——
 * 保存期间用户又改了输入则保留新值；响应的凭据字段只有布尔，绝无 secret 值。
 */
import type { SyncConfigSaveResponse, SyncPushPayload, SyncStatusResponse } from './sync-api.ts'

/** 参与合并的 state 结构子集（不依赖 SyncUiState 全量定义，避免循环 import）。 */
export interface SavedConfigState {
  savingConfig: boolean
  webdavPassword: string
  token: string
  s3Secret: string
  gistToken: string
  statusInfo: SyncStatusResponse | null
}

/** 只清「本次已写入的」内存凭据：仍等于刚才发出去的值才清空，否则说明用户改过，保留。 */
function clearSent(value: string, sent: string | undefined): string {
  return value !== '' && value !== sent ? value : ''
}

/**
 * 保存成功的 state 演进：savingConfig 复位 → 清空已写入的凭据 → 合并凭据徽章事实。
 * @param s 保存发起时刻之后的权威 state（stateRef.current）
 * @param saved POST /sync/config 响应（只含布尔，无 secret 值）
 * @param sent 本次实际发出的请求体（判断「哪些值确实写出去了」）
 */
export function savedConfigState(
  s: SavedConfigState,
  saved: SyncConfigSaveResponse,
  sent: SyncPushPayload,
): SavedConfigState {
  const next: SavedConfigState = {
    ...s,
    savingConfig: false,
    webdavPassword: clearSent(s.webdavPassword, sent.password),
    token: clearSent(s.token, sent.token),
    // 云端点密钥同一口径：s3 与 gist 共用请求体的 secret 槽位
    s3Secret: clearSent(s.s3Secret, sent.secret),
    gistToken: clearSent(s.gistToken, sent.secret),
  }
  // 状态未知（还没拉到 /sync/status）时没有徽章可合并，等下一次 loadStatus 回填
  if (s.statusInfo === null) return next
  const info: SyncStatusResponse = {
    ...s.statusInfo,
    configured: true,
    credentialConfigured: saved.credentialConfigured,
  }
  // webdav 徽章：url / username 是可回显的非敏感事实，用本机已有的回填
  if (saved.webdav !== undefined) {
    info.webdav = {
      url: s.statusInfo.webdav?.url,
      username: s.statusInfo.webdav?.username,
      usernameConfigured: saved.webdav.usernameConfigured,
      passwordConfigured: saved.webdav.passwordConfigured,
    }
  }
  // 云端点：响应只回非密视图 + secretStored 布尔（值永不回传），直接合并供徽章刷新
  if (saved.s3 !== undefined) info.s3 = saved.s3
  if (saved.gist !== undefined) info.gist = saved.gist
  next.statusInfo = info
  return next
}
