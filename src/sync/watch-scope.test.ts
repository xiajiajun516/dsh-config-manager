/**
 * **监听范围**单测（src/sync/watch-scope.ts）。
 *
 * 盯三件事：
 *  1. 路径必须覆盖「承载可同步分区的落盘位置」，且一律 posix 相对 $DSH_HOME；
 *  2. 绝**不**监听会话日志 / 同步工作副本 / 自身状态文件（自激循环 + 铁律冲突）；
 *  3. 噪声判据只吞依赖树、.git 与原子写临时文件 —— 误吞会让真实改动漏同步。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  WATCH_IGNORED_SEGMENTS,
  buildWatchTargets,
  isNoiseRelPath,
  targetAbsPath,
  toHomeRelPath,
} from './watch-scope.ts';

const HOME = path.join(path.sep, 'home', 'u', '.dsh');

test('buildWatchTargets：默认 profile=web，覆盖全部分区的落盘位置（posix 相对路径）', () => {
  const targets = buildWatchTargets({ homeDir: HOME });
  const rels = targets.map((t) => t.relPath);
  for (const rel of rels) {
    assert.ok(!rel.startsWith('/'), rel + ' 必须是 home 相对路径');
    assert.ok(!rel.includes('\\'), rel + ' 必须用 posix 分隔符');
    assert.ok(!rel.startsWith('./'), rel + ' 不得带 ./ 前缀');
  }
  // 关键落盘点逐条钉住（漏一个 = 那类改动永远要等定时器）
  for (const expected of [
    'settings.yaml',
    'cordis.patch.yml',
    'AGENTS.md',
    'profiles/web/cordis.patch.yml',
    'profiles/web/pnpm-workspace.yaml',
    'profiles/web/package.json',
    'profiles/web/patches',
    'skills',
    '.agent-presets',
    'dsh-config-manager/sync/sync-config.json',
    'dsh-config-manager/sync/sync-selection.json',
    'dsh-config-manager/sync/ui-prefs.json',
    'dsh-config-manager/market/market-config.json',
    'dsh-config-manager/exports/.backup-notes.json',
  ]) {
    assert.ok(rels.includes(expected), '缺监听目标：' + expected);
  }
  // 分区可见性：诊断要能说出「这条路径为什么被监听」
  for (const t of targets) assert.ok(t.sections.length > 0, t.relPath + ' 必须声明承载的分区');
  const covered = new Set(targets.flatMap((t) => [...t.sections]));
  for (const id of ['settings', 'providers', 'ui', 'prompts', 'mcp', 'plugins', 'skills', 'agentPresets', 'agentInstructions', 'self']) {
    assert.ok(covered.has(id as never), '分区 ' + id + ' 没有任何监听路径');
  }
  // 目录目标才递归，文件目标恒 false（Windows 上递归 fs.watch 更贵）
  for (const t of targets) {
    if (t.kind === 'file') assert.equal(t.recursive, false, t.relPath + ' 文件目标不得设递归');
  }
});

test('buildWatchTargets：profile 决定 profile 层路径；空串回落 web', () => {
  const desktop = buildWatchTargets({ homeDir: HOME, profile: 'desktop' }).map((t) => t.relPath);
  assert.ok(desktop.includes('profiles/desktop/cordis.patch.yml'));
  assert.ok(!desktop.includes('profiles/web/cordis.patch.yml'), '不得同时监听别的 profile');
  const empty = buildWatchTargets({ homeDir: HOME, profile: '' }).map((t) => t.relPath);
  assert.ok(empty.includes('profiles/web/cordis.patch.yml'), '空 profile 回落 web（与 core/backup.ts 同口径）');
});

test('buildWatchTargets：绝不监听 sessions / 工作副本 / 自身状态（自激循环与铁律）', () => {
  const rels = buildWatchTargets({ homeDir: HOME }).map((t) => t.relPath);
  assert.ok(!rels.includes(''), '绝不监听 home 根本身（会递归吃到 sessions/ 与 node_modules）');
  assert.ok(!rels.some((r) => r === '.' || r === './'), '绝不监听 home 根本身');
  assert.ok(!rels.some((r) => r.split('/').includes('sessions')), '会话日志可能几 GB，必须等定时器');
  assert.ok(!rels.includes('profiles'), '绝不递归 profiles/（含整棵 pnpm 依赖树）');
  // 调度器每轮都改写这些文件 → 监听即自激
  for (const selfState of [
    'dsh-config-manager/sync/sync-state.json',
    'dsh-config-manager/sync/sync-history.json',
    'dsh-config-manager/sync/sync-autosync.json',
    'dsh-config-manager/sync/backup-schedule.json',
  ]) {
    assert.ok(!rels.includes(selfState), '绝不要监听自身状态文件：' + selfState);
  }
});

test('toHomeRelPath：home 内给 posix 相对路径，home 外与交叉盘给 null', () => {
  assert.equal(toHomeRelPath(HOME, path.join(HOME, 'skills', 'a', 'SKILL.md')), 'skills/a/SKILL.md');
  assert.equal(toHomeRelPath(HOME, path.join(HOME, 'settings.yaml')), 'settings.yaml');
  assert.equal(toHomeRelPath(HOME, HOME), null, 'home 自身没有相对路径');
  assert.equal(toHomeRelPath(HOME, path.join(HOME, '..', 'other', 'x.json')), null, 'home 外一律 null');
});

test('isNoiseRelPath：只吞依赖树 / .git / 原子写临时文件（宁可多跑一轮，绝不误吞真实改动）', () => {
  for (const noise of [
    '',
    'node_modules/pkg/index.js',
    'profiles/web/node_modules/.bin/x',
    'skills/.git/HEAD',
    'settings.yaml.tmp-1234-0',
    'dsh-config-manager/sync/sync-config.json.tmp-9-1',
  ]) {
    assert.equal(isNoiseRelPath(noise), true, noise + ' 应视为噪声');
  }
  for (const real of [
    'settings.yaml',
    'AGENTS.md',
    'skills/nodejs-testing/SKILL.md',
    'profiles/web/patches/fix.patch',
    'dsh-config-manager/sync/sync-config.json',
    '.agent-presets/reviewer.json',
  ]) {
    assert.equal(isNoiseRelPath(real), false, real + ' 是真实改动，不得过滤');
  }
  assert.deepEqual([...WATCH_IGNORED_SEGMENTS], ['node_modules', '.git']);
});

test('targetAbsPath：home + posix 相对路径还原成本机绝对路径', () => {
  const target = buildWatchTargets({ homeDir: HOME }).find((t) => t.relPath === 'profiles/web/patches');
  assert.ok(target !== undefined);
  assert.equal(targetAbsPath(HOME, target!), path.join(HOME, 'profiles', 'web', 'patches'));
});
