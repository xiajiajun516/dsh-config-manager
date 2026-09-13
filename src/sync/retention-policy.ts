/**
 * m-retention：保留策略（GFS 分层）纯函数层。
 *
 * 背景：保留策略此前是**三处硬编码 FIFO「保留最近 N 个」**——快照
 * `SNAPSHOT_RETENTION_LIMIT = 10`（core/backup.ts）、定时备份
 * `DEFAULT_BACKUP_RETENTION = 10`（sync/backup-files.ts），用户完全不可调、无分层。
 * 本模块把策略抽成可配置的 GFS 模型（参考 restic `forget --keep-last/--keep-monthly/
 * --keep-yearly`；配置备份场景下「最近几份 + 每月留 1 份」这类分层比纯 FIFO 更合用）。
 *
 * 分层语义（selectRetentionKeepers，**级联 GFS**；分层规则见下，务必精确）：
 *  1) keepLast：按时间倒序取最近 N 个（N<=0 = 关闭该层）；
 *  2) keepMonthly：从新到旧扫描，**每个日历月首次遇见的项即该月代表**（= 该月最新项）；
 *     该月若已被 keepLast 代表，则**不额外追加文件**（避免同月两份），但仍**占用一个额度**；
 *     最多覆盖 keepMonthly 个月（= 字面语义「最多保留 N 个月的代表」）；
 *  3) keepYearly：同口径按日历年，最多覆盖 keepYearly 个年；
 *  4) 结果 = 三层并集（同一候选绝不重复计入）。
 * 即：一个周期（月/年）在同一层内至多贡献 1 份，且月度/年度层覆盖的周期数严格不超过额度。
 *
 * 日历口径统一用 **UTC**（跨时区/跨机器结果一致、测试可确定；产物是天粒度，本地时区与
 * UTC 的差异仅是一天内的时刻偏移，不改变「每月留一份」的意图）。
 *
 * 零依赖（**不 import 任何模块**，尤其不得出现 `node:` 前缀）：本模块被 host（prune 决策）
 * 与 client（设置界面）同时引用——按仓库铁律，跨端运行时 import 会把整条依赖链打进
 * `lib/client.js`，一旦带 `node:` 依赖即致插件整体加载失败。
 */

/** 保留策略（GFS 三层；`0` = 关闭该层） */
export interface RetentionPolicy {
  /** 最近保留份数（按时间倒序） */
  keepLast: number;
  /** 每月保留份数（按 UTC 日历月分组，每月至多保留最新 1 份，最多覆盖 N 个月） */
  keepMonthly: number;
  /** 每年保留份数（按 UTC 日历年分组，每年至多保留最新 1 份，最多覆盖 N 年） */
  keepYearly: number;
}

/** 缺省策略 = 「保留最近 10 个」——与既有硬编码 FIFO（快照 10 / 定时备份 10）**完全等价**：
 *  `keepMonthly=0 / keepYearly=0` 时行为与改造前一致（向后兼容，不改变现有用户行为）。 */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  keepLast: 10,
  keepMonthly: 0,
  keepYearly: 0,
};

/** 各层值域（UI 输入 min/max 与 validateRetentionPolicy 同源，避免两处漂移） */
export const RETENTION_LIMITS = {
  keepLast: { min: 0, max: 1000 },
  keepMonthly: { min: 0, max: 120 },
  keepYearly: { min: 0, max: 120 },
} as const;

/** 判定「是否为缺省策略」（决定接线处是否走既有 FIFO 路径保持逐字节等价） */
export function isDefaultRetentionPolicy(policy: RetentionPolicy): boolean {
  return policy.keepLast === DEFAULT_RETENTION_POLICY.keepLast
    && policy.keepMonthly === DEFAULT_RETENTION_POLICY.keepMonthly
    && policy.keepYearly === DEFAULT_RETENTION_POLICY.keepYearly;
}

/** 保留判定候选：两种来源**各带一个时间字段**（见 retentionCandidateTimeMs 的口径纪律）。
 *  - 快照目录：`id` + `createdAt`（ISO-8601 UTC 字符串）；
 *  - 备份产物：`name` + `mtimeMs`（数值时间戳）。 */
export interface RetentionCandidate {
  /** 快照 id（快照口径） */
  id?: string;
  /** 文件名（备份产物口径） */
  name?: string;
  /** 创建时间（ISO-8601 字符串；快照口径，优先于 mtimeMs） */
  createdAt?: string;
  /** 文件 mtime（ms 时间戳；备份产物口径，仅当无 createdAt 时使用） */
  mtimeMs?: number;
}

/** 候选标识：快照用 id、备份产物用 name；两者都缺失 → 空串（集合内仍可去重）。 */
export function retentionCandidateKey(item: RetentionCandidate): string {
  if (typeof item.id === 'string' && item.id !== '') return item.id;
  if (typeof item.name === 'string' && item.name !== '') return item.name;
  return '';
}

/**
 * 候选时间（ms）。**口径纪律（两条 prune 路径依赖它，勿随意改优先级）**：
 *
 * 1) `createdAt` **优先**：ISO-8601 UTC（`Z` 结尾、定宽）是快照的**创建时间**，
 *    且不可被文件复制/移动/恢复改写 —— 快照 prune（FileSnapshotStore.prune）走此口径，
 *    候选只带 `{id, createdAt}`。对定宽 ISO UTC 串，`Date.parse` 序 == 字符串字典序，
 *    故与既有 `selectPruneCandidates`（`a.createdAt < b.createdAt`）**可证明等价**。
 * 2) 无 `createdAt` 时退回 `mtimeMs`：ZIP 产物（pruneAutoBackupsByPolicy）走此口径，
 *    候选只带 `{name, mtimeMs}`；mtime 是备份产物的客观诞生次序，且既有实现本就按 mtime 排序。
 *
 * 为什么 createdAt 优先而非 mtimeMs：mtime 会被**复制/恢复流程改写**（本仓库有 restore 与
 * pre-restore 流程），若它压过 createdAt，快照路径就会从「创建时间序」漂移成「文件修改序」，
 * 在目录被复制后会删错文件 —— 而 createdAt 是快照自身的不可变事实。两者在生产候选里
 * **从不同时出现**（各自只带一个字段），此优先级是为「万一同时出现」时的确定性契约。
 *
 * 无法解析 → `NaN`（= 时间未知，由 selectRetentionKeepers 按最旧处理：优先被淘汰）。
 */
export function retentionCandidateTimeMs(item: RetentionCandidate): number {
  if (typeof item.createdAt === 'string' && item.createdAt !== '') {
    const parsed = Date.parse(item.createdAt);
    if (Number.isFinite(parsed)) return parsed;
    // createdAt 存在但不可解析：**不再**退回 mtimeMs —— 避免同一候选按两个口径漂移；
    // 直接判为「时间未知」（NaN），语义明确且可测。
    return Number.NaN;
  }
  if (typeof item.mtimeMs === 'number' && Number.isFinite(item.mtimeMs)) return item.mtimeMs;
  return Number.NaN;
}

/** UTC 日历月键（`2026-01`；零填充 → 字典序即时间序） */
function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** UTC 日历年键（`2026`；零填充 → 字典序即时间序） */
function yearKey(ms: number): string {
  return String(new Date(ms).getUTCFullYear());
}

/**
 * 分层保留共用实现：对「时间有效」的候选按周期键分组，每周期保留最新的 1 个，
 * 最多覆盖最新的 `limit` 个周期。
 *
 * - `decorated` 必须已按时间**倒序**（最新在前）→ 首次遇到的某周期项即该周期最新项；
 * - 周期已由上层（keepLast）保留时**只占位、不追加**（避免同周期保留两份）；
 * - 时间未知（NaN）的候选不参与分层（只在 keepLast 层按最旧处理）。
 */
function keepByPeriod(
  decorated: ReadonlyArray<{ key: string; time: number }>,
  keep: Set<string>,
  limit: number,
  periodOf: (ms: number) => string,
): void {
  if (limit <= 0) return;
  const covered = new Set<string>();
  for (const item of decorated) {
    if (!Number.isFinite(item.time)) continue;
    const period = periodOf(item.time);
    if (covered.has(period)) continue; // 该周期已由更新项代表
    if (covered.size >= limit) continue; // 已覆盖 limit 个周期（更早周期不再保护）
    covered.add(period);
    if (!keep.has(item.key)) keep.add(item.key); // 该周期最新项入选
  }
}

/**
 * 选出应**保留**的候选标识集合（纯函数、稳定排序、绝不修改入参）。
 *
 * - `keepLast <= 0` = 不按「最近」保护，但 monthly/yearly 两层仍生效；
 * - 时间未知（NaN）的候选按**最旧**处理（排在最后，最先被淘汰）；
 * - 同刻候选的稳定次序：输入序靠后的在前（= 「更晚」）；该取向与既有
 *   `selectPruneCandidates` 的稳定升序 + 删最旧的语义一致；
 * - 缺省策略（keepLast=10，无分层）下结果与既有 FIFO 完全一致（见 `retention-policy.test.ts`
 *   的一致性用例；接线处的 `isDefaultRetentionPolicy` 快速路径提供逐字节保底）。
 *
 * @param items 候选（备份产物 or 快照元信息）
 * @param policy 保留策略
 * @param now 参考时间（保留参数：供调用方注入确定时间，便于将来扩展「按时间窗口」类规则；
 *            当前分层规则不依赖 now，故默认值不影响结果）
 */
export function selectRetentionKeepers(
  items: readonly RetentionCandidate[],
  policy: RetentionPolicy,
  now: Date = new Date(),
): Set<string> {
  void now;
  const keep = new Set<string>();
  if (items.length === 0) return keep;

  // 装饰 + 稳定排序：时间倒序（最新在前）；**同刻确定性 tie-breaker**（见下）；时间未知排最后。
  //
  // tie-breaker 的选择（必须与既有 selectPruneCandidates 的语义一致，不可随意改）：
  // 旧实现 = `[...metas].sort((a,b) => a.createdAt < b.createdAt ? -1 : ... )` 取**升序**前
  // (N-limit) 个删除。JS `Array#sort` 自 ES2019 起稳定 → 同刻项保持**输入顺序**，
  // 因此旧实现「同刻时删输入序靠前的（较早的）」。
  // 本实现取「倒序最新在前 + slice(0, keepLast)」，要等价就必须让同刻项里
  // **输入序靠后的排在前面**（视为更晚、优先保留）→ 即 `b.index - a.index`。
  // 关键：本仓库 prune 的候选顺序来自 `fs.readdir`（**顺序不保证**），故
  // 「同刻删哪个」在两种实现下都由输入序决定；差别只在于我们把该规则**显式写死**了，
  // 而不是依赖 sort 的稳定性 —— 这正是「删哪个是确定的」的保证（有单测固化）。
  const decorated = items.map((item, index) => ({
    key: retentionCandidateKey(item),
    time: retentionCandidateTimeMs(item),
    index,
  }));
  decorated.sort((a, b) => {
    const at = Number.isFinite(a.time) ? a.time : Number.NEGATIVE_INFINITY;
    const bt = Number.isFinite(b.time) ? b.time : Number.NEGATIVE_INFINITY;
    if (at !== bt) return bt - at;
    return b.index - a.index; // 同刻：输入序靠后者视为更晚 → 优先保留（与旧实现稳定排序等价）
  });

  // 1) keepLast：最近 N 个
  if (policy.keepLast > 0) {
    for (const item of decorated.slice(0, policy.keepLast)) keep.add(item.key);
  }
  // 2) keepMonthly：按 UTC 日历月分组
  keepByPeriod(decorated, keep, policy.keepMonthly, monthKey);
  // 3) keepYearly：按 UTC 日历年分组
  keepByPeriod(decorated, keep, policy.keepYearly, yearKey);

  return keep;
}

/**
 * 校验保留策略输入（host 侧草稿校验与 UI 共用）。
 * 三个字段必须齐备且为整数、落在值域内；**非法一律拒绝并给可读原因**（绝不静默回退，
 * 调用方需自行决定是回退缺省还是把错误回给用户）。
 */
export function validateRetentionPolicy(
  raw: unknown,
): { ok: true; value: RetentionPolicy } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'retention must be an object with keepLast/keepMonthly/keepYearly' };
  }
  const obj = raw as Record<string, unknown>;
  const value: RetentionPolicy = { ...DEFAULT_RETENTION_POLICY };
  const fields: ReadonlyArray<[keyof RetentionPolicy, { min: number; max: number }]> = [
    ['keepLast', RETENTION_LIMITS.keepLast],
    ['keepMonthly', RETENTION_LIMITS.keepMonthly],
    ['keepYearly', RETENTION_LIMITS.keepYearly],
  ];
  for (const [name, range] of fields) {
    const v = obj[name];
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      return { ok: false, error: `${name} must be an integer` };
    }
    if (v < range.min || v > range.max) {
      return { ok: false, error: `${name} must be between ${range.min} and ${range.max}` };
    }
    value[name] = v;
  }
  return { ok: true, value };
}

/** 策略是否含分层（monthly/yearly 任一启用）：调用方据此决定是否走分层路径与提示文案。 */
export function hasRetentionTiers(policy: RetentionPolicy): boolean {
  return policy.keepMonthly > 0 || policy.keepYearly > 0;
}

/* ---------------- 接线契约（供宿主注入 core / backup-files） ---------------- */

/**
 * 分层保留选择器：与 core 的 `PruneSelector` **结构一致**（同一签名）。
 *
 * 为什么在这里而不在 core：架构边界测试禁止 `core/ → sync/` 反向依赖（core 是解耦领域层）。
 * 故 core 只声明结构契约（RetentionPolicyLike / PruneSelector），本模块提供 GFS 实现，
 * 由宿主（入口层 src/index.ts）注入。core 的 `fallbackPruneSelector` 在未注入时兜底。
 *
 * - 缺省策略（keepLast=10 且无分层）走旧 `selectPruneCandidates` 快速路径 → 与改造前等价；
 * - 返回按 createdAt 升序的**待清理** id 列表（先删最旧，与旧实现一致）；
 * - 不修改入参。
 */
export function selectPruneCandidatesByPolicy(
  metas: ReadonlyArray<{ id: string; createdAt: string }>,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  selectLegacy?: (metas: ReadonlyArray<{ id: string; createdAt: string }>, limit: number) => string[],
): string[] {
  if (isDefaultRetentionPolicy(policy)) {
    // 快速路径：由宿主传入 core 的 selectPruneCandidates 保持逐字等价；未传则走下面通用路径
    if (selectLegacy !== undefined) return selectLegacy(metas, policy.keepLast);
  }
  if (metas.length === 0) return [];
  const keepers = selectRetentionKeepers(
    metas.map((m) => ({ id: m.id, createdAt: m.createdAt })),
    policy,
  );
  const sorted = [...metas].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return sorted.filter((m) => !keepers.has(m.id)).map((m) => m.id);
}

/** 保留策略 → 一行可读摘要参数（供日志/i18n 文案组装；本层不产出用户可见句子）。
 *  `tiered=false` 表示三层均未启用（策略等价于「不自动清理」）。 */
export function retentionPolicySummary(policy: RetentionPolicy): {
  keepLast: number;
  keepMonthly: number;
  keepYearly: number;
  tiered: boolean;
} {
  return {
    keepLast: policy.keepLast,
    keepMonthly: policy.keepMonthly,
    keepYearly: policy.keepYearly,
    tiered: policy.keepLast > 0 || hasRetentionTiers(policy),
  };
}
