/**
 * issue #142（keepDays 年龄档）**接线护栏**：两条 prune 路径必须同口径。
 *
 * 背景：保留策略有两处消费点 ——
 *  1) 快照目录 prune（`selectPruneCandidatesByPolicy`，时间口径 createdAt）；
 *  2) 定时自动备份清理（`pruneAutoBackupsByPolicy`，时间口径 mtimeMs）。
 * 年龄档（`keepDays`）是「近 N 天内的全部保留，再对更早的按 GFS 稀释」，
 * 两条路径都要生效，否则用户会在一个入口看到「保留 7 天」、另一个入口照样删掉今天的备份。
 *
 * 本文件同时钉住两件事：
 *  - `keepDays` 参与「全关判定」：只开年龄档（keepLast/monthly/yearly 全 0）**不是**「不自动清理」，
 *    否则窗口期一过就再没人清理；
 *  - `now` 可注入：年龄档不依赖真实时钟（否则用例会随时间漂移）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AUTO_BACKUP_PREFIX, pruneAutoBackupsByPolicy } from './backup-files.ts';
import { selectPruneCandidatesByPolicy } from './retention-policy.ts';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const DAY = 86_400_000;

/** 造 auto 备份产物：mtime = NOW - daysAgo 天（名字用既有可解析形态） */
async function makeBackups(daysAgoList: number[]): Promise<{ dir: string; names: string[] }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-agedays-'));
  const names: string[] = [];
  for (let i = 0; i < daysAgoList.length; i++) {
    const days = daysAgoList[i]!;
    const name = AUTO_BACKUP_PREFIX + '2026100' + (i + 1) + '-000000-f' + i + '.zip';
    const p = path.join(dir, name);
    await fs.writeFile(p, 'zip');
    const secs = (NOW.getTime() - days * DAY) / 1000;
    await fs.utimes(p, secs, secs);
    names.push(name);
  }
  return { dir, names };
}

test('#142：自动备份清理按 keepDays 保住窗口内的全部产物', async () => {
  // f0=0 天前、f1=1 天前、f2=3 天前、f3=10 天前
  const { dir, names } = await makeBackups([0, 1, 3, 10]);
  try {
    const removed = await pruneAutoBackupsByPolicy(dir, { keepLast: 1, keepMonthly: 0, keepYearly: 0, keepDays: 2 }, NOW);
    const left = (await fs.readdir(dir)).sort();
    assert.deepEqual(left, [names[0]!, names[1]!].sort(), '2 天窗口内的两份必须原样保留');
    assert.deepEqual(removed.sort(), [names[2]!, names[3]!].sort(), '窗口外的两份按策略删除');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('#142：只开年龄档（keepLast/monthly/yearly 全 0）→ 仍在清理，不是「不自动清理」', async () => {
  const { dir, names } = await makeBackups([0, 40]);
  try {
    const removed = await pruneAutoBackupsByPolicy(dir, { keepLast: 0, keepMonthly: 0, keepYearly: 0, keepDays: 30 }, NOW);
    assert.deepEqual((await fs.readdir(dir)).sort(), [names[0]!].sort(), '窗口内的今天这份保留');
    assert.deepEqual(removed, [names[1]!], '40 天前那份被淘汰（全关判定必须把 keepDays 算进去）');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('#142：快照 prune 与自动备份清理同口径（同一策略、同一 now → 同一批年龄被淘汰）', () => {
  const metas = [0, 1, 3, 10].map((d) => ({
    id: 's' + d,
    createdAt: new Date(NOW.getTime() - d * DAY).toISOString(),
  }));
  const pruned = selectPruneCandidatesByPolicy(
    metas,
    { keepLast: 1, keepMonthly: 0, keepYearly: 0, keepDays: 2 },
    undefined,
    NOW,
  );
  assert.deepEqual(pruned, ['s10', 's3'], '窗口内 s0/s1 保留，其余按 createdAt 升序待删（先删最旧）');
});
