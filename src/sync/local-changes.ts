/**
 * 「本地有没有会进载荷的改动」的判定（§3.1 上传「看变化」；从 sync-engine 拆出，体量棘轮只许下调）。
 *
 * 为什么单独一层：判据必须与推送载荷**同集合、同字节口径** —— 比对里剔掉的易变字段必须同时从
 * 载荷剔除，否则每轮轮询都真推一次（字节口径的唯一实现是 adapters/file-collection.ts 的
 * comparableContent()，实测见 docs/evidence/sync-channel.md）。散在引擎里既没法单测，也没人敢改。
 */
import { sanitizeSectionData } from '../core/section-sanitize.ts';
import type { ConfigAdapter, ExportSection, HostContext, SecretScanner } from '../core/types.ts';
import { isFileSection } from '../schema/config.ts';
import type { SectionData } from '../schema/types.ts';
import { hashSection } from './sync-state.ts';
import type { SyncState } from './sync-state.ts';

/**
 * 任一候选分区（= 会进载荷的那一批）的导出 hash ≠ 基线 ⇒ true。
 * - 从未同步（state.sections 为空）→ true；
 * - 基线缺该分区 → true（比不出来的不能当成「没变」）；
 * - 单项导出失败 → 跳过该项（与 push 单项跳过语义一致），绝不当成「有变化」去触发空推。
 * 只读本地导出 + sync-state，不碰远端。
 */
export async function hasLocalSectionChanges(args: {
  state: SyncState;
  adapters: readonly ConfigAdapter[];
  ctx: HostContext;
  scanner: SecretScanner;
  exportSection?: (adapter: ConfigAdapter) => Promise<ExportSection>;
}): Promise<boolean> {
  const { state, adapters, ctx, scanner, exportSection } = args;
  if (Object.keys(state.sections).length === 0) return true;
  for (const adapter of adapters) {
    let section;
    try {
      section = await (exportSection !== undefined
        ? exportSection(adapter)
        : adapter.export(ctx, { includeSecrets: false }));
    } catch {
      continue;
    }
    const data = isFileSection(adapter.id) ? section.data : sanitizeSectionData(adapter, scanner, section.data).sanitized;
    const recorded = state.sections[adapter.id];
    if (recorded === undefined) return true;
    if (recorded.hash !== hashSection(data as SectionData)) return true;
  }
  return false;
}
