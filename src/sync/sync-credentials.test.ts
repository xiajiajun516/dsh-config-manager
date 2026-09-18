/**
 * issue #38：同步页「导出密钥」真正生效的端到端测试。
 *
 * 修复前：`includeSecrets` 在同步通道内**没有数据源** —— 它唯一的效果是跳过同步载荷的
 * 第二道 SecretScanner 脱敏（方向是降低防护，而不是取得凭据），推送载荷与不勾时逐字节相同。
 *
 * 修复后：
 *  - push：读取 `$DSH_HOME/.credentials.yaml` 原文，用同一次调用的密码加密为**独立**凭据载荷
 *    （`SyncSnapshot.credentials`；不进 sections —— credentialsStatus/secrets 属结构性拒绝分区），
 *    随加密快照上行，远端全程只见密文；
 *  - pull/preview：用密码解密出 `Map<ref, value>`，为每个 ref 生成 MissingSecret 计划项；
 *  - apply-items：把该 Map 作为 executeImportPlan 的 `decryptedCredentials`（仅内存）交给
 *    credentials adapter → `credentials.set(ref, value)` 写回本机。
 *
 * 安全断言贯穿全部用例：明文凭据值绝不出现在上传载荷 / 报告 / 计划文本中。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAdapters } from '../adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import { Importer } from '../core/importer.ts';
import { credentialsMapFromYaml, decryptCredentialsPayload } from './snapshot-crypto.ts';
import { SyncEngine } from './sync-engine.ts';
import { computeSnapshotMeta } from './transport.ts';
import type { SyncSnapshot, SyncSnapshotMeta, SyncTransport } from './transport.ts';

const NS = ['general', 'theme'];
const PASSWORD = 'pw-12345678';
const CRED_YAML = 'DEEPSEEK_API_KEY: sk-real-cred-0001\nGITHUB_TOKEN: ghp_realcred0002\n';

/** 内存 SyncTransport（与 sync-engine.test.ts 同款最小实现） */
class MemSyncTransport implements SyncTransport {
  readonly type = 'memory';
  snapshots = new Map<string, SyncSnapshot>();
  metas: SyncSnapshotMeta[] = [];
  async list(): Promise<SyncSnapshotMeta[]> {
    return [...this.metas].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
  // 真实通道经序列化落盘/上网，读写必为独立副本；内存实现必须同样深拷贝，
  // 否则 prepareSnapshot 的原地解密会污染「远端」对象（第二次解密即报需密码）。
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.snapshots.set(snapshot.id, structuredClone(snapshot));
    this.metas.push(computeSnapshotMeta(snapshot));
    return computeSnapshotMeta(snapshot);
  }
  async download(id: string): Promise<SyncSnapshot> {
    const s = this.snapshots.get(id);
    if (!s) throw new Error(`快照不存在: ${id}`);
    return structuredClone(s);
  }
  async delete(id: string): Promise<void> {
    this.snapshots.delete(id);
    this.metas = this.metas.filter((m) => m.id !== id);
  }
}

type Ctx = ReturnType<typeof makeContext>;

function makeEngine(ctx: Ctx, transport: MemSyncTransport, stateDir: string): SyncEngine {
  const adapters = createAdapters({ namespaces: NS });
  const importer = new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() });
  return new SyncEngine({
    ctx,
    transport,
    stateDir,
    adapters,
    importer,
    now: () => new Date('2026-08-16T12:00:00.000Z'),
  } as ConstructorParameters<typeof SyncEngine>[0]);
}

/** 源机：已注册 namespace + 本机凭据文件 */
async function makeSource(ctx: Ctx): Promise<void> {
  ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
  await ctx.fs.writeFile('.credentials.yaml', Buffer.from(CRED_YAML, 'utf8'));
}

/** 目标机：namespace 已注册（从未配置），凭据为空 */
function makeTarget(): Ctx {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  for (const n of NS) ctx.settings.registered.add(n);
  return ctx;
}

test('push：includeSecrets 读取 .credentials.yaml → 加密为独立凭据载荷（明文绝不进载荷）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cred-push-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    await makeSource(ctx);
    const transport = new MemSyncTransport();
    const engine = makeEngine(ctx, transport, tmp);

    const report = await engine.push({ snapshotId: 'cred-1', encrypt: true, password: PASSWORD, includeSecrets: true });
    assert.equal(report.ok, true);
    assert.ok(
      !report.warnings.some((w) => w.includes('凭据')),
      `凭据可读 → 不应产生凭据相关告警，实际: ${report.warnings.join(' | ')}`,
    );

    const uploaded = transport.snapshots.get('cred-1')!;
    assert.equal(uploaded.manifest.encrypted, true);
    assert.equal(uploaded.manifest.containsSecrets, true, 'manifest 语义保持：含秘密');
    const payload = uploaded.credentials;
    assert.ok(payload !== undefined, '凭据载荷随快照上行（修复前恒为 undefined）');

    // 明文凭据值绝不出现在上传载荷的任何字节里
    const serialized = JSON.stringify(uploaded);
    assert.ok(!serialized.includes('sk-real-cred-0001'), '载荷不得含明文凭据值');
    assert.ok(!serialized.includes('ghp_realcred0002'), '载荷不得含明文凭据值');
    assert.ok(!('credentialsStatus' in (uploaded.sections as Record<string, unknown>)), '凭据绝不进 sections');

    // 密码可解回原文（跨机恢复的唯一途径）
    const yamlText = await decryptCredentialsPayload(payload!, PASSWORD);
    const map = credentialsMapFromYaml(yamlText);
    assert.equal(map.get('DEEPSEEK_API_KEY'), 'sk-real-cred-0001');
    assert.equal(map.get('GITHUB_TOKEN'), 'ghp_realcred0002');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push：只加密不导出密钥 → 不带凭据载荷（默认安全不变量不破）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cred-enc-only-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    await makeSource(ctx);
    const transport = new MemSyncTransport();
    const engine = makeEngine(ctx, transport, tmp);

    await engine.push({ snapshotId: 'enc-only', encrypt: true, password: PASSWORD });
    const uploaded = transport.snapshots.get('enc-only')!;
    assert.equal(uploaded.manifest.containsSecrets, false);
    assert.equal(uploaded.credentials, undefined, '未勾选导出密钥 → 不带任何凭据载荷');
    assert.ok(!JSON.stringify(uploaded).includes('sk-real-cred-0001'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('push：勾了导出密钥但本机无凭据文件 → 明确告警且不带载荷（不静默成功）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cred-missing-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    const transport = new MemSyncTransport();
    const engine = makeEngine(ctx, transport, tmp);

    const report = await engine.push({ snapshotId: 'no-cred', encrypt: true, password: PASSWORD, includeSecrets: true });
    assert.equal(report.ok, true, '推送本身照常成功（其余配置仍要同步）');
    assert.equal(transport.snapshots.get('no-cred')!.credentials, undefined);
    assert.ok(report.warnings.length > 0, '必须告警：用户能看见「勾了导出密钥却没导出任何值」');
    assert.ok(report.warnings.some((w) => w.includes('凭据文件')), `告警须点明凭据文件，实际: ${report.warnings.join(' | ')}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pull/preview：凭据载荷解密 → 计划含迁移项 + 返回仅内存的 ref→值 Map', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cred-pull-'));
  try {
    const transport = new MemSyncTransport();
    const srcCtx = makeContext('win32', 'C:\\Users\\alice');
    await makeSource(srcCtx);
    await makeEngine(srcCtx, transport, tmp).push({
      snapshotId: 'cred-remote', encrypt: true, password: PASSWORD, includeSecrets: true,
    });

    const dstCtx = makeTarget();
    const dstEngine = makeEngine(dstCtx, transport, tmp);

    // 无密码 → 明确报错（加密快照不可静默降级）
    await assert.rejects(() => dstEngine.pull(), /需要解密密码/);

    const pull = await dstEngine.pull({ password: PASSWORD });
    assert.equal(pull.ok, true);
    const secretChange = pull.changes.find((c) => c.id === 'secret:DEEPSEEK_API_KEY');
    assert.ok(secretChange !== undefined, '差异报告须列出凭据迁移项');
    assert.equal(secretChange!.kind, 'MissingSecret');
    assert.equal(pull.needsReview, true, '凭据迁移必须进人工确认（默认不采用）');

    const preview = await dstEngine.preview({ password: PASSWORD });
    assert.equal(preview.ok, true);
    assert.equal(preview.credentials?.get('DEEPSEEK_API_KEY'), 'sk-real-cred-0001');
    assert.equal(preview.credentials?.get('GITHUB_TOKEN'), 'ghp_realcred0002');
    const item = preview.plan!.items.find((i) => i.id === 'secret:DEEPSEEK_API_KEY');
    assert.ok(item !== undefined, '计划含凭据迁移项');
    assert.equal(item!.adapter, 'credentialsStatus');
    // 计划/报告文本绝不含凭据值
    assert.ok(!JSON.stringify(preview.plan).includes('sk-real-cred-0001'), '计划不得含凭据值');
    assert.ok(!JSON.stringify(pull).includes('sk-real-cred-0001'), '差异报告不得含凭据值');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('applyItems：带凭据 Map → credentials.set 写回本机；不带 → 跳过且不写入', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cred-apply-'));
  try {
    const transport = new MemSyncTransport();
    const srcCtx = makeContext('win32', 'C:\\Users\\alice');
    await makeSource(srcCtx);
    await makeEngine(srcCtx, transport, tmp).push({
      snapshotId: 'cred-remote', encrypt: true, password: PASSWORD, includeSecrets: true,
    });

    // ① 不注入凭据（模拟旧行为/无凭据）→ MissingSecret 跳过，目标机凭据保持为空
    const noCredCtx = makeTarget();
    const noCredEngine = makeEngine(noCredCtx, transport, tmp);
    const noCredPreview = await noCredEngine.preview({ password: PASSWORD });
    const noCredPlan = {
      ...noCredPreview.plan!,
      items: noCredPreview.plan!.items.filter((i) => i.id === 'secret:DEEPSEEK_API_KEY'),
    };
    const noCredReport = await noCredEngine.applyItems(noCredPreview.zipPath, noCredPlan);
    assert.equal(noCredReport.ok, true);
    assert.equal(noCredCtx.credentials.values.get('DEEPSEEK_API_KEY'), undefined, '未提供凭据时不得写入');

    // ② 注入凭据（一键同步会话持有）→ 真正写回本机凭据
    const dstCtx = makeTarget();
    const dstEngine = makeEngine(dstCtx, transport, tmp);
    const preview = await dstEngine.preview({ password: PASSWORD });
    const subPlan = {
      ...preview.plan!,
      items: preview.plan!.items.filter((i) => i.id.startsWith('secret:')),
    };
    const report = await dstEngine.applyItems(preview.zipPath, subPlan, { credentials: preview.credentials });
    assert.equal(report.ok, true);
    assert.deepEqual(report.failed, []);
    assert.equal(dstCtx.credentials.values.get('DEEPSEEK_API_KEY'), 'sk-real-cred-0001', '凭据已随同步写回本机');
    assert.equal(dstCtx.credentials.values.get('GITHUB_TOKEN'), 'ghp_realcred0002');
    assert.ok(!JSON.stringify(report).includes('sk-real-cred-0001'), '执行报告不得含凭据值');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('pull：未加密快照携带凭据载荷 → 拒绝（与「明文快照携带秘密」同类）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cred-plain-'));
  try {
    const transport = new MemSyncTransport();
    // 伪造一份「未加密却带凭据载荷」的远端快照（篡改/旧坏数据形态）
    const forged: SyncSnapshot = {
      id: 'forged-1',
      createdAt: '2026-08-16T12:00:00.000Z',
      manifest: {
        schemaVersion: 1, dshVersion: '0.1.0', platform: 'win32',
        sectionIds: [], containsSecrets: false,
      },
      sections: {},
      credentials: { info: {} as never, data: 'AAAA' },
    };
    transport.snapshots.set(forged.id, forged);
    transport.metas.push(computeSnapshotMeta(forged));

    const ctx = makeTarget();
    const engine = makeEngine(ctx, transport, tmp);
    await assert.rejects(
      () => engine.pull(),
      /containsSecrets=true/,
      '未加密快照不得携带凭据载荷',
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('散文件布局不承载凭据载荷（issue #38 防御：绝不静默丢弃）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cred-layout-'));
  try {
    const { writeSnapshotToDir } = await import('./layout.ts');
    const snapshot: SyncSnapshot = {
      id: 'plain-with-cred',
      createdAt: '2026-08-16T12:00:00.000Z',
      manifest: {
        schemaVersion: 1, dshVersion: '0.1.0', platform: 'win32',
        sectionIds: [], containsSecrets: true, encrypted: true,
      },
      sections: {},
      credentials: { info: {} as never, data: 'AAAA' },
    };
    await assert.rejects(
      () => writeSnapshotToDir(snapshot, path.join(tmp, 'snap')),
      /凭据载荷只能随加密快照/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
