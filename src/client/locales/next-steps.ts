/**
 * Config Manager 字典分域 · 导入 / 同步后的收尾清单。
 *
 * tech-debt #22（2026-11 拆分）：本文件只承载该域键值；聚合与键顺序由 ../locales.ts 编排。
 * 约束：zh 文案逐字保留、en 一键一镜像（`Record<keyof typeof zh, string>` 编译期校验），
 * 键集合由 src/core/engine-locale.test.ts 的既有键冻结指纹兜底。本文件零依赖、零 import。
 */
export const zh = {
  // —— 导入/同步后收尾清单（P0-① / P2-⑪）——
  'nextSteps.title': '接下来需要处理',
  'nextSteps.done': '全部完成，无需额外处理',
  'nextSteps.restart.hint': '需重启 DSH 后生效（{count}）：',
  'nextSteps.secrets.hint': '未随备份导出、需在本机补录的凭据（{count}）：',
  'nextSteps.unresolved.hint': '未成功应用（{count}），可用下方按钮重试：',
} as const;

export const en: Record<keyof typeof zh, string> = {
  // —— Sync status facts (Workbench Rebuild) ——
  // Import/sync next-steps checklist (P0-① / P2-⑪)
  'nextSteps.title': 'Next steps',
  'nextSteps.done': 'All done — nothing else to handle',
  'nextSteps.restart.hint': 'Take effect after restarting DSH ({count}):',
  'nextSteps.secrets.hint': 'Not exported with the backup — re-enter on this machine ({count}):',
  'nextSteps.unresolved.hint': 'Not applied ({count}) — retry with the button below:',
};
