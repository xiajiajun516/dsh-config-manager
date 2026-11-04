/**
 * 文件体量棘轮（只许降，不许涨）。
 *
 * 为什么需要：巨型文件让「改一处要读多少」和 merge 冲突成本线性上升，
 * 但一次性拆分风险高。这里先把每个大文件的**当前行数**钉成上限 ——
 * 谁再往这些文件里加代码，测试就红，被迫先想「这点逻辑该放这吗」。
 *
 * 规则：
 * - 拆小了就把这里的天花板一起下调（棘轮只往下走）。
 * - 真要上调，必须同时写清理由与拆解计划，并在 `docs/maintenance/tech-debt.md` 记一笔。
 *   （上调记录：rollback-point 5963 → 5980，D3 内置敏感文件排除，见 tech-debt #3；
 *    run-store 2166 → 2221，恢复面板「写盘进行中」瞬态切片 + 4 处共用的登记 hook，
 *    这是 tech-debt #7 的修法本体，不是新增功能；locales 曾上调到 1797，本轮已按页面域
 *    拆成 `src/client/locales/*.ts`，聚合器回落 63 行并从本表移除（tech-debt #22）。）
 * - 新文件超过 1400 行也要登记进来（否则它会绕开棘轮继续长）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 路径 → 行数上限（当前实测值，只许下调）。 */
const CEILINGS: Record<string, number> = {
  'src/core/rollback-point.ts': 5980,
  // 4389 → 4135（2026-11-04）：调度/心跳/缓存清理下沉到 src/core/host-schedulers/，
  // parseSyncBody 家族下沉 route-support.ts；理由与残留见 tech-debt #23。
  'src/index.ts': 4135,
  'src/sync/sync-engine.ts': 2213,
  // 2166 → 2221（2026-11-04）：恢复面板「写盘进行中」瞬态切片 + begin/endRecoveryWrite
  // （不落盘，PersistedRecoveryState 显式 Omit 'write'），是 tech-debt #7 的修法本体。
  'src/client/run-store.ts': 2221,
  'src/core/analyzer.ts': 1481,
  'src/client/sync/SyncPanel.tsx': 1590,
  'src/cli/actions.ts': 1574,
  'src/ui/rollback-view.ts': 1558,
  'src/core/rollback-ledger.ts': 1462,
  'src/cli/index.ts': 1460,
};

/** wc -l 口径：按换行计数，末行无换行不计。 */
function lineCount(path: string): number {
  const text = readFileSync(path, 'utf8');
  let lines = text.split('\n').length - 1;
  if (text.length > 0 && !text.endsWith('\n')) lines += 1;
  return lines;
}

test('F-01 巨型文件不得超过登记上限（棘轮只许下调）', () => {
  const offenders: string[] = [];
  for (const [rel, ceiling] of Object.entries(CEILINGS)) {
    const abs = join(repoRoot, rel);
    assert.ok(existsSync(abs), `棘轮登记的文件已不存在：${rel}（拆分后请从表里移除并下调）`);
    const lines = lineCount(abs);
    if (lines > ceiling) offenders.push(`${rel}: ${lines} 行 > 上限 ${ceiling} 行`);
  }
  assert.deepEqual(
    offenders,
    [],
    '以下文件越过体量棘轮 —— 请先把逻辑下沉到新模块，而不是继续往上堆：\n' + offenders.join('\n'),
  );
});

test('F-02 棘轮表本身有效（无重复路径、行数已到阈值才算）', () => {
  const paths = Object.keys(CEILINGS);
  assert.equal(new Set(paths).size, paths.length, '棘轮表有重复路径');
  for (const rel of paths) {
    const lines = lineCount(join(repoRoot, rel));
    assert.ok(lines >= 1400, `${rel} 只有 ${lines} 行，已低于登记阈值，请从表中移除`);
  }
});
