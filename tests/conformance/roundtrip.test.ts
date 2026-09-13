/**
 * Bundle 格式 v1 —— 一致性 / 往返 / 向前兼容测试（conformance suite）。
 *
 * 目标：把「格式」变成**可被外部实现验证**的东西。
 *   - 基线语料全部由仓库真实 Exporter 产出（不是手写 JSON 假设）；
 *   - 畸形语料 = 基线 bundle 注入未知结构 + **重算 checksums**（见 ./corpus.ts）；
 *   - 引擎走内存 mock（HostContext + ConfigAdapter 门面，`src/adapters/test-helpers.ts`），
 *     **不依赖真实 DSH**，因此任何实现者都能在无 DSH 环境下复用这套语料。
 *
 * 规格依据：`docs/spec/bundle-format-v1.md`（§7 向前兼容规则 / §10 已知缺口）。
 *
 * ── 关于已记录缺口的写法（重要） ────────────────────────────────────────────
 * 本文件对已知缺口一律采用**特征化测试（characterization test）**：
 * 断言「当前真实行为」，并在注释里标注缺口编号（G-01 / G-02 / G-06）与
 * 「这是已记录的缺口，非期望行为」。
 *   - CI 保持绿：测试钉住的是当下事实，不是理想；
 *   - 缺口被永久记录：谁改坏了现状会红灯；
 *   - 一旦有人修好缺口（例如未知分区不再算 missingSections），本文件会红灯，
 *     提醒维护者**更新特征化断言**并同步 `docs/spec/bundle-format-v1.md` 的缺口表。
 * 绝不写成「永久红灯」的失败测试，也绝不把实现缺陷当作期望行为写进断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Exporter } from '../../src/core/exporter.ts';
import { Importer } from '../../src/core/importer.ts';
import { createAdapters } from '../../src/adapters/index.ts';
import { makeContext, MemSnapshotStore, type MockHostContext } from '../../src/adapters/test-helpers.ts';
import { parseZip, writeZip } from '../../src/utils/zip.ts';
import { sha256Hex, buildChecksums } from '../../src/utils/hashing.ts';
import { CHECKSUMS_FILE, MANIFEST_FILE, parseManifest } from '../../src/schema/manifest.ts';
import { decryptCredentials, createEncryptionProvider, SecurityError } from '../../src/security/encryption.ts';
import { isTooNew, describeVersion } from '../../src/schema/versions.ts';
import { runSchemaMigration } from '../../src/core/analyzer.ts';
import { zhMsg } from '../../src/core/messages.ts';
import { rebuildBundle, listEntries, readEntryText } from './corpus.ts';
import type { SectionId } from '../../src/schema/types.ts';

/* ─────────────────────────── 语料常量 ─────────────────────────── */

/** 语料覆盖的分区（小而可读：namespace 类 + patch 类 + 文件类 + 凭据状态各一） */
const FIXTURE_SECTIONS: SectionId[] = [
  'settings', 'ui', 'providers', 'prompts', 'skills', 'agentPresets', 'credentialsStatus',
];

/** 传给 createAdapters 的 namespace 清单（provider namespace 必须在内） */
const NS = ['general', 'theme', 'llm-deepseek'];

/** 合成密码与合成凭据（**绝无真实凭据**；仅用于验证加密往返链路） */
const TEST_PASSWORD = 'conformance-password-123';
const FIXTURE_CREDENTIAL_VALUE = 'sk-conformance-fixture-value';
const CREDENTIALS_YAML = `DEEPSEEK_API_KEY: ${FIXTURE_CREDENTIAL_VALUE}\nOTHER_TOKEN: tok-conformance-fixture\n`;

const SKILL_REL = 'conformance/coding.md';
const SKILL_BODY = '# Conformance skill\nSynthetic content only.\n';
const PRESET_REL = 'conformance/agent.cordis.yml';
const PRESET_BODY = 'services:\n  - name: conformance\n';

/** 源机器（合成 home，非真实个人路径） */
const SRC_HOME = 'C:\\Users\\fixture-src';
/** 目标机器（合成 home） */
const DST_HOME = 'C:\\Users\\fixture-dst';

/** 固定导出时间：语料可复现（不依赖运行时时钟） */
const FIXED_NOW = () => new Date('2026-08-14T12:00:00.000Z');

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-conformance-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/* ─────────────────────────── 语料构造 ─────────────────────────── */

/** 种子源配置：7 个分区都有真实内容（namespace / patch 行 / 文件 / 凭据状态） */
async function seedSource(ctx: MockHostContext): Promise<void> {
  ctx.settings.ns.set('general', {
    value: { theme: 'dark', language: 'zh-CN', nested: { keep: [1, 2, 3], text: '你好，世界！' } },
    revision: 3,
    secrets: [],
  });
  // 'theme' 属 UI 类 namespace → 由 ui 分区承载（settings/ui 互斥并集）
  ctx.settings.ns.set('theme', { value: { mode: 'dark', accent: 'blue' }, revision: 1, secrets: [] });
  // apiKey 是敏感字段 → 导出时被 secret 扫描剥离为空串；凭据真值只经 secrets.enc（加密语料用）
  ctx.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: FIXTURE_CREDENTIAL_VALUE },
    revision: 5,
    secrets: [{ path: ['apiKey'], set: true }],
  });
  ctx.credentials.values.set('DEEPSEEK_API_KEY', FIXTURE_CREDENTIAL_VALUE);
  await ctx.fs.writeFile(path.join('skills', SKILL_REL), Buffer.from(SKILL_BODY, 'utf8'));
  await ctx.fs.writeFile(path.join('.agent-presets', PRESET_REL), Buffer.from(PRESET_BODY, 'utf8'));
  ctx.patchFile.lines.set('conformance-persona', {
    lineId: 'conformance-persona',
    raw: {
      id: 'conformance-persona',
      name: 'dsh-config-manager',
      config: { systemPrompt: 'You are a conformance fixture persona.' },
    },
  });
}

/** 真实 Exporter 产出 baseline bundle（语料的唯一来源） */
async function exportBaseline(
  src: MockHostContext,
  outPath: string,
  opts: { encryption?: ReturnType<typeof createEncryptionProvider>; includeSecrets?: boolean } = {},
): Promise<void> {
  await new Exporter({
    ctx: src,
    adapters: createAdapters({ namespaces: NS }),
    exporterVersion: '0.1.0-conformance',
    encryption: opts.encryption,
    now: FIXED_NOW,
  }).export({ includeSecrets: opts.includeSecrets ?? false, only: FIXTURE_SECTIONS, outPath });
}

/** 目标机（干净）：只注册 namespace，不写任何值 → 让导入走 Create 而非 MissingDependency */
function seedCleanTarget(): MockHostContext {
  const dst = makeContext('win32', DST_HOME);
  for (const ns of NS) dst.settings.registered.add(ns);
  return dst;
}

function makeImporter(dst: MockHostContext): Importer {
  return new Importer({
    ctx: dst,
    adapters: createAdapters({ namespaces: NS }),
    snapshotStore: new MemSnapshotStore(),
  });
}

async function exists(dst: MockHostContext, rel: string): Promise<boolean> {
  try {
    await dst.fs.readFile(rel);
    return true;
  } catch {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
 * 1. 明文 v1 往返无损
 * ═══════════════════════════════════════════════════════════════════════ */

test('RT-01 明文 v1 多分区往返：Exporter → ZIP → Importer → 目标数据等价', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    const zipPath = path.join(dir, 'rt01-baseline.zip');
    await exportBaseline(src, zipPath);

    /* ── 导出产物契约（第三方 exporter 必须逐条满足） ── */
    const archive = parseZip(await fs.readFile(zipPath));
    const manifest = parseManifest(archive.readEntryText(MANIFEST_FILE));
    assert.equal(manifest.schemaVersion, 1, '明文 v1 语料的 schemaVersion 必须是 1');
    assert.equal(manifest.security.encrypted, false, '无 encryption provider 时不得标记加密');
    assert.equal(manifest.security.containsSecrets, false, 'includeSecrets=false 时不得声称含秘密');
    assert.equal(manifest.security.encryption, null, '未加密时 encryption 必须是 null');
    for (const id of FIXTURE_SECTIONS) {
      assert.equal(manifest.sections[id], true, `manifest.sections.${id} 必须为 true`);
    }
    // manifest.sections 必须覆盖全部 15 个分区 id，未导出者显式为 false（不得缺键）
    const ALL_SECTIONS: SectionId[] = [
      'settings', 'ui', 'providers', 'plugins', 'mcp', 'prompts', 'skills', 'agentPresets',
      'agentInstructions', 'workspaces', 'pluginFiles', 'credentialsStatus', 'secrets', 'sessions', 'self',
    ];
    assert.deepEqual(Object.keys(manifest.sections).sort(), [...ALL_SECTIONS].sort(), 'manifest.sections 必须覆盖全部 15 个分区 id');
    for (const id of ALL_SECTIONS) {
      if (FIXTURE_SECTIONS.includes(id)) continue;
      assert.equal(manifest.sections[id], false, `未导出的分区 ${id} 必须显式为 false`);
    }
    for (const entry of [
      'config/settings.json', 'config/ui.json', 'ai/providers.json', 'custom/prompts.json',
      `custom/skills/${SKILL_REL}`, `agents/presets/${PRESET_REL}`, 'security/credentials.json',
    ]) {
      assert.ok(archive.has(entry), `ZIP 应包含 ${entry}`);
    }
    assert.ok(!archive.has('security/secrets.enc'), '未注入 encryption provider 时不得生成 secrets.enc');

    // checksums 覆盖「除 manifest / checksums 之外」的全部条目，且逐条可校验
    const checksums = archive.readEntryJson(CHECKSUMS_FILE) as Record<string, string>;
    const dataEntries = archive.names().filter((n) => n !== MANIFEST_FILE && n !== CHECKSUMS_FILE);
    assert.deepEqual(Object.keys(checksums).sort(), [...dataEntries].sort(), 'checksums 表条目集合必须与数据条目完全一致');
    for (const name of dataEntries) {
      assert.equal(sha256Hex(archive.readEntry(name)), checksums[name], `${name} 的 SHA-256 必须匹配 checksums 表`);
    }

    /* ── 导入（Dry Run 零写入 → 执行） ── */
    const dst = seedCleanTarget();
    const importer = makeImporter(dst);
    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.valid, true, `同平台同版本明文包必须 valid=true（errors=${JSON.stringify(analysis.errors)}）`);
    assert.deepEqual(analysis.errors, []);
    assert.deepEqual(analysis.warnings, [], '基线语料不得产生任何告警');
    assert.equal(analysis.encrypted, false);
    assert.equal(analysis.compatibility, 'excellent', '同平台 + 无缺失分区 + schema 支持 → excellent');
    assert.equal(analysis.secretCount, 1, '1 个已配置但未导出值的凭据 → secretCount=1');
    assert.deepEqual([...analysis.sectionsInZip].sort(), [...FIXTURE_SECTIONS].sort(), 'sectionsInZip 必须等于声明且可识别的分区集合');

    // Dry Run 断言：分析阶段零写入
    assert.equal(dst.settings.ns.get('general'), undefined, 'analyzeImport 不得写入目标 namespace');
    assert.equal(await exists(dst, path.join('skills', SKILL_REL)), false, 'analyzeImport 不得写入目标文件');

    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    assert.deepEqual(
      Object.keys(plan.estimatedActions).sort(),
      [...FIXTURE_SECTIONS].sort(),
      '计划必须覆盖全部 7 个分区（每分区至少一项）',
    );
    assert.ok(plan.missingSecrets.some((s) => s.ref === 'DEEPSEEK_API_KEY'), '未导出值的已配置凭据必须进入 missingSecrets');

    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.executed.filter((e) => e.status === 'failed'), [], '不得有失败项');

    /* ── 数据等价断言（往返核心） ── */
    // settings：namespace 值逐字段等价（含嵌套对象 / Unicode）
    assert.deepEqual(dst.settings.ns.get('general')?.value, {
      theme: 'dark', language: 'zh-CN', nested: { keep: [1, 2, 3], text: '你好，世界！' },
    });
    // ui：UI 类 namespace 独立往返
    assert.deepEqual(dst.settings.ns.get('theme')?.value, { mode: 'dark', accent: 'blue' });
    // providers / settings 都写 llm-deepseek；apiKey 已被 secret 扫描剥离为空串（安全不变量）
    assert.deepEqual(dst.settings.ns.get('llm-deepseek')?.value, {
      apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '',
    });
    // prompts：目标无来源行 → 重建 patch 行；persona 文本等价
    //   ⚠️ 已知有损点（非缺口，规格 §7.3）：源为字符串 `systemPrompt`，落盘形态为 `{persona}` 对象。
    const line = dst.patchFile.lines.get('conformance-persona')?.raw as
      | { config?: { systemPrompt?: { persona?: string } } }
      | undefined;
    assert.equal(line?.config?.systemPrompt?.persona, 'You are a conformance fixture persona.');
    // skills / agentPresets：文件类分区逐字节等价（baseDir 与 core/backup.ts 的 FILE_BASES 对齐）
    assert.equal(Buffer.from(await dst.fs.readFile(path.join('skills', SKILL_REL))).toString('utf8'), SKILL_BODY);
    assert.equal(Buffer.from(await dst.fs.readFile(path.join('.agent-presets', PRESET_REL))).toString('utf8'), PRESET_BODY);
    // 幂等：同一 bundle 再导一次 → 无失败项
    const plan2 = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    const result2 = await importer.executeImportPlan(zipPath, plan2, { confirm: true });
    assert.equal(result2.ok, true);
    assert.deepEqual(result2.executed.filter((e) => e.status === 'failed'), [], '重复导入必须幂等（不得失败）');
  });
});

test('RT-02 明文 v1 往返：不删除目标独有配置（§32 合并语义）', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    const zipPath = path.join(dir, 'rt02-baseline.zip');
    await exportBaseline(src, zipPath);

    const dst = seedCleanTarget();
    dst.settings.ns.set('target-only', { value: { keep: true }, revision: 1, secrets: [] });
    await dst.fs.writeFile(path.join('skills', 'target-only.md'), Buffer.from('# target only\n', 'utf8'));

    const importer = makeImporter(dst);
    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true });
    assert.equal(result.ok, true);
    assert.deepEqual(dst.settings.ns.get('target-only')?.value, { keep: true }, '目标独有 namespace 不得被删除');
    assert.equal(
      Buffer.from(await dst.fs.readFile(path.join('skills', 'target-only.md'))).toString('utf8'),
      '# target only\n',
      '目标独有文件不得被删除',
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 2. 未知分区 / 未知顶层字段 —— G-01 / G-02 特征化
 * ═══════════════════════════════════════════════════════════════════════ */

test('FC-01 未知分区（G-01/G-02/G-03 已修复）：数据被跳过但**明确告知**，且绝不混入 missingSections', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    const baseZip = path.join(dir, 'fc01-base.zip');
    await exportBaseline(src, baseZip);

    // 构造「v1 + 两个未来分区」的 bundle：声明 keybindings / workflows，并把它们的文件真的放进 ZIP。
    // 重算 checksums 是必须的（见 corpus.ts 注释），否则会被完整性校验先拦下，测不到本路径。
    const unknownZip = await rebuildBundle(baseZip, path.join(dir, 'fc01-unknown-sections.zip'), {
      manifest: (m) => {
        (m.sections as Record<string, boolean>)['keybindings'] = true;
        (m.sections as Record<string, boolean>)['workflows'] = true;
      },
      extraEntries: [
        {
          name: 'keybindings/keybindings.json',
          data: Buffer.from('{"version":1,"bindings":[{"key":"ctrl+k","command":"workbench.action.quickOpen"}]}', 'utf8'),
        },
        {
          name: 'custom/workflows/deploy.json',
          data: Buffer.from('{"version":1,"workflows":[{"id":"deploy","steps":["build","ship"]}]}', 'utf8'),
        },
      ],
    });

    // 语料自检：文件确实在 ZIP 里（这是本用例的前提——数据**存在**，只是本版本不认识）
    const entries = await listEntries(unknownZip);
    assert.ok(entries.includes('keybindings/keybindings.json'), '语料必须真的把未知分区文件放进 ZIP');
    assert.ok(entries.includes('custom/workflows/deploy.json'), '语料必须真的把未知分区文件放进 ZIP');
    // manifest 层：未知分区键只是 warning，不阻塞解析（规格 §2.3）
    const manifest = parseManifest(await readEntryText(unknownZip, MANIFEST_FILE));
    assert.equal((manifest.sections as Record<string, boolean>)['keybindings'], true);

    const dst = seedCleanTarget();
    const importer = makeImporter(dst);
    const analysis = await importer.analyzeImport(unknownZip);

    /* ── 修复后的正确行为（G-01/G-02/G-03） ────────────────────────────────
     * 未知分区 = 「本版本不认识」≠「备份声明了但文件缺失」。前者必须被单独收集并
     * 明确告知（数据未导入），后者才是 missingSections。 */
    assert.equal(analysis.valid, true, '未知分区不阻塞导入（这一点保持）');
    assert.deepEqual(analysis.errors, [], '未知分区不得产生 error');

    // G-01/G-03：未知分区被单独收集进 unsupportedSections（required 字段）
    assert.deepEqual(
      [...analysis.unsupportedSections].sort(),
      ['keybindings', 'workflows'],
      'G-01：未知分区必须被显式收集，而不是静默丢弃',
    );
    assert.ok(!analysis.sectionsInZip.includes('keybindings' as SectionId), '未知分区不出现在 sectionsInZip');
    assert.ok(!analysis.sectionsInZip.includes('workflows' as SectionId), '未知分区不出现在 sectionsInZip');

    // G-02：告警文案必须说「本版本不支持 + 已跳过、未导入」，且**不得**说成「缺少的分区」
    assert.deepEqual(
      analysis.warnings,
      ['备份包含本版本不支持的分区: keybindings, workflows（已跳过，未导入）'],
      'G-02：必须给出准确的「不受支持、已跳过」告警',
    );
    assert.ok(
      !analysis.warnings.some((w) => w.includes('缺少的分区')),
      'G-02：未知分区绝不得被报成「备份声明了但缺少的分区」（文件其实就在 ZIP 里）',
    );

    // G-02：既然不再误报为缺失，兼容性也不应再被拖成 partial
    assert.equal(analysis.compatibility, 'excellent', 'G-02：未知分区不再污染兼容性评分');

    // 未知分区不产生计划项（数据不落目标）——这一点是既定语义，保持
    const plan = await importer.createImportPlan(unknownZip, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    assert.deepEqual(
      Object.keys(plan.estimatedActions).sort(),
      [...FIXTURE_SECTIONS].sort(),
      '未知分区不产生任何计划项（其数据被跳过，但已明确告知）',
    );
  });
});

test('FC-02 未知顶层 / 已知对象内未知字段：解析保留，但不产生任何导入效果（规格 §7.1 ①②）', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    const baseZip = path.join(dir, 'fc02-base.zip');
    await exportBaseline(src, baseZip);

    const unknownZip = await rebuildBundle(baseZip, path.join(dir, 'fc02-unknown-fields.zip'), {
      manifest: (m) => {
        const loose = m as unknown as Record<string, unknown>;
        loose['x-future-manifest-key'] = { migrated: true };
        loose['futureTopLevel'] = 'keep-me';
        (m.exporter as unknown as Record<string, unknown>)['futureExporterField'] = 'keep';
      },
    });

    // manifest 层：未知字段原样保留（无白名单重写）
    const parsed = parseManifest(await readEntryText(unknownZip, MANIFEST_FILE)) as unknown as Record<string, unknown>;
    assert.deepEqual(parsed['x-future-manifest-key'], { migrated: true }, '未知顶层字段必须保留在解析结果里');
    assert.equal(parsed['futureTopLevel'], 'keep-me');
    assert.equal((parsed['exporter'] as Record<string, unknown>)['futureExporterField'], 'keep', '已知对象内未知子字段必须保留');

    // 导入层：未知字段不报错、不告警、也不产生任何计划项差异（它们不参与任何逻辑）
    const dst = seedCleanTarget();
    const analysis = await makeImporter(dst).analyzeImport(unknownZip);
    assert.equal(analysis.valid, true);
    assert.deepEqual(analysis.errors, []);
    assert.deepEqual(analysis.warnings, [], '未知字段不得产生任何告警');
    assert.equal(analysis.compatibility, 'excellent', '未知字段不得影响兼容性评分');
    assert.deepEqual([...analysis.sectionsInZip].sort(), [...FIXTURE_SECTIONS].sort());
  });
});

test('FC-03 分区数据 version 过高（G-05 已修复）：跳过该分区并告警，不阻断整个 bundle', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    const baseZip = path.join(dir, 'fc03-base.zip');
    await exportBaseline(src, baseZip);

    /* ── 正向：version = 2（数字且 > 1）→ 跳过该分区 + 告警，**不阻断** ──────
     * 修复前：validateSectionData 对 version !== 1 一律 error → extractSections 抛错
     * → **整个 bundle 无法导入**（一个未来分区的数据版本就能毁掉整次恢复）。 */
    const futureUi = await rebuildBundle(baseZip, path.join(dir, 'fc03-section-v2.zip'), {
      extraEntries: [
        { name: 'config/ui.json', data: Buffer.from('{"version":2,"namespaces":{}}', 'utf8') },
      ],
    });

    const dst = seedCleanTarget();
    const analysis = await makeImporter(dst).analyzeImport(futureUi);

    assert.equal(analysis.valid, true, 'G-05：分区数据版本过高不得阻断整个 bundle');
    assert.deepEqual(analysis.errors, [], 'G-05：这不是 error 而是 warning');
    assert.deepEqual(
      analysis.warnings,
      ['分区 ui 的数据版本 2 高于本版本支持的 1（已跳过该分区）'],
      'G-05：必须明确告知哪个分区、什么版本、被跳过',
    );

    // 该分区被跳过：既不在 sectionsInZip，也**不算缺失**（与未知分区同一纪律）
    assert.ok(!analysis.sectionsInZip.includes('ui' as SectionId), 'G-05：被跳过的分区不进 sectionsInZip');
    assert.ok(
      !analysis.warnings.some((w) => w.includes('缺少的分区')),
      'G-05：被跳过的分区不得被报成「声明了但缺失」（文件其实就在 ZIP 里）',
    );
    assert.equal(analysis.compatibility, 'excellent', 'G-05：跳过一个版本过高的分区不得把兼容性拖低');

    // 结构化暴露：被跳过的分区必须与「未知分区」对称地出现在 analysis 上，
    // 而不是只有一行告警文字——否则 UI 无法分列展示这两类跳过的原因。
    assert.deepEqual(
      analysis.unsupportedVersions,
      [{ section: 'ui', version: 2 }],
      'G-05：被跳过的分区必须结构化暴露（与 unsupportedSections 对称）',
    );
    assert.deepEqual(
      analysis.unsupportedSections,
      [],
      'G-05：「数据版本过高」不是「未知分区」，两者不得串味',
    );

    // 该分区不产生任何计划项；其余分区照常
    const plan = await makeImporter(dst).createImportPlan(futureUi, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    assert.ok(!plan.items.some((i) => i.adapter === 'ui'), 'G-05：被跳过的分区不得产生任何计划项');
    assert.ok(
      Object.keys(plan.estimatedActions).length > 0,
      'G-05：其余分区必须照常产生计划项（只有该分区被跳过）',
    );

    /* ── 反向：version 损坏（< 1 / 非数字 / 缺失）→ **仍必须硬失败** ────────
     * 「高于本版本」是可前向兼容的未知；「不是合法版本号」是数据损坏，两者不可混同。 */
    const brokenCases: { id: string; payload: string }[] = [
      { id: 'v0', payload: '{"version":0,"namespaces":{}}' },
      { id: 'vstring', payload: '{"version":"2","namespaces":{}}' },
      { id: 'vmissing', payload: '{"namespaces":{}}' },
    ];
    for (const broken of brokenCases) {
      const brokenZip = await rebuildBundle(baseZip, path.join(dir, `fc03-broken-${broken.id}.zip`), {
        extraEntries: [{ name: 'config/ui.json', data: Buffer.from(broken.payload, 'utf8') }],
      });
      await assert.rejects(
        () => makeImporter(seedCleanTarget()).analyzeImport(brokenZip),
        /分区 ui 数据无效/,
        `G-05：version ${broken.id} 属数据损坏，必须保持硬失败`,
      );
    }
  });
});

test('FC-04 语义回归：missingSections 只统计「已知分区但文件缺失」，与「未知分区」互不串味', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    const baseZip = path.join(dir, 'fc04-base.zip');
    await exportBaseline(src, baseZip);

    // 声明一个**本版本认识**、但 ZIP 内确实没有文件的分区（mcp 不在 FIXTURE_SECTIONS 里，
    // 所以 baseline 不含 mcp/servers.json）——这才是真正的「声明了但缺失」。
    const missingZip = await rebuildBundle(baseZip, path.join(dir, 'fc04-missing-known.zip'), {
      manifest: (m) => { m.sections.mcp = true; },
    });

    const dst = seedCleanTarget();
    const analysis = await makeImporter(dst).analyzeImport(missingZip);

    // 正向：已知分区缺失 → 仍必须如实报告（G-01/G-02/G-05 的修复不得把它一起吞掉）
    assert.equal(analysis.valid, true, '分区缺失是 warning，不阻断');
    assert.deepEqual(
      analysis.warnings,
      ['备份声明了但缺少的分区: mcp'],
      '已知分区但 ZIP 内无文件 → 必须仍是「声明了但缺少的分区」',
    );
    // 反向：这不是「未知分区」，不得被误记进 unsupportedSections
    assert.deepEqual(analysis.unsupportedSections, [], '已知分区缺失不得被算成「本版本不支持的分区」');
    // 兼容性：真缺失 → partial（规格 §6.3）
    assert.equal(analysis.compatibility, 'partial', '真实的分区缺失仍必须把兼容性评低');
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 3. 加密包往返
 * ═══════════════════════════════════════════════════════════════════════ */

test('ENC-01 加密往返：正确密码 → 解密成功、凭据按值恢复、密码与明文均不落 ZIP', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    await src.fs.writeFile(path.join(src.homeDir, '.credentials.yaml'), Buffer.from(CREDENTIALS_YAML, 'utf8'));
    const zipPath = path.join(dir, 'enc01.zip');
    await exportBaseline(src, zipPath, { encryption: createEncryptionProvider(TEST_PASSWORD), includeSecrets: true });

    const archive = parseZip(await fs.readFile(zipPath));
    const manifest = parseManifest(archive.readEntryText(MANIFEST_FILE));
    assert.equal(manifest.security.encrypted, true, '注入 encryption provider → 备份必须标记加密');
    assert.equal(manifest.security.containsSecrets, true, 'includeSecrets=true 且凭据文件非空 → containsSecrets=true');
    assert.ok(manifest.security.encryption, '必须记录加密参数（算法/KDF/salt/iv/authTag）');
    assert.equal(manifest.security.encryption!.algorithm, 'aes-256-gcm');
    assert.equal(manifest.security.encryption!.kdf, 'scrypt');
    assert.ok(archive.has('security/secrets.enc'), '必须写入 security/secrets.enc');

    // 密码与明文凭据绝不落盘（secrets.enc 为密文，单独排除）
    for (const name of archive.names()) {
      if (name === 'security/secrets.enc') continue;
      const text = Buffer.from(archive.readEntry(name)).toString('utf8');
      assert.ok(!text.includes(TEST_PASSWORD), `密码不得出现在 ${name}`);
      assert.ok(!text.includes(FIXTURE_CREDENTIAL_VALUE), `明文凭据不得出现在 ${name}`);
    }

    // 宿主侧解密（第三方 importer 用同一路径恢复凭据）
    const plaintext = await decryptCredentials(
      archive.readEntry('security/secrets.enc'),
      manifest.security.encryption!,
      TEST_PASSWORD,
    );
    assert.equal(plaintext, CREDENTIALS_YAML, '正确密码必须解出原始 .credentials.yaml 文本');

    const dst = seedCleanTarget();
    const importer = makeImporter(dst);
    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.encrypted, true, '分析结果必须暴露 encrypted 标志，UI 据此索要密码');
    assert.equal(analysis.secretCount, 1);

    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    assert.ok(plan.missingSecrets.some((s) => s.ref === 'DEEPSEEK_API_KEY'), '已配置但未导出值的凭据必须出现在 missingSecrets');

    // 不变量：加密包未提供解密结果 → 拒绝执行（不允许静默降级为「缺凭据照常导入」）
    await assert.rejects(
      () => importer.executeImportPlan(zipPath, plan, { confirm: true }),
      /解密密码才能导入/,
      '加密备份无 decryptedCredentials 必须拒绝执行',
    );
    assert.equal(await exists(dst, path.join('skills', SKILL_REL)), false, '拒绝时不得产生任何写入');

    const map = new Map<string, string>();
    for (const row of plaintext.split('\n')) {
      const m = /^([A-Za-z0-9_]+):\s*(.+)$/.exec(row.trim());
      if (m) map.set(m[1]!, m[2]!);
    }
    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true, decryptedCredentials: map });
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingSecrets, [], '解密覆盖的凭据不再计入缺失');
    assert.equal(dst.credentials.values.get('DEEPSEEK_API_KEY'), FIXTURE_CREDENTIAL_VALUE, '凭据必须按值恢复');
    assert.deepEqual(
      dst.settings.ns.get('general')?.value,
      { theme: 'dark', language: 'zh-CN', nested: { keep: [1, 2, 3], text: '你好，世界！' } },
      '加密包的非凭据分区同样必须往返无损',
    );
  });
});

test('ENC-02 加密往返：错误密码 → BAD_PASSWORD，且解密失败路径零写入（无半写入状态）', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    await src.fs.writeFile(path.join(src.homeDir, '.credentials.yaml'), Buffer.from(CREDENTIALS_YAML, 'utf8'));
    const zipPath = path.join(dir, 'enc02.zip');
    await exportBaseline(src, zipPath, { encryption: createEncryptionProvider(TEST_PASSWORD), includeSecrets: true });

    const archive = parseZip(await fs.readFile(zipPath));
    const manifest = parseManifest(archive.readEntryText(MANIFEST_FILE));
    const blob = archive.readEntry('security/secrets.enc');

    // 密码错误 → GCM 认证失败 → BAD_PASSWORD（分类明确，不得退化成「损坏」或静默成功）
    await assert.rejects(
      () => decryptCredentials(blob, manifest.security.encryption!, 'wrong-password-999'),
      (err: unknown) => err instanceof SecurityError && err.code === 'BAD_PASSWORD',
      '错误密码必须抛 SecurityError(BAD_PASSWORD)',
    );

    // 错误密码发生在解密阶段（任何执行之前）→ 目标必须完全未被触碰
    const dst = seedCleanTarget();
    const importer = makeImporter(dst);
    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });

    let failure: unknown = null;
    try {
      await decryptCredentials(blob, manifest.security.encryption!, 'wrong-password-999');
    } catch (err) {
      failure = err;
    }
    assert.ok(failure instanceof SecurityError, '错误密码必须让解密步骤失败');

    // 半写入检查：settings / 文件 / patch 行 / 凭据全部保持原样
    assert.equal(dst.settings.ns.get('general'), undefined, '错误密码不得写入任何 namespace');
    assert.equal(await exists(dst, path.join('skills', SKILL_REL)), false, '错误密码不得写入任何文件');
    assert.equal(dst.patchFile.lines.size, 0, '错误密码不得写入任何 patch 行');
    assert.equal(dst.credentials.values.size, 0, '错误密码不得写入任何凭据');

    // 即便用户「确认执行」但解密结果为空，凭据项也绝不得被写入
    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true, decryptedCredentials: new Map() });
    assert.equal(result.ok, true, '非凭据分区照常导入（密码错误只影响凭据）');
    assert.equal(dst.credentials.values.size, 0, '空解密结果绝不得写入凭据');
    assert.deepEqual(result.missingSecrets, ['DEEPSEEK_API_KEY'], '未提供的凭据必须如实报告为缺失');
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 4. schema 过新 / 过旧 —— 硬失败 + 可操作错误
 * ═══════════════════════════════════════════════════════════════════════ */

test('VER-01 schema 过新（v2）：走 isTooNew 路径硬失败，给出可操作错误而非静默通过', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    const baseZip = path.join(dir, 'ver01-base.zip');
    await exportBaseline(src, baseZip);

    const tooNewZip = await rebuildBundle(baseZip, path.join(dir, 'ver01-schema-v2.zip'), {
      manifest: (m) => { m.schemaVersion = 2; },
    });

    // 语料自检：manifest 确实变成 v2，且 checksums 已重算
    // （否则测到的是完整性错误，而不是版本错误）
    const archive = parseZip(await fs.readFile(tooNewZip));
    assert.equal(parseManifest(archive.readEntryText(MANIFEST_FILE)).schemaVersion, 2);
    const checksums = archive.readEntryJson(CHECKSUMS_FILE) as Record<string, string>;
    for (const name of archive.names().filter((n) => n !== MANIFEST_FILE && n !== CHECKSUMS_FILE)) {
      assert.equal(sha256Hex(archive.readEntry(name)), checksums[name], `${name} checksum 必须已重算`);
    }

    assert.equal(isTooNew(2), true);
    assert.equal(describeVersion(2), 'schema v2（高于当前 1，需升级插件）');

    const dst = seedCleanTarget();
    await assert.rejects(
      () => makeImporter(dst).analyzeImport(tooNewZip),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // 明确可操作：含版本号 + 指向「需升级插件」；且不得报成完整性/损坏类错误
        assert.match(err.message, /schema v2/);
        assert.match(err.message, /高于当前 1/);
        assert.match(err.message, /需升级插件/);
        assert.match(err.message, /无法导入/);
        assert.ok(!/完整性/.test(err.message), '过新版本不得报成完整性失败（避免误导用户重导）');
        return true;
      },
      'schema v2 必须硬失败（不得静默通过、不得尽力而为部分导入）',
    );
    assert.equal(dst.settings.ns.get('general'), undefined, '版本不受支持时不得产生任何写入');
    assert.equal(await exists(dst, path.join('skills', SKILL_REL)), false);
  });
});

test('VER-02 schema 过旧（低于最低支持）：同样硬失败并说明低于最低支持版本', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    const baseZip = path.join(dir, 'ver02-base.zip');
    await exportBaseline(src, baseZip);

    const tooOldZip = await rebuildBundle(baseZip, path.join(dir, 'ver02-schema-v0.zip'), {
      manifest: (m) => { m.schemaVersion = 0; },
    });

    const dst = seedCleanTarget();
    await assert.rejects(
      () => makeImporter(dst).analyzeImport(tooOldZip),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /schema v0/);
        assert.match(err.message, /低于最低支持 1/);
        return true;
      },
    );
    assert.equal(dst.settings.ns.get('general'), undefined);
  });
});

test('VER-03 迁移链接入导入路径（G-06/G-07 已修复，B2 守卫已加固）：loadBundle 方法体内受 needsMigration 守卫地调用 runSchemaMigration，v1 包不触发迁移', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    const zipPath = path.join(dir, 'ver03.zip');
    await exportBaseline(src, zipPath);

    /* ── B2 修复：守卫必须覆盖「**接线**」，而不只是「文件里存在这个符号」 ──────────
     * 旧守卫只做「遍历 src/core/*.ts（剔注释行）grep /migrateToCurrent/，断言命中 analyzer.ts」。
     * 而 `migrateToCurrent` 的唯一代码行在 `runSchemaMigration` 函数体内（文件级符号），
     * 所以把 loadBundle 里的 `if (needsMigration(...))` 改成 `if (false)`，旧守卫照样绿——
     * 它断言的是「符号存在」，缺陷却是「这个符号在导入路径上从未被调用」。
     * 现在改为：① 解析出 `loadBundle` 的**方法体**（按花括号配平定位，不靠 grep 全文）；
     *          ② 断言方法体内存在以 `needsMigration(...)` 为条件的 if；
     *          ③ 断言 `runSchemaMigration(` 调用出现在该 if 的**受控块内**（顺序 + 花括号范围）。
     * 变异验证：把该 if 条件改成 `if (false)` → ② 无守卫可匹配 → 本用例红灯（审计的 M4 突变）。 */
    const analyzerSrc = await fs.readFile(
      fileURLToPath(new URL('../../src/core/analyzer.ts', import.meta.url)),
      'utf8',
    );
    const lines = analyzerSrc.split('\n');
    const declAt = lines.findIndex((l) => l.includes('loadBundle(zipPath: string)'));
    assert.ok(declAt >= 0, 'B2：必须能找到 loadBundle 的声明（守卫自身的前置条件）');
    const header = lines.slice(declAt, declAt + 2).join('\n');
    assert.ok(/\{\s*$/.test((lines[declAt] ?? '').trimEnd()), `B2：loadBundle 声明未按预期以 { 结尾（守卫失效）：${header}`);
    assert.ok(!/runSchemaMigration/.test(header), 'B2：runSchemaMigration 不得出现在 loadBundle 签名行（守卫自身的前置条件）');

    // 花括号配平：从声明行的 { 开始，深度首次回落到 0 的那一行即方法体结束
    let depth = 0;
    let bodyEnd = -1;
    for (let i = declAt; i < lines.length; i += 1) {
      const code = (lines[i] ?? '').replace(/\/\/.*$/, '');
      for (const ch of code) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      if (depth === 0 && i > declAt) { bodyEnd = i; break; }
    }
    assert.ok(bodyEnd > declAt, 'B2：未能定位 loadBundle 方法体边界（守卫自身的前置条件）');
    const body = lines.slice(declAt, bodyEnd + 1).join('\n');

    // ② 方法体内必须有以 needsMigration(...) 为条件的守卫
    const guardRe = /if\s*\(\s*needsMigration\s*\(/g;
    const guards: { at: number; brace: number }[] = [];
    for (let m = guardRe.exec(body); m !== null; m = guardRe.exec(body)) {
      const brace = body.indexOf('{', m.index);
      if (brace >= 0) guards.push({ at: m.index, brace });
    }
    assert.ok(
      guards.length > 0,
      'B2/G-06：loadBundle 方法体内必须存在 needsMigration 守卫（把条件改成 if (false) 必须让本断言失败）',
    );

    // ③ 调用点必须落在该守卫的受控块内（顺序 + 花括号范围），且不能被注释掉
    const callAt = body.indexOf('runSchemaMigration(');
    assert.ok(
      callAt >= 0,
      'B2/G-06：loadBundle 方法体内必须真实调用 runSchemaMigration(（文件级出现不算接线）',
    );
    assert.ok(
      !/^\s*(\/\/|\*)/.test(body.slice(body.lastIndexOf('\n', callAt) + 1, callAt)),
      'B2/G-06：runSchemaMigration 调用点不得被注释掉',
    );
    const gated = guards.find((g) => {
      const close = body.indexOf('}', g.brace + 1);
      return g.at < callAt && close >= 0 && callAt < close;
    });
    assert.ok(
      gated !== undefined,
      'B2/G-06：runSchemaMigration 必须在 needsMigration 守卫的受控块内被调用（顺序 + 块范围），'
        + '而不是仅仅出现在文件里',
    );

    // 行为面：v1 包（= CURRENT）不触发迁移，正常导入且无任何迁移痕迹
    const dst = seedCleanTarget();
    const importer = makeImporter(dst);
    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.valid, true);
    assert.ok(!analysis.warnings.some((w) => w.includes('迁移')), 'G-06：当前版本（v1）的包不得产生迁移告警');
    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true });
    assert.equal(result.ok, true);
    assert.ok(!result.warnings.some((w) => w.includes('迁移')), 'G-06：执行结果中不得有迁移痕迹');

    /* ── 迁移链**真实可执行**：直接驱动接线点 ─────────────────────────────
     * 当前 MIN_SUPPORTED = CURRENT = 1 ⇒ needsMigration 恒假 ⇒ loadBundle 内该分支结构上不可达。
     * 因此这里直接调用 loadBundle 使用的同一函数（runSchemaMigration），用注册表中真实存在的
     * v1→v2 步骤驱动整条链，证明「有定义、有测试、从不执行」已变成「真实可执行」。 */
    const v1Doc = parseManifest(await readEntryText(zipPath, MANIFEST_FILE));
    const migrated = runSchemaMigration(v1Doc, 1, 2, zhMsg);
    assert.deepEqual(
      migrated.warnings,
      ['备份 schema 已从 v1 迁移到 v2'],
      'G-06：每个已应用的迁移步骤必须翻译成用户可见告警（import.migrated）',
    );
    assert.equal(migrated.manifest.schemaVersion, 1, 'v1→v2 为占位迁移：当前原样透传（不谎报已升版）');
    assert.equal(
      migrated.manifest.exporter.name,
      v1Doc.exporter.name,
      '迁移结果必须是迁移链的返回 doc（而非原始 manifest 的副本）',
    );

    // 迁移后必须重新校验：结果不是合法 manifest → 抛明确错误，绝不继续
    assert.throws(
      () => runSchemaMigration({ not: 'a manifest' }, 1, 2, zhMsg),
      /迁移后的 manifest 不合法/,
      'G-06：迁移结果不合法必须硬失败（不得把半迁移文档当合法 manifest 继续）',
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 5. 语料本身的可复用性契约（供外部实现比对）
 * ═══════════════════════════════════════════════════════════════════════ */

test('CORPUS-01 语料构造器契约：rebuildBundle 只改指定结构，其余条目逐字节不变且 checksums 有效', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    const baseZip = path.join(dir, 'corpus-base.zip');
    await exportBaseline(src, baseZip);

    const rebuilt = await rebuildBundle(baseZip, path.join(dir, 'corpus-rebuilt.zip'), {
      manifest: (m) => { m.schemaVersion = 2; },
    });

    const before = parseZip(await fs.readFile(baseZip));
    const after = parseZip(await fs.readFile(rebuilt));
    assert.deepEqual(after.names().sort(), before.names().sort(), '未追加条目时 ZIP 条目集合必须完全一致');

    for (const name of before.names()) {
      if (name === MANIFEST_FILE || name === CHECKSUMS_FILE) continue;
      assert.equal(
        sha256Hex(after.readEntry(name)),
        sha256Hex(before.readEntry(name)),
        `${name} 必须逐字节不变（语料只改 manifest）`,
      );
    }
    const checksums = after.readEntryJson(CHECKSUMS_FILE) as Record<string, string>;
    for (const name of after.names().filter((n) => n !== MANIFEST_FILE && n !== CHECKSUMS_FILE)) {
      assert.equal(sha256Hex(after.readEntry(name)), checksums[name], `${name} checksum 必须与重算后的表一致`);
    }
    assert.equal(parseManifest(after.readEntryText(MANIFEST_FILE)).schemaVersion, 2);
  });
});

test('CORPUS-02 完整性语义：篡改数据条目且不重算 checksums → 必须被拒绝；重算后必须放行', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    const baseZip = path.join(dir, 'corpus02-base.zip');
    await exportBaseline(src, baseZip);

    // 篡改 config/settings.json 的字节，但保留原始 checksums 表
    const tampered = await rebuildBundle(baseZip, path.join(dir, 'corpus02-tampered.zip'), {
      recomputeChecksums: false,
      extraEntries: [
        {
          name: 'config/settings.json',
          data: Buffer.from('{"version":1,"namespaces":{"general":{"value":{"theme":"INJECTED"},"revision":99,"secrets":[]}}}', 'utf8'),
        },
      ],
    });
    const dst = seedCleanTarget();
    await assert.rejects(
      () => makeImporter(dst).analyzeImport(tampered),
      /完整性校验失败/,
      '数据条目被改动而未重算 checksums → 必须被完整性校验拒绝（这正是语料必须重算 checksums 的原因）',
    );
    assert.equal(dst.settings.ns.get('general'), undefined, '完整性失败时零写入');

    // 同一份篡改内容 + 重算 checksums → 完整性通过（证明拒绝来自 checksum 机制本身）
    const consistent = await rebuildBundle(baseZip, path.join(dir, 'corpus02-consistent.zip'), {
      extraEntries: [
        {
          name: 'config/settings.json',
          data: Buffer.from('{"version":1,"namespaces":{"general":{"value":{"theme":"INJECTED"},"revision":99,"secrets":[]}}}', 'utf8'),
        },
      ],
    });
    const dst2 = seedCleanTarget();
    const analysis = await makeImporter(dst2).analyzeImport(consistent);
    assert.equal(analysis.valid, true, '重算 checksums 后同一内容必须被接受');
    assert.deepEqual(analysis.warnings, []);
  });
});

test('INT-01 完整性反向语义（G-04 已修复）：ZIP 内含未登记进校验表的条目 → 明确告警但不阻断', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    const baseZip = path.join(dir, 'int01-base.zip');
    await exportBaseline(src, baseZip);

    /* 保留原始 checksums 表（**不重算**），只追加两个新条目：
     *   - 一个普通文件（未登记 ⇒ 未被校验 ⇒ 必须告警）；
     *   - 一个目录条目（以 "/" 结尾 ⇒ 按约定排除，不得进告警）。
     * 修复前：verifyAgainstTable 只遍历表里的键，ZIP 里多出的条目既不校验也不告知——
     * 一个夹带了任意内容的条目可以完全无声地躺在「已通过完整性校验」的备份里。 */
    const rogue = await rebuildBundle(baseZip, path.join(dir, 'int01-extra-entries.zip'), {
      recomputeChecksums: false,
      extraEntries: [
        { name: 'injected/rogue.json', data: Buffer.from('{"version":1,"rogue":true}', 'utf8') },
        { name: 'injected/emptydir/', data: Buffer.alloc(0) },
      ],
    });

    // 语料自检：条目确实在 ZIP 里、且确实**不在**校验表内（否则测不到本路径）
    const archive = parseZip(await fs.readFile(rogue));
    assert.ok(archive.has('injected/rogue.json'), '语料必须真的把未登记条目放进 ZIP');
    assert.ok(archive.has('injected/emptydir/'), '语料必须真的把目录条目放进 ZIP');
    const checksums = archive.readEntryJson(CHECKSUMS_FILE) as Record<string, string>;
    assert.equal(checksums['injected/rogue.json'], undefined, '语料：rogue.json 必须不在校验表内');
    assert.equal(checksums['injected/emptydir/'], undefined, '语料：目录条目必须不在校验表内');

    const dst = seedCleanTarget();
    const analysis = await makeImporter(dst).analyzeImport(rogue);

    // G-04：不阻断（未知 ZIP 条目不参与校验是格式 v1 的既定语义，这里只是不再「静默」）
    assert.equal(analysis.valid, true, 'G-04：未登记条目不得阻断导入');
    assert.deepEqual(analysis.errors, [], 'G-04：这是 warning 而非 error');
    // G-04：必须点名列出；目录条目被排除（只列普通文件）
    assert.deepEqual(
      analysis.warnings,
      ['ZIP 内含未登记进校验表的条目: "injected/rogue.json"（未被校验）'],
      'G-04：必须显式列出未登记条目（目录条目除外）',
    );
    // Dry Run 零写入
    assert.equal(dst.settings.ns.get('general'), undefined, 'G-04：告警不改变 Dry Run 零写入不变量');
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * H2：校验表**缺失** / **为空** 时不得静默通过
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * 语料助手：把任意 bundle 的 `integrity/checksums.json` 换成给定内容。
 *   - `table === null`  → **删除**该条目（表缺失）；
 *   - `table` 为对象     → 覆盖为给定表（`{}` 即空表）。
 * 其余条目（含 manifest.json）逐字节原样保留，因此不会引入其他干扰因素。
 */
async function rebuildWithChecksums(
  srcZipPath: string,
  outZipPath: string,
  table: Record<string, string> | null,
): Promise<string> {
  const archive = parseZip(await fs.readFile(srcZipPath));
  const entries: { name: string; data: Uint8Array }[] = [];
  for (const name of archive.names()) {
    if (name === CHECKSUMS_FILE) continue;
    entries.push({ name, data: archive.readEntry(name) });
  }
  if (table !== null) {
    entries.push({ name: CHECKSUMS_FILE, data: Buffer.from(JSON.stringify(table, null, 2), 'utf8') });
  }
  await writeZip(outZipPath, entries);
  return outZipPath;
}

test('INT-02 校验表缺失（H2 已修复）：全部条目未被校验 → 必须显式告警，不得静默通过', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    const baseZip = path.join(dir, 'int02-base.zip');
    await exportBaseline(src, baseZip);

    /* H2：`integrity/checksums.json` 整体删除。
     * 修复前整段完整性逻辑（含 G-04 的反向检查）都嵌在 `if (archive.has(CHECKSUMS_FILE))` 内，
     * 于是「剥掉校验表」= 一个条目都不校验，却 valid=true / errors=[] / warnings=[] ——零提示。 */
    const stripped = await rebuildWithChecksums(baseZip, path.join(dir, 'int02-no-checksums.zip'), null);

    // 语料自检：表确实不在 ZIP 里，而数据条目仍在（否则测不到本路径）
    const archive = parseZip(await fs.readFile(stripped));
    assert.equal(archive.has(CHECKSUMS_FILE), false, '语料：checksums.json 必须真的被剥掉');
    assert.ok(archive.has('config/settings.json'), '语料：数据条目必须仍在（证明剥掉的只是校验表）');
    assert.equal(archive.names().filter((n) => n === CHECKSUMS_FILE).length, 0, '语料：不得残留第二个校验表条目');

    const dst = seedCleanTarget();
    const analysis = await makeImporter(dst).analyzeImport(stripped);

    assert.equal(analysis.valid, true, 'H2：表缺失只告警，不阻断（格式 v1 既定语义）');
    assert.deepEqual(analysis.errors, [], 'H2：这是 warning 而非 error');
    assert.ok(
      analysis.warnings.includes('备份未提供完整性校验表，全部条目未被校验'),
      `H2：表缺失必须显式告警，实际 warnings=${JSON.stringify(analysis.warnings)}`,
    );
    // Dry Run 零写入
    assert.equal(dst.settings.ns.get('general'), undefined, 'H2：告警不改变 Dry Run 零写入不变量');
  });
});

test('INT-03 校验表为空（H2 已修复）：{} 等价于「没有任何条目被校验」→ 同样必须告警', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    const baseZip = path.join(dir, 'int03-base.zip');
    await exportBaseline(src, baseZip);

    /* H2：表**存在但为空**。与「表缺失」对用户是同一件事：没有任何条目被校验。
     * 修复前 `verifyAgainstTable({})` 返回 ok=true、且反向检查因空表无「表内键」而产出零告警。 */
    const emptied = await rebuildWithChecksums(baseZip, path.join(dir, 'int03-empty-checksums.zip'), {});

    const archive = parseZip(await fs.readFile(emptied));
    assert.ok(archive.has(CHECKSUMS_FILE), '语料：空表条目必须真的存在');
    assert.deepEqual(
      archive.readEntryJson(CHECKSUMS_FILE),
      {},
      '语料：校验表必须是空对象（不是被剥掉、也不是残缺 JSON）',
    );

    const dst = seedCleanTarget();
    const analysis = await makeImporter(dst).analyzeImport(emptied);

    assert.equal(analysis.valid, true, 'H2：空表只告警，不阻断');
    assert.deepEqual(analysis.errors, [], 'H2：这是 warning 而非 error');
    assert.ok(
      analysis.warnings.includes('备份未提供完整性校验表，全部条目未被校验'),
      `H2：空表必须显式告警，实际 warnings=${JSON.stringify(analysis.warnings)}`,
    );
    assert.equal(dst.settings.ns.get('general'), undefined, 'H2：告警不改变 Dry Run 零写入不变量');
  });
});

test('INT-04 非空校验表语义不变（H2 回归）：表内条目照旧逐条校验，未登记条目照旧只告警', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', SRC_HOME);
    await seedSource(src);
    const baseZip = path.join(dir, 'int04-base.zip');
    await exportBaseline(src, baseZip);

    // 用导出时真实产生的表覆盖回去（非空）→ 不得出现「未提供校验表」告警，且完整性照旧通过
    const baseArchive = parseZip(await fs.readFile(baseZip));
    const realTable = baseArchive.readEntryJson(CHECKSUMS_FILE) as Record<string, string>;
    assert.ok(Object.keys(realTable).length > 0, '语料：导出产物的校验表必须非空');
    const rebuilt = await rebuildWithChecksums(baseZip, path.join(dir, 'int04-same-table.zip'), realTable);

    const dst = seedCleanTarget();
    const analysis = await makeImporter(dst).analyzeImport(rebuilt);

    assert.equal(analysis.valid, true, 'H2 回归：表存在且非空时行为不变');
    assert.deepEqual(analysis.errors, []);
    assert.deepEqual(analysis.warnings, [], 'H2 回归：非空且完整的表不得产生任何完整性告警');
    assert.ok(
      !analysis.warnings.some((w) => w.includes('未提供完整性校验表')),
      'H2 回归：表存在且非空时不得误报「未提供校验表」',
    );
  });
});
