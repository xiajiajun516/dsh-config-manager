/**
 * patch 行**键名**的跨大版本守卫（issue #137）。
 *
 * 写侧 `forceQuotes`（issue #135）只保**值**；键名仍由 js-yaml 决定加不加引号，于是
 * `007` / `True` / `.5` / `~` 这类键被 4.x 读成 `7` / `true` / `0.5` / `null`，
 * 空键名更会让整份 `cordis.patch.yml` 解析失败。检测器在 `utils/patch-yaml.ts`
 * （`findPatchKeyHazards`），这里只负责把命中翻成计划项文案 —— 各适配器共用一份措辞，
 * 免得同一个风险在插件 / MCP 两处说法不一致。
 *
 * 为什么是「计划项降级」而不是「写盘时抛错」：抛错走 analyzer 的 hardFailed ⇒
 * `rollbackOnError` 会把**整笔导入**回滚（别的分区也跟着白做）；`kind: 'Error'` 的计划项
 * 在 `src/core/analyzer.ts` 里只记账、不回滚、不中断后续条目（与 plugin-files 的
 * SEC-05 同一条通道）。
 */
import type { MsgFunc } from '../core/messages.ts'
import type { PatchKeyHazard } from '../utils/patch-yaml.ts'

/**
 * 把一处键名风险转成用户可见文案。
 *
 * @param ref 计划项对应的 patch 行 id（`lineId`），用于让用户定位到具体是哪一行
 * @param hazard `findPatchKeyHazards` 的命中项
 */
export function patchKeyHazardMessage(msg: MsgFunc, ref: string, hazard: PatchKeyHazard): string {
  const path = hazard.path === '' ? '-' : hazard.path
  return hazard.effect === 'parse-fail'
    ? msg('adapter.patchKeyParseFail', { ref, path })
    : msg('adapter.patchKeyAmbiguous', { ref, key: hazard.key, path })
}
