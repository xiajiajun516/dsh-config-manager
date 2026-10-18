/**
 * 场景族 1–9：三方合并 / 首同步 / 单侧修改 / 空与损坏载荷。
 *
 * 断言对象是**真实产物**：实际文件内容、merge 结果里的 merged 数据、sync-state.json 原文；
 * 不只看返回值，也不看 UI 文案。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { merge } from '../../src/sync/merge.ts';
import type { MergePlan, MergeSectionResult } from '../../src/sync/merge.ts';
import type { FilesSection, SectionData } from '../../src/schema/types.ts';
import { hashSection } from '../../src/sync/sync-state.ts';
import {
  createSharedDevices, filesSection, fileTexts, getNamespace,
  makeRoot, readSkill, readStateJson, readStateText,
  setNamespace, settingsSection, writeSkill,
} from './helpers.ts';
import type { Device } from './helpers.ts';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 两台设备共同的初始配置（同机同配置 → 内容逐字节一致）。 */
async function seedConfig(device: Device): Promise<void> {
  setNamespace(device, 'general', { theme: 'dark', language: 'zh-CN' }, 3);
  setNamespace(device, 'theme', { mode: 'dark' }, 1);
  await writeSkill(device, 'coding.md', '# Coding\n');
  await writeSkill(device, 'writing.md', '# Writing\n');
  device.ctx.plugins.installed.set('@deepseek-ai/dsh-ssh', { name: '@deepseek-ai/dsh-ssh', version: '1.0.0', enabled: true });
}

/** 取 plan 里某个分区的结果（缺失 → 断言失败并给出实际分区清单）。 */
function sectionOf(plan: MergePlan, id: string): MergeSectionResult {
  const r = plan.sections.find((s) => s.id === id);
  assert.ok(r !== undefined, 'merger 结果缺少分区 ' + id + '（实际: ' + plan.sections.map((s) => s.id).join(',') + '）');
  return r;
}

test('场景 1 首次同步：push 建基线（sync-state 原文 + 祖先副本），另一台设备能 preview 出差异', async () => {
  const root = await makeRoot('first-sync');
  try {
    const { transport, devices } = await createSharedDevices(root, ['a', 'b']);
    const a = devices['a']!;
    const b = devices['b']!;
    await seedConfig(a);
    await seedConfig(b);

    // 空远端：没有可合并项、也没有可拉项
    assert.equal(await a.engine.hasNewRemoteSnapshot(), false, '远端为空时不得声称有新快照');
    assert.deepEqual(await a.engine.merge(), { sections: [] }, '空远端 merge 返回空计划');

    const report = await a.engine.push({ snapshotId: 'sync-first' });
    assert.equal(report.ok, true);
    const uploaded = transport.snapshots.get('sync-first');
    assert.ok(uploaded !== undefined, '首次推送已上传快照');
    const settings = (uploaded!.sections as Record<string, SectionData>)['settings']!;
    const general = (settings as unknown as { namespaces: Record<string, { value: unknown }> }).namespaces['general']!;
    assert.deepEqual(general.value, { theme: 'dark', language: 'zh-CN' }, '快照里是真实配置值');
    const skills = (uploaded!.sections as Record<string, SectionData>)['skills'] as unknown as FilesSection;
    assert.equal(fileTexts(skills as unknown as SectionData).get('coding.md'), '# Coding\n', '文件类分区内容随快照上行');

    // 基线：lastSnapshotId/ancestorId/分区 hash 全部正确；原文可解析（schemaVersion 3）
    const state = (await readStateJson(a))!;
    assert.equal(state['schemaVersion'], 3);
    assert.equal(state['lastSnapshotId'], 'sync-first');
    assert.equal(state['ancestorId'], 'sync-first');
    const rec = (state['sections'] as Record<string, { hash: string }>)['settings']!;
    assert.equal(rec.hash, hashSection(settings), '基线 hash = 快照内容 hash');
    const ancestorManifest = path.join(a.localSnapshotsDir, 'sync-first', 'manifest.json');
    assert.ok((await fs.stat(ancestorManifest)).isFile(), '本地祖先副本已落盘（下一轮三方合并的 base）');

    // 另一台设备（从未同步）走 preview（首次同步路径）：能读出待导入项，且不写本机
    const preview = await b.engine.preview();
    assert.equal(preview.ok, true);
    assert.ok(preview.plan !== null && preview.plan.items.length > 0, '首次同步能生成导入计划');
    assert.ok(preview.plan!.items.some((i) => i.adapter === 'settings'), '计划里包含 settings');
    assert.equal(await b.engine.hasNewRemoteSnapshot(), true, '对 B 来说远端有可拉快照');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 2 本地单独修改：merge → keepLocal（选本地值），merge 本身零写入', async () => {
  const root = await makeRoot('local-only');
  try {
    const { devices } = await createSharedDevices(root, ['a']);
    const a = devices['a']!;
    await seedConfig(a);
    await a.engine.push({ snapshotId: 'sync-a1' });
    const before = await readStateText(a);

    setNamespace(a, 'general', { theme: 'light', language: 'zh-CN' }, 4);
    const plan = await a.engine.merge();
    const r = sectionOf(plan, 'settings');
    assert.equal(r.decision, 'keepLocal');
    const merged = r.merged as unknown as { namespaces: Record<string, { value: unknown }> };
    assert.deepEqual(merged.namespaces['general']!.value, { theme: 'light', language: 'zh-CN' }, '胜出方 = 本地现值');
    assert.equal(await readStateText(a), before, 'merge() 只读：sync-state.json 逐字节不变');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 3 远端单独修改：merge → useRemote（选远端值），本机配置未被改写（settings 分区）', async () => {
  const root = await makeRoot('remote-only');
  try {
    const { devices } = await createSharedDevices(root, ['a', 'b']);
    const a = devices['a']!;
    const b = devices['b']!;
    await seedConfig(a);
    await seedConfig(b);
    await a.engine.push({ snapshotId: 'sync-a1' });

    setNamespace(b, 'general', { theme: 'light', language: 'zh-CN' }, 4);
    await b.engine.push({ snapshotId: 'sync-b1' });

    const plan = await a.engine.merge();
    const r = sectionOf(plan, 'settings');
    assert.equal(r.decision, 'useRemote');
    assert.deepEqual(
      (r.merged as unknown as { namespaces: Record<string, { value: unknown }> }).namespaces['general']!.value,
      { theme: 'light', language: 'zh-CN' },
      '胜出方 = 远端现值',
    );
    assert.deepEqual(getNamespace(a, 'theme'), { mode: 'dark' }, 'merge 不写本机配置（只有 apply 才写）');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 4 两端改不同文件：合并结果同时保留两侧改动（实际文件字节）', async () => {
  const root = await makeRoot('diff-files');
  try {
    const { devices } = await createSharedDevices(root, ['a', 'b']);
    const a = devices['a']!;
    const b = devices['b']!;
    await seedConfig(a);
    await seedConfig(b);
    await a.engine.push({ snapshotId: 'sync-a1' });

    // A 改 coding.md；B 改 writing.md（两端改的是不同文件）
    await writeSkill(a, 'coding.md', '# Coding v2 by A\n');
    await writeSkill(b, 'writing.md', '# Writing v2 by B\n');
    const bPush = await b.engine.push({ snapshotId: 'sync-b1' });
    assert.equal(bPush.ok, true);

    const plan = await a.engine.merge();
    const r = sectionOf(plan, 'skills');
    assert.equal(r.conflicts.length, 0, '不同文件的改动不得判成冲突');
    assert.ok(r.merged !== undefined, '合并必须产出 merged 数据，而不是丢给用户裁决');
    const texts = fileTexts(r.merged as unknown as SectionData);
    assert.equal(texts.get('coding.md'), '# Coding v2 by A\n', '本地改动保留');
    assert.equal(texts.get('writing.md'), '# Writing v2 by B\n', '远端改动保留');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 5 两端改同一文件但不同 key（JSON 分区）：互不覆盖，两侧都保留', async () => {
  const root = await makeRoot('same-file-diff-key');
  try {
    const { devices } = await createSharedDevices(root, ['a', 'b']);
    const a = devices['a']!;
    const b = devices['b']!;
    await seedConfig(a);
    await seedConfig(b);
    await a.engine.push({ snapshotId: 'sync-a1' });

    // A 在 general 里加 editor 键；B 改 general 里的 theme 键 —— 同一 namespace 内不同 key
    setNamespace(a, 'general', { theme: 'dark', language: 'zh-CN', editor: { fontSize: 14 } }, 4);
    setNamespace(b, 'general', { theme: 'light', language: 'zh-CN' }, 4);
    await b.engine.push({ snapshotId: 'sync-b1' });

    const plan = await a.engine.merge();
    const r = sectionOf(plan, 'settings');
    assert.equal(r.conflicts.length, 0, '不同 key 的改动不得判成冲突');
    assert.equal(r.decision, 'merge', '双方改动都保住时决策必须是 merge（不是 useRemote）');
    const k = r.merged as unknown as { namespaces: Record<string, { value: unknown }> };
    assert.deepEqual(
      k.namespaces['general']!.value,
      { theme: 'light', language: 'zh-CN', editor: { fontSize: 14 } },
      '本地新增键 + 远端修改键都保留',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 6 两端改同一文件真冲突：同一 key 两侧不同值 → conflict，且不产出 merged', async () => {
  const root = await makeRoot('real-conflict');
  try {
    const { devices } = await createSharedDevices(root, ['a', 'b']);
    const a = devices['a']!;
    const b = devices['b']!;
    await seedConfig(a);
    await seedConfig(b);
    await a.engine.push({ snapshotId: 'sync-a1' });

    setNamespace(a, 'general', { theme: 'blue', language: 'zh-CN' }, 4);
    setNamespace(b, 'general', { theme: 'red', language: 'zh-CN' }, 4);
    await b.engine.push({ snapshotId: 'sync-b1' });

    const plan = await a.engine.merge();
    const r = sectionOf(plan, 'settings');
    assert.equal(r.decision, 'conflict');
    assert.ok(r.conflicts.length >= 1, '真冲突必须列出冲突项');
    assert.equal(r.merged, undefined, '冲突时绝不返回「猜出来的 merged」');
    const paths = r.conflicts.map((c) => c.path);
    assert.ok(
      paths.some((x) => x.includes('general') && x.includes('theme')),
      '冲突定位到具体叶子路径（实际: ' + paths.join(',') + '）',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 7 一端删另一端改（两个方向）：都判 conflict，绝不静默丢一边', () => {
  const base = filesSection([['a.md', '# A old\n'], ['b.md', '# B old\n']]);

  // 方向 1：本地删 a.md，远端改 a.md
  const plan1 = merge(
    { skills: filesSection([['b.md', '# B old\n']]) },
    { skills: filesSection([['a.md', '# A remote\n'], ['b.md', '# B old\n']]) },
    { skills: base },
  );
  const r1 = plan1.sections.find((s) => s.id === 'skills')!;
  assert.equal(r1.decision, 'conflict', '本地删/远端改必须交用户裁决（不得复活已删文件）');
  assert.equal(r1.merged, undefined);
  const c1 = r1.conflicts.find((c) => c.path === 'a.md');
  assert.ok(c1 !== undefined, '冲突定位到 a.md');
  assert.equal(c1!.kind, 'file');
  assert.equal(c1!.local, undefined, '本地侧 = 已删除');
  assert.notEqual(c1!.remote, undefined, '远端侧保留改动内容供裁决');

  // 方向 2：本地改 b.md，远端删 b.md
  const plan2 = merge(
    { skills: filesSection([['a.md', '# A old\n'], ['b.md', '# B local\n']]) },
    { skills: filesSection([['a.md', '# A old\n']]) },
    { skills: base },
  );
  const r2 = plan2.sections.find((s) => s.id === 'skills')!;
  assert.equal(r2.decision, 'conflict', '本地改/远端删必须交用户裁决（不得静默接受删除）');
  assert.equal(r2.merged, undefined);
  const c2 = r2.conflicts.find((c) => c.path === 'b.md');
  assert.ok(c2 !== undefined, '冲突定位到 b.md');
  assert.equal(c2!.remote, undefined, '远端侧 = 已删除');
  assert.notEqual(c2!.local, undefined, '本地侧保留改动内容供裁决');
});

test('场景 8 多层嵌套 JSON 合并：同一 namespace 下不同深度的键都要保留（目标契约）', () => {
  // 祖先：general.value = { editor: { font: { size: 12, family: 'mono' } }, theme: 'dark' }
  const anc = settingsSection({ general: { editor: { font: { size: 12, family: 'mono' } }, theme: 'dark' } });
  // 本地只改 size；远端只改 family —— 递归键合并应保留两者
  const loc = settingsSection({ general: { editor: { font: { size: 14, family: 'mono' } }, theme: 'dark' } });
  const rem = settingsSection({ general: { editor: { font: { size: 12, family: 'serif' } }, theme: 'dark' } });

  const plan = merge(
    { settings: loc as SectionData },
    { settings: rem as SectionData },
    { settings: anc as SectionData },
  );
  const r = plan.sections.find((s) => s.id === 'settings')!;
  assert.equal(r.conflicts.length, 0, '不同嵌套键的双侧改动不得判成冲突（需要递归键合并）');
  const merged = r.merged as unknown as { namespaces: Record<string, { value: unknown }> };
  assert.deepEqual(
    merged.namespaces['general']!.value,
    { editor: { font: { size: 14, family: 'serif' } }, theme: 'dark' },
    '两侧深层改动都保留（size=14 来自本地、family=serif 来自远端）',
  );
});

test('场景 9a 空文件 / 缺分区：空文件集合不报错，远端缺且本地未改 → skip', () => {
  const empty = filesSection([]);
  const plan = merge(
    { skills: empty },
    { skills: filesSection([]) },
    { skills: filesSection([]) },
  );
  assert.equal(plan.sections.find((s) => s.id === 'skills')!.decision, 'skip', '空 == 空 → skip');

  const s = settingsSection({ general: { theme: 'dark' } });
  const plan2 = merge({ settings: s as SectionData }, {}, { settings: s as SectionData });
  assert.equal(plan2.sections.find((x) => x.id === 'settings')!.decision, 'skip', '远端缺 + 本地未改 → skip');
});

test('场景 9b 非法 JSON 载荷（远端分区是字符串）：绝不静默采用，必须安全失败', async () => {
  const root = await makeRoot('invalid-json');
  try {
    const { devices, transport } = await createSharedDevices(root, ['a']);
    const a = devices['a']!;
    await seedConfig(a);
    await a.engine.push({ snapshotId: 'sync-a1' });
    // 远端同一快照的分区被写成字符串（模拟被外部工具/坏归档破坏）
    const bad = transport.snapshots.get('sync-a1')!;
    (bad.sections as Record<string, unknown>)['settings'] = 'not-json-at-all';

    // Lead 已落形状闸门（H-1）：非普通对象的分区值 → conflict(reason='format')，绝不原样采用。
    const plan = await a.engine.merge();
    const r = plan.sections.find((s) => s.id === 'settings')!;
    assert.equal(r.decision, 'conflict', '非法形状的分区值必须判 conflict');
    assert.equal(r.merged, undefined, '非法形状绝不产出 merged');
    assert.equal(r.conflicts[0]!.reason, 'format');
    assert.equal(r.conflicts[0]!.remote, 'not-json-at-all', '冲突里保留畸形远端原值供诊断');
    const localRaw = r.conflicts[0]!.local as { version?: unknown } | undefined;
    assert.equal(localRaw?.version, 1, '合法一侧（本地 settings）在冲突里保留原值');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 9c 加密快照无密码 / 载荷损坏：merge 明确失败（不猜、不静默）', async () => {
  const root = await makeRoot('encrypted-no-password');
  try {
    const { devices, transport } = await createSharedDevices(root, ['a']);
    const a = devices['a']!;
    await seedConfig(a);
    await a.engine.push({ snapshotId: 'sync-a1' });
    // 把快照改造成「加密但无法解密」的形态
    const snap = transport.snapshots.get('sync-a1')! as unknown as Record<string, unknown>;
    snap['manifest'] = { ...(snap['manifest'] as object), encrypted: true };
    snap['sections'] = { encrypted: { info: { algorithm: 'aes-256-gcm', salt: '', iv: '', authTag: '' }, data: 'DSC1broken' } };
    transport.metas[0] = { ...transport.metas[0]!, manifest: { ...transport.metas[0]!.manifest, encrypted: true } };

    await assert.rejects(
      () => a.engine.merge(),
      (err: unknown) => err instanceof Error && /密码|password|decrypt|解密/i.test(err.message),
      '无密码时合并加密快照必须明确报错（不得把密文当明文）',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 13 重复执行幂等：同内容二次执行零写入（sync-state 逐字节不变）', async () => {
  const root = await makeRoot('idempotent');
  try {
    const { devices } = await createSharedDevices(root, ['a']);
    const a = devices['a']!;
    await seedConfig(a);
    await a.engine.push({ snapshotId: 'sync-a1' });

    // 第一次 merge：无变化 → 全部 skip
    const plan1 = await a.engine.merge();
    assert.ok(plan1.sections.every((s) => s.decision === 'skip'), '无改动时所有分区 skip');
    const before = await readStateText(a);
    // 对 skip 计划执行 applyMergePlan：没有任何 autoApply → 不得写盘
    const report = await a.engine.applyMergePlan({ autoApply: [], review: plan1.sections, skipped: [] });
    assert.equal(report.ok, true);
    assert.deepEqual(report.applied, []);
    assert.equal(await readStateText(a), before, '空计划执行后 sync-state 逐字节不变');
    assert.equal(await readSkill(a, 'coding.md'), '# Coding\n', '本机文件未被触碰');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
