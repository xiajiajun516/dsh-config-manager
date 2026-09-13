/**
 * m-retention 集成测试（快照侧）：
 *  - selectPruneCandidatesByPolicy：缺省策略与既有 FIFO 结果逐项一致（向后兼容硬保证）；
 *  - 分层策略（keepLast + keepMonthly/keepYearly）保留跨月/跨年代表；
 *  - FileSnapshotStore 注入 retentionPolicy 后 prune 真按策略执行；
 *  - **既有豁免规则在分层下继续生效**：pinned 置顶快照豁免；
 *  - retentionPolicy 提供者抛错 → 回退缺省策略（不崩溃、不误删）。
 *
 * 与 tests/core/retention.test.ts（R-01..R-06，既有行为）互补：该文件守住旧行为不变，
 * 本文件证伪「分层策略真的接进了 prune 路径」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  FileSnapshotStore, selectPruneCandidates,
} from '../../src/core/backup.ts';
import type { PruneSelector } from '../../src/core/backup.ts';
import { DEFAULT_RETENTION_POLICY, selectPruneCandidatesByPolicy } from '../../src/sync/retention-policy.ts';
import { listSnapshots } from '../../src/core/restore.ts';

/**
 * 宿主注入形态的 GFS 选择器（与 src/index.ts 的 retentionPruneSelector 等价）：
 * core 不反向依赖 sync，故分层实现由宿主注入 —— 本测试按同一形态接线，
 * 才能证伪「分层策略真的接进了 prune 路径」。
 */
const gfsSelector: PruneSelector = (metas, policy) =>
  selectPruneCandidatesByPolicy(metas, policy, selectPruneCandidates);

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-retention-policy-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 直接写入一个快照目录（save() 之外的种子方式，同 tests/core/retention.test.ts） */
async function seedSnapshot(dir: string, id: string, createdAt: string): Promise<void> {
  await fs.mkdir(path.join(dir, id), { recursive: true });
  await fs.writeFile(path.join(dir, id, 'snapshot.json'), JSON.stringify({
    id, createdAt, sourceZip: `${id}.zip`, entries: [],
  }), 'utf8');
}

function minSnapshot(id: string, createdAt: string): {
  id: string; createdAt: string; sourceZip: string; entries: unknown[];
} {
  return { id, createdAt, sourceZip: `${id}.zip`, entries: [] };
}

/** 生成 2026-01..12 每月 3 个（day 5/10/15）共 36 个候选 */
function monthlyCandidates(): { id: string; createdAt: string }[] {
  const out: { id: string; createdAt: string }[] = [];
  for (let month = 1; month <= 12; month++) {
    for (const day of [5, 10, 15]) {
      out.push({
        id: `m${String(month).padStart(2, '0')}-d${String(day).padStart(2, '0')}`,
        createdAt: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00.000Z`,
      });
    }
  }
  return out;
}

/* ---------------- 纯函数：向后兼容 + 分层 ---------------- */

test('RP-I-01 缺省策略走旧路径：与 selectPruneCandidates 结果逐项一致（含同刻稳定次序）', () => {
  const metas = Array.from({ length: 15 }, (_, i) => ({
    // 每两个一组同刻：验证 tie-break 与既有实现一致
    id: `s${String(i + 1).padStart(2, '0')}`,
    createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + Math.floor(i / 2) * 86_400_000).toISOString(),
  }));
  assert.deepEqual(
    selectPruneCandidatesByPolicy(metas, DEFAULT_RETENTION_POLICY),
    selectPruneCandidates(metas),
    '缺省策略（最近 10 个）必须与既有 FIFO 逐项一致',
  );
  assert.deepEqual(selectPruneCandidatesByPolicy(metas), selectPruneCandidates(metas), '省略 policy 同结果');
  assert.deepEqual(selectPruneCandidatesByPolicy([], DEFAULT_RETENTION_POLICY), [], '空输入容错');
  assert.deepEqual(selectPruneCandidatesByPolicy(metas.slice(0, 10), DEFAULT_RETENTION_POLICY), [], '恰好 10 个不删');
});

test('RP-I-02 keepLast 层：可调数量（1 / 3 / 超总数）', () => {
  const metas = Array.from({ length: 6 }, (_, i) => ({
    id: `s${i}`,
    createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
  }));
  assert.equal(selectPruneCandidatesByPolicy(metas, { keepLast: 1, keepMonthly: 0, keepYearly: 0 }).length, 5, 'keepLast=1 删 5 个');
  assert.equal(selectPruneCandidatesByPolicy(metas, { keepLast: 3, keepMonthly: 0, keepYearly: 0 }).length, 3, 'keepLast=3 删 3 个');
  assert.deepEqual(selectPruneCandidatesByPolicy(metas, { keepLast: 99, keepMonthly: 0, keepYearly: 0 }), [], '超总数 → 不删');
  assert.deepEqual(
    selectPruneCandidatesByPolicy(metas, { keepLast: 0, keepMonthly: 0, keepYearly: 0 }),
    metas.map((m) => m.id).sort(),
    '全 0 策略 → 全部可清理（用户显式关闭自动保留）',
  );
});

test('RP-I-03 keepMonthly 分层：跨月老快照被保留，非代表项被清理', () => {
  const metas = monthlyCandidates();
  // 最近 2 个 + 每月留 1 份（12 个月）
  const prune = selectPruneCandidatesByPolicy(metas, { keepLast: 2, keepMonthly: 12, keepYearly: 0 });
  const kept = new Set(metas.map((m) => m.id).filter((id) => !prune.includes(id)));
  // 每月代表 = 该月最新（d15）→ 12 个；keepLast=2 额外选中 12 月的 d10/d15（d15 已作代表）→ +1
  assert.equal(kept.size, 13, '12 个月度代表 + keepLast 额外补的 12 月 d10');
  for (let month = 1; month <= 12; month++) {
    const key = `m${String(month).padStart(2, '0')}-d15`;
    assert.ok(kept.has(key), `每月最新项 ${key} 应被分层保留（这是相对纯 FIFO 的关键增益）`);
  }
  assert.ok(kept.has('m12-d10'), 'keepLast=2 额外保留 12 月 d10');
  assert.ok(prune.includes('m01-d05'), '1 月非代表项应被清理');
  assert.ok(prune.includes('m01-d10'), '1 月非代表项（次新）应被清理');
  assert.ok(!prune.includes('m01-d15'), '1 月代表不得被清理');
  // 对照：纯缺省策略（最近 10 个）会把 1-11 月全部清掉
  const pruneDefault = selectPruneCandidatesByPolicy(metas, DEFAULT_RETENTION_POLICY);
  assert.ok(pruneDefault.includes('m01-d15'), '缺省 FIFO 会淘汰 1 月代表（分层策略不会）');
  assert.equal(pruneDefault.length, 26, '缺省策略删 36 - 10 = 26 个');
});

test('RP-I-04 keepYearly 分层：跨年老快照被保留', () => {
  const metas = [
    { id: 'y2018', createdAt: '2018-06-01T00:00:00.000Z' },
    { id: 'y2019', createdAt: '2019-06-01T00:00:00.000Z' },
    { id: 'y2020', createdAt: '2020-06-01T00:00:00.000Z' },
    { id: 'y2021', createdAt: '2021-06-01T00:00:00.000Z' },
    { id: 'y2022', createdAt: '2022-06-01T00:00:00.000Z' },
  ];
  const prune = selectPruneCandidatesByPolicy(metas, { keepLast: 0, keepMonthly: 0, keepYearly: 3 });
  const kept = metas.map((m) => m.id).filter((id) => !prune.includes(id));
  assert.deepEqual(kept, ['y2020', 'y2021', 'y2022'], '最近 3 年各留 1 份');
  assert.deepEqual(prune.slice().sort(), ['y2018', 'y2019'], '被清理的是更早年份');
});

/* ---------------- store 集成：策略真接进 prune ---------------- */

test('RP-I-05 FileSnapshotStore：注入 retentionPolicy 后 prune 按分层执行', async () => {
  await withTmp(async (dir) => {
    // 12 个历史快照：2026-01..2026-12 各 1 个
    for (let month = 1; month <= 12; month++) {
      await seedSnapshot(dir, `h${String(month).padStart(2, '0')}`, `2026-${String(month).padStart(2, '0')}-15T00:00:00.000Z`);
    }
    // 策略：最近 1 个 + 每月留 1 份（12 个月额度）→ 第 13 个落盘后，月度层只保留 12 个最新月代表
    const store = new FileSnapshotStore({
      dir,
      retentionPolicy: () => ({ keepLast: 1, keepMonthly: 12, keepYearly: 0 }),
      pruneSelector: gfsSelector,
    });
    await store.save(minSnapshot('fresh', '2027-01-20T00:00:00.000Z'));

    const ids = (await listSnapshots(dir)).map((m) => m.id);
    assert.ok(ids.includes('fresh'), '新快照保留');
    assert.ok(ids.includes('h12'), '2026-12 仍保留');
    assert.ok(ids.includes('h02'), '2026-02 仍保留（在 12 个月额度内）');
    assert.ok(!ids.includes('h01'), '2026-01 被挤出月度额度（2027-01 占一个）→ 清理');
    assert.equal(ids.length, 12, '12 个月度代表（含 fresh 代表 2027-01）');

    // 对照：缺省策略下同样的 13 个快照只留最近 10 个（h01..h03 被清）
    const dir2 = `${dir}-default`;
    await fs.mkdir(dir2, { recursive: true });
    try {
      for (let month = 1; month <= 12; month++) {
        await seedSnapshot(dir2, `h${String(month).padStart(2, '0')}`, `2026-${String(month).padStart(2, '0')}-15T00:00:00.000Z`);
      }
      const storeDefault = new FileSnapshotStore({ dir: dir2 });
      await storeDefault.save(minSnapshot('fresh', '2027-01-20T00:00:00.000Z'));
      const ids2 = (await listSnapshots(dir2)).map((m) => m.id);
      assert.equal(ids2.length, 10, '缺省策略仍为「最近 10 个」（默认行为未被改变）');
      assert.ok(!ids2.includes('h01') && !ids2.includes('h02') && !ids2.includes('h03'), '缺省策略清最旧 3 个');
      assert.ok(ids2.includes('fresh'), '缺省策略保留最新');
    } finally {
      await fs.rm(dir2, { recursive: true, force: true });
    }
  });
});

test('RP-I-06 分层策略下 pinned 置顶快照仍豁免自动清理', async () => {
  await withTmp(async (dir) => {
    for (let month = 1; month <= 12; month++) {
      await seedSnapshot(dir, `h${String(month).padStart(2, '0')}`, `2026-${String(month).padStart(2, '0')}-15T00:00:00.000Z`);
    }
    // 最旧的 h01 置顶：分层策略会把它判为可淘汰，但 pinned 必须豁免
    const pinnedFile = path.join(dir, 'h01', 'snapshot.json');
    const rec = JSON.parse(await fs.readFile(pinnedFile, 'utf8')) as Record<string, unknown>;
    rec['pinned'] = true;
    await fs.writeFile(pinnedFile, JSON.stringify(rec), 'utf8');

    const store = new FileSnapshotStore({
      dir,
      retentionPolicy: () => ({ keepLast: 1, keepMonthly: 12, keepYearly: 0 }),
      pruneSelector: gfsSelector,
    });
    await store.save(minSnapshot('fresh', '2027-01-20T00:00:00.000Z'));

    const ids = (await listSnapshots(dir)).map((m) => m.id);
    assert.ok(ids.includes('h01'), '置顶快照必须豁免（即使分层策略判其可淘汰）');
    assert.ok(ids.includes('fresh'), '新快照保留');
  });
});

test('RP-I-07 retentionPolicy 提供者抛错 → 回退缺省策略（不崩溃、不误删）', async () => {
  await withTmp(async (dir) => {
    for (let i = 1; i <= 10; i++) {
      await seedSnapshot(dir, `s${String(i).padStart(2, '0')}`, `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z`);
    }
    const store = new FileSnapshotStore({
      dir,
      retentionPolicy: () => { throw new Error('策略读取失败（模拟）'); },
    });
    await store.save(minSnapshot('s11', '2026-11-01T00:00:00.000Z'));
    const ids = (await listSnapshots(dir)).map((m) => m.id);
    assert.equal(ids.length, 10, '回退缺省策略后仍为 10 个');
    assert.ok(!ids.includes('s01'), '缺省策略删最旧的 s01');
    assert.ok(ids.includes('s11'), '新快照保留');
  });
});

test('RP-I-08 retentionPolicy 异步提供者生效（宿主从配置读策略的形态）', async () => {
  await withTmp(async (dir) => {
    for (let month = 1; month <= 11; month++) {
      await seedSnapshot(dir, `h${String(month).padStart(2, '0')}`, `2026-${String(month).padStart(2, '0')}-15T00:00:00.000Z`);
    }
    let calls = 0;
    const store = new FileSnapshotStore({
      dir,
      retentionPolicy: async () => {
        calls += 1;
        return { keepLast: 1, keepMonthly: 11, keepYearly: 0 };
      },
      pruneSelector: gfsSelector,
    });
    await store.save(minSnapshot('fresh', '2026-12-20T00:00:00.000Z'));
    assert.ok(calls > 0, 'prune 时确实调用了策略提供者（接线证明）');
    const ids = (await listSnapshots(dir)).map((m) => m.id);
    assert.equal(ids.length, 11, '11 个月度代表保留（h01 被挤出：12 月由 fresh 代表）');
    assert.ok(ids.includes('h11'), '2026-11 保留');
    assert.ok(!ids.includes('h01'), '2026-01 被挤出月度额度 → 清理');
  });
});

/**
 * 反证检查（防空转）：**不注入** pruneSelector 时，core 只走 fallback（仅 keepLast），
 * 分层字段被忽略 → 跨月老快照应被按「最近 N 个」清掉。
 * 若本用例与 RP-I-05 结果相同，说明分层测试是空转的（没真依赖注入的选择器）。
 */
test('RP-I-09 反证：未注入分层选择器时分层不生效（证明 RP-I-05 非空转）', async () => {
  await withTmp(async (dir) => {
    for (let month = 1; month <= 12; month++) {
      await seedSnapshot(dir, `h${String(month).padStart(2, '0')}`, `2026-${String(month).padStart(2, '0')}-15T00:00:00.000Z`);
    }
    // 只给策略、不给选择器：core 的 fallback 只认 keepLast=1 → 第 13 个落盘后只剩 1 个
    const store = new FileSnapshotStore({
      dir,
      retentionPolicy: () => ({ keepLast: 1, keepMonthly: 12, keepYearly: 0 }),
    });
    await store.save(minSnapshot('fresh', '2027-01-20T00:00:00.000Z'));
    const ids = (await listSnapshots(dir)).map((m) => m.id);
    assert.deepEqual(ids, ['fresh'], '未注入分层选择器 → 退化为「只留最近 1 个」（分层未生效）');
  });

  // 对照：同一策略 + 注入分层选择器 → 12 个月代表都保留
  await withTmp(async (dir) => {
    for (let month = 1; month <= 12; month++) {
      await seedSnapshot(dir, `h${String(month).padStart(2, '0')}`, `2026-${String(month).padStart(2, '0')}-15T00:00:00.000Z`);
    }
    const store = new FileSnapshotStore({
      dir,
      retentionPolicy: () => ({ keepLast: 1, keepMonthly: 12, keepYearly: 0 }),
      pruneSelector: gfsSelector,
    });
    await store.save(minSnapshot('fresh', '2027-01-20T00:00:00.000Z'));
    const ids = (await listSnapshots(dir)).map((m) => m.id);
    assert.equal(ids.length, 12, '注入分层选择器 → 12 个月度代表保留（分层真生效）');
  });
});
