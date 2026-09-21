/**
 * 会话子集筛选（issue #39 Feature 1）：把 sessions 分区按「最新 N 个会话」挑出来。
 *
 * 三条硬规则（来自真机恢复现场）：
 *  - **单位是会话目录**：一个会话可能同时存在 `session.jsonl.zstd` 与 `session.v3.jsonl.zstd`
 *    （DSH 升级格式时留下的），只挑一份会让恢复出来的会话缺一半历史 → 选中目录即整目录带走；
 *  - **文件名判据不写死**：`session.lock` 之类运行时文件不算会话，新格式会话也不能被整批漏掉；
 *  - **按会话日志的最新 mtime 倒序**：不用目录 mtime（增量写入时不可靠）。
 *
 * 纯函数 + 注入式 mtime：不碰 fs，宿主/适配器负责提供时间，便于单测与对拍。
 */

/**
 * 会话日志文件名判据：`session` + 任意版本段 + `.jsonl`，可再带 `.zstd`。
 *
 * 刻意不写死 `session.jsonl.zstd`：DSH 换存储格式时会留下 `session.v3.jsonl.zstd` 之类的
 * 新形态，写死会让「最新 N 个」整批漏掉新格式会话。
 * 反向也刻意排除 `session.lock`：那是运行时锁文件，不是会话内容。
 */
export const SESSION_LOG_NAME_RE = /^session(\.[A-Za-z0-9]+)*\.jsonl(\.zstd)?$/;

/** 文件名（不含目录）是否为一个会话日志。 */
export function isSessionLogFileName(name: string): boolean {
  return SESSION_LOG_NAME_RE.test(name);
}

/** `sessions.limit` 归一化：非整数（含 undefined / NaN / 字符串）→ undefined = 不施加数量限制。 */
export function normalizeSessionLimit(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : undefined;
}

/**
 * 会话最小可拆单元 = `<projectKey>/<sessionId>` 目录（与 `SessionsAdapter.unitIdOf` 同一口径）。
 * 相对 `sessions` 根目录的路径，斜杠分隔。
 */
export interface SessionUnit {
  unitId: string;
  /** 该单元的会话日志（相对 `sessions` 根目录；至少一条，否则不构成会话） */
  logs: string[];
  /** 最新一份会话日志的 mtime（毫秒）；时间不可用 → null（排序时置后，绝不当成 0） */
  latestMtimeMs: number | null;
}

/** 路径 → 会话单元 id（深度不足 2 段 = 不是会话目录 → null）。 */
export function sessionUnitIdOf(relPath: string): string | null {
  const parts = relPath.split('/');
  if (parts.length < 2) return null;
  const project = parts[0] ?? '';
  const session = parts[1] ?? '';
  if (project === '' || session === '') return null;
  return `${project}/${session}`;
}

/**
 * 相对路径清单 → 会话单元清单。
 *
 * 只保留**含至少一个会话日志**的单元：`session.lock` 之类运行文件、以及深度不足两段的
 * 散落文件都不算会话（否则「最新 N 个」会被噪声文件挤占名额）。
 * `mtimeOf` 对每个日志文件调用一次（只有日志需要时间，避免为了排序 stat 整棵树）。
 */
export function groupSessionUnits(
  rels: readonly string[],
  mtimeOf: (rel: string) => number | null,
): SessionUnit[] {
  const units = new Map<string, SessionUnit>();
  for (const rel of rels) {
    const unitId = sessionUnitIdOf(rel);
    if (unitId === null) continue;
    const name = rel.split('/').pop() ?? '';
    if (!isSessionLogFileName(name)) continue;
    const existing = units.get(unitId);
    const mtime = mtimeOf(rel);
    if (existing === undefined) {
      units.set(unitId, { unitId, logs: [rel], latestMtimeMs: mtime });
      continue;
    }
    existing.logs.push(rel);
    if (mtime !== null && (existing.latestMtimeMs === null || mtime > existing.latestMtimeMs)) {
      existing.latestMtimeMs = mtime;
    }
  }
  return [...units.values()];
}

/**
 * 取最新的 `limit` 个会话单元，返回保留的 unitId 集合。
 *
 *  - `limit < 0` → 全带；
 *  - `limit === 0` → 空集；
 *  - 时间不可用的单元排在**最后**（并列按 unitId 字典序，结果稳定可复现）。
 */
export function pickLatestSessionUnits(units: readonly SessionUnit[], limit: number): Set<string> {
  const ordered = [...units].sort((a, b) => {
    const am = a.latestMtimeMs;
    const bm = b.latestMtimeMs;
    if (am === null && bm !== null) return 1;
    if (am !== null && bm === null) return -1;
    if (am !== null && bm !== null && am !== bm) return bm - am;
    return a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0;
  });
  const kept = limit < 0 ? ordered : ordered.slice(0, Math.max(limit, 0));
  return new Set(kept.map((u) => u.unitId));
}
