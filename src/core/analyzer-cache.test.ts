/**
 * 已验证归档的**跨请求缓存**（P0-2）。
 *
 * 为什么要有这些用例：宿主每次请求都新建 Importer/Analyzer（`makeImporter()`），实例级
 * `bundleCache` 在两个请求之间永远命中不了 —— 一次导入向导会把同一个 ZIP 完整读入 + 全量解压
 * + 逐条 SHA-256 校验 3~4 次。缓存必须同时满足三条互相对立的性质：
 *  ① 只读入口（analyze / plan）**复用**（否则等于没做）；
 *  ② 写盘入口（execute）**绝不复用** —— 校验通过之后、真正写盘之前归档被换掉，必须被再次拦下（TOCTOU）；
 *  ③ 归档身份（大小 / mtime）一变就失效（不能拿陈旧校验结果去改用户数据）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Analyzer, clearVerifiedBundleCache } from './analyzer.ts';
import { Importer } from './importer.ts';
import type { AnalyzerOptions } from './analyzer.ts';
import { createAdapters } from '../adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import { writeZip, parseZip } from '../utils/zip.ts';
import { buildManifest } from '../schema/manifest.ts';
import { buildChecksums } from '../utils/hashing.ts';
import { SECTION_IDS } from '../schema/config.ts';
import type { SectionId } from '../schema/types.ts';

/** 造一份最小合法备份（manifest + settings 分区 + integrity/checksums.json）。 */
async function buildBundle(settingsValue: string): Promise<{ zipPath: string; tmp: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-analyzer-cache-'));
  const flags: Record<string, boolean> = {};
  for (const sid of SECTION_IDS) flags[sid] = false;
  flags['settings'] = true;
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
  // 校验表覆盖「除 manifest.json 与自身外」的全部条目（与 exporter 同口径）。把 manifest.json
  // 也登记进去会被 analyzer 判成「登记了但条目集合里没有」，整包被拒。
  const entries = [{ name: 'config/settings.json', data: Buffer.from(settingsValue, 'utf8') }];
  const checksums = buildChecksums(entries);
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') });
  entries.push({ name: 'integrity/checksums.json', data: Buffer.from(JSON.stringify(checksums), 'utf8') });
  const zipPath = path.join(tmp, 'bundle.zip');
  await writeZip(zipPath, entries);
  return { zipPath, tmp };
}

const SETTINGS = JSON.stringify({ version: 1, namespaces: { llm: { value: { model: 'deepseek-chat' }, revision: 1, secrets: [] } } });
const DECISIONS = { strategy: 'merge' as const, resolutions: {}, pathMappings: [] };

/** 计数用的 parseZip 替身：缓存命中的唯一可观察后果就是「不再解析归档」。 */
function countingParser(): { override: NonNullable<AnalyzerOptions['parseZipOverride']>; calls: () => number } {
  let calls = 0;
  return {
    override: (buf, limits) => {
      calls += 1;
      return parseZip(buf, limits);
    },
    calls: () => calls,
  };
}

/** 每次调用都新建 Analyzer —— 与宿主 `makeImporter()`（每请求一个实例）同构。 */
function analyzerFor(override: AnalyzerOptions['parseZipOverride']): Analyzer {
  return new Analyzer({
    ctx: makeContext('linux', '/home/bob'),
    adapters: createAdapters({ namespaces: ['llm'] }),
    snapshotStore: new MemSnapshotStore(),
    parseZipOverride: override,
  });
}

test('只读入口复用：analyze → plan（两个 Analyzer 实例）只解析一次归档', async () => {
  clearVerifiedBundleCache();
  const { zipPath, tmp } = await buildBundle(SETTINGS);
  try {
    const parser = countingParser();
    await analyzerFor(parser.override).analyzeImport(zipPath);
    assert.equal(parser.calls(), 1, '首次必须真解析');
    await analyzerFor(parser.override).createImportPlan(zipPath, DECISIONS);
    assert.equal(parser.calls(), 1, 'plan 必须命中已验证缓存（同路径 + 同大小 + 同 mtime）');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('写盘入口不复用：execute 一律重新解析（TOCTOU 窗口必须自己关掉）', async () => {
  clearVerifiedBundleCache();
  const { zipPath, tmp } = await buildBundle(SETTINGS);
  try {
    const parser = countingParser();
    const plan = await analyzerFor(parser.override).createImportPlan(zipPath, DECISIONS);
    assert.equal(parser.calls(), 1);
    await analyzerFor(parser.override).executeImportPlan(zipPath, plan, { confirm: true });
    assert.equal(parser.calls(), 2, 'execute 必须重新解析并重新校验，不得吃缓存');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('实锤 TOCTOU：plan 之后把归档换成「内容改了、校验表没改」的包 → execute 仍被完整性校验拦下', async () => {
  clearVerifiedBundleCache();
  const { zipPath, tmp } = await buildBundle(SETTINGS);
  try {
    const parser = countingParser();
    const plan = await analyzerFor(parser.override).createImportPlan(zipPath, DECISIONS);
    // 篡改：settings 内容变了，checksums.json 仍是旧的（最常见的形态）
    const tampered = JSON.stringify({ version: 1, namespaces: { llm: { value: { model: 'evil-model' }, revision: 1, secrets: [] } } });
    const raw = await fs.readFile(zipPath);
    const archive = parseZip(raw);
    const entries = archive.names()
      .filter((name) => !name.endsWith('/'))
      .map((name) => ({
        name,
        data: name === 'config/settings.json' ? Buffer.from(tampered, 'utf8') : Buffer.from(archive.readEntry(name)),
      }));
    await writeZip(zipPath, entries);

    await assert.rejects(
      () => analyzerFor(parser.override).executeImportPlan(zipPath, plan, { confirm: true }),
      /备份完整性校验失败/,
      '校验后被换掉的归档必须在写盘前重新校验时失败（绝不能因为「刚才校验过」就放行）',
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('归档身份变化（大小/mtime）→ 只读缓存立即失效', async () => {
  clearVerifiedBundleCache();
  const { zipPath, tmp } = await buildBundle(SETTINGS);
  const longer = JSON.stringify({ version: 1, namespaces: { llm: { value: { model: 'deepseek-reasoner', extra: 'x'.repeat(64) }, revision: 2, secrets: [] } } });
  try {
    const parser = countingParser();
    await analyzerFor(parser.override).analyzeImport(zipPath);
    assert.equal(parser.calls(), 1);
    // 同一路径换成另一份归档（内容更长 → size 变）；再把 mtime 也设成固定值，
    // 证明失效判据不是「碰巧 mtime 变了」而是 size 本身进了身份。
    const rebuilt = await buildBundle(longer);
    await fs.copyFile(rebuilt.zipPath, zipPath);
    await fs.utimes(zipPath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    await analyzerFor(parser.override).createImportPlan(zipPath, DECISIONS);
    assert.equal(parser.calls(), 2, 'size 变了必须重新解析（否则等于用旧包的校验结果签新包）');
    await fs.rm(rebuilt.tmp, { recursive: true, force: true });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/**
 * t14 / core-F1 回归：**同一个 Importer 实例**上 plan → execute 也必须重新读盘 + 重新校验。
 *
 * 为什么补这条：跨实例的 TOCTOU 已有用例覆盖，但生产里存在同实例调用者
 * （src/sync/sync-engine.ts:1252 createImportPlan → :1286 executeImportPlan 用的是同一个
 * this.importer），且 Importer 是 docs/contracts/headless-consumption.md 的门面契约。
 * 修前实测：同实例 execute 吃实例级 bundleCache → 篡改归档不被发现、返回 ok:true。
 */
test('同实例 TOCTOU：plan 之后换包 → 同一 Importer 实例的 execute 也必须重新校验（不得吃实例缓存）', async () => {
  clearVerifiedBundleCache();
  const { zipPath, tmp } = await buildBundle(SETTINGS);
  try {
    const parser = countingParser();
    // 一个实例跑完 plan + execute（与 sync-engine.applyMergePlan 的生产形态同构）
    const importer = new Importer({
      ctx: makeContext('linux', '/home/bob'),
      adapters: createAdapters({ namespaces: ['llm'] }),
      snapshotStore: new MemSnapshotStore(),
      parseZipOverride: parser.override,
    });
    const plan = await importer.createImportPlan(zipPath, DECISIONS);
    assert.equal(parser.calls(), 1, 'plan 首次必须真解析');

    // 篡改：settings 内容变了，checksums.json 仍是旧的
    const tampered = JSON.stringify({ version: 1, namespaces: { llm: { value: { model: 'evil-model' }, revision: 1, secrets: [] } } });
    const raw = await fs.readFile(zipPath);
    const archive = parseZip(raw);
    const entries = archive.names()
      .filter((name) => !name.endsWith('/'))
      .map((name) => ({
        name,
        data: name === 'config/settings.json' ? Buffer.from(tampered, 'utf8') : Buffer.from(archive.readEntry(name)),
      }));
    await writeZip(zipPath, entries);

    await assert.rejects(
      () => importer.executeImportPlan(zipPath, plan, { confirm: true }),
      /备份完整性校验失败/,
      '同一实例上被换掉的归档也必须在写盘前重新校验时失败',
    );
    assert.equal(parser.calls(), 2, 'execute 必须重新解析归档（同实例不得复用实例缓存）');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
