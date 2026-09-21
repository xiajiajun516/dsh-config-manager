/**
 * issue #39：含 vault 的加密备份里带着凭据原文，导入后仍要求人工重填。
 *
 * 根因：宿主导入路径与同步引擎解析 `.credentials.yaml` 时只认「顶层字符串项」
 * （DSH 预发布扁平布局），而 DSH v1 把凭据值放在顶层 `refs:` 块下 → 整段被过滤掉
 * → `decryptedCredentials` 为空 → `/decrypt` 回传的 refs 为空 → 导入向导按
 * `!decryptRefs.includes(s.ref)` 过滤失效，两个 ref 全进「待补录」清单。
 *
 * 本测试走宿主真实路径：Exporter（includeSecrets=true）→ tryDecryptCredentials（index.ts）
 * → executeImportPlan，覆盖「refs 块被认出 → 凭据自动回填 → 不再提示人工重填」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from '../../src/core/exporter.ts';
import { Importer } from '../../src/core/importer.ts';
import { createAdapters } from '../../src/adapters/index.ts';
import { makeContext, MemSnapshotStore, type MockHostContext } from '../../src/adapters/test-helpers.ts';
import { createEncryptionProvider } from '../../src/security/encryption.ts';
import { createSecretScanner } from '../../src/security/secret-scanner.ts';
import { tryDecryptCredentials } from '../../src/index.ts';

const NS = ['general'];
const PASSWORD = 'backup-password-123';
const REFS = ['DEEPSEEK_API_KEY', 'RJK66_API_KEY'];

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-cred-refs-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 复刻报告人的容器内 `.credentials.yaml`：v1 布局 + refs 块 + records 会话记录 */
const CREDENTIALS_YAML = [
  'version: 1',
  'refs:',
  '  RJK66_API_KEY: sk-rjk66-real-0002',
  '  DEEPSEEK_API_KEY: sk-deepseek-real-0001',
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  '      secret: session-secret-should-not-leak',
  '',
].join('\n');

function makeAdapters() {
  return createAdapters({
    namespaces: NS,
    credentialsRefs: async () => [...REFS],
  });
}

/** A 机：两个 ref 已在 DSH 凭据槽位里配置 + v1 布局的 .credentials.yaml */
async function makeSource(homeDir: string): Promise<MockHostContext> {
  const src = makeContext('linux', homeDir);
  src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
  for (const ref of REFS) src.credentials.values.set(ref, 'placeholder');
  await src.fs.writeFile(path.join(homeDir, '.credentials.yaml'), Buffer.from(CREDENTIALS_YAML, 'utf8'));
  return src;
}

/** A 机导出加密备份（含凭据原文）→ 返回 zip 路径 */
async function exportEncryptedBackup(src: MockHostContext, zipPath: string): Promise<void> {
  await new Exporter({
    ctx: src,
    adapters: makeAdapters(),
    scanner: createSecretScanner(),
    encryption: createEncryptionProvider(PASSWORD),
    now: () => new Date('2026-09-19T00:00:00.000Z'),
  }).export({ includeSecrets: true, outPath: zipPath });
}

test('issue #39：宿主解析认 refs 块 → 凭据随包回填，不再进待补录清单', async () => {
  await withTmp(async (dir) => {
    const src = await makeSource(path.join(dir, 'home-a'));
    const zipPath = path.join(dir, 'enc.zip');
    await exportEncryptedBackup(src, zipPath);

    // ② B 机（全新 home：vault 镜像必然为空，模拟跨机）
    const dst = makeContext('linux', path.join(dir, 'home-b'));
    const importer = new Importer({ ctx: dst, adapters: makeAdapters(), snapshotStore: new MemSnapshotStore() });
    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    const planRefs = plan.missingSecrets.map((s) => s.ref);
    assert.deepEqual([...planRefs].sort(), [...REFS].sort(), '计划里仍是待补录占位（Dry Run 阶段不注入密码）');

    // ③ 宿主 /decrypt 路径：解开 secrets.enc → refs（修复前恒为空数组 → 向导无法过滤出「已由密码恢复」的项）
    const decrypted = await tryDecryptCredentials(zipPath, PASSWORD);
    assert.ok(decrypted !== undefined, '加密备份应解出凭据 Map');
    assert.equal(decrypted!.get('DEEPSEEK_API_KEY'), 'sk-deepseek-real-0001', 'refs 块下的键值必须被认出');
    assert.equal(decrypted!.get('RJK66_API_KEY'), 'sk-rjk66-real-0002');
    assert.equal(decrypted!.size, 2, 'records/payload 里的会话秘密不得混进凭据清单');
    assert.ok(![...decrypted!.values()].includes('session-secret-should-not-leak'));
    // 向导过滤判据（ImportWizardView：!decryptRefs.includes(s.ref)）→ 全部已被密码覆盖
    assert.deepEqual(planRefs.filter((ref) => !decrypted!.has(ref)), [], '待补录清单应为空');

    // ③b issue #39 Feature 2：/analyze 直接回传凭据可恢复性（宿主不必自己解 secrets.enc 解析 YAML）
    const blind = await importer.analyzeImport(zipPath);
    assert.deepEqual(blind.credentials, { inArchive: true, refs: [], satisfied: [] }, '不给密码 → 只知「包里有值」，不知 ref 名');
    const informed = await importer.analyzeImport(zipPath, { decryptedCredentials: decrypted });
    assert.deepEqual(informed.credentials, {
      inArchive: true,
      refs: ['DEEPSEEK_API_KEY', 'RJK66_API_KEY'],
      satisfied: [],
    }, '给了密码 → ref 名齐全，且此刻本机尚未配置');
    // 只回传 ref 名：整个分析结果不得出现任何凭据值
    assert.ok(!JSON.stringify(informed).includes('sk-deepseek-real-0001'), '分析结果绝不携带凭据值');
    assert.ok(!JSON.stringify(informed).includes('session-secret-should-not-leak'), '会话秘密不得进入分析结果');

    // ④ 执行：凭据写回本机，结果不再要求人工重填
    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true, decryptedCredentials: decrypted });
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingSecrets, [], '由包内密文回填的凭据不再计入缺失');
    assert.equal(dst.credentials.values.get('DEEPSEEK_API_KEY'), 'sk-deepseek-real-0001');
    assert.equal(dst.credentials.values.get('RJK66_API_KEY'), 'sk-rjk66-real-0002');
    assert.ok(
      !result.warnings.some((w) => w.includes('需人工重填')),
      `不得再提示人工重填，实际: ${result.warnings.join(' | ')}`,
    );
    assert.ok(
      result.warnings.some((w) => w.includes('已从备份包内的密文回填')),
      `应如实说明凭据来自包内密文，实际: ${result.warnings.join(' | ')}`,
    );
    // 安全不变量：告警文本不得携带凭据值
    assert.ok(!result.warnings.join(' | ').includes('sk-deepseek-real-0001'));

    // ⑤ issue #39 Feature 3：结果新增 credentialsRestored（只增不改；只回传条数）
    assert.equal(result.credentialsRestored, 2, '从归档内解出并回填的条数');
    assert.ok(!JSON.stringify(result).includes('sk-deepseek-real-0001'), '结果不得携带凭据值');

    // ⑥ 回填之后再分析：同样的 ref 现在算「本机已满足」
    const after = await importer.analyzeImport(zipPath, { decryptedCredentials: decrypted });
    assert.deepEqual(after.credentials?.satisfied, ['DEEPSEEK_API_KEY', 'RJK66_API_KEY']);
  });
});

test('issue #39：包内仍缺 ref 时保留「人工重填」提示（不因新文案掩盖真实缺口）', async () => {
  await withTmp(async (dir) => {
    const src = await makeSource(path.join(dir, 'home-a'));
    const zipPath = path.join(dir, 'enc.zip');
    await exportEncryptedBackup(src, zipPath);

    const dst = makeContext('linux', path.join(dir, 'home-b'));
    const importer = new Importer({ ctx: dst, adapters: makeAdapters(), snapshotStore: new MemSnapshotStore() });
    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });

    const decrypted = await tryDecryptCredentials(zipPath, PASSWORD);
    assert.ok(decrypted !== undefined);
    const partial = new Map(decrypted!);
    partial.delete('RJK66_API_KEY'); // 模拟「包里只覆盖了一部分 ref」

    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true, decryptedCredentials: partial });
    assert.deepEqual(result.missingSecrets, ['RJK66_API_KEY'], '确实还缺的 ref 必须如实列出');
    assert.equal(result.credentialsRestored, 1, '只统计真正回填成功的条数');
    assert.ok(
      result.warnings.some((w) => w.includes('需人工重填')),
      `仍有未满足 ref → 保留重填提示，实际: ${result.warnings.join(' | ')}`,
    );
  });
});
