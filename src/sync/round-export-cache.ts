/**
 * I 项：单轮自动同步的本地导出复用缓存（作用域只限一次 runOnceInternal 内部）。
 *
 * 解决的问题：单轮内 `detectPhase -> hasLocalChanges -> merge -> push` 对未变更分区重复调用
 * `adapter.export()`（无锁 3 次 / 有锁 4 次；当 `plugins` 含超限/软链/20k+ 本地插件导致
 * `local-plugin-host.packedCache` 放弃缓存时，每次导出都要重跑全树 stat / `npm pack`）。
 *
 * 边界不变量：
 * - 只缓存 `includeSecrets: false` 的导出结果（含 `warnings`/`counts`/`files`/`data`），含密导出恒绕过；
 * - cache key 包含 `adapter.id` 与 `sessions` 导出参数，防止不同切片参数串用；
 * - 磁盘写入（`applyMergePlan`）后按写入分区失效，失败回滚清空全池，绝不把写入前内容当落盘后状态；
 * - 有 `mutationLock` 时，锁前预检与锁内重检各自独立实例化缓存，不跨越锁边界复用（保住 TOCTOU 重检语义）。
 */
import type { ConfigAdapter, ExportOptions, ExportSection, HostContext } from '../core/types.ts';
import type { SectionId } from '../schema/types.ts';

function optionsKeyOf(id: SectionId, opts: ExportOptions): string {
  const limit = opts.sessions?.limit ?? '';
  const items = opts.includeItems?.[id];
  const itemKey = items !== undefined ? items.join('\u0000') : '';
  return `${limit}:${itemKey}`;
}

export class RoundExportCache {
  private readonly entries = new Map<string, ExportSection>();

  async getOrExport(adapter: ConfigAdapter, ctx: HostContext, opts: ExportOptions): Promise<ExportSection> {
    if (opts.includeSecrets) {
      return adapter.export(ctx, opts);
    }
    const key = `${adapter.id}\u0001${optionsKeyOf(adapter.id, opts)}`;
    const hit = this.entries.get(key);
    if (hit !== undefined) return hit;
    const result = await adapter.export(ctx, opts);
    this.entries.set(key, result);
    return result;
  }

  /** 使指定分区的全部导出参数变体失效（applyMergePlan 写入磁盘后调用）。 */
  invalidate(ids: readonly SectionId[]): void {
    if (ids.length === 0) return;
    const prefixes = ids.map((id) => `${id}\u0001`);
    for (const key of this.entries.keys()) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
