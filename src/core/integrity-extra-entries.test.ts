/**
 * SEC-05 回归：校验表只做「正向」校验 —— 表里登记的逐条比对，**表外的归档条目没人管**。
 * 文件类分区又是按归档名原样落盘的，于是「ZIP 有、checksums 没登记」的文件照样被写进目标目录，
 * 完整性声明形同虚设（审计 docs/archive/2026-11-01-technical-audit.md SEC-05）。
 *
 * 修后口径：
 *  - 会落盘的文件分区条目（Create/Update/Conflict）若不在 checksums 表内 ⇒ 计划项升级为 Error（逐条零写入），
 *    整包仍 valid（表外 ≠ 被篡改，只留一条 warning）；
 *  - 校验表**缺失或为空** ⇒ 一个条目都没被校验，文件分区条目同样逐条拦（RV1-F1，否则删表即绕过）；
 *  - 历史包兼容开关 extraEntryExemptSections（默认空）按分区豁免，豁免分区退回「只告警」旧行为；
 *  - 「不在任何文件分区前缀下」的散落条目仍是告警（守 tests/conformance/roundtrip.test.ts INT-01）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Analyzer } from './analyzer.ts';
import { Importer } from './importer.ts';
import { createAdapters } from '../adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import { writeZip } from '../utils/zip.ts';
import { buildManifest } from '../schema/manifest.ts';
import { buildChecksums } from '../utils/hashing.ts';
import { SECTION_IDS, SECTION_FILE_PREFIXES, SECTION_JSON_PATHS } from '../schema/config.ts';
import { UNVERIFIED_FILE_ENTRY_CODE } from '../security/integrity.ts';
import type { SectionId } from '../schema/types.ts';
import type { HostContext } from './types.ts';

const SETTINGS = JSON.stringify({
  version: 1,
  namespaces: { llm: { value: { model: 'deepseek-chat' }, revision: 1, secrets: [] } },
});
const DECISIONS = { strategy: 'merge' as const, resolutions: {}, pathMappings: [] };
/** skills 分区在 ZIP 内的真实前缀（custom/skills/），从注册表派生，不写死布局。 */
const SKILL_PREFIX = SECTION_FILE_PREFIXES['skills']!;
const SKILL_REL = 'demo/SKILL.md';
const SKILL_ENTRY = SKILL_PREFIX + SKILL_REL;
/** 不在任何文件分区前缀下的散落条目（INT-01 用）。 */
const ROGUE_ENTRY = 'injected/rogue.json';

/** 造包：settings + skills 声明为包含；unlisted 里的条目进 ZIP 但不进 checksums 表。 */
async function buildBundle(
  opts: { unlisted?: string[]; declareSkills?: boolean; checksums?: 'omit' | 'empty' } = {},
): Promise<{ zipPath: string; tmp: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-sec05-'));
  const flags: Record<string, boolean> = {};
  for (const sid of SECTION_IDS) flags[sid] = false;
  flags['settings'] = true;
  flags['skills'] = opts.declareSkills !== false;
  const manifest = buildManifest({
    exporterVersion: '0.1.0',
    dshVersion: '0.1.54',
    platform: 'win32',
    arch: 'x64',
    sections: flags as Record<SectionId, boolean>,
    containsSecrets: false,
    encrypted: false,
    encryption: null,
  });
  const contentEntries = [
    { name: SECTION_JSON_PATHS['settings']!, data: Buffer.from(SETTINGS, 'utf8') },
    { name: SKILL_ENTRY, data: Buffer.from('# demo skill', 'utf8') },
    { name: ROGUE_ENTRY, data: Buffer.from('{"rogue":true}', 'utf8') },
  ];
  const unlisted = new Set(opts.unlisted ?? []);
  const checksums = buildChecksums(contentEntries.filter((e) => !unlisted.has(e.name)));
  const entries = [
    ...contentEntries,
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    // RV1-F1：表缺失（'omit'）与表为空（'empty'）都必须逐条 fail-closed —— 两种形态曾被当成「没事」。
    ...(opts.checksums === 'omit'
      ? []
      : [{
        name: 'integrity/checksums.json',
        data: Buffer.from(opts.checksums === 'empty' ? '{}' : JSON.stringify(checksums), 'utf8'),
      }]),
  ];
  const zipPath = path.join(tmp, 'bundle.zip');
  await writeZip(zipPath, entries);
  return { zipPath, tmp };
}

function mkCtx(): HostContext {
  return makeContext('linux', '/home/bob');
}

function mkAnalyzer(ctx: HostContext, extraEntryExemptSections?: readonly SectionId[]): Analyzer {
  return new Analyzer({
    ctx,
    adapters: createAdapters({ namespaces: ['llm'] }),
    snapshotStore: new MemSnapshotStore(),
    ...(extraEntryExemptSections ? { extraEntryExemptSections } : {}),
  });
}

function mkImporter(ctx: HostContext): Importer {
  return new Importer({ ctx, adapters: createAdapters({ namespaces: ['llm'] }), snapshotStore: new MemSnapshotStore() });
}

test('SEC-05/① 对照：文件分区条目全量登记 → 不阻断，计划项照常 Create', async () => {
  const { zipPath } = await buildBundle();
  const ctx = mkCtx();
  const importer = mkImporter(ctx);
  const analysis = await importer.analyzeImport(zipPath);
  assert.equal(analysis.valid, true, '全量登记不应阻断');
  assert.deepEqual(analysis.errors, []);
  const plan = await importer.createImportPlan(zipPath, DECISIONS);
  const item = plan.items.find((i) => i.adapter === 'skills' && i.target?.ref === SKILL_REL);
  assert.ok(item, 'skills 分区应有 SKILL.md 计划项');
  assert.equal(item!.kind, 'Create');
});

test('SEC-05/② 表外文件分区条目 → 计划项 Error（零写入），analysis 只留一条 warning', async () => {
  const { zipPath } = await buildBundle({ unlisted: [SKILL_ENTRY] });
  const ctx = mkCtx();
  const importer = mkImporter(ctx);
  const analysis = await importer.analyzeImport(zipPath);
  // 表外 ≠ 被篡改：逐条 Error 已保证零写入，把整包判死只会拒绝整笔合法导入（含一个多余文件的历史包），
  // 却没多拦住任何一次写盘 ⇒ valid 保持 true，错误面只留一条 warning 点名该条目。
  assert.equal(analysis.valid, true, '表外条目不得把整包判死');
  assert.deepEqual(analysis.errors, [], '表外条目不进 errors（不阻断整体导入）');
  const named = analysis.warnings.some((w) => w.includes(SKILL_REL) || w.includes(SKILL_ENTRY));
  assert.ok(named, 'warnings 必须点名该条目，实际: ' + JSON.stringify(analysis.warnings));
  const plan = await importer.createImportPlan(zipPath, DECISIONS);
  const item = plan.items.find((i) => i.adapter === 'skills' && i.target?.ref === SKILL_REL);
  assert.ok(item, '被阻断条目仍要出现在计划里（用户能看到为什么没导）');
  assert.equal(item!.kind, 'Error');
  assert.equal(item!.severity, 'error');
  assert.ok(item!.detail?.includes(UNVERIFIED_FILE_ENTRY_CODE), 'detail 应带错误码，实际: ' + String(item!.detail));
});

test('SEC-05/③ 按分区豁免 → 退回只告警（历史包兼容开关，默认关）', async () => {
  const { zipPath } = await buildBundle({ unlisted: [SKILL_ENTRY] });
  const ctx = mkCtx();
  const analyzer = mkAnalyzer(ctx, ['skills']);
  const analysis = await analyzer.analyzeImport(zipPath);
  assert.equal(analysis.valid, true, '豁免分区不得阻断');
  assert.ok(analysis.warnings.some((w) => w.includes(SKILL_ENTRY)), '豁免也要留告警，不能静默放行');
  const plan = await analyzer.createImportPlan(zipPath, DECISIONS);
  const item = plan.items.find((i) => i.adapter === 'skills' && i.target?.ref === SKILL_REL);
  assert.equal(item!.kind, 'Create', '豁免分区应照常落盘');
});

test('SEC-05/④ 非文件分区的散落条目仍只告警（守 INT-01 口径）', async () => {
  const { zipPath } = await buildBundle({ unlisted: [ROGUE_ENTRY] });
  const ctx = mkCtx();
  const analysis = await mkImporter(ctx).analyzeImport(zipPath);
  assert.equal(analysis.valid, true, '散落条目不阻断');
  assert.deepEqual(analysis.errors, []);
  assert.ok(analysis.warnings.some((w) => w.includes(ROGUE_ENTRY)), '散落条目必须有告警（不得静默忽略）');
});

test('SEC-05/⑤ 执行被阻断的计划 → 表外文件零落盘', async () => {
  const { zipPath } = await buildBundle({ unlisted: [SKILL_ENTRY] });
  const ctx = mkCtx();
  const importer = mkImporter(ctx);
  const plan = await importer.createImportPlan(zipPath, DECISIONS);
  const skillItem = plan.items.find((i) => i.adapter === 'skills' && i.target?.ref === SKILL_REL);
  assert.ok(skillItem, '被阻断条目应在计划里');
  const result = await importer.executeImportPlan(zipPath, plan, { confirm: true });
  const blocked = result.executed.find((e) => e.itemId === skillItem!.id);
  assert.equal(blocked?.status, 'failed', '被阻断项执行结果必须是 failed');
  assert.equal(await ctx.fs.exists(SKILL_ENTRY), false, '表外条目绝不能被写进目标');
});

/* ─── RV1-F1：表缺失 / 表为空 ⇒ 逐条 fail-closed（删掉表就等于关掉 SEC-05 的那个绕过） ─── */

async function expectFailClosed(mode: 'omit' | 'empty'): Promise<void> {
  const { zipPath } = await buildBundle({ checksums: mode });
  const ctx = mkCtx();
  const importer = mkImporter(ctx);
  const analysis = await importer.analyzeImport(zipPath);
  // 逐条 fail-closed，不是整包拒：settings 这类非文件分区照常可导，判死的只是完整性管不到的文件分区条目。
  assert.equal(analysis.valid, true, '表缺失/为空不得把整包判死（旧包仍要能用）');
  assert.deepEqual(analysis.errors, []);
  assert.ok(
    analysis.warnings.some((w) => w.includes(SKILL_ENTRY)),
    '没有校验表时，文件分区条目必须被点名（静默放行 = 防线失效），实际: ' + JSON.stringify(analysis.warnings),
  );

  const plan = await importer.createImportPlan(zipPath, DECISIONS);
  const skillItem = plan.items.find((i) => i.adapter === 'skills' && i.target?.ref === SKILL_REL);
  assert.ok(skillItem, '文件分区条目应在计划里');
  assert.equal(skillItem!.kind, 'Error', '没有校验表 ⇒ 文件分区条目一律未覆盖 ⇒ 必须拦');
  assert.ok(String(skillItem!.detail ?? '').includes(UNVERIFIED_FILE_ENTRY_CODE), '拦下时必须带错误码');
  assert.ok(
    plan.items.some((i) => i.adapter === 'settings' && i.kind !== 'Error'),
    '非文件分区（settings）不应被连带阻断',
  );

  const result = await importer.executeImportPlan(zipPath, plan, { confirm: true });
  assert.equal(result.executed.find((e) => e.itemId === skillItem!.id)?.status, 'failed', '被拦项执行结果必须是 failed');
  assert.equal(await ctx.fs.exists(SKILL_ENTRY), false, '没有校验表时，文件条目绝不能被写进目标');
}

test('RV1/F1⑥ 包内缺 integrity/checksums.json → 文件分区条目逐条拦、零写入（删表不能绕过 SEC-05）', async () => {
  await expectFailClosed('omit');
});

test('RV1/F1⑦ 校验表为空 {} → 与缺失同口径（空表 = 一个条目都没校验）', async () => {
  await expectFailClosed('empty');
});

