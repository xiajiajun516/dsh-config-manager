/**
 * skills 分区：bundled 技能不参与备份（issue #102 回归测试）。
 *
 * 真机现象：导出把插件 registerProvider 注册、`source === 'bundled'` 的技能也写成
 * `<name>/SKILL.md`，但技能服务只暴露 SKILL.md 文本，脚本/资源拿不到 ⇒ 备份是**残缺影子**；
 * 导入后影子落在 `$DSH_HOME/skills` 与插件自带的同名技能争生效顺序，且不随插件升级更新。
 *
 * 三条硬约束（本文件钉住）：
 *  ① 导出：service 侧 `source === 'bundled'` 不进行，其它来源照旧；
 *  ② 导入：旧备份里的 bundled 技能在**计划阶段**降级为 Skip（不写盘、无可执行 target）；
 *  ③ 判不出（旧宿主没有 source / 服务抛错）时按旧行为放行 —— 绝不少导入用户真正的技能。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillsAdapter, isMigratableSkillSource } from './skills.ts';
import { makeContext, makeImportContext, sha256Hex } from './test-helpers.ts';
import type { MockHostContext } from './test-helpers.ts';
import type { FileEntry, FilesSection } from '../schema/types.ts';
import type { SkillDefinitionView, SkillSummaryView } from '../core/types.ts';

const HOME = '/home/me';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 注入技能服务端口：summary 列表 + 按名取定义（get 缺省返回正文可用的定义）。 */
function withSkills(
  ctx: MockHostContext,
  summaries: SkillSummaryView[],
  get?: (name: string) => Promise<SkillDefinitionView | undefined>,
): MockHostContext {
  ctx.skills = {
    list: async () => summaries,
    get: get ?? (async (name: string) => {
      const summary = summaries.find((s) => s.name === name);
      return summary === undefined ? undefined : { ...summary, content: `body of ${name}` };
    }),
  };
  return ctx;
}

function fileEntry(relativePath: string, text: string): FileEntry {
  const data = bytes(text);
  return { relativePath, data, contentHash: sha256Hex(data) };
}

function skillsSection(files: FileEntry[]): FilesSection {
  return { version: 1, files };
}

/* ------------------------------------------------------------ 判据 */

test('isMigratableSkillSource：只有 bundled 不可迁移；undefined（旧宿主）必须放行', () => {
  assert.equal(isMigratableSkillSource('bundled'), false);
  assert.equal(isMigratableSkillSource(undefined), true, '旧宿主不报来源 —— 判成不可迁移会让技能分区恒空');
  assert.equal(isMigratableSkillSource('user-dsh'), true);
  assert.equal(isMigratableSkillSource('custom'), true);
  assert.equal(isMigratableSkillSource('project-dsh'), true);
});

/* ------------------------------------------------------ 导出侧（①） */

test('导出：service 侧 bundled 技能不进备份，其它来源与磁盘技能照旧（issue #102）', async () => {
  const ctx = makeContext('win32', HOME);
  await ctx.fs.writeFile('skills/disk-a/SKILL.md', bytes('---\nname: disk-a\ndescription: d\n---\n\nbody'));

  withSkills(ctx, [
    { name: 'disk-a', description: 'on disk source wins', source: 'user-dsh' },
    { name: 'legit-custom', description: 'custom dir skill', source: 'custom' },
    { name: 'diagnose-windows-sandbox-acl', description: 'bundled by a plugin', source: 'bundled' },
  ]);

  const exported = await new SkillsAdapter().export(ctx, { includeSecrets: false });
  const rels = exported.data.files.map((f) => f.relativePath).sort();

  assert.deepEqual(rels, ['disk-a/SKILL.md', 'legit-custom/SKILL.md'], 'bundled 技能必须被排除，其余两路照旧');
  assert.ok(rels.every((r) => !r.startsWith('diagnose-windows-sandbox-acl')), 'bundled 技能不得写出任何影子文件');
});

test('导出：service 不报 source（旧宿主形态）时照旧收录，不因判据丢技能', async () => {
  const ctx = makeContext('win32', HOME);
  withSkills(ctx, [{ name: 'legacy-skill', description: 'no source field' }]);

  const exported = await new SkillsAdapter().export(ctx, { includeSecrets: false });
  assert.deepEqual(exported.data.files.map((f) => f.relativePath), ['legacy-skill/SKILL.md']);
});

/* ------------------------------------------------------ 导入侧（②③） */

test('导入：旧备份里的 bundled 技能降级为 Skip（无可执行 target），用户技能照常 Create', async () => {
  const dst = makeContext('win32', HOME);
  withSkills(dst, [
    { name: 'diagnose-windows-sandbox-acl', description: 'bundled by a plugin', source: 'bundled' },
  ]);
  const section = skillsSection([
    fileEntry('diagnose-windows-sandbox-acl/SKILL.md', '---\nname: diagnose-windows-sandbox-acl\n---\n\nbody'),
    fileEntry('my-own-skill/SKILL.md', '---\nname: my-own-skill\n---\n\nbody'),
  ]);
  const sections = new Map<string, unknown>([['skills', section]]);
  const adapter = new SkillsAdapter();

  const items = await adapter.analyzeImport(section, makeImportContext(dst, sections));
  const bundled = items.find((i) => i.target?.ref === 'diagnose-windows-sandbox-acl/SKILL.md' || i.id.includes('diagnose'));
  assert.ok(bundled !== undefined);
  assert.equal(bundled.kind, 'Skip', 'bundled 技能在计划阶段就跳过（不写盘）');
  assert.equal(bundled.target, undefined, '不得留下可执行的写入 target');
  assert.equal(bundled.severity, 'info');
  assert.match(bundled.description, /bundled/, '说明必须点名原因（插件内置提供、副本不完整）');

  const own = items.find((i) => i.id.includes('my-own-skill'));
  assert.ok(own !== undefined);
  assert.equal(own.kind, 'Create', '用户自己的技能仍需正常导入');
  assert.equal(own.target?.ref, 'my-own-skill/SKILL.md');
});

test('导入：技能服务列举失败时原样放行（不因判不出而少导技能）', async () => {
  const dst = makeContext('win32', HOME);
  dst.skills = {
    list: async () => { throw new Error('skill service down'); },
    get: async () => undefined,
  };
  const section = skillsSection([fileEntry('diagnose-windows-sandbox-acl/SKILL.md', 'x')]);
  const sections = new Map<string, unknown>([['skills', section]]);

  const items = await new SkillsAdapter().analyzeImport(section, makeImportContext(dst, sections));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'Create', '服务不可用 ⇒ 退回旧行为（该写就写），绝不静默丢弃');
  assert.equal(items[0]?.target?.ref, 'diagnose-windows-sandbox-acl/SKILL.md');
});

test('导入：目标机无技能服务（旧宿主）时行为与改造前一致', async () => {
  const dst = makeContext('win32', HOME);
  const section = skillsSection([fileEntry('some-skill/SKILL.md', 'x')]);
  const sections = new Map<string, unknown>([['skills', section]]);

  const items = await new SkillsAdapter().analyzeImport(section, makeImportContext(dst, sections));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'Create');
});
