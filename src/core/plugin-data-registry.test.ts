/**
 * pluginData / pluginAssets 来源注册表的纯函数单测（零 I/O）。
 *
 * 这里钉的是「收录口径」的四条硬性质：
 *  ① 区域归属（角色 → 分区）与内置来源的取证标签；
 *  ② 最长前缀归属 —— 大资产不能被短前缀的配置区域吞掉；
 *  ③ 排除与安全（cache 不进包；非法 home 相对路径一律拒绝）；
 *  ④ 自述声明（dsh.dataDirs）的形状解析：不认识就整条丢弃，绝不猜。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_PLUGIN_DATA_SOURCES, areaOfPath, areasForSection, isExcludedRel, normalizeHomeRel,
  parseDeclaredDataDirs, relInArea, sectionOfRole,
} from './plugin-data-registry.ts';
import type { PluginDataArea, PluginDataSource } from './plugin-data-registry.ts';

/** 区域条目（与 adapter 的 PluginDataEntry 同形；core 测试不反向依赖 adapters 层） */
type AreaEntry = { source: PluginDataSource; area: PluginDataArea };

const ALL: AreaEntry[] = [];
for (const source of BUILTIN_PLUGIN_DATA_SOURCES) {
  for (const area of source.areas) ALL.push({ source, area });
}

test('全局唯一来源：id 不重复，且每个来源都如实标注取证强度', () => {
  const ids = BUILTIN_PLUGIN_DATA_SOURCES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of BUILTIN_PLUGIN_DATA_SOURCES) {
    assert.ok(['measured', 'fixture', 'documented'].includes(s.evidence), s.id);
    assert.ok(s.areas.length > 0, s.id);
  }
  // 本机实测的两个来源必须真有 measured 证据（其余是文档取证，不得美化）
  assert.equal(BUILTIN_PLUGIN_DATA_SOURCES.find((s) => s.id === 'mnemon')?.evidence, 'measured');
});

test('角色 → 分区：config 进 pluginData，assets 进 pluginAssets，cache 两个都不进', () => {
  assert.equal(sectionOfRole('config'), 'pluginData');
  assert.equal(sectionOfRole('assets'), 'pluginAssets');
  assert.equal(sectionOfRole('cache'), null);

  const config = areasForSection(BUILTIN_PLUGIN_DATA_SOURCES, 'pluginData').map((e) => e.area.relPath);
  const assets = areasForSection(BUILTIN_PLUGIN_DATA_SOURCES, 'pluginAssets').map((e) => e.area.relPath);
  assert.ok(config.includes('.dsh-wallpaper-engine'));
  assert.ok(config.includes('.mnemon/runtime'));
  assert.ok(!config.includes('.dsh-wallpaper-engine/uploads'), '大资产不得出现在配置分区');
  assert.ok(assets.includes('.dsh-wallpaper-engine/uploads'));
  assert.ok(assets.includes('.mnemon/data'));
  assert.ok(![...config, ...assets].includes('.dsh-wallpaper-engine/cache'), '缓存永不进任何分区');
});

test('最长前缀归属：uploads 下的文件归 uploads 区域，不是它祖先的配置区域', () => {
  const hit = areaOfPath(ALL, '.dsh-wallpaper-engine/uploads/a.mp4');
  assert.equal(hit?.area.relPath, '.dsh-wallpaper-engine/uploads');
  assert.equal(hit?.area.role, 'assets');

  // 配置分区视角：upload 路径被祖先区域的 excludeRel 挡住 → 判 null（导入侧据此拒绝写）
  const configOnly = areasForSection(BUILTIN_PLUGIN_DATA_SOURCES, 'pluginData');
  assert.equal(areaOfPath(configOnly, '.dsh-wallpaper-engine/uploads/a.mp4'), null);
  assert.equal(areaOfPath(configOnly, '.dsh-wallpaper-engine/config.json')?.area.relPath, '.dsh-wallpaper-engine');
});

test('relInArea / isExcludedRel：文件区域精确匹配，目录区域前缀匹配', () => {
  const fileArea = { relPath: '.x/state.json', role: 'config' as const };
  assert.equal(relInArea(fileArea, '.x/state.json'), true);
  assert.equal(relInArea(fileArea, '.x/state.json.bak'), false);

  const dirArea = { relPath: '.x', role: 'config' as const, excludeRel: ['cache'] };
  assert.equal(relInArea(dirArea, '.x/a/b'), true);
  assert.equal(isExcludedRel(dirArea, '.x/cache'), true);
  assert.equal(isExcludedRel(dirArea, '.x/cache/deep/b'), true);
  assert.equal(isExcludedRel(dirArea, '.x/cacheX'), false, '前缀必须是完整路径段');
  assert.equal(isExcludedRel(dirArea, '.x/a'), false);
});

test('normalizeHomeRel：拒绝一切可能越界的写法，反斜杠归一为 POSIX', () => {
  assert.equal(normalizeHomeRel('.a/b'), '.a/b');
  assert.equal(normalizeHomeRel('.a\\b'), '.a/b');
  assert.equal(normalizeHomeRel('  .a/b  '), '.a/b');

  for (const bad of ['', '  ', '/abs/x', 'C:/x', 'a/../b', '..', './a', 'a/', 'a//b', 'a/\u0000b', 42, null, undefined]) {
    assert.equal(normalizeHomeRel(bad), null, JSON.stringify(bad));
  }
});

test('parseDeclaredDataDirs：合法声明解析成来源；形状不认识整条丢弃（不猜）', () => {
  const source = parseDeclaredDataDirs('dsh-fake', {
    dsh: { dataDirs: [
      { path: '.fake-plugin', role: 'config', env: ['FAKE_DATA_DIR'] },
      { path: '.fake-plugin/uploads', role: 'assets', exclude: ['tmp'] },
    ] },
  });
  assert.ok(source);
  assert.equal(source?.id, 'declared:dsh-fake');
  assert.deepEqual(source?.packages, ['dsh-fake']);
  assert.equal(source?.areas.length, 2);
  assert.deepEqual(source?.areas[0]?.envOverrides, ['FAKE_DATA_DIR']);
  assert.deepEqual(source?.areas[1]?.excludeRel, ['tmp']);
  assert.equal(source?.areas[1]?.role, 'assets');

  // 缺省角色 = config
  assert.equal(parseDeclaredDataDirs('p', { dsh: { dataDirs: [{ path: '.p' }] } })?.areas[0]?.role, 'config');

  // 整条丢弃的形态
  assert.equal(parseDeclaredDataDirs('p', null), null);
  assert.equal(parseDeclaredDataDirs('p', {}), null);
  assert.equal(parseDeclaredDataDirs('p', { dsh: {} }), null);
  assert.equal(parseDeclaredDataDirs('p', { dsh: { dataDirs: [] } }), null);
  assert.equal(parseDeclaredDataDirs('p', { dsh: { dataDirs: 'nope' } }), null);
  assert.equal(parseDeclaredDataDirs('p', { dsh: { dataDirs: [{ path: '/abs' }] } }), null, '绝对路径 → 整条丢弃');
  assert.equal(parseDeclaredDataDirs('p', { dsh: { dataDirs: [{ path: '.ok' }, { path: '../escape' }] } }), null, '任一非法 → 整条丢弃');
});
