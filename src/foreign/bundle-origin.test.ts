/**
 * 外部来源包的「溯源块」（manifest.foreign）护栏 —— 2026-10-18。
 *
 * 为什么必须单独钉住：审计结论是标准 bundle v1 的 manifest 里**没有任何来源字段**，
 * 外部来源包落盘后与 DSH 自产备份**逐字同构**，用户事后无法复核「这包从哪来」。
 * 修复把来源写进 manifest.foreign（src/schema/types.ts）后，本文件守住四件事：
 *  ① 映射正确（ForeignOrigin.source → ManifestForeignOrigin.agent，字段逐字一致）；
 *  ② 向后兼容（没给 origin 时 manifest 里**不出现** foreign 键 —— 旧行为逐字不变）；
 *  ③ 完整性口径不变（foreign 不是 ZIP 条目、不参与任何条目摘要 ⇒ 同一内容在
 *     「有/无 origin」两种包里的 integrity/checksums.json 逐字相同）；
 *  ④ 端到端可消费（既有 Importer 能 analyzeImport 带 foreign 的包）+ **无值**（夹具里的
 *     假凭据子串绝不出现在 manifest/checksums/整包字节里）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAdapters } from '../adapters/index.ts';
import { MemSnapshotStore, makeContext } from '../adapters/test-helpers.ts';
import { Importer } from '../core/importer.ts';
import { CHECKSUMS_FILE, MANIFEST_FILE, parseManifest } from '../schema/manifest.ts';
import { verifyChecksums } from '../utils/hashing.ts';
import { parseZip } from '../utils/zip.ts';
import { writeForeignBundle } from './bundle.ts';
import { convertClaudeCode } from './claude-code.ts';
import type { ForeignImportResult, ForeignOrigin } from './types.ts';
import type { ManifestForeignOrigin } from '../schema/types.ts';

/** 夹具里的假凭据：它出现在**输入**（外部配置的 env 值）里，绝不允许出现在产物的 manifest 中 */
const FAKE_SECRET = 'sk-ant-BUNDLE-ORIGIN-SECRET-0123456789';

/** 一份最小的真实转换结果（含一个带凭据的 MCP server + 一份全局指令） */
function baseResult(): ForeignImportResult {
  return convertClaudeCode({
    claudeJson: {
      mcpServers: {
        svc: { command: 'npx', args: ['-y', 'svc'], env: { GITHUB_TOKEN: FAKE_SECRET } },
      },
    },
    memory: '# 全局指令' + String.fromCharCode(10),
  });
}

/**
 * 显式**不带** origin 的转换结果。
 *
 * 必须显式删除：翻译层（如 claude-code.ts）本版起会自己装配 origin，缺省即带 —— 本用例要测的是
 * **writer 的缺省分支**（旧行为逐字不变），所以夹具必须明确「这次没有 origin」，而不是碰运气。
 */
function resultWithoutOrigin(): ForeignImportResult {
  const result = baseResult();
  delete result.origin;
  return result;
}

/** 翻译层给出的溯源块（字段齐备；只有标识与计数，无任何配置值） */
const ORIGIN: ForeignOrigin = {
  source: 'claude-code',
  locations: ['.claude.json', '.claude/CLAUDE.md'],
  sourceVersion: '1.2.3',
  projects: ['D:/proj/app'],
  plugins: [{
    name: 'demo-plugin',
    version: '1.0.0',
    marketplace: 'demo-mkt',
    repo: 'owner/repo',
    ref: 'main',
    components: ['skills', 'mcp'],
  }],
  skipped: [{ code: 'unsupported-hooks', count: 2 }, { code: 'unsupported-commands', count: 5 }],
  credentialRefs: ['mcp:svc:GITHUB_TOKEN'],
};

/** 期望落进 manifest 的形状：唯一差异是 source → agent */
const EXPECTED_FOREIGN: ManifestForeignOrigin = {
  agent: 'claude-code',
  locations: ['.claude.json', '.claude/CLAUDE.md'],
  sourceVersion: '1.2.3',
  projects: ['D:/proj/app'],
  plugins: [{
    name: 'demo-plugin',
    version: '1.0.0',
    marketplace: 'demo-mkt',
    repo: 'owner/repo',
    ref: 'main',
    components: ['skills', 'mcp'],
  }],
  skipped: [{ code: 'unsupported-hooks', count: 2 }, { code: 'unsupported-commands', count: 5 }],
  credentialRefs: ['mcp:svc:GITHUB_TOKEN'],
};

interface ReadBack {
  names: string[];
  manifest: Record<string, unknown>;
  manifestText: string;
  checksums: Record<string, string>;
  checksumsText: string;
  /** 内容条目（排除 manifest.json / integrity/checksums.json），供 verifyChecksums 复算 */
  contentEntries: Map<string, Uint8Array>;
}

async function readBack(zipPath: string): Promise<ReadBack> {
  const archive = parseZip(await fs.readFile(zipPath));
  const contentEntries = new Map<string, Uint8Array>();
  for (const name of archive.names()) {
    if (name === MANIFEST_FILE || name === CHECKSUMS_FILE) continue;
    contentEntries.set(name, archive.readEntry(name));
  }
  return {
    names: archive.names(),
    manifest: JSON.parse(archive.readEntryText(MANIFEST_FILE)) as Record<string, unknown>,
    manifestText: archive.readEntryText(MANIFEST_FILE),
    checksums: JSON.parse(archive.readEntryText(CHECKSUMS_FILE)) as Record<string, string>,
    checksumsText: archive.readEntryText(CHECKSUMS_FILE),
    contentEntries,
  };
}

/** 写两个包：带 origin（A）与不带 origin（B）。内容逐字相同，只有 manifest 应不同。 */
async function writePair(tmp: string): Promise<{ a: string; b: string }> {
  const a = path.join(tmp, 'with-origin.zip');
  const b = path.join(tmp, 'without-origin.zip');
  const common = {
    exporterVersion: '0.0.0-test',
    dshVersion: '0.1.0',
    platform: 'win32' as const,
    arch: 'x64',
    // 固定时间：两包的 manifest 差异必须只来自 foreign
    exportedAt: '2026-10-18T00:00:00.000Z',
  };
  const resultA: ForeignImportResult = { ...baseResult(), origin: ORIGIN };
  const resultB: ForeignImportResult = resultWithoutOrigin();
  await writeForeignBundle({ result: resultA, outPath: a, ...common });
  await writeForeignBundle({ result: resultB, outPath: b, ...common });
  return { a, b };
}

test('O-01 origin → manifest.foreign：source 映射为 agent，字段逐字一致、无残留 source 键', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-foreign-origin-'));
  try {
    const { a } = await writePair(tmp);
    const read = await readBack(a);
    assert.deepEqual(read.manifest['foreign'], EXPECTED_FOREIGN, 'foreign 必须与入参一致且完成 source→agent 映射');
    // assert.deepEqual 带断言签名，会把上一行的取窄成 ManifestForeignOrigin；这里显式经 unknown 取原始对象
    const foreign = read.manifest['foreign'] as unknown as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(foreign, 'source'), false, '对外契约字段名是 agent，不得残留 source');
    // 溯源块不是 ZIP 条目：既不加条目、也不进分区
    assert.equal(read.names.includes('foreign'), false, 'foreign 只进 manifest.json，不得成为 ZIP 条目');
    assert.equal(read.names.includes('manifest.foreign'), false);
    // 可被既有读侧解析（宽容校验通过、零 error）
    const parsed = parseManifest(read.manifestText);
    assert.deepEqual(parsed.foreign, EXPECTED_FOREIGN, 'parseManifest 必须逐字保留 foreign');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('O-02 未给 origin ⇒ manifest 里没有 foreign 键（旧行为逐字不变）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-foreign-no-origin-'));
  try {
    const { b } = await writePair(tmp);
    const read = await readBack(b);
    assert.equal(
      Object.prototype.hasOwnProperty.call(read.manifest, 'foreign'), false,
      'origin 缺省时必须不写 foreign（旧包与自产备份保持同构）',
    );
    assert.equal(read.manifestText.includes('"foreign"'), false, '序列化文本里也不得出现该键');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('O-03 checksums 口径不变：有/无 origin 两包对同一内容条目摘要逐字相同且自校验通过', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-foreign-checksums-'));
  try {
    const { a, b } = await writePair(tmp);
    const readA = await readBack(a);
    const readB = await readBack(b);
    // 两包内容条目集合相同（foreign 不新增条目）
    assert.deepEqual([...readA.contentEntries.keys()].sort(), [...readB.contentEntries.keys()].sort());
    // 逐条摘要相同 —— 这是「manifest 变化绝不影响既有条目摘要」的直接证据
    assert.deepEqual(readA.checksums, readB.checksums, 'foreign 不得改变任何既有条目的摘要');
    assert.ok(Object.keys(readA.checksums).length > 0, '两包必须有内容条目（否则本用例无意义）');
    // checksums 自身不含 manifest.json / checksums.json 的条目
    assert.equal(Object.prototype.hasOwnProperty.call(readA.checksums, MANIFEST_FILE), false);
    assert.equal(Object.prototype.hasOwnProperty.call(readA.checksums, CHECKSUMS_FILE), false);
    // 摘要与包内实际字节一致（既有完整性口径）
    for (const read of [readA, readB]) {
      const verified = verifyChecksums(read.contentEntries, read.checksums);
      assert.deepEqual(verified, { ok: true, mismatches: [], missing: [] }, 'checksums 必须能自校验通过');
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('O-04 端到端可消费：既有 Importer 能 analyzeImport 带 foreign 的包', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-foreign-e2e-origin-'));
  try {
    const { a } = await writePair(tmp);
    const ctx = makeContext('win32', path.join(tmp, 'target-home'));
    const importer = new Importer({ ctx, adapters: createAdapters(), snapshotStore: new MemSnapshotStore() });
    const analysis = await importer.analyzeImport(a);
    assert.equal(analysis.valid, true, '带 foreign 的包必须仍是合法 bundle：' + JSON.stringify(analysis.errors));
    assert.ok(analysis.sectionsInZip.includes('mcp'), '既有分区必须照常识别：' + JSON.stringify(analysis.sectionsInZip));
    assert.deepEqual(analysis.errors, [], 'foreign 不得产生任何 error');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('O-05 无值不变量：夹具里的假凭据子串不出现在 manifest.foreign / checksums / 整包字节里', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-foreign-no-secret-'));
  try {
    const { a, b } = await writePair(tmp);
    for (const zipPath of [a, b]) {
      const read = await readBack(zipPath);
      assert.equal(read.manifestText.includes(FAKE_SECRET), false, 'manifest 文本里不得出现凭据值');
      assert.equal(read.checksumsText.includes(FAKE_SECRET), false, 'checksums 文本里不得出现凭据值');
      assert.equal(
        JSON.stringify(read.manifest['foreign'] ?? {}).includes(FAKE_SECRET), false,
        'foreign 块里不得出现凭据值（只允许引用名）',
      );
      const bytes = await fs.readFile(zipPath);
      assert.equal(bytes.includes(Buffer.from(FAKE_SECRET, 'utf8')), false, '整包字节里不得出现凭据明文');
    }
    // 引用名（只有名字）仍如实保留 —— 证明「不搬运值，但也不隐瞒有凭据」这条纪律没被本改动破坏
    const readA = await readBack(a);
    assert.deepEqual((readA.manifest['foreign'] as ManifestForeignOrigin).credentialRefs, ['mcp:svc:GITHUB_TOKEN']);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('O-06 真实翻译层的 origin 一路落到 manifest.foreign（该来源本版未装配 origin 时自动跳过）', async (t) => {
  const translated = baseResult();
  if (translated.origin === undefined) {
    t.skip('该来源本版未装配 origin（writer 的缺省分支已由 O-02 覆盖）');
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-foreign-translated-origin-'));
  try {
    const zipPath = path.join(tmp, 'translated.zip');
    await writeForeignBundle({
      result: translated,
      outPath: zipPath,
      exporterVersion: '0.0.0-test',
      dshVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      exportedAt: '2026-10-18T00:00:00.000Z',
    });
    const read = await readBack(zipPath);
    const foreign = read.manifest['foreign'] as ManifestForeignOrigin | undefined;
    assert.ok(foreign !== undefined, '翻译层给了 origin，manifest 里就必须有 foreign');
    assert.equal(foreign.agent, translated.origin.source, 'agent 必须等于翻译层的 source');
    assert.ok(Array.isArray(foreign.locations), 'locations 必须是数组（可为空）');
    // 审计要点：外部来源包必须能被区分出来（不再与 DSH 自产备份逐字同构）
    assert.equal(read.manifestText.includes('"foreign"'), true, 'manifest 文本里必须可见 foreign');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
