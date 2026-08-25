/**
 * profiles-view 纯函数测试：Profile 名校验、切换预览摘要、结果语义 kind。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { SwitchPreview, ProfileSwitchResult } from '../profiles/profile-manager.ts';
import {
  profileSwitchKind,
  summarizeSwitchPreview,
  validateProfileNameInput,
} from './profiles-view.ts';

function preview(partial: Partial<SwitchPreview> = {}): SwitchPreview {
  return {
    items: [],
    missingSecrets: [],
    needsRestart: false,
    sectionsInProfile: ['settings', 'plugins'],
    ...partial,
  };
}

function result(partial: Partial<ProfileSwitchResult> = {}): ProfileSwitchResult {
  return {
    ok: true,
    executed: [],
    needsRestart: false,
    missingSecrets: [],
    warnings: [],
    rollback: null,
    snapshotId: 'snap-1',
    ...partial,
  };
}

test('profiles-view: validateProfileNameInput 合法名通过、非法名拒绝', () => {
  assert.equal(validateProfileNameInput('work'), null);
  assert.equal(validateProfileNameInput(' Personal '), null, '首尾空格容忍（trim 后校验）');
  assert.equal(validateProfileNameInput(''), 'name is required');
  assert.equal(validateProfileNameInput('  '), 'name is required');
  assert.equal(validateProfileNameInput('..'), 'illegal name');
  assert.equal(validateProfileNameInput('a/b'), 'illegal characters');
  assert.equal(validateProfileNameInput('a\\b'), 'illegal characters');
  assert.equal(validateProfileNameInput('a\0b'), 'illegal characters');
  assert.equal(validateProfileNameInput('a..b'), 'illegal characters');
  assert.equal(validateProfileNameInput('x'.repeat(65)), 'name must be ≤ 64 characters');
});

test('profiles-view: summarizeSwitchPreview 统计口径与导入预览一致', () => {
  const p = preview({
    items: [
      { id: 'settings:a', kind: 'Update', adapter: 'settings', description: '更新设置 a', severity: 'info' },
      { id: 'plugin:b', kind: 'Install', adapter: 'plugins', description: '安装插件 b', severity: 'info' },
      { id: 'settings:c', kind: 'Conflict', adapter: 'settings', description: '冲突 c', severity: 'warning' },
      { id: 'prompt:d', kind: 'Skip', adapter: 'prompts', description: '一致跳过 d', severity: 'info' },
    ],
    missingSecrets: [{ ref: 'KEY', required: true }],
    needsRestart: true,
  });
  const s = summarizeSwitchPreview(p);
  assert.equal(s.willChange, 3, 'Update+Install+Conflict 计为将变更');
  assert.equal(s.unchanged, 1);
  assert.equal(s.conflicts, 1);
  assert.equal(s.secretsNeeded, 1);
  assert.equal(s.needsRestart, true);
  assert.deepEqual(s.sectionsInProfile, ['settings', 'plugins']);
});

test('profiles-view: profileSwitchKind 语义', () => {
  assert.equal(profileSwitchKind(null), 'ok');
  assert.equal(profileSwitchKind(result()), 'ok');
  assert.equal(profileSwitchKind(result({ ok: false, rollback: null })), 'failed');
  assert.equal(
    profileSwitchKind(result({ ok: false, rollback: { full: true, restored: [], failed: [] } })),
    'rolledBack',
  );
});