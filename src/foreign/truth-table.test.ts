/**
 * 真值表护栏（design doc §8.2 与 truth-table.ts 文件头都声称有「truth-table.test.ts」做
 * 「真值表 ↔ 各来源 probePaths 逐平台交叉核对」——审计发现**这个文件此前并不存在**，
 * 6 个配置类来源的 probePaths 因此没有任何交叉核对。本文件补齐它。
 *
 * 三条断言（都是源码级真值，不读真机 home）：
 *  ① 真值表与来源词表**同序同集合**（顺序 = UI/CLI 列表顺序的事实源）；
 *  ② 配置类来源的 probePaths 必须逐条等于真值表条目按平台展开的结果（未识别令牌原样保留 ⇒ 立刻红）；
 *  ③ 来源的 evidence 必须逐条等于真值表里的 evidence（**不得在来源定义里自己填更好看的一档**）。
 *
 * 会话类 24 个来源的 probePaths 由各自 wiring 提供（session-source.ts 装配），
 * 本文件只核对它们的真值表条目存在且取证强度一致。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { builtinForeignSources, FOREIGN_SOURCE_IDS } from './registry.ts';
import { FOREIGN_SOURCE_IDS_FROM_SHAPES } from './source-modules.ts';
import { FOREIGN_TRUTH_TABLES, expandTruthList, TRUTH_PROBES } from './truth-table.ts';
import type { ForeignPlatform } from './platform-paths.ts';

const PLATFORMS: readonly ForeignPlatform[] = ['win32', 'darwin', 'linux'];

/** 配置类来源（其余 24 个是会话类，probePaths 由各自 wiring 提供） */
const CONFIG_CLASS: ReadonlySet<string> = new Set([
  'claude-code', 'hermes', 'cursor', 'codex', 'copilot', 'antigravity',
]);

test('V1 真值表与来源词表同序同集合（不得漂移）', () => {
  const tableIds = FOREIGN_TRUTH_TABLES.map((e) => e.id);
  assert.equal(new Set(tableIds).size, tableIds.length, '真值表 id 必须唯一');
  assert.deepEqual(tableIds, [...FOREIGN_SOURCE_IDS], '真值表顺序必须等于来源词表顺序');
  assert.deepEqual(tableIds, [...FOREIGN_SOURCE_IDS_FROM_SHAPES], '真值表顺序必须等于形状表顺序');
});

test('V2 每个条目三平台都有非空默认位置，且没有未展开令牌', () => {
  for (const entry of FOREIGN_TRUTH_TABLES) {
    for (const p of PLATFORMS) {
      const list = entry.defaults[p];
      assert.ok(Array.isArray(list), entry.id + ' ' + p + ' 默认位置不是数组');
      // autoRoots:false = 该来源**没有**自动根（如 chatgpt 只能由用户显式给路径）——空表是刻意的
      if (entry.autoRoots) {
        assert.ok(list.length > 0, entry.id + ' ' + p + ' 声明有自动根却没有任何默认位置');
      }
      for (const expanded of expandTruthList(p, list)) {
        assert.ok(!expanded.includes('<'), entry.id + ' ' + p + ' 存在未展开令牌：' + expanded);
      }
    }
    assert.equal(typeof entry.autoRoots, 'boolean', entry.id + ' autoRoots 必须是布尔');
    assert.ok(entry.refs.length > 0, entry.id + ' refs 必须写明依据');
  }
});

test('V3 配置类来源 probePaths 必须逐条等于真值表展开结果', () => {
  const sources = builtinForeignSources().filter((s) => CONFIG_CLASS.has(s.id));
  assert.equal(sources.length, CONFIG_CLASS.size, '配置类来源个数与常量表不一致');
  for (const source of sources) {
    const entry = FOREIGN_TRUTH_TABLES.find((e) => e.id === source.id);
    assert.ok(entry !== undefined, source.id + ' 缺真值表条目');
    for (const p of PLATFORMS) {
      const probe = TRUTH_PROBES[p];
      const actual = source.probePaths({ homeDir: probe.homeDir, env: {}, platform: p });
      assert.deepEqual([...actual], expandTruthList(p, entry.defaults[p]), source.id + ' ' + p + ' probePaths 与真值表不一致');
    }
  }
});

test('V4 来源的 evidence 必须逐条等于真值表（不得美化取证强度）', () => {
  for (const source of builtinForeignSources()) {
    const entry = FOREIGN_TRUTH_TABLES.find((e) => e.id === source.id);
    assert.ok(entry !== undefined, source.id + ' 缺真值表条目');
    assert.equal(source.evidence, entry.evidence, source.id + ' evidence 与真值表不一致');
  }
});

test('V5 CLAUDE_CONFIG_DIR 是 claude-code 的真值表 envKeys（文档取证必须落到数据里）', () => {
  const entry = FOREIGN_TRUTH_TABLES.find((e) => e.id === 'claude-code');
  assert.ok(entry !== undefined);
  const keys = (entry.envKeys ?? []).map((k) => k.key);
  assert.ok(keys.includes('CLAUDE_CONFIG_DIR'), 'claude-code 必须登记 CLAUDE_CONFIG_DIR');
});
