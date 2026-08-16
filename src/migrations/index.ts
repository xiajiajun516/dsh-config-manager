/**
 * 迁移链（设计 §10）：schemaVersion 独立演进，迁移逻辑集中于此。
 * 当前 v1 为起点（CURRENT_SCHEMA_VERSION=1），未来 schema v2 发布时：
 *   1) 新增 src/migrations/v1-to-v2.ts 的迁移函数；
 *   2) 在下方 MIGRATIONS 注册；业务代码零版本判断（统一走 migrateToCurrent）。
 */
import { CURRENT_SCHEMA_VERSION, MIN_SUPPORTED_SCHEMA_VERSION, UnsupportedSchemaError } from '../schema/versions.ts';
import { V1_TO_V2 } from './v1-to-v2.ts';

export interface MigrationStep {
  from: number;
  to: number;
  /** 纯函数式转换：输入旧结构 → 输出新结构（不触碰目标 DSH） */
  migrate(doc: unknown): unknown;
}

export interface MigrationResult {
  doc: unknown;
  migratedFrom: number;
  applied: { from: number; to: number }[];
}

/**
 * 迁移注册表：按 from 升序的链式步骤。
 * 当前只有 v1→v2 占位（CURRENT=1 时不会触发，schema v2 发布后生效）。
 */
export const MIGRATIONS: MigrationStep[] = [V1_TO_V2];

/** 注册新迁移步骤（供未来版本追加；保持链式无环：from 严格递增） */
export function registerMigration(step: MigrationStep): void {
  const dup = MIGRATIONS.find((s) => s.from === step.from || s.to === step.to);
  if (dup) throw new Error(`迁移步骤冲突: ${step.from}→${step.to} 与 ${dup.from}→${dup.to} 重叠`);
  MIGRATIONS.push(step);
  MIGRATIONS.sort((a, b) => a.from - b.from);
}

/**
 * 沿迁移链把文档升级到目标版本（缺省当前版本）。
 * - 已是目标版本 → 原样返回；
 * - 高于目标 → UnsupportedSchemaError（需升级插件）；
 * - 低于最低支持 → UnsupportedSchemaError；
 * - 无可用迁移路径 → 抛错。
 */
export function migrateToCurrent(doc: unknown, fromVersion: number, targetVersion: number = CURRENT_SCHEMA_VERSION): MigrationResult {
  if (fromVersion === targetVersion) {
    return { doc, migratedFrom: fromVersion, applied: [] };
  }
  if (fromVersion > targetVersion) {
    throw new UnsupportedSchemaError(fromVersion, `备份 schema v${fromVersion} 高于当前 v${targetVersion}，需升级本插件`);
  }
  if (fromVersion < MIN_SUPPORTED_SCHEMA_VERSION) {
    throw new UnsupportedSchemaError(fromVersion, `备份 schema v${fromVersion} 低于最低支持 v${MIN_SUPPORTED_SCHEMA_VERSION}`);
  }

  let current = doc;
  let version = fromVersion;
  const applied: { from: number; to: number }[] = [];
  while (version < targetVersion) {
    const step = MIGRATIONS.find((s) => s.from === version && s.to <= targetVersion);
    if (!step) {
      throw new UnsupportedSchemaError(version, `没有从 schema v${version} 到 v${targetVersion} 的迁移路径`);
    }
    if (step.to <= step.from) {
      throw new Error(`迁移步骤 ${step.from}→${step.to} 未前进（注册表损坏）`);
    }
    current = step.migrate(current);
    applied.push({ from: step.from, to: step.to });
    version = step.to;
  }
  return { doc: current, migratedFrom: fromVersion, applied };
}
