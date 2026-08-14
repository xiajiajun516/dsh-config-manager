/**
 * v1 → v2 迁移（占位）：Export Schema 发布 v2 时在此实现真实转换并注册。
 * 当前 CURRENT_SCHEMA_VERSION=1，本步骤不会触发（migrateToCurrent 目标=1）。
 *
 * 迁移必须是纯函数式：输入 v1 结构 → 输出 v2 结构，绝不触碰目标 DSH。
 */
import type { MigrationStep } from './index.ts';

/** v1→v2 转换（占位实现：v2 尚不存在，仅结构骨架） */
export const V1_TO_V2: MigrationStep = {
  from: 1,
  to: 2,
  migrate(doc: unknown): unknown {
    // TODO(schema-v2): 例如 settings 分区结构变更时在此改写；当前原样返回
    return doc;
  },
};
