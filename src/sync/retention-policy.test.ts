/**
 * 保留策略纯函数测试（m-retention）：
 *  - DEFAULT_RETENTION_POLICY 与既有 FIFO 行为一致性（向后兼容的硬保证）；
 *  - keepLast 边界（0 / 1 / N / 超总数）；
 *  - keepMonthly 跨月分组取每月最新 + 上限额度；
 *  - keepYearly 同理；
 *  - 三层并集不重复；
 *  - validateRetentionPolicy 全量非法输入拒绝；
 *  - 纯函数不修改入参 + 稳定次序（同刻候选）；
 *  - 时间未知（无 createdAt/mtimeMs）候选按最旧处理。
 *
 * 日历口径：**UTC**（与实现一致；断言用 `T00:00:00.000Z` 形态规避本地时区干扰）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RETENTION_POLICY,
  RETENTION_LIMITS,
  hasRetentionTiers,
  isDefaultRetentionPolicy,
  retentionCandidateKey,
  retentionCandidateTimeMs,
  retentionPolicySummary,
  selectPruneCandidatesByPolicy,
  selectRetentionKeepers,
  validateRetentionPolicy,
  type RetentionCandidate,
  type RetentionPolicy,
} from './retention-policy.ts';
import { SNAPSHOT_RETENTION_LIMIT, selectPruneCandidates } from '../core/backup.ts';

/** 构造候选（快照口径：id + createdAt） */
function snap(id: string, createdAt: string): RetentionCandidate {
  return { id, createdAt };
}

/** 保留策略快捷构造 */
function policy(keepLast: number, keepMonthly = 0, keepYearly = 0): RetentionPolicy {
  return { keepLast, keepMonthly, keepYearly };
}

/** Set → 排序数组（断言可读/可比） */
function sorted(keep: Set<string>): string[] {
  return [...keep].sort();
}

/* ---------------- 缺省策略与既有行为一致性 ---------------- */

test('RP-01 缺省策略常量：keepLast=10，分层关闭（= 等价既有 FIFO）', () => {
  assert.deepEqual(DEFAULT_RETENTION_POLICY, { keepLast: 10, keepMonthly: 0, keepYearly: 0 });
  assert.equal(DEFAULT_RETENTION_POLICY.keepLast, SNAPSHOT_RETENTION_LIMIT, '缺省 keepLast 必须等于既有快照保留上限');
  assert.equal(hasRetentionTiers(DEFAULT_RETENTION_POLICY), false, '缺省无分层');
  assert.equal(isDefaultRetentionPolicy(DEFAULT_RETENTION_POLICY), true);
  assert.equal(isDefaultRetentionPolicy(policy(10, 0, 1)), false, '任一字段不同即非缺省');
  assert.equal(isDefaultRetentionPolicy(policy(9, 0, 0)), false);
});

test('RP-02 缺省策略结果与既有 FIFO selectPruneCandidates 完全一致（含同刻稳定次序）', () => {
  // 15 个快照（含 3 对同刻）：既有实现删最旧的 5 个，本实现保留最新的 10 个 → 两者互补
  const items: RetentionCandidate[] = [];
  for (let i = 0; i < 15; i++) {
    // 每两个一组同刻（i=0/1 同刻，2/3 同刻 …），验证同刻 tie-break 与既有稳定排序一致
    const ms = Date.parse('2026-01-01T00:00:00.000Z') + Math.floor(i / 2) * 86_400_000;
    items.push(snap(`s${String(i).padStart(2, '0')}`, new Date(ms).toISOString()));
  }
  const keep = selectRetentionKeepers(items, DEFAULT_RETENTION_POLICY);
  // 既有实现（limit=10）：按 createdAt 升序取前 5 个删除
  const pruneLegacy = selectPruneCandidates(items.map((i) => ({ id: i.id!, createdAt: i.createdAt! })), 10);
  const all = items.map((i) => i.id!);
  const legacyKept = all.filter((id) => !pruneLegacy.includes(id)).sort();
  assert.deepEqual(sorted(keep), legacyKept, '缺省策略保留集合必须与既有 FIFO 保留集合逐项一致');
  assert.equal(pruneLegacy.length, 5, '既有实现删 5 个（前置校验：15 - 10）');
});

test('RP-03 缺省策略：不足/恰好上限时全部保留（与既有「不过线不删」一致）', () => {
  const ten = Array.from({ length: 10 }, (_, i) => snap(`s${i}`, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`));
  assert.equal(selectRetentionKeepers(ten, DEFAULT_RETENTION_POLICY).size, 10, '恰好 10 个全保留');
  assert.equal(selectRetentionKeepers(ten.slice(0, 3), DEFAULT_RETENTION_POLICY).size, 3, '不足 10 个全保留');
  assert.equal(selectRetentionKeepers([], DEFAULT_RETENTION_POLICY).size, 0, '空输入 → 空集合');
});

/* ---------------- keepLast 边界 ---------------- */

test('RP-04 keepLast 边界：0（关闭） / 1 / N / 超总数', () => {
  const items = [
    snap('old', '2026-01-01T00:00:00.000Z'),
    snap('mid', '2026-06-01T00:00:00.000Z'),
    snap('new', '2026-12-01T00:00:00.000Z'),
  ];
  assert.deepEqual(sorted(selectRetentionKeepers(items, policy(0))), [], 'keepLast=0 且无分层 → 不保留任何项');
  assert.deepEqual(sorted(selectRetentionKeepers(items, policy(1))), ['new'], 'keepLast=1 → 只留最新');
  assert.deepEqual(sorted(selectRetentionKeepers(items, policy(2))), ['mid', 'new'], 'keepLast=2 → 留最新两个');
  assert.deepEqual(sorted(selectRetentionKeepers(items, policy(99))), ['mid', 'new', 'old'], 'keepLast 超总数 → 全保留');
});

test('RP-05 keepLast 按时间倒序取最近（乱序输入结果一致）', () => {
  const chronological = [
    snap('a', '2026-01-01T00:00:00.000Z'),
    snap('b', '2026-02-01T00:00:00.000Z'),
    snap('c', '2026-03-01T00:00:00.000Z'),
  ];
  const shuffled = [chronological[1]!, chronological[2]!, chronological[0]!];
  assert.deepEqual(
    sorted(selectRetentionKeepers(shuffled, policy(2))),
    sorted(selectRetentionKeepers(chronological, policy(2))),
    '输入顺序不影响结果',
  );
  assert.deepEqual(sorted(selectRetentionKeepers(shuffled, policy(2))), ['b', 'c'], '取时间最新的两个');
});

/* ---------------- keepMonthly ---------------- */

test('RP-06 keepMonthly：跨月分组取每月最新（keepLast=0 时分层仍生效）', () => {
  // 1 月 3 个、2 月 2 个、3 月 1 个；keepLast=0 → 每月留最新 1 个
  const items = [
    snap('jan-1', '2026-01-05T00:00:00.000Z'),
    snap('jan-2', '2026-01-20T00:00:00.000Z'),
    snap('jan-3', '2026-01-31T00:00:00.000Z'),
    snap('feb-1', '2026-02-10T00:00:00.000Z'),
    snap('feb-2', '2026-02-28T00:00:00.000Z'),
    snap('mar-1', '2026-03-15T00:00:00.000Z'),
  ];
  assert.deepEqual(
    sorted(selectRetentionKeepers(items, policy(0, 12))),
    ['feb-2', 'jan-3', 'mar-1'],
    '每月保留时间最新的 1 个',
  );
});

test('RP-07 keepMonthly 上限：只覆盖最新的 N 个月（无候选的月份不占额度）', () => {
  // 2026-01 / 03 / 05 / 07 各 1 个；keepMonthly=2 → 只留 07 与 05
  const items = [
    snap('m01', '2026-01-15T00:00:00.000Z'),
    snap('m03', '2026-03-15T00:00:00.000Z'),
    snap('m05', '2026-05-15T00:00:00.000Z'),
    snap('m07', '2026-07-15T00:00:00.000Z'),
  ];
  assert.deepEqual(sorted(selectRetentionKeepers(items, policy(0, 2))), ['m05', 'm07'], '只保留最新 2 个月的代表');
  assert.deepEqual(
    sorted(selectRetentionKeepers(items, policy(0, 0))),
    [],
    'keepMonthly=0 → 该层关闭',
  );
});

test('RP-08 keepMonthly 与 keepLast 并集：同月代表已被 keepLast 选中时不额外留第二份', () => {
  // 3 月有 2 个：keepLast=1 取 mar-2；keepMonthly=12 只应「占位」3 月，不再追加 mar-1
  const items = [
    snap('jan-1', '2026-01-15T00:00:00.000Z'),
    snap('mar-1', '2026-03-10T00:00:00.000Z'),
    snap('mar-2', '2026-03-20T00:00:00.000Z'),
  ];
  const keep = selectRetentionKeepers(items, policy(1, 12));
  assert.deepEqual(sorted(keep), ['jan-1', 'mar-2'], '同月不保留两份（3 月只占 1 个位）');
});

/* ---------------- keepYearly ---------------- */

test('RP-09 keepYearly：按年分组取每年最新 + 上限额度', () => {
  const items = [
    snap('y2023', '2023-06-01T00:00:00.000Z'),
    snap('y2024', '2024-06-01T00:00:00.000Z'),
    snap('y2025', '2025-06-01T00:00:00.000Z'),
    snap('y2026', '2026-06-01T00:00:00.000Z'),
  ];
  assert.deepEqual(
    sorted(selectRetentionKeepers(items, policy(0, 0, 2))),
    ['y2025', 'y2026'],
    'keepYearly=2 → 只保留最近 2 年的代表',
  );
  assert.deepEqual(sorted(selectRetentionKeepers(items, policy(0, 0, 0))), [], 'keepYearly=0 → 层关闭');
  // 每年多个只留最新
  const many = [
    snap('2025-a', '2025-01-01T00:00:00.000Z'),
    snap('2025-b', '2025-12-31T00:00:00.000Z'),
    snap('2026-a', '2026-02-01T00:00:00.000Z'),
  ];
  assert.deepEqual(
    sorted(selectRetentionKeepers(many, policy(0, 0, 12))),
    ['2025-b', '2026-a'],
    '每年保留时间最新的 1 个',
  );
});

/* ---------------- 三层并集 ---------------- */

test('RP-10 三层并集：结果不重复、覆盖各级代表（last + monthly + yearly）', () => {
  const items = [
    snap('d-jan', '2026-01-10T00:00:00.000Z'),
    snap('d-feb', '2026-02-10T00:00:00.000Z'),
    snap('d-mar', '2026-03-10T00:00:00.000Z'),
    snap('y-2019', '2019-07-01T00:00:00.000Z'),
    snap('y-2018', '2018-07-01T00:00:00.000Z'),
  ];
  // keepLast=1 → d-mar；
  // keepMonthly=2 → 2026-03 已被 keepLast 代表（占额度、不追加）→ 再取 2026-02（d-feb）→ 额度用尽，
  //                  d-jan（2026-01）不再保护；
  // keepYearly=2 → 2026 已被代表（占额度、不追加）→ 再取 2019（y-2019）→ 额度用尽，2018 不保护。
  const keep = selectRetentionKeepers(items, policy(1, 2, 2));
  assert.deepEqual(sorted(keep), ['d-feb', 'd-mar', 'y-2019']);
  assert.equal(keep.size, 3, 'Set 天然去重：三层并集无重复项');

  // 分层额度放大后：月度 3 个月 + 年度 3 年 → 覆盖 jan/feb 两个月（mar 占位）+ 2019/2018 两年
  const wider = selectRetentionKeepers(items, policy(1, 3, 3));
  assert.deepEqual(sorted(wider), ['d-feb', 'd-jan', 'd-mar', 'y-2018', 'y-2019'], '额度充足时覆盖全部代表');
  assert.equal(wider.size, 5);
});

/* ---------------- 时间未知 / 边界 ---------------- */

test('RP-11 时间未知候选按最旧处理（keepLast 未达上限时仍被保留）', () => {
  const items: RetentionCandidate[] = [
    snap('no-time', 'not-a-date'),
    snap('t1', '2026-01-01T00:00:00.000Z'),
    snap('t2', '2026-02-01T00:00:00.000Z'),
  ];
  assert.deepEqual(sorted(selectRetentionKeepers(items, policy(2))), ['t1', 't2'], '未知时间排最后 → 被 keepLast=2 淘汰');
  assert.deepEqual(
    sorted(selectRetentionKeepers(items, policy(3))),
    ['no-time', 't1', 't2'],
    '未达上限时全保留（含时间未知项）',
  );
  // 时间未知项不参与分层（无法归入任何周期）
  assert.deepEqual(sorted(selectRetentionKeepers(items, policy(0, 12))), ['t1', 't2'], '未知时间项不进月度分层');
});

test('RP-12 候选标识与时间取值：id 优先于 name；createdAt 优先于 mtimeMs（口径纪律）', () => {
  assert.equal(retentionCandidateKey({ id: 'S1', name: 'a.zip' }), 'S1', '快照口径优先 id');
  assert.equal(retentionCandidateKey({ name: 'a.zip' }), 'a.zip', '备份产物用 name');
  assert.equal(retentionCandidateKey({}), '', '两者都缺失 → 空串');
  assert.equal(retentionCandidateKey({ id: '', name: 'b.zip' }), 'b.zip', '空 id 回退 name');
  const mtime = Date.parse('2026-05-05T00:00:00.000Z');
  assert.equal(
    retentionCandidateTimeMs({ createdAt: '2026-05-05T00:00:00.000Z' }),
    mtime,
    'createdAt（快照口径）解析为时间戳',
  );
  assert.equal(retentionCandidateTimeMs({ mtimeMs: mtime }), mtime, '无 createdAt 时用 mtimeMs（备份产物口径）');
  assert.equal(
    retentionCandidateTimeMs({ mtimeMs: Date.parse('2030-01-01T00:00:00.000Z'), createdAt: '2026-05-05T00:00:00.000Z' }),
    mtime,
    '**createdAt 优先于 mtimeMs**：mtime 会被复制/恢复改写，创建时间才是快照的不可变事实',
  );
  assert.equal(
    retentionCandidateTimeMs({ mtimeMs: mtime, createdAt: 'not-a-date' }),
    Number.NaN,
    'createdAt 存在但不可解析 → 不回退 mtimeMs（判为时间未知，避免同一候选按两口径漂移）',
  );
  assert.ok(Number.isNaN(retentionCandidateTimeMs({ createdAt: 'zzz' })), '非法 createdAt → NaN');
  assert.ok(Number.isNaN(retentionCandidateTimeMs({})), '全缺失 → NaN');
});

test('RP-13 纯函数不修改入参 + 候选顺序稳定（同刻按输入序倒序，与既有 FIFO tie-break 一致）', () => {
  const items = [
    snap('first', '2026-01-01T00:00:00.000Z'),
    snap('second', '2026-01-01T00:00:00.000Z'),
    snap('newer', '2026-06-01T00:00:00.000Z'),
  ];
  const snapshotBefore = JSON.stringify(items);
  const keep = selectRetentionKeepers(items, policy(2));
  assert.equal(JSON.stringify(items), snapshotBefore, '绝不修改入参');
  // 同刻两者取「输入序靠后」的那个（= 既有 sort 稳定 + 删最旧的语义）
  assert.deepEqual(sorted(keep), ['newer', 'second'], '同刻候选取输入序靠后者');

  const repeated = selectRetentionKeepers(items, policy(2, 3, 3));
  assert.deepEqual(sorted(repeated), sorted(selectRetentionKeepers(items, policy(2, 3, 3))), '同输入同策略结果可重复');
});

/* ---------------- 口径纪律：ISO 串序 ≡ Date.parse 序；同刻删哪个确定 ---------------- */

/**
 * RP-17（captain review 要求）：快照路径必须保持 **ISO-8601 字符串比较口径**。
 *
 * 对定宽 ISO-8601 UTC 串，字符串字典序 == `Date.parse` 时间序 —— 这是**可证明的等价**：
 *  `YYYY-MM-DDTHH:mm:ss.sssZ` 各字段定宽零填充，且以 `Z`（UTC）结尾，故逐字符比较
 *  等价于逐字段比较数值。本用例用随机化批量断言把该等价性固化，防止未来有人改成
 *  「非定宽」或「本地时区」写法而静默破坏快照 prune 语义。
 */
test('RP-17 口径等价：定宽 ISO-8601 UTC 串的字典序 ≡ Date.parse 序（快照路径安全）', () => {
  // 确定性伪随机（xorshift32），避免 Math.random 造成不可复现失败
  let seed = 0x2f6e2b1;
  const rnd = (): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0xffffffff;
  };
  const items: RetentionCandidate[] = [];
  for (let i = 0; i < 60; i++) {
    // 覆盖大范围时间戳（含跨年/闰年/月末），毫秒随机
    const ms = Date.parse('2015-01-01T00:00:00.000Z') + Math.floor(rnd() * 15 * 365 * 86_400_000);
    items.push(snap(`s${String(i).padStart(3, '0')}`, new Date(ms).toISOString()));
  }

  // 字典序升序
  const byString = [...items].sort((a, b) => (a.createdAt! < b.createdAt! ? -1 : a.createdAt! > b.createdAt! ? 1 : 0)).map((m) => m.id);
  // 时间戳序升序
  const byParse = [...items].sort((a, b) => Date.parse(a.createdAt!) - Date.parse(b.createdAt!)).map((m) => m.id);
  assert.deepEqual(byString, byParse, '定宽 ISO UTC 串：字典序必须与 Date.parse 序完全一致');

  // 端到端：新实现（走 Date.parse）的「应清理」集合必须与旧实现（走字符串序）一致
  for (const limit of [1, 5, 10, 30, 59]) {
    const legacy = selectPruneCandidates(items.map((m) => ({ id: m.id!, createdAt: m.createdAt! })), limit);
    const general = selectPruneCandidatesByPolicy(items.map((m) => ({ id: m.id!, createdAt: m.createdAt! })), {
      keepLast: limit, keepMonthly: 0, keepYearly: 0,
    });
    assert.deepEqual(general, legacy, `limit=${limit}：新口径应清理集合必须与旧口径一致`);
  }
});

/**
 * RP-18（captain review 要求）：同一时间戳的多项 → **删哪个是确定的**（不能依赖 sort 稳定性）。
 *
 * 候选顺序来自 `fs.readdir`（顺序不保证），故必须把 tie-break 规则显式写死并固化：
 * 同刻项里「输入序靠后者」视为更晚 → 优先保留；因此同刻组中**输入序最靠前者最先被淘汰**。
 * 本用例对多种输入排列断言「保留/淘汰集合按输入序完全确定」。
 */
test('RP-18 同刻确定性：同一时间戳多项时，淘汰谁由输入序唯一确定（不依赖 sort 稳定性）', () => {
  const T = '2026-07-07T07:07:07.000Z';
  // 5 项全同刻 + 1 项更早（保证有淘汰发生）；keepLast=2
  const mk = (order: string[]): RetentionCandidate[] =>
    order.map((id) => (id === 'old' ? snap(id, '2026-01-01T00:00:00.000Z') : snap(id, T)));

  // 排列 A：a,b,c,d,e 顺序
  const A = mk(['a', 'b', 'c', 'd', 'e', 'old']);
  const keepA = selectRetentionKeepers(A, policy(2));
  assert.deepEqual(sorted(keepA), ['d', 'e'], '同刻组取输入序最靠后的 2 个（e 更晚于 d）');

  // 排列 B：同刻组反序 → 保留的应是反序后最靠后的两个（即原 a,b）
  const B = mk(['e', 'd', 'c', 'b', 'a', 'old']);
  const keepB = selectRetentionKeepers(B, policy(2));
  assert.deepEqual(sorted(keepB), ['a', 'b'], '反序输入 → 保留集合随之改变（证明由输入序决定，而非「按 id 猜」）');

  // 确定性：同一输入重复调用结果完全相同
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(sorted(selectRetentionKeepers(A, policy(2))), ['d', 'e'], '同输入结果可重复');
  }

  // 与旧实现交叉验证：旧实现（稳定升序 + slice 删最旧）在同刻场景下的保留集合
  const legacyPrune = selectPruneCandidates(A.map((m) => ({ id: m.id!, createdAt: m.createdAt! })), 2);
  const legacyKeep = A.map((m) => m.id!).filter((id) => !legacyPrune.includes(id)).sort();
  assert.deepEqual(sorted(keepA), legacyKeep, '同刻场景下新实现保留集合 == 旧实现保留集合');

  // 全部同刻：明确「最早进入输入序的被淘汰」
  const allSame = mk(['x1', 'x2', 'x3', 'x4']);
  assert.deepEqual(sorted(selectRetentionKeepers(allSame, policy(2))), ['x3', 'x4'], '全同刻：取输入序最靠后的 2 个');
});

/* ---------------- validateRetentionPolicy ---------------- */

test('RP-14 validateRetentionPolicy：合法输入通过（含边界值 0 与上限）', () => {
  assert.deepEqual(validateRetentionPolicy({ keepLast: 5, keepMonthly: 12, keepYearly: 3 }), {
    ok: true,
    value: { keepLast: 5, keepMonthly: 12, keepYearly: 3 },
  });
  assert.deepEqual(
    validateRetentionPolicy({ keepLast: 0, keepMonthly: 0, keepYearly: 0 }),
    { ok: true, value: { keepLast: 0, keepMonthly: 0, keepYearly: 0 } },
    '全 0（关闭自动清理）合法',
  );
  assert.deepEqual(
    validateRetentionPolicy({
      keepLast: RETENTION_LIMITS.keepLast.max,
      keepMonthly: RETENTION_LIMITS.keepMonthly.max,
      keepYearly: RETENTION_LIMITS.keepYearly.max,
    }),
    {
      ok: true,
      value: {
        keepLast: RETENTION_LIMITS.keepLast.max,
        keepMonthly: RETENTION_LIMITS.keepMonthly.max,
        keepYearly: RETENTION_LIMITS.keepYearly.max,
      },
    },
    '上限值合法',
  );
});

test('RP-15 validateRetentionPolicy：非法输入一律拒绝并给可读原因（不静默回退）', () => {
  const cases: Array<{ input: unknown; pattern: RegExp; why: string }> = [
    { input: null, pattern: /object/, why: 'null' },
    { input: undefined, pattern: /object/, why: 'undefined' },
    { input: [], pattern: /object/, why: '数组' },
    { input: 'x', pattern: /object/, why: '字符串' },
    { input: 10, pattern: /object/, why: '数字（旧版 number 形态需调用方自行转换）' },
    { input: {}, pattern: /keepLast/, why: '缺字段' },
    { input: { keepLast: 1, keepMonthly: 1 }, pattern: /keepYearly/, why: '缺 keepYearly' },
    { input: { keepLast: -1, keepMonthly: 0, keepYearly: 0 }, pattern: /between/, why: '负数（下限 0）' },
    { input: { keepLast: 1.5, keepMonthly: 0, keepYearly: 0 }, pattern: /integer/, why: '小数' },
    { input: { keepLast: 0, keepMonthly: 0, keepYearly: 1.0000001 }, pattern: /integer/, why: '非整数（浮点误差）' },
    { input: { keepLast: 1001, keepMonthly: 0, keepYearly: 0 }, pattern: /between/, why: 'keepLast 超上限' },
    { input: { keepLast: 1, keepMonthly: 121, keepYearly: 0 }, pattern: /between/, why: 'keepMonthly 超上限' },
    { input: { keepLast: 1, keepMonthly: 0, keepYearly: 121 }, pattern: /between/, why: 'keepYearly 超上限' },
    { input: { keepLast: '10', keepMonthly: 0, keepYearly: 0 }, pattern: /integer/, why: '字符串数字' },
    { input: { keepLast: Number.NaN, keepMonthly: 0, keepYearly: 0 }, pattern: /integer/, why: 'NaN' },
    { input: { keepLast: Number.POSITIVE_INFINITY, keepMonthly: 0, keepYearly: 0 }, pattern: /integer/, why: 'Infinity' },
    { input: { keepLast: true, keepMonthly: 0, keepYearly: 0 }, pattern: /integer/, why: '布尔' },
    { input: { keepLast: null, keepMonthly: 0, keepYearly: 0 }, pattern: /integer/, why: 'null 字段' },
  ];
  for (const c of cases) {
    const r = validateRetentionPolicy(c.input);
    assert.equal(r.ok, false, `${c.why} 应被拒绝`);
    if (!r.ok) {
      assert.match(r.error, c.pattern, `${c.why} 的错误原因应可读且指向字段`);
      assert.ok(r.error.length > 0, `${c.why} 必须有错误文案`);
    }
  }
});

/* ---------------- 摘要工具 ---------------- */

test('RP-16 retentionPolicySummary：tiered 判定（全关 = 不自动清理）', () => {
  assert.deepEqual(retentionPolicySummary(policy(10, 0, 0)), { keepLast: 10, keepMonthly: 0, keepYearly: 0, tiered: true });
  assert.deepEqual(retentionPolicySummary(policy(0, 0, 0)), { keepLast: 0, keepMonthly: 0, keepYearly: 0, tiered: false });
  assert.deepEqual(retentionPolicySummary(policy(0, 12, 0)), { keepLast: 0, keepMonthly: 12, keepYearly: 0, tiered: true }, '仅月度分层也算启用');
  assert.deepEqual(retentionPolicySummary(policy(0, 0, 5)), { keepLast: 0, keepMonthly: 0, keepYearly: 5, tiered: true }, '仅年度分层也算启用');
});
