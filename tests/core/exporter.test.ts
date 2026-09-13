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

/* ---------------- G-09：文件类分区内容必须进扫描器（只告警，不改写） ---------------- */

test('G-09 文件类分区扫描：技能文件里的凭据 → 告警 + 计入 redactedHits，且内容原样不改写', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('linux', '/home/g09');
    const secretLine = 'apiKey: "sk-live-file-section-9f3a2b7c1d4e"';
    const skillText = `# Deploy skill\n${secretLine}\nrun the pipeline\n`;
    await src.fs.writeFile('skills/deploy.md', Buffer.from(skillText, 'utf8'));
    const adapters = createAdapters({ namespaces: [] });
    const zipPath = path.join(dir, 'dsh-config-g09.zip');

    const result = await new Exporter({
      ctx: src, adapters,
      scanner: createSecretScanner(), // 强化扫描器：含 scanText
      now: () => new Date('2026-08-14T12:00:00.000Z'),
    }).export({ includeSecrets: false, outPath: zipPath });

    // 1) 必须告警（分区 + 文件路径），文案可操作
    const warn = result.report.warnings.find((w) => w.includes('skills') && w.includes('deploy.md'));
    assert.ok(warn !== undefined, `应告警文件类分区命中，实际 warnings=${JSON.stringify(result.report.warnings)}`);
    assert.ok(warn!.includes('疑似凭据'), '告警文案应说明检测到疑似凭据');
    assert.ok(!warn!.includes('sk-live-file-section'), '告警绝不能带凭据值');
    // 2) 命中必须计入 redactedHits
    assert.ok(result.report.security.redactedHits >= 1, `文件类分区命中应计入 redactedHits，实际 ${result.report.security.redactedHits}`);
    // 3) 关键设计约束：只告警、不改写 —— 文件内容字节级原样进入 ZIP
    const archive = parseZip(await fs.readFile(zipPath));
    const exported = Buffer.from(archive.readEntry('custom/skills/deploy.md')).toString('utf8');
    assert.equal(exported, skillText, '文件类分区内容不得被静默改写/剥离（只告警）');
    // 4) 告警不改变 checksums 覆盖范围（条目仍逐一可校验）
    const checksums = archive.readEntryJson(CHECKSUMS_FILE) as Record<string, string>;
    for (const name of archive.names().filter((n) => n !== MANIFEST_FILE && n !== CHECKSUMS_FILE)) {
      assert.equal(sha256Hex(archive.readEntry(name)), checksums[name]!, `${name} checksum 匹配`);
    }
  });
});

test('G-09 文件类分区扫描：二进制文件跳过（不产生误报）；无 scanText 的扫描器不扫（行为不变）', async () => {
  await withTmp(async (dir) => {
    // 1) 二进制（含 NUL）不按文本扫描
    const src = makeContext('linux', '/home/g09b');
    const binary = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]),
      Buffer.from('password: "sk-live-binary-should-be-skipped"', 'utf8'),
    ]);
    await src.fs.writeFile('skills/blob.png', binary);
    const adapters = createAdapters({ namespaces: [] });
    const zipPath = path.join(dir, 'dsh-config-g09b.zip');

    const scanned = await new Exporter({
      ctx: src, adapters,
      scanner: createSecretScanner(),
      now: () => new Date('2026-08-14T12:00:00.000Z'),
    }).export({ includeSecrets: false, outPath: zipPath });

    assert.equal(scanned.report.security.redactedHits, 0, '二进制文件不得被文本扫描误报');
    assert.ok(!scanned.report.warnings.some((w) => w.includes('疑似凭据')), '二进制文件不产生凭据告警');
    // 二进制字节仍无损进入 ZIP
    const archive = parseZip(await fs.readFile(zipPath));
    assert.deepEqual(Buffer.from(archive.readEntry('custom/skills/blob.png')), binary, '二进制文件字节无损');

    // 2) 未注入 scanner（core 缺省字段名黑名单无 scanText）→ 文件类分区不扫，与修复前一致
    const src2 = makeContext('linux', '/home/g09c');
    await src2.fs.writeFile('skills/plain.md', Buffer.from('apiKey: "sk-live-no-scanner-111"\n', 'utf8'));
    const zipPath2 = path.join(dir, 'dsh-config-g09c.zip');
    const noScanner = await new Exporter({
      ctx: src2, adapters, now: () => new Date('2026-08-14T12:00:00.000Z'),
    }).export({ includeSecrets: false, outPath: zipPath2 });

    assert.equal(noScanner.report.security.redactedHits, 0, '缺省扫描器无 scanText → 文件类分区不计命中');
    assert.ok(!noScanner.report.warnings.some((w) => w.includes('疑似凭据')));
  });
});

/* ---------------- G-09/H1：文件类分区告警必须按**文件**去重 + 截断必须补汇总告警 ---------------- */

/**
 * H1 回归（缺陷实证）：修复前告警按 hit 计数且不去重 —— 同一行同时命中「字段名」与「值形状」会产生
 * 两条同路径告警，少数文件即可吃满 MAX_FILE_SECTION_WARNINGS_PER_SECTION=5，
 * 导致**含真实明文凭据的文件完全零告警**（被静默淹没）。
 *
 * 夹具：auditA.md 有 3 行秘密 → scanText 产出 **6 条 hit**（每行各命中「字段名 + 值形状」两种形态，同 1 个文件），
 * z-realCreds.yaml 有 1 行真实凭据 → 2 条 hit（1 个路径），且文件名字典序在 auditA.md **之后**。
 * 修复前按 hit 截断到 5：auditA 的 6 条 hit 独占全部 5 个额度，z-realCreds.yaml 的告警被完全挤掉，
 * 告警列表里全是 auditA.md（同路径重复 5 次），含真实明文凭据的文件零告警（正是 H1 缺陷）。
 */
test('G-09/H1 文件类分区告警：按文件去重（同路径不重复）+ 真有凭据的文件不得被淹没', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('linux', '/home/g09h1');
    const auditA = [
      '# audit A',
      'apiKey: "sk-live-auditA-9f3a2b7c1d4e"',
      'authToken: "ghp_0123456789abcdefghijABCDEF"',
      'clientSecret: "ghs_0123456789abcdefghijABCDEF"',
      'run the pipeline',
    ].join('\n') + '\n';
    await src.fs.writeFile('skills/auditA.md', Buffer.from(auditA, 'utf8'));
    const realCredsText = 'apiKey: "sk-live-realB-7c1d4e9f3a2b"\n';
    await src.fs.writeFile('skills/z-realCreds.yaml', Buffer.from(realCredsText, 'utf8'));

    const adapters = createAdapters({ namespaces: [] });
    const zipPath = path.join(dir, 'dsh-config-g09h1.zip');
    const result = await new Exporter({
      ctx: src, adapters,
      scanner: createSecretScanner(),
      now: () => new Date('2026-08-14T12:00:00.000Z'),
    }).export({ includeSecrets: false, outPath: zipPath });

    const secretWarnings = result.report.warnings.filter((w) => w.includes('疑似凭据'));
    // 文案形如「文件类分区 skills 中检测到疑似凭据: <path>」；path 本身不含「: 」
    const warnedPaths = secretWarnings.map((w) => w.slice(w.indexOf(': ') + 2));

    // 1) 核心断言：含真实凭据的文件必须被告警（修复前 0 条 —— 被 auditA 的重复 hit 淹没）
    assert.ok(
      secretWarnings.some((w) => w.includes('z-realCreds.yaml')),
      `含真实凭据的文件必须被告警，实际 warnings=${JSON.stringify(secretWarnings)}`,
    );
    // 2) 无重复路径告警：修复前 auditA.md 会重复出现 4 次
    assert.equal(
      new Set(warnedPaths).size, warnedPaths.length,
      `同一路径不得重复告警，实际=${JSON.stringify(warnedPaths)}`,
    );
    // 3) 去重后只有 2 个文件 → 未触及上限，不应有截断汇总
    assert.equal(
      secretWarnings.some((w) => w.includes('另有')), false,
      `2 个文件未触及上限，不应有截断汇总，实际=${JSON.stringify(secretWarnings)}`,
    );
    // 4) redactedHits 仍是**全量**命中（报告统计通道，不去重、不截断）：auditA=6 + realCreds=2 = 8
    assert.equal(result.report.security.redactedHits, 8, 'redactedHits 必须计入全量 hit（不去重、不截断）');
    // 5) 告警不得泄露凭据值
    assert.ok(!secretWarnings.some((w) => w.includes('sk-live-')), '告警绝不能带凭据值');
    // 6) 只告警不改写：真实凭据文件字节级原样进入 ZIP
    const archive = parseZip(await fs.readFile(zipPath));
    assert.equal(
      Buffer.from(archive.readEntry('custom/skills/z-realCreds.yaml')).toString('utf8'),
      realCredsText,
      '文件类分区内容不得被静默改写/剥离（只告警）',
    );
  });
});

test('G-09/H1 同一文件的多种命中形态只产生一条告警（字段名 + 值形状双命中不再重复）', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('linux', '/home/g09h1b');
    // 单文件、单行同时命中「字段名」与「值形状」→ scanText 产出 2 条 hit（同 path）
    await src.fs.writeFile('skills/dual.md', Buffer.from('apiKey: "sk-live-dual-1a2b3c4d5e6f"\n', 'utf8'));
    const adapters = createAdapters({ namespaces: [] });
    const zipPath = path.join(dir, 'dsh-config-g09h1b.zip');
    const result = await new Exporter({
      ctx: src, adapters,
      scanner: createSecretScanner(),
      now: () => new Date('2026-08-14T12:00:00.000Z'),
    }).export({ includeSecrets: false, outPath: zipPath });

    const secretWarnings = result.report.warnings.filter((w) => w.includes('疑似凭据'));
    assert.equal(secretWarnings.length, 1, `同一文件必须只告警一次，实际=${JSON.stringify(secretWarnings)}`);
    assert.ok(secretWarnings[0]!.includes('dual.md'), '告警应指向该文件');
    assert.equal(result.report.security.redactedHits, 2, '两条 hit 仍全量计入 redactedHits（统计通道不去重）');
  });
});

test('G-09/H1 文件数超过上限时：按文件截断 + 必须补一条汇总告警（截断不得静默）', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('linux', '/home/g09h1c');
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      await src.fs.writeFile(`skills/${name}.md`, Buffer.from(`# ${name}\nsk-live-${name}-9f3a2b7c1d4e\n`, 'utf8'));
    }
    const adapters = createAdapters({ namespaces: [] });
    const zipPath = path.join(dir, 'dsh-config-g09h1c.zip');
    const result = await new Exporter({
      ctx: src, adapters,
      scanner: createSecretScanner(),
      now: () => new Date('2026-08-14T12:00:00.000Z'),
    }).export({ includeSecrets: false, outPath: zipPath });

    const secretWarnings = result.report.warnings.filter((w) => w.includes('疑似凭据'));
    // 7 个命中文件：前 5 个逐条告警 + 1 条「另有 2 个文件命中」汇总
    assert.equal(secretWarnings.length, 6, `应为 5 条文件告警 + 1 条汇总，实际=${JSON.stringify(secretWarnings)}`);
    assert.ok(secretWarnings.some((w) => w.includes('另有 2 个文件命中')), `被截断的文件数必须补汇总告警，实际=${JSON.stringify(secretWarnings)}`);
    assert.equal(result.report.security.redactedHits, 7, '7 条 hit 全量计入 redactedHits');
  });
});


