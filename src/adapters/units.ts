/**
 * 分区内「最小可拆单元」的共享判定（Phase 1 条目级导出选择）。
 *
 * 为什么需要「单元」这一层：文件类分区（skills / agentPresets / sessions / pluginFiles / self）
 * 不能按裸文件勾选 —— 一个技能目录 bundle 拆开就失效，一个会话目录拆开就不再是会话。
 * 所以「哪些文件属于同一个可勾选整体」是 adapter 的知识，由本模块提供默认规则。
 *
 * 单元 id 规则（与导入侧 PlanItem.id 同一命名空间，保证「导出的勾选」将来可复用到导入）：
 *   - 文件类：<section>:<单元相对路径>
 *   - 插件：  plugin:<包名> / patch:<行 id> / plugins:patch:<rel> / plugins:pnpm-workspace
 *   - 工作区：workspace:<记录 id>
 *
 * 本模块全部为纯函数：零 I/O，因此预览端点可以在零额外读盘的前提下枚举单元
 * （输入即 export() 的产物，不需要第二次遍历目录/读文件）。
 */
import type { ExportUnit } from '../core/types.ts';

/** 相对路径归一化为 POSIX（反斜杠 → 正斜杠），保证单元 id 跨平台稳定。 */
export function toPosixRel(rel: string): string {
  return rel.replace(/\\/g, '/');
}

/** 文件类分区的默认单元 = 首个路径段（目录 bundle 整体成一个单元；平铺文件 = 自身）。 */
export function defaultUnitId(rel: string): string {
  const p = toPosixRel(rel);
  const i = p.indexOf('/');
  return i === -1 ? p : p.slice(0, i);
}

/**
 * 白名单判定：allow === undefined = 未指定 → 全量导出（向后兼容，旧调用方零改动）；
 * 空数组 = 什么都不允许（调用方应把该分区整体视为未勾选，见 Exporter.export）。
 */
export function unitAllowed(allow: readonly string[] | undefined, id: string): boolean {
  return allow === undefined || allow.includes(id);
}

/** 白名单是否让该分区整体为空（= 用户取消了整个分区，不是「导出空分区」）。 */
export function allowListEmptiesSection(allow: readonly string[] | undefined): boolean {
  return allow !== undefined && allow.length === 0;
}

/** 由「成员文件」归并出单元清单（体积 = 成员文件字节合计；零 I/O）。 */
export function unitsFromFiles(
  sectionId: string,
  files: readonly { relativePath: string; data: Uint8Array }[],
  unitIdOf: (rel: string) => string,
): ExportUnit[] {
  const byUnit = new Map<string, { count: number; size: number }>();
  for (const f of files) {
    const unit = unitIdOf(f.relativePath);
    const cur = byUnit.get(unit) ?? { count: 0, size: 0 };
    cur.count += 1;
    cur.size += f.data.length;
    byUnit.set(unit, cur);
  }
  return [...byUnit.entries()].map(([unit, agg]) => ({
    id: sectionId + ':' + unit,
    label: unit,
    fileCount: agg.count,
    sizeBytes: agg.size,
  }));
}
