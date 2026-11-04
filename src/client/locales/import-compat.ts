/**
 * Config Manager 字典分域 · 导入兼容性评分（Workbench Rebuild）。
 *
 * tech-debt #22（2026-11 拆分）：本文件只承载该域键值；聚合与键顺序由 ../locales.ts 编排。
 * 约束：zh 文案逐字保留、en 一键一镜像（`Record<keyof typeof zh, string>` 编译期校验），
 * 键集合由 src/core/engine-locale.test.ts 的既有键冻结指纹兜底。本文件零依赖、零 import。
 */
export const zh = {
  // —— 导入兼容性（Workbench Rebuild）——
  'import.compatibility.sections': '{count} 个分区',
  'import.compatibility.plugins': '已装 {installed} · 待装 {toInstall}',
  'import.compatibility.paths': '{count} 项路径处理',
  'import.compatibility.secrets': '{count} 项密钥补录',
  'import.compatibility.score.excellent': '优秀',
  'import.compatibility.score.good': '良好',
  'import.compatibility.score.partial': '部分兼容',
  'import.compatibility.score.unsupported': '不支持',
  'import.compatibility.sectionsTitle': '备份包含的分区',
} as const;

export const en: Record<keyof typeof zh, string> = {
  // —— Import compatibility (Workbench Rebuild) ——
  'import.compatibility.sections': '{count} {count, plural, section|sections}',
  'import.compatibility.plugins': 'installed {installed} · to install {toInstall}',
  'import.compatibility.paths': '{count} path {count, plural, issue|issues}',
  'import.compatibility.secrets': '{count} {count, plural, secret|secrets} to re-enter',
  'import.compatibility.score.excellent': 'Excellent',
  'import.compatibility.score.good': 'Good',
  'import.compatibility.score.partial': 'Partial',
  'import.compatibility.score.unsupported': 'Unsupported',
  'import.compatibility.sectionsTitle': 'Sections in this backup',
};
