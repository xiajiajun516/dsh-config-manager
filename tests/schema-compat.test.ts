/**
 * F8 版本兼容补测（拒绝未来版本 + 未知字段保留）。
 *
 * 借鉴 uagent-sync 的 workspace-state-codec 契约：拒绝未来版本、低于最低支持版本
 * 抛错、未知兼容字段保留（passthrough）。本仓库实现位于：
 *   - src/migrations/index.ts  migrateToCurrent（拒绝过新 / 低于 MIN / 无迁移路径）
 *   - src/schema/versions.ts    isTooNew / needsMigration / isCurrent / canImport /
 *                               describeVersion / isSupported / UnsupportedSchemaError
 *   - src/migrations/v1-to-v2.ts 占位迁移（CURRENT=1 不触发，migrate 原样返回 doc）
 *
 * 未知字段保留结论（本文件固化）：
 *   - V1_TO_V2.migrate 无白名单、原样返回同一引用 → 未知字段天然保留；
 *   - migrateToCurrent 同版本返回同一引用；
 *   - parseManifest / validateManifest 只做已知字段类型校验，不做白名单重写 →
 *     未知键原样留在解析结果里。
 *
 * 注：MIN_SUPPORTED=CURRENT=1 时 needsMigration 的「真值档」与 describeVersion 的
 * 「将迁移」分支不可达（不存在 1<v<1 的整数），本文件如实测试可达档位并注明。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MIGRATIONS, migrateToCurrent, registerMigration } from '../src/migrations/index.ts';
import { V1_TO_V2 } from '../src/migrations/v1-to-v2.ts';
import {
  CURRENT_SCHEMA_VERSION, MIN_SUPPORTED_SCHEMA_VERSION,
  UnsupportedSchemaError, canImport, describeVersion, isCurrent, isSupported,
  needsMigration, isTooNew,
} from '../src/schema/versions.ts';
import { buildManifest, parseManifest, serializeManifest } from '../src/schema/manifest.ts';

/** 含未知字段的样例文档（未来版本可能新增的兼容键） */
function docWithUnknown(): Record<string, unknown> {
  return {
    settings: { theme: 'dark' },
    'x-unknown-top': { future: true },
    futureField: 'keep-me',
  };
}

test('SC-01 已是当前版本：原样返回同一引用，applied 为空，未知字段保留', () => {
  const doc = docWithUnknown();
  const r = migrateToCurrent(doc, CURRENT_SCHEMA_VERSION);
  assert.equal(r.doc, doc, '同版本应返回同一引用（零拷贝透传）');
  assert.deepEqual(r.applied, []);
  assert.equal(r.migratedFrom, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(
    r.doc as Record<string, unknown>,
    { settings: { theme: 'dark' }, 'x-unknown-top': { future: true }, futureField: 'keep-me' },
    '未知字段必须原样保留',
  );
});

test('SC-02 拒绝未来版本：fromVersion > CURRENT → UnsupportedSchemaError', () => {
  const doc = docWithUnknown();
  assert.throws(
    () => migrateToCurrent(doc, CURRENT_SCHEMA_VERSION + 1),
    (err: unknown) => err instanceof UnsupportedSchemaError && err.version === CURRENT_SCHEMA_VERSION + 1,
  );
  // 未来版本不得被改写：失败后原文档不变
  assert.deepEqual(doc, docWithUnknown());
});

test('SC-03 拒绝低于最低支持版本 → UnsupportedSchemaError', () => {
  assert.throws(
    () => migrateToCurrent({}, MIN_SUPPORTED_SCHEMA_VERSION - 1),
    (err: unknown) => err instanceof UnsupportedSchemaError && err.version === MIN_SUPPORTED_SCHEMA_VERSION - 1,
  );
});

test('SC-04 无迁移路径：目标版本超过注册表可达范围 → 明确抛错', () => {
  // 链上只有 v1→v2，缺 v2→v3：migrateToCurrent(doc, 1, 3) 无路径
  assert.throws(
    () => migrateToCurrent({}, 1, CURRENT_SCHEMA_VERSION + 2),
    (err: unknown) => err instanceof UnsupportedSchemaError,
  );
});

test('SC-05 未知字段保留：v1→v2 占位迁移原样透传（migrateToCurrent(doc, 1, 2)）', () => {
  const doc = docWithUnknown();
  const r = migrateToCurrent(doc, 1, 2);
  assert.deepEqual(r.applied, [{ from: 1, to: 2 }], 'v1→v2 步骤应被应用');
  assert.equal(r.doc, doc, '占位迁移返回同一引用 → 未知字段不被丢弃');
  assert.equal((r.doc as Record<string, unknown>)['futureField'], 'keep-me');
  assert.deepEqual((r.doc as Record<string, unknown>)['x-unknown-top'], { future: true });
  assert.equal(r.migratedFrom, 1);
});

test('SC-06 未知字段保留：V1_TO_V2.migrate 直接调用同样透传（无白名单）', () => {
  const doc = docWithUnknown();
  const out = V1_TO_V2.migrate(doc);
  assert.equal(out, doc, '占位迁移不建新对象、不展开白名单');
  assert.deepEqual(out, docWithUnknown());
});

test('SC-07 未知字段保留：parseManifest 解析含未知键的 manifest 不丢弃', () => {
  const base = buildManifest({
    exporterVersion: '0.1.45',
    dshVersion: '0.1.0',
    platform: 'win32',
    arch: 'x64',
    sections: { settings: true },
    containsSecrets: false,
    encrypted: false,
    encryption: null,
    exportedAt: '2026-08-23T00:00:00.000Z',
  });
  // 注入未来版本可能新增的兼容键（顶层 + 已知对象内）
  const withUnknown = {
    ...base,
    'x-future-manifest-key': { migrated: true },
    exporter: { ...base.exporter, futureExporterField: 'keep' },
  };
  const parsed = parseManifest(serializeManifest(withUnknown));
  assert.deepEqual(
    (parsed as unknown as Record<string, unknown>)['x-future-manifest-key'],
    { migrated: true },
    '未知顶层键必须保留',
  );
  assert.equal(
    (parsed.exporter as Record<string, unknown>)['futureExporterField'],
    'keep',
    '已知对象内的未知子键必须保留',
  );
});

test('SC-08 版本判定函数各档位（isCurrent/needsMigration/isTooNew/canImport/isSupported）', () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 1);
  assert.equal(MIN_SUPPORTED_SCHEMA_VERSION, 1);
  // isCurrent：恰好当前
  assert.equal(isCurrent(CURRENT_SCHEMA_VERSION), true);
  assert.equal(isCurrent(CURRENT_SCHEMA_VERSION + 1), false);
  // needsMigration：低于当前且在支持范围内才为 true；当前 MIN=CURRENT=1 无真值档（如实注明）
  assert.equal(needsMigration(CURRENT_SCHEMA_VERSION), false, '当前版本无需迁移');
  assert.equal(needsMigration(MIN_SUPPORTED_SCHEMA_VERSION - 1), false, '低于最低支持不属于迁移范畴');
  assert.equal(needsMigration(CURRENT_SCHEMA_VERSION + 1), false, '过新版本不属于迁移范畴');
  // isTooNew：高于当前
  assert.equal(isTooNew(CURRENT_SCHEMA_VERSION + 1), true);
  assert.equal(isTooNew(CURRENT_SCHEMA_VERSION), false);
  // canImport：当前或可迁移旧版
  assert.equal(canImport(CURRENT_SCHEMA_VERSION), true);
  assert.equal(canImport(MIN_SUPPORTED_SCHEMA_VERSION - 1), false);
  assert.equal(canImport(CURRENT_SCHEMA_VERSION + 1), false);
  // isSupported：支持范围 [MIN, CURRENT]
  assert.equal(isSupported(CURRENT_SCHEMA_VERSION), true);
  assert.equal(isSupported(MIN_SUPPORTED_SCHEMA_VERSION - 1), false);
  assert.equal(isSupported(CURRENT_SCHEMA_VERSION + 1), false);
});

test('SC-09 describeVersion 各可达档位描述（当前/过新/低于最低）', () => {
  assert.match(describeVersion(CURRENT_SCHEMA_VERSION), /当前版本/);
  assert.match(describeVersion(CURRENT_SCHEMA_VERSION + 1), /高于当前/);
  assert.match(describeVersion(MIN_SUPPORTED_SCHEMA_VERSION - 1), /低于最低支持/);
  // 注：needsMigration 真值档当前不可达（MIN=CURRENT=1），「将迁移」分支未覆盖
});

test('SC-10 链式迁移保留未知字段：临时注册 v2→v3 后 v1→v3 全程透传', () => {
  const before = MIGRATIONS.length;
  registerMigration({
    from: 2,
    to: 3,
    migrate: (d) => ({ ...(d as object), v3Applied: true }),
  });
  try {
    const doc = docWithUnknown();
    const r = migrateToCurrent(doc, 1, 3);
    assert.deepEqual(r.applied, [{ from: 1, to: 2 }, { from: 2, to: 3 }]);
    assert.equal((r.doc as Record<string, unknown>)['v3Applied'], true, 'v2→v3 转换生效');
    // 未知字段在链式转换（展开合并）后仍保留
    assert.equal((r.doc as Record<string, unknown>)['futureField'], 'keep-me');
    assert.deepEqual((r.doc as Record<string, unknown>)['x-unknown-top'], { future: true });
  } finally {
    const idx = MIGRATIONS.findIndex((s) => s.from === 2 && s.to === 3);
    if (idx >= 0) MIGRATIONS.splice(idx, 1);
    assert.equal(MIGRATIONS.length, before, '临时步骤已清理');
  }
});
