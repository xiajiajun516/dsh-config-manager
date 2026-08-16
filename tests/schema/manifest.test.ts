/**
 * Manifest 校验测试（m7-tests-docs；规范 §三 manifest / §18 完整性）。
 *
 * 覆盖：buildManifest 构造、validateManifest 字段/类型/未知分区、
 *       parseManifest 拒绝非法、serialize 往返。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildManifest, serializeManifest, parseManifest, validateManifest, MANIFEST_FILE,
} from '../../src/schema/manifest.ts';
import { CURRENT_SCHEMA_VERSION } from '../../src/schema/versions.ts';
import type { Manifest } from '../../src/schema/types.ts';

function validInput(): Parameters<typeof buildManifest>[0] {
  return {
    exporterVersion: '0.1.0',
    dshVersion: '0.1.0-rc.6',
    platform: 'win32',
    arch: 'x64',
    sections: { settings: true, secrets: false } as unknown as Manifest['sections'],
    containsSecrets: false,
    encrypted: false,
    encryption: null,
    exportedAt: '2026-08-14T12:00:00.000Z',
  };
}

test('M-01 buildManifest：字段齐全、schemaVersion 恒为当前版本、sections/security 形状正确', () => {
  const m = buildManifest(validInput());
  assert.equal(m.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(m.exporter.name, 'DSH Config Manager');
  assert.equal(m.exporter.version, '0.1.0');
  assert.deepEqual(m.source, { dshVersion: '0.1.0-rc.6', platform: 'win32', arch: 'x64' });
  assert.equal(m.exportedAt, '2026-08-14T12:00:00.000Z');
  assert.equal(m.sections.settings, true);
  assert.equal(m.security.containsSecrets, false);
  assert.equal(m.security.encrypted, false);
  assert.equal(m.security.encryption, null);
  // 未传 exportedAt → 自动当前时间
  const auto = buildManifest({ ...validInput(), exportedAt: undefined });
  assert.equal(Number.isNaN(Date.parse(auto.exportedAt)), false, '缺省 exportedAt 应为合法 ISO 时间');
});

test('M-02 validateManifest：合法 manifest 零 error（允许未知分区 warning）', () => {
  const issues = validateManifest(buildManifest(validInput()));
  assert.equal(issues.filter((i) => i.severity === 'error').length, 0);
  assert.equal(issues.length, 0, '合法输入应无任何 issue');
});

test('M-03 validateManifest：缺失/类型错误 → error', () => {
  const base = buildManifest(validInput()) as unknown as Record<string, unknown>;

  // 非对象
  assert.ok(validateManifest(null).some((i) => i.severity === 'error'));
  assert.ok(validateManifest('str').some((i) => i.severity === 'error'));

  // schemaVersion 非数字
  assert.ok(validateManifest({ ...base, schemaVersion: 'one' }).some((i) => i.path === 'schemaVersion' && i.severity === 'error'));
  // exporter 缺失
  const noExporter = { ...base }; delete (noExporter as Record<string, unknown>)['exporter'];
  assert.ok(validateManifest(noExporter).some((i) => i.path === 'exporter' && i.severity === 'error'));
  // exporter.name 非字符串
  assert.ok(validateManifest({ ...base, exporter: { name: 1, version: 'x' } }).some((i) => i.path === 'exporter.name'));
  // source 缺失
  const noSource = { ...base }; delete (noSource as Record<string, unknown>)['source'];
  assert.ok(validateManifest(noSource).some((i) => i.path === 'source'));
  // exportedAt 非法
  assert.ok(validateManifest({ ...base, exportedAt: 'not-a-date' }).some((i) => i.path === 'exportedAt'));
  // sections 缺失
  const noSections = { ...base }; delete (noSections as Record<string, unknown>)['sections'];
  assert.ok(validateManifest(noSections).some((i) => i.path === 'sections'));
  // security 缺失
  const noSecurity = { ...base }; delete (noSecurity as Record<string, unknown>)['security'];
  assert.ok(validateManifest(noSecurity).some((i) => i.path === 'security'));
  // security.containsSecrets 非布尔
  assert.ok(validateManifest({ ...base, security: { containsSecrets: 'yes', encrypted: false, encryption: null } }).some((i) => i.path === 'security.containsSecrets'));
});

test('M-04 validateManifest：未知分区 → warning（非 error），sections 值非布尔 → error', () => {
  const m = buildManifest(validInput()) as unknown as Record<string, unknown>;
  const unknown = validateManifest({ ...m, sections: { ...(m['sections'] as object), keybindings: true } });
  assert.ok(unknown.some((i) => i.path === 'sections.keybindings' && i.severity === 'warning'), '未知分区应仅 warning');
  assert.equal(unknown.filter((i) => i.severity === 'error').length, 0, '未知分区不应导致 error');

  const badType = validateManifest({ ...m, sections: { ...(m['sections'] as object), settings: 'yes' } });
  assert.ok(badType.some((i) => i.path === 'sections.settings' && i.severity === 'error'), 'sections 值非布尔 → error');
});

test('M-05 serializeManifest → parseManifest 往返一致（JSON 合法）', () => {
  const m = buildManifest(validInput());
  const raw = serializeManifest(m);
  assert.doesNotThrow(() => JSON.parse(raw), '序列化输出应为合法 JSON');
  const parsed = parseManifest(raw);
  assert.deepEqual(parsed, m, '序列化→解析应往返一致');
});

test('M-06 parseManifest：非法 JSON / 非法结构 → 抛错（导入第一道闸）', () => {
  assert.throws(() => parseManifest('{not json'), /manifest\.json 无效|JSON/);
  assert.throws(() => parseManifest('[]'), /manifest\.json 无效/);
  assert.throws(() => parseManifest('{"schemaVersion": "x"}'), /manifest\.json 无效/);
});

test('M-07 MANIFEST_FILE 常量', () => {
  assert.equal(MANIFEST_FILE, 'manifest.json');
});
