import type { MsgFunc } from '../core/messages.ts'

/**
 * 本轮 blob GC 的放弃码（SYN-04）。**机器可判定**，文案由上层按码翻译（字典键由 Lead 统一加）：
 * 通道没有 logger，`delete()` 还会吞掉 GC 抛出的异常，所以「本轮为什么没回收」只能靠这个码如实外露。
 * 三态同义：拿不到引用者内容 = 无法证明「没人引用」⇒ 本轮整轮放弃，绝不按残集删除。
 *
 * 单一来源：webdav / s3 两个通道都从这里导入（此前各写一份同名常量，改一侧不炸另一侧 =
 * 静默漂移；本模块不 import 任何 transport，所以不存在环）。
 */
export const GC_SKIP_REFERENCE_MISSING = 'gc-skip-reference-missing'
export const GC_SKIP_REFERENCE_UNREADABLE = 'gc-skip-reference-unreadable'
export const GC_SKIP_SNAPSHOT_UNPARSABLE = 'gc-skip-snapshot-unparsable'

/** blob GC 放弃码（SYN-04）。 */
export type GcSkipCode =
  | typeof GC_SKIP_REFERENCE_MISSING
  | typeof GC_SKIP_REFERENCE_UNREADABLE
  | typeof GC_SKIP_SNAPSHOT_UNPARSABLE

/**
 * SYN-04b：通道「本轮 GC 放弃码」的读取与冒泡（从 sync-engine.ts 下沉，行为逐字不变）。
 *
 * 为什么放在独立模块：SYN-04 之后 webdav/s3 遇到「引用快照 404 / 读不出」会**放弃本轮 blob GC**
 * （绝不在「证明不了没人引用」时删 blob），而通道层没有 logger、delete() 又把 GC 异常吃掉
 * ⇒ 放弃只能靠 transport 的只读字段外露。字段形态是 getter（见 webdav/s3 transport 的
 * `get lastGcSkip()`），这里按 unknown 读、只接受非空字符串，getter 抛错也不影响 push。
 *
 * 判据（缺一不可，全部当「没有放弃码」）：字段缺失 / null / 非字符串 / 空串 / getter 抛错。
 * 读不到 ≠ 没有放弃：通道没这个能力时本来就不该冒泡告警，所以两者在调用侧合并处理。
 */
export function readGcSkipCode(transport: unknown): string | null {
  try {
    const raw = (transport as { lastGcSkip?: unknown } | null | undefined)?.lastGcSkip
    return typeof raw === 'string' && raw !== '' ? raw : null
  } catch {
    return null
  }
}

/**
 * SYN-04b：放弃码 → 一条 warning 文本。
 *
 * 码必须同时以**明文**出现：core 目录的翻译器对未知键回退键名本身（{code} 插值随之丢失），
 * 而文案键由上层统一补字典 —— 在补键之前，只发出裸键名等于「报了但看不出来」，日志也无法 grep。
 */
export function gcSkipWarning(msg: MsgFunc, code: string): string {
  const text = msg('sync.gcSkipped', { code })
  return text.includes(code) ? text : text + ': ' + code
}

/**
 * SYN-04b：把通道的 GC 放弃码冒泡成一条 warning（`state` 保证同一轮只报一次）。
 *
 * 语义边界：放弃 GC **不是** push 失败 —— 快照本身已上传/已删除，只是这一轮的孤儿 blob
 * 没被回收（磁盘/远端会多留几份文件）。所以它进 warnings、不进 ok，与 prune 既有语义一致。
 */
export function reportGcSkipOnce(transport: unknown, msg: MsgFunc, warnings: string[], state: { done: boolean }): void {
  if (state.done) return
  const code = readGcSkipCode(transport)
  if (code === null) return
  state.done = true
  warnings.push(gcSkipWarning(msg, code))
}
