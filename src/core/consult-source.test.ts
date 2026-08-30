/**
 * 迁移前咨询源读取（Phase 7）单测。
 * 覆盖：export-zip 读取（manifest/checksums/sections/敏感暴露/可迁移性）、
 * local-snapshot 与 profile 合成源构建。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from './exporter.ts';
import { createAdapters } from '../adapters/index.ts';
import { makeContext } from '../adapters/test-helpers.ts';
import { readExportZipSource, buildLocalSnapshotSource, buildProfileSource } from './consult-source.ts';
import { writeZip } from '../utils/zip.ts';
import { buildManifest } from '../schema/manifest.ts';
import { buildChecksums } from '../utils/hashing.ts';
import type { SectionId } from '../schema/types.ts';
import type { ConsultSourceRef } from './migration-consult.ts';

const NS = ['general', 'theme', 'llm-deepseek', 'llm-pi-ai'];

async function seedSource(ctx: ReturnType<typeof makeContext>): Promise<void> {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-super-secret-value-123' },
    revision: 5,
    secrets: [{ path: ['apiKey'], set: true }],
  });
  ctx.credentials.values.set('DEEPSEEK_API_KEY', 'sk-super-secret-value-123');
  await ctx.fs.writeFile('skills/coding.md', Buffer.from('# Coding skill\nUse deepseek.\n', 'utf8'));
}

async function buildZip(): Promise<{ zipPath: string; tmp: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-consult-'));
  const src = makeContext('win32', 'C:\\Users\\alice');
  await seedSource(src);
  const adapters = createAdapters({ namespaces: NS });
  const zipPath = path.join(tmp, 'dsh-config-consult.zip');
  await new Exporter({
    ctx: src, adapters, exporterVersion: '0.1.0',
    now: () => new Date('2026-08-14T12:00:00.000Z'),
  }).export({ includeSecrets: false, outPath: zipPath });
  return { zipPath, tmp };
}

test('consult-source: 读取合法导出 ZIP → 归一化数据完整', async () => {
  const { zipPath, tmp } = await buildZip();
  try {
    const ref: ConsultSourceRef = { type: 'export-zip', id: zipPath };
    const data = await readExportZipSource(ref, zipPath, {
      computeMigratability: async () => ({ ok: true, itemCount: 3, fatalConflicts: 0, warnings: 0, sections: ['settings', 'providers'], errors: [] }),
    });
    assert.ok(data.manifest !== null);
    assert.equal(data.manifest.schemaVersion, 1);
    assert.equal(data.manifestIssues.length, 0);
    assert.equal(data.checksumIssues.length, 0);
    assert.equal(data.zipSlipIssues.length, 0);
    assert.ok(data.sections.has('settings'));
    assert.ok(data.sections.has('providers'));
    assert.equal(data.migratability?.ok, true);
    assert.equal(data.migratability?.itemCount, 3);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('consult-source: 敏感暴露面（含明文 secret 的源被检测）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-consult-sec-'));
  try {
    // 构造含明文 apiKey 的 ZIP（模拟未脱敏源）
    const sectionFlags = {} as Record<string, boolean>;
    for (const sid of ['settings', 'ui', 'providers', 'plugins', 'mcp', 'prompts', 'skills', 'agentPresets', 'agentInstructions', 'workspaces', 'pluginFiles', 'credentialsStatus', 'secrets', 'sessions', 'self']) {
      sectionFlags[sid] = false;
    }
    sectionFlags.settings = true;
    const manifest = buildManifest({
      exporterVersion: '0.1.0',
      dshVersion: '0.1.54',
      platform: 'win32',
      arch: 'x64',
      sections: sectionFlags as Record<SectionId, boolean>,
      containsSecrets: true,
      encrypted: false,
      encryption: null,
    });
    const settingsJson = JSON.stringify({ version: 1, namespaces: { llm: { value: { apiKey: 'sk-plaintext-secret-1234567890' } } } });
    const entries = [
      { name: 'config/settings.json', data: Buffer.from(settingsJson, 'utf8') },
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    ];
    const checksums = buildChecksums(entries);
    entries.push({ name: 'integrity/checksums.json', data: Buffer.from(JSON.stringify(checksums), 'utf8') });
    const zipPath = path.join(tmp, 'leaky.zip');
    await writeZip(zipPath, entries);

    const ref: ConsultSourceRef = { type: 'export-zip', id: zipPath };
    const data = await readExportZipSource(ref, zipPath);
    assert.ok(data.sensitiveHits.some((h) => h.path.includes('settings')), '应检测到 settings 分区敏感字段');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('consult-source: 损坏 ZIP → zipSlipIssues 捕获，不抛错', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-consult-bad-'));
  try {
    const badPath = path.join(tmp, 'bad.zip');
    await fs.writeFile(badPath, Buffer.from('not a zip'));
    const ref: ConsultSourceRef = { type: 'export-zip', id: badPath };
    const data = await readExportZipSource(ref, badPath);
    assert.ok(data.zipSlipIssues.length > 0);
    assert.equal(data.manifest, null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('consult-source: local-snapshot 合成源（verify ok → 无完整性问题）', () => {
  const ref: ConsultSourceRef = { type: 'local-snapshot', id: 'snap-1', snapshotId: 'snap-1' };
  const data = buildLocalSnapshotSource(ref, {
    sections: new Map([['settings', {}]]),
    verify: { ok: true },
    restorePlan: { itemCount: 4, conflicts: 0, warnings: 1, sections: ['settings'], errors: [] },
    sourceDsh: '0.1.54',
    sourcePlatform: 'win32',
  });
  assert.ok(data.manifest !== null);
  assert.equal(data.manifestIssues.length, 0);
  assert.equal(data.checksumIssues.length, 0);
  assert.equal(data.migratability?.itemCount, 4);
  assert.equal(data.migratability?.warnings, 1);
});

test('consult-source: local-snapshot 合成源（verify fail → 完整性问题）', () => {
  const ref: ConsultSourceRef = { type: 'local-snapshot', id: 'snap-1', snapshotId: 'snap-1' };
  const data = buildLocalSnapshotSource(ref, {
    sections: new Map(),
    verify: { ok: false, reason: 'blob hash 不匹配' },
    restorePlan: { itemCount: 0, conflicts: 0, warnings: 0, sections: [], errors: [] },
    sourceDsh: '0.1.54',
    sourcePlatform: 'win32',
  });
  assert.ok(data.manifestIssues.some((i) => i.severity === 'error'));
  assert.ok(data.checksumIssues.length > 0);
});

test('consult-source: profile 合成源', () => {
  const ref: ConsultSourceRef = { type: 'profile', id: 'work' };
  const data = buildProfileSource(ref, {
    sections: new Map([['settings', {}], ['providers', {}]]),
    switchPreview: { itemCount: 5, conflicts: 1, warnings: 0, sections: ['settings', 'providers'], errors: [] },
    sourceDsh: '0.1.54',
    sourcePlatform: 'win32',
  });
  assert.ok(data.manifest !== null);
  assert.equal(data.migratability?.itemCount, 5);
  assert.equal(data.migratability?.fatalConflicts, 1);
  assert.equal(data.sections.size, 2);
});

test('consult-source: READ-ONLY（咨询不写任何文件）', async () => {
  const { zipPath, tmp } = await buildZip();
  try {
    // 记录咨询前目录指纹（相对路径 + 大小 + mtime）
    const fingerprint = async (): Promise<string> => {
      const out: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) {
            await walk(p);
          } else {
            const st = await fs.stat(p);
            out.push(`${path.relative(tmp, p)}:${st.size}:${st.mtimeMs}`);
          }
        }
      };
      await walk(tmp);
      return out.sort().join('\n');
    };
    const before = await fingerprint();

    // 执行完整咨询（读取 + 评分）
    const ref: ConsultSourceRef = { type: 'export-zip', id: zipPath };
    const data = await readExportZipSource(ref, zipPath, {
      computeMigratability: async () => ({ ok: true, itemCount: 1, fatalConflicts: 0, warnings: 0, sections: ['settings'], errors: [] }),
    });
    const { computeConsultReport } = await import('./migration-consult.ts');
    computeConsultReport(data, { targetDsh: '0.1.54', targetPlatform: 'win32' });

    const after = await fingerprint();
    assert.equal(after, before, '咨询不得写任何文件（目录指纹应一致）');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
