/**
 * 市场免责弹窗的「不再提示」状态（m-disclaimer，node 可测）。
 *
 * 背景（2026-08-21）：用户要求上传 / 下载 / 装回本地时弹出免责弹窗，
 * 并支持「不再提示」勾选 —— 勾选后该操作以后不再弹。
 *
 * 设计：
 *  - 三个操作**分开记**（upload / download / install 各一个 key，互不影响）；
 *  - 持久化用浏览器 localStorage（跨会话偏好，关掉浏览器再开仍记得）；
 *  - storage 由调用方注入（React 壳传 window.localStorage；测试注入 mock），
 *    本层零浏览器依赖、纯函数可测；
 *  - 读写都包 try/catch：存储不可用（隐私模式 / 禁用）时静默降级为
 *    「未勾选」（下次仍提示），绝不让存储异常打断操作流程。
 *
 * 安全：本层只存布尔标记，不触碰任何凭据；key 无敏感信息。
 */
export type DisclaimerKey = 'upload' | 'download' | 'install'

/** localStorage key 前缀（按 key 隔离三个操作） */
export const DISCLAIMER_STORAGE_PREFIX = 'dsh-cm-market.disclaimer.'

/** 由操作 key 生成 localStorage key。 */
export function disclaimerStorageKey(key: DisclaimerKey): string {
  return `${DISCLAIMER_STORAGE_PREFIX}${key}`
}

/** 读取「不再提示」状态（true = 已勾选，该操作以后不再弹免责；任何异常 → false）。 */
export function readDisclaimerDismissed(key: DisclaimerKey, storage: Pick<Storage, 'getItem'>): boolean {
  try {
    return storage.getItem(disclaimerStorageKey(key)) === '1'
  } catch {
    return false
  }
}

/** 写入「不再提示」状态（勾选后调用；存储不可用时静默忽略）。 */
export function writeDisclaimerDismissed(key: DisclaimerKey, storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(disclaimerStorageKey(key), '1')
  } catch {
    // 存储不可用 → 忽略：下次仍会提示（安全侧保守）
  }
}
