/**
 * issue #59：远端「存在但读不出来」的快照的常驻告知。
 *
 * 背景：`list()` 跳过坏快照是必要防御（一条坏数据不该让整份列表失败），但**静默跳过**会让
 * 用户看到「push 报成功 + 远端列表为空」这种自相矛盾的状态而无从自查。宿主现在把读失败
 * 随列表一起回传（`unreadable[]`），这里把它渲染成一条常驻警告。
 *
 * 为什么单独成文件（t42 物理拆分约定）：主文件 `SyncPanel.tsx` 有行数棘轮，展示段一律拆出去；
 * 与 `SyncChannelEntryCard` / `SecurityOptionsCard` 等渲染段同级平铺。
 */
import type { TranslateNS } from '../client-types.ts'
import { Banner } from '../common/ui.tsx'

/** 展示用：只留文件名（宿主回传的是快照文件路径，目录部分对用户无意义）。 */
function baseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file
}

export function UnreadableSnapshotsBanner({
  items,
  t,
}: {
  items: readonly { file: string; reason: string }[]
  t: TranslateNS<'config-manager-sync'>
}) {
  if (items.length === 0) return null
  return (
    <Banner kind="warn">
      {t('snapshots.unreadableHint', {
        n: String(items.length),
        files: items.map((u) => baseName(u.file)).join(t('common.listSeparator')),
      })}
    </Banner>
  )
}
