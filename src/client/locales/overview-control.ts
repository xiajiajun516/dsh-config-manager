/**
 * Config Manager 字典分域 · 总览控制中心（结果列、活动复制、分区导航）。
 *
 * tech-debt #22（2026-11 拆分）：本文件只承载该域键值；聚合与键顺序由 ../locales.ts 编排。
 * 约束：zh 文案逐字保留、en 一键一镜像（`Record<keyof typeof zh, string>` 编译期校验），
 * 键集合由 src/core/engine-locale.test.ts 的既有键冻结指纹兜底。本文件零依赖、零 import。
 */
export const zh = {
  // —— Overview 控制中心（Workbench Rebuild v2）——
  'overview.result.success': '成功',
  'overview.result.failed': '失败',
  'overview.result.skipped': '跳过',
  'overview.result.pending': '待裁决',
  'overview.activity.copy': '复制',
  'overview.activity.redacted': '（文件名已脱敏）',
  'overview.sections.entries': '{count} 项',
  'overview.nav.activity': '活动',
  'overview.nav.about': '关于',
} as const;

export const en: Record<keyof typeof zh, string> = {
  // —— Overview control center (Workbench Rebuild v2) ——
  'overview.result.success': 'OK',
  'overview.result.failed': 'Failed',
  'overview.result.skipped': 'Skipped',
  'overview.result.pending': 'Needs decision',
  'overview.activity.copy': 'Copy',
  'overview.activity.redacted': '(filename redacted)',
  'overview.sections.entries': '{count} {count, plural, item|items}',
  'overview.nav.activity': 'Activity',
  'overview.nav.about': 'About',
};
