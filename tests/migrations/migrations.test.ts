/**
 * 迁移机制测试（m7-tests-docs；规范 §33 Version 组 / §36 场景 G）。
 *
 * 场景 G（旧 schema 迁移）当前状态如实说明：
 *   - CURRENT_SCHEMA_VERSION = 1，MIN_SUPPORTED = 1，MIGRATIONS = [V1_TO_V2]（占位，migrate 原样返回）
 *   - 因此「真实旧版备份 → 端到端迁移」无法触发（v1 即当前版本，不存在可喂入的真实旧备份）
 *   - 本文件对**迁移机制本身**做机制级验证：migrateToCurrent 边界（同版本 / 过新 /
 *     低于最低 / 无迁移路径 / 注册重叠拒绝 / 链式推进），保证未来 schema v2 发布时机制可用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIGRATIONS, migrateToCurrent, registerMigration,
} from '../../src/migrations/index.ts';
import { V1_TO_V2 } from '../../src/migrations/v1-to-v2.ts';
import {
  CURRENT_SCHEMA_VERSION, MIN_SUPPORTED_SCHEMA_VERSION,
  isCurrent, isSupported, needsMigration, isTooNew, canImport,
  describeVersion, UnsupportedSchemaError,
} from '../../src/schema/versions.ts';

test('G-01 同版本：migrateToCurrent(doc, 1) → 原样返回、无迁移步骤', () => {
  const doc = { settings: { theme: 'dark' } };
  const r = migrateToCurrent(doc, 1);
  assert.equal(r.doc, doc, '同版本应原样返回同一引用');
  assert.deepEqual(r.applied, []);
  assert.equal(r.migratedFrom, 1);
});

test('G-02 过新 schema：高于当前 → UnsupportedSchemaError（需升级插件）', () => {
  assert.throws(
    () => migrateToCurrent({}, 2),
    (err: unknown) => err instanceof UnsupportedSchemaError && err.version === 2,
  );
});

test('G-03 低于最低支持：低于 MIN → UnsupportedSchemaError', () => {
  assert.throws(
    () => migrateToCurrent({}, MIN_SUPPORTED_SCHEMA_VERSION - 1),
    (err: unknown) => err instanceof UnsupportedSchemaError && err.version === MIN_SUPPORTED_SCHEMA_VERSION - 1,
  );
});

test('G-04 无迁移路径：目标版本超过注册表可到达范围 → 明确报错', () => {
  // 从 v1 到 v3：链上只有 v1→v2，缺 v2→v3 → 抛 UnsupportedSchemaError
  assert.throws(
    () => migrateToCurrent({}, 1, 3),
    (err: unknown) => err instanceof UnsupportedSchemaError,
  );
});

test('G-05 注册重叠拒绝：重复注册相同 from → 抛错（注册表防损坏）', () => {
  const before = MIGRATIONS.length;
  assert.throws(
    () => registerMigration({ from: V1_TO_V2.from, to: V1_TO_V2.to, migrate: (d) => d }),
    /迁移步骤冲突/,
  );
  assert.equal(MIGRATIONS.length, before, '失败的注册不得污染注册表');
});

test('G-06 占位链存在性：V1_TO_V2 已注册且为纯函数（当前不触发）', () => {
  assert.ok(MIGRATIONS.some((s) => s.from === V1_TO_V2.from && s.to === V1_TO_V2.to), 'v1→v2 步骤应已注册');
  const doc = { marker: 'v1' };
  const out = V1_TO_V2.migrate(doc);
  assert.equal(out, doc, '占位迁移当前原样返回');
  // 当前版本 = 1 → needsMigration(1) 为 false（v1 即当前，无需迁移）
  assert.equal(needsMigration(1), false);
});

test('G-07 链式推进：注册 v2→v3 临时步骤后，v1 可链式到 v3', () => {
  const before = MIGRATIONS.length;
  registerMigration({ from: 2, to: 3, migrate: (d) => ({ ...(d as object), v3: true }) });
  try {
    const r = migrateToCurrent({ v1: true }, 1, 3);
    assert.deepEqual(r.applied, [{ from: 1, to: 2 }, { from: 2, to: 3 }], '应按序应用两步');
    assert.equal((r.doc as { v3: boolean }).v3, true, 'v2→v3 的转换应生效');
    assert.equal(r.migratedFrom, 1);
  } finally {
    // 清理临时步骤（保持注册表整洁）
    const idx = MIGRATIONS.findIndex((s) => s.from === 2 && s.to === 3);
    if (idx >= 0) MIGRATIONS.splice(idx, 1);
    assert.equal(MIGRATIONS.length, before, '临时步骤已清理');
  }
});

test('G-08 版本判定函数：isCurrent/isSupported/needsMigration/isTooNew/canImport', () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 1);
  assert.equal(MIN_SUPPORTED_SCHEMA_VERSION, 1);
  assert.equal(isCurrent(1), true);
  assert.equal(isCurrent(2), false);
  assert.equal(isSupported(1), true);
  assert.equal(isSupported(0), false, '低于最低不支持');
  assert.equal(isSupported(2), false, '高于当前不支持');
  assert.equal(needsMigration(0), false);
  assert.equal(needsMigration(1), false, '当前版本无需迁移');
  assert.equal(needsMigration(2), false, '过新版本不属于迁移范畴');
  assert.equal(isTooNew(2), true);
  assert.equal(isTooNew(1), false);
  assert.equal(canImport(1), true);
  assert.equal(canImport(0), false);
  assert.equal(canImport(2), false);
});

test('G-09 describeVersion 各分支可读描述', () => {
  assert.match(describeVersion(1), /当前版本/);
  assert.match(describeVersion(2), /高于当前/);
  assert.match(describeVersion(0), /低于最低支持/);
});

test('G-10 UnsupportedSchemaError 携带版本号', () => {
  const err = new UnsupportedSchemaError(42);
  assert.equal(err.version, 42);
  assert.match(err.message, /42/);
});
