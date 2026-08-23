/**
 * Export 矩阵测试（m7-tests-docs；规范 §33 Export 组 / §36 场景 A/C）。
 *
 * 覆盖：正常导出 / 空配置 / 大配置 / Unicode / 特殊字符 / Secret 过滤。
 * 全部基于内存 mock 的 HostContext（src/adapters/test-helpers.ts），
 * ZIP 结构断言用真实 parseZip；与 src 内测试不重复。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { Exporter } from '../../src/core/exporter.ts';
import { createAdapters } from '../../src/adapters/index.ts';
import { parseZip } from '../../src/utils/zip.ts';
import { sha256Hex } from '../../src/utils/hashing.ts';
import { parseManifest, CHECKSUMS_FILE, MANIFEST_FILE } from '../../src/schema/manifest.ts';
import { createSecretScanner } from '../../src/security/secret-scanner.ts';
import { makeContext, type MockHostContext } from '../../src/adapters/test-helpers.ts';
import type { Manifest } from '../../src/schema/types.ts';

const NS = ['general', 'theme', 'llm-deepseek', 'llm-pi-ai'];

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-export-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 组装完整源（覆盖全部默认包含分区） */
async function seedFullSource(ctx: MockHostContext): Promise<void> {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('theme', { value: { mode: 'dark' }, revision: 1, secrets: [] });
  ctx.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-super-secret-value-123' },
    revision: 5,
    secrets: [{ path: ['apiKey'], set: true }],
  });
  ctx.credentials.values.set('DEEPSEEK_API_KEY', 'sk-super-secret-value-123');
  await ctx.fs.writeFile('skills/coding.md', Buffer.from('# Coding skill\nUse deepseek.\n', 'utf8'));
  await ctx.fs.writeFile('.agent-presets/work/agent.cordis.yml', Buffer.from('services:\n  - name: work\n', 'utf8'));
  await ctx.fs.writeFile('dsh-ssh.json', Buffer.from('{"hosts":[]}', 'utf8'));
  ctx.workspace.records.set('ws-ops', {
    id: 'ws-ops', path: 'C:\\Users\\alice\\projects\\ops', title: 'OpsFlow', sessionIds: [],
  });
  ctx.patchFile.lines.set('mcp-fs', {
    lineId: 'mcp-fs',
    raw: { id: 'mcp-fs', name: 'dsh-mcp-client', config: { serverName: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] } },
  });
}

test('E-01 正常导出：全分区 ZIP 结构 + manifest + checksums 可校验 + 报告', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await seedFullSource(src);
    const adapters = createAdapters({ namespaces: NS });
    const zipPath = path.join(dir, 'dsh-config-e01.zip');

    const result = await new Exporter({
      ctx: src, adapters, exporterVersion: '0.1.0', scanner: createSecretScanner(),
      now: () => new Date('2026-08-14T12:00:00.000Z'),
    }).export({ includeSecrets: false, outPath: zipPath });

    // manifest 完整性
    const manifest: Manifest = result.manifest;
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.exporter.name, 'DSH Config Manager');
    assert.equal(manifest.exporter.version, '0.1.0');
    assert.equal(manifest.source.platform, 'win32');
    assert.equal(manifest.source.dshVersion, '0.1.0-rc.6');
    assert.equal(manifest.security.containsSecrets, false);
    assert.equal(manifest.security.encrypted, false);
    for (const section of ['settings', 'ui', 'providers', 'plugins', 'mcp', 'prompts', 'skills', 'agentPresets', 'workspaces', 'credentialsStatus'] as const) {
      assert.equal(manifest.sections[section], true, `分区 ${section} 应包含`);
    }

    // ZIP 条目齐全
    const archive = parseZip(await fs.readFile(zipPath));
    for (const entry of ['config/settings.json', 'config/ui.json', 'ai/providers.json', 'plugins/plugins.json', 'mcp/servers.json', 'custom/prompts.json', 'custom/skills/coding.md', 'agents/presets/work/agent.cordis.yml', 'workspaces/workspaces.json', 'security/credentials.json']) {
      assert.ok(archive.has(entry), `ZIP 应包含 ${entry}`);
    }

    // checksums 逐一可校验（排除 manifest/checksums 自身）
    const checksums = archive.readEntryJson(CHECKSUMS_FILE) as Record<string, string>;
    const names = archive.names().filter((n) => n !== MANIFEST_FILE && n !== CHECKSUMS_FILE);
    assert.equal(names.length, Object.keys(checksums).length, 'checksums 表条目数与 ZIP 文件数一致');
    for (const name of names) {
      assert.equal(sha256Hex(archive.readEntry(name)), checksums[name], `${name} checksum 应匹配`);
    }

    // 报告字段
    assert.ok(result.report.included.some((i) => i.section === 'settings' && i.counts.namespaces === 2), '报告应含 settings 计数');
    assert.ok(result.report.file.name.endsWith('.zip'));
    assert.equal(result.report.security.secretsExcluded, true);
    assert.equal(result.report.security.containsSecrets, false);
  });
});

test('E-02 空配置：导出成功，manifest 合法，无数据也产生有效 ZIP', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('linux', '/home/empty');
    // 不注入任何配置
    const adapters = createAdapters({ namespaces: [] });
    const zipPath = path.join(dir, 'dsh-config-e02.zip');

    const result = await new Exporter({ ctx: src, adapters, now: () => new Date('2026-08-14T12:00:00.000Z') })
      .export({ includeSecrets: false, outPath: zipPath });

    assert.equal(result.manifest.schemaVersion, 1);
    const archive = parseZip(await fs.readFile(zipPath));
    assert.ok(archive.has(MANIFEST_FILE), '空导出也应有 manifest.json');
    assert.ok(archive.has(CHECKSUMS_FILE), '空导出也应有 checksums.json');
    // 空配置的 settings 分区存在但无 namespace（adapter 返回空对象，不报错）
    const settings = archive.readEntryJson('config/settings.json') as { namespaces: Record<string, unknown> };
    assert.deepEqual(settings.namespaces, {});
  });
});

test('E-03 大配置：1MB+ 技能文件 + 大量 namespace，往返校验一致', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('linux', '/home/big');
    // 大技能文件（1MB+，用真随机内容避免可压缩性触发 zip bomb 压缩比上限）
    const bigContent = crypto.randomBytes(1024 * 1024);
    await src.fs.writeFile('skills/big.md', bigContent);
    // 大量 namespace
    for (let i = 0; i < 200; i++) {
      src.settings.ns.set(`ns-${i}`, { value: { index: i, label: `label-${i}` }, revision: i, secrets: [] });
    }
    const adapters = createAdapters({ namespaces: Array.from({ length: 200 }, (_, i) => `ns-${i}`) });
    const zipPath = path.join(dir, 'dsh-config-e03.zip');

    const result = await new Exporter({ ctx: src, adapters, now: () => new Date('2026-08-14T12:00:00.000Z') })
      .export({ includeSecrets: false, outPath: zipPath });

    const archive = parseZip(await fs.readFile(zipPath));
    const extracted = archive.readEntry('custom/skills/big.md');
    assert.equal(extracted.length, 1024 * 1024, '大文件解压后应保持 1MB');
    assert.deepEqual(Buffer.from(extracted), bigContent, '大文件内容一致');
    const checksums = archive.readEntryJson(CHECKSUMS_FILE) as Record<string, string>;
    for (const name of archive.names().filter((n) => n !== MANIFEST_FILE && n !== CHECKSUMS_FILE)) {
      assert.equal(sha256Hex(archive.readEntry(name)), checksums[name]!, `${name} checksum 匹配`);
    }
    assert.ok(result.report.file.sizeBytes > 0);
  });
});

test('E-04 Unicode：中文 / emoji / 换行 / 引号 / 特殊符号往返一致', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('darwin', '/Users/宇');
    src.settings.ns.set('general', {
      value: {
        language: '中文',
        greeting: '你好，世界！🚀',
        multiline: '第一行\n第二行\t制表符',
        quotes: '他说："你好" \'单引号\'',
        specials: '& < > % $ # @ ! * ( )',
        unicode: '\u0000\u001f\u007f中文',
      },
      revision: 1,
      secrets: [],
    });
    await src.fs.writeFile('skills/技能 文件.md', Buffer.from('# 技能\nemoji 🎉 特殊字符 & " \'  < >\n', 'utf8'));
    const adapters = createAdapters({ namespaces: ['general'] });
    const zipPath = path.join(dir, 'dsh-config-e04.zip');

    await new Exporter({ ctx: src, adapters, now: () => new Date('2026-08-14T12:00:00.000Z') })
      .export({ includeSecrets: false, outPath: zipPath });

    const archive = parseZip(await fs.readFile(zipPath));
    const settings = archive.readEntryJson('config/settings.json') as { namespaces: Record<string, { value: Record<string, unknown> }> };
    assert.deepEqual(settings.namespaces.general?.value, {
      language: '中文',
      greeting: '你好，世界！🚀',
      multiline: '第一行\n第二行\t制表符',
      quotes: '他说："你好" \'单引号\'',
      specials: '& < > % $ # @ ! * ( )',
      unicode: '\u0000\u001f\u007f中文',
    });
    const skill = Buffer.from(archive.readEntry('custom/skills/技能 文件.md')).toString('utf8');
    assert.equal(skill, '# 技能\nemoji 🎉 特殊字符 & " \'  < >\n');
  });
});

test('E-05 特殊字符：路径含空格/中文/&，文件名含特殊字符', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await src.fs.writeFile('skills/my skill & 技能.md', Buffer.from('# skill\n', 'utf8'));
    const adapters = createAdapters({ namespaces: [] });
    const zipPath = path.join(dir, 'dsh config 2026 & 备份.zip');

    await new Exporter({ ctx: src, adapters, now: () => new Date('2026-08-14T12:00:00.000Z') })
      .export({ includeSecrets: false, outPath: zipPath });

    const archive = parseZip(await fs.readFile(zipPath));
    assert.ok(archive.has('custom/skills/my skill & 技能.md'), '特殊字符文件名的技能应保留');
  });
});

test('E-06 Secret 过滤：敏感字段剥离、引用豁免、redactedHits 计数、ZIP 全文本无秘密值', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.settings.ns.set('llm-pi-ai', {
      value: {
        providers: {
          openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com', models: ['gpt-4o'] },
          custom: { apiKey: 'sk-CUSTOM-SECRET-999', baseURL: 'https://x.example.com' },
        },
      },
      revision: 2,
      secrets: [],
    });
    src.settings.ns.set('general', { value: { password: 'hunter2', token: 'abc123token' }, revision: 1, secrets: [] });
    src.credentials.values.set('OPENAI_API_KEY', 'sk-openai-456');
    const adapters = createAdapters({ namespaces: ['llm-pi-ai', 'general'] });
    const zipPath = path.join(dir, 'dsh-config-e06.zip');

    const result = await new Exporter({
      ctx: src, adapters, // 缺省 scanner = 字段名黑名单剥离（defaultSecretScanner）
      now: () => new Date('2026-08-14T12:00:00.000Z'),
    }).export({ includeSecrets: false, outPath: zipPath });

    // 报告应记录剥离命中（password / token / apiKey 三个敏感字段）
    assert.ok(result.report.security.redactedHits >= 3, `redactedHits 应 >=3，实际 ${result.report.security.redactedHits}`);

    // ZIP 全文本（除 checksums）不得含任何秘密值
    const archive = parseZip(await fs.readFile(zipPath));
    const allText = archive.names()
      .filter((n) => n !== CHECKSUMS_FILE)
      .map((n) => Buffer.from(archive.readEntry(n)).toString('utf8'))
      .join('\n');
    for (const secret of ['sk-CUSTOM-SECRET-999', 'hunter2', 'abc123token', 'sk-openai-456']) {
      assert.ok(!allText.includes(secret), `秘密值 ${secret} 不得写入导出`);
    }

    // 引用豁免：apiKeyEnv 只存环境变量名，保留
    const providers = archive.readEntryJson('ai/providers.json') as { providers: Record<string, { apiKeyEnv?: string; apiKey?: string }> };
    assert.equal(providers.providers.openai?.apiKeyEnv, 'OPENAI_API_KEY', 'apiKeyEnv 引用应保留');
    assert.equal(providers.providers.custom?.apiKey, '', 'apiKey 值应剥离为空串');
  });
});

test('E-07 文件级 vault：includeSecrets=false 时敏感文件镜像到本机 vault，报告标记，ZIP 无明文', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    const secret = 'sk-vaulT-secret-777';
    await src.fs.writeFile(path.join(src.homeDir, '.credentials.yaml'), Buffer.from(`apiKey: ${secret}\n`, 'utf8'));
    const adapters = createAdapters({ namespaces: [] });
    const zipPath = path.join(dir, 'dsh-config-e07.zip');

    const result = await new Exporter({ ctx: src, adapters, now: () => new Date('2026-08-14T12:00:00.000Z') })
      .export({ includeSecrets: false, outPath: zipPath });

    // 报告标记 + 提示（vault 镜像走报告字段，manifest 不加字段）
    assert.equal(result.report.security.vaultRefreshed, 1, '报告应标记 vault 镜像 1 个文件');
    assert.ok(result.report.warnings.some((w) => w.includes('vault')), '报告应含 vault 提示');

    // vault 镜像落盘且字节一致（vault 只在本机，不进归档/同步）
    const vaultPath = path.join(src.homeDir, 'dsh-config-manager', 'vault', '.credentials.yaml');
    assert.equal(await src.fs.exists(vaultPath), true, 'vault 镜像应存在');
    assert.deepEqual(
      Buffer.from(await src.fs.readFile(vaultPath)),
      Buffer.from(`apiKey: ${secret}\n`, 'utf8'),
      'vault 镜像字节应与源一致',
    );

    // ZIP 全文本不含明文秘密
    const archive = parseZip(await fs.readFile(zipPath));
    const allText = archive.names()
      .filter((n) => n !== CHECKSUMS_FILE)
      .map((n) => Buffer.from(archive.readEntry(n)).toString('utf8'))
      .join('\n');
    assert.ok(!allText.includes(secret), '秘密值不得写入导出');
    assert.ok(!archive.has('security/secrets.enc'), '无加密提供者时不生成 secrets.enc');
  });
});

test('E-08 无敏感文件：vault 刷新为空，报告不产生 vault 提示', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('linux', '/home/empty');
    const adapters = createAdapters({ namespaces: [] });
    const zipPath = path.join(dir, 'dsh-config-e08.zip');

    const result = await new Exporter({ ctx: src, adapters, now: () => new Date('2026-08-14T12:00:00.000Z') })
      .export({ includeSecrets: false, outPath: zipPath });

    assert.equal(result.report.security.vaultRefreshed, 0, '无敏感文件时 vault 镜像数为 0');
    assert.ok(!result.report.warnings.some((w) => w.includes('vault')), '无敏感文件时不应产生 vault 提示');
  });
});
