/**
 * Config Manager 表面文案：zh 为源语言，en 镜像每个键。
 * 字典 namespace 由 client/index.ts 注册（declare module 合并进 LocaleNamespaceMap）。
 * 键集合通过 `ConfigManagerKey` 类型在注册处做编译期校验（缺键/多键即编译错误）。
 *
 * tech-debt #22（2026-11）：按页面域拆到 ./locales/*.ts，本文件只做聚合 —— 导入面零变更
 * （`zh` / `en` / `ConfigManagerKey` 仍从这里导出），键顺序按原文件出现顺序逐字展开。
 * 注意两侧展开顺序不同：en 的 nextSteps 段原本就排在 import 兼容性之后（勿按 zh 顺序「对齐」）。
 */
import { en as commonEn, zh as commonZh } from './locales/common.ts';
import { en as overviewEn, zh as overviewZh } from './locales/overview.ts';
import { en as exportEn, zh as exportZh } from './locales/export.ts';
import { en as importEn, zh as importZh } from './locales/import.ts';
import { en as restoreEn, zh as restoreZh } from './locales/restore.ts';
import { en as backupEn, zh as backupZh } from './locales/backup.ts';
import { en as reportEn, zh as reportZh } from './locales/report.ts';
import { en as nextStepsEn, zh as nextStepsZh } from './locales/next-steps.ts';
import { en as aboutEn, zh as aboutZh } from './locales/about.ts';
import { en as profilesEn, zh as profilesZh } from './locales/profiles.ts';
import { en as importCompatEn, zh as importCompatZh } from './locales/import-compat.ts';
import { en as shellEn, zh as shellZh } from './locales/shell.ts';
import { en as overviewControlEn, zh as overviewControlZh } from './locales/overview-control.ts';
import { en as sessionsEn, zh as sessionsZh } from './locales/sessions.ts';
import { en as foreignEn, zh as foreignZh } from './locales/foreign.ts';

export const zh = {
  ...commonZh,
  ...overviewZh,
  ...exportZh,
  ...importZh,
  ...restoreZh,
  ...backupZh,
  ...reportZh,
  ...nextStepsZh,
  ...aboutZh,
  ...profilesZh,
  ...importCompatZh,
  ...shellZh,
  ...overviewControlZh,
  ...sessionsZh,
  ...foreignZh,
} as const;

export const en: Record<keyof typeof zh, string> = {
  ...commonEn,
  ...overviewEn,
  ...exportEn,
  ...importEn,
  ...restoreEn,
  ...backupEn,
  ...reportEn,
  ...aboutEn,
  ...profilesEn,
  ...importCompatEn,
  ...nextStepsEn,
  ...shellEn,
  ...overviewControlEn,
  ...sessionsEn,
  ...foreignEn,
};

/** 字典键联合（注册处 compile-time 校验） */
export type ConfigManagerKey = keyof typeof zh;
