/**
 * Config Manager 字典分域 · 导入报告。
 *
 * tech-debt #22（2026-11 拆分）：本文件只承载该域键值；聚合与键顺序由 ../locales.ts 编排。
 * 约束：zh 文案逐字保留、en 一键一镜像（`Record<keyof typeof zh, string>` 编译期校验），
 * 键集合由 src/core/engine-locale.test.ts 的既有键冻结指纹兜底。本文件零依赖、零 import。
 */
export const zh = {
  // —— 报告 ——
  'report.import.title': '导入结果',
  'report.needsRestart': '插件 / MCP 变更将在重启 DSH 后生效。',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'report.import.title': 'Import Result',
  'report.needsRestart': 'Plugin / MCP changes take effect after restarting DSH.',
};
