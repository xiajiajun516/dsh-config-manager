/**
 * Migration History & Auditability Engine（Phase 6）——统一、持久、append-only、可查询、可导出的
 * 迁移/审计历史存储。
 *
 * 职责（严格限定）：
 *  - migration-history/ 目录下 per-file append-only 条目存储；
 *  - 原子写（atomicWriteFile，0600 + symlink-reject）；
 *  - 读取（只认合法历史文件，忽略 tmp/脏文件；损坏文件跳过并计数）；
 *  - 查询（kind / 结果 / 时间 / 分区 过滤）、统计、导出（JSON / Markdown）；
 *  - retention（删最旧、幂等）；
 *  - **Redaction 边界**：条目内仅有 summary / error 是自由文本，写入前必须经
 *    scanAndRedact（含 high-entropy 档）+ redactJournalText 双重清洗；其余字段
 *    （kind/result/source/sections/operationId/snapshotId/runId/at）均为常量或 UUID，
 *    无 secret 承载面。
 *
 * 安全/架构纪律（Phase 6 §3）：
 *  - **不建第二套 framework**：复用 Phase 1 atomicWriteFile、journal 的 per-file append
 *    模式、security 脱敏、paths 保留前缀；本模块是新能力（审计史），非重复基础设施。
 *  - **APPEND-ONLY**：条目写入即完整独立文件，无 update/delete API（编译层无暴露）；
 *    仅 retention 删最旧。篡改文件 → 读回损坏识别并跳过（不静默接受）。
 *  - **DURABLE**：落盘跨重启。
 *  - **BOUND**：条目尽量关联 operationId / snapshotId / runId。
 *
 * 与 DSH 运行时解耦：IO 经可注入门面（测试注入失败点），引擎层零 DSH 依赖。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFile } from '../utils/atomic-write.ts';
import { maskHighEntropy, redact } from '../security/redaction.ts';
import { scanAndRedact } from '../security/secret-scanner.ts';
import { sha256Hex } from '../utils/hashing.ts';
import { coreText, engineMsg } from './messages-core.ts';
import type { MsgFunc } from './msg-types.ts';

// ---------- 常量 ----------

export const MIGRATION_HISTORY_SCHEMA_VERSION = 1;
export const MIGRATION_HISTORY_DIR = 'migration-history';
/** 默认保留上限（retention 删最旧）。 */
export const DEFAULT_MIGRATION_RETENTION = 1000;

/** 用户可配置的保留上限区间（0 = 不限制；上限防「一次填 10 亿」把 UI 输入当系统限制用）。 */
export const HISTORY_RETENTION_MIN = 0;
export const HISTORY_RETENTION_MAX = 100_000;

/**
 * 保留上限字面量校验（路由/偏好共用的唯一口径）：只接受区间内的整数。
 * 非法（字符串 / 小数 / 负数 / 越界）一律 false —— 调用方不得自行 Math.trunc 后放行。
 */
export function isValidHistoryRetention(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= HISTORY_RETENTION_MIN
    && value <= HISTORY_RETENTION_MAX;
}

/**
 * 有效保留上限：用户配置值合法则用它，否则回落默认（1000）。
 * 0 = 不限制（由 retention 自己短路），缺省/损坏 → 默认档。
 */
export function resolveHistoryRetention(configured: unknown): number {
  return isValidHistoryRetention(configured) ? configured : DEFAULT_MIGRATION_RETENTION;
}

/** 文件名正则：`<stamp>-<hex12>.<kind>.json`，只认合法历史文件。 */
const HISTORY_BASENAME_RE = /^[0-9A-Za-z:.+-]{8,}-[0-9a-f]{12}\.[a-z-]+\.json$/i;
const TMP_PREFIX = '.dshcm.';

/** 合法 kind 集合（§5 COMPLETE 清单 + 评审补 'profile-import'）。 */
const MIGRATION_KINDS = [
  'import', 'restore', 'rollback',
  'profile-create', 'profile-select', 'profile-switch', 'profile-delete', 'profile-rename', 'profile-save', 'profile-import',
  'sync-apply', 'autosync', 'recovery',
  'backup', 'backup-manual', 'snapshot-delete', 'snapshot-prune',
] as const;

// ---------- 类型 ----------

/** §5 覆盖的操作 kind（COMPLETE 不变量；常量枚举，天然非敏感）。 */
export type MigrationKind = (typeof MIGRATION_KINDS)[number];

/**
 * 操作结果。
 *
 * 'pending'（0.4.1）：操作**跑完了但仍有待裁决项**（自动同步上传成功、下行冲突未裁决；
 * 合并已应用一部分）。它不是 failed —— 网络/凭据/repo 都是好的；也不是 skipped ——
 * 那一轮确实做了事。旧实现把 partial 直接折成 'failed'，用户看到「自动同步 失败」而
 * 实际只需要在同步页确认一次冲突。读侧（parseEntry / query 解析）必须接受该值，
 * 否则含 pending 的历史条目会被整条丢弃。
 */
export type MigrationResult = 'success' | 'failed' | 'skipped' | 'pending';

/**
 * 自动同步一轮的状态 → 历史 result（宿主 appendHistoryFn 的唯一映射，0.4.1）。
 *
 * 关键一条：`partial`（跑完了但仍有待裁决分区）**不是** failed —— 通道与凭据都正常，
 * 只是需要用户在同步页确认一次冲突。落成 failed 会让首页红字报「同步失败」，
 * 用户据此去查网络/凭据，方向完全错。
 */
export function historyResultFromAutosyncStatus(status: 'success' | 'skipped' | 'partial' | 'failed'): MigrationResult {
  if (status === 'success') return 'success';
  if (status === 'skipped') return 'skipped';
  return status === 'partial' ? 'pending' : 'failed';
}

/**
 * 自动同步「空检查轮」判定：这一轮既没上传也没下行、更没应用任何分区（sections 恒空），
 * 它只是 realtime 通道缺省每 60s 一次（remoteCheckMs）的远端探测 —— 是**轮询**，不是活动。
 *
 * 为什么必须挡在统一历史之外（2026-11-08 真机实测，desktop 档案）：
 *  ① 1 条/分钟把首页「最近活动」刷成与真推**完全同形**的 success 行（用户据此报告
 *     「每隔 1 分钟都在推送」，而同期 git 工作副本只有 4 次真实 add/deletes）；
 *  ② 统一历史保留额度（缺省 1000 条）被空轮吃满：实测 1009 条里 934 条是 autosync，
 *     其中 688 条正是 upToDate 空轮，真实事件（备份 22 / 档案操作 40）被最旧淘汰；
 *  ③ /history 是目录全量扫描（条目越多首页越慢），空轮只会让它线性变慢。
 *
 * 不丢诊断：sync-history.json 仍逐轮记录（含 upToDate），同步页「上次运行 / 跳过原因」照常显示。
 */
export function isAutosyncIdleRound(entry: { status: string; skipReason?: string }): boolean {
  return entry.status === 'success' && entry.skipReason === 'upToDate';
}

/**
 * 自动同步方向 → 字典键（`both`/`push`/`pull`/`none` 是机器 token，不得直接铺到界面上）。
 * 未知方向返回 null，由调用方原样回显（不猜、不吞）。
 */
export function autosyncDirectionMessageKey(direction: unknown): string | null {
  switch (direction) {
    case 'push': return 'host.autosyncDirectionPush';
    case 'pull': return 'host.autosyncDirectionPull';
    case 'both': return 'host.autosyncDirectionBoth';
    case 'none': return 'host.autosyncDirectionNone';
    default: return null;
  }
}

/** 自动同步一轮 → 统一历史条目的载荷（不写则为 null）。 */
export type AutosyncHistoryInput = Pick<MigrationHistoryEntry, 'result' | 'sections' | 'source' | 'summary' | 'error'>;

/**
 * 自动同步一轮 → 统一历史条目；空检查轮返回 null（调用方直接 return，不写）。
 *
 * 规则落在 core 而不是宿主闭包里：宿主 src/index.ts 有体量棘轮（tests/file-size-ratchet.test.ts），
 * 且这几条判断本身要能单测（空轮不写 / 方向本地化 / failed 带原因）。
 * msg 由调用方注入（宿主传 engineMsg），本模块只管查表不引入新状态。
 */
export function autosyncUnifiedHistoryInput(
  entry: {
    status: 'success' | 'skipped' | 'partial' | 'failed';
    direction?: unknown;
    skipReason?: string;
    transport?: string;
    error?: string;
    appliedSections?: string[];
  },
  msg: MsgFunc = engineMsg,
): AutosyncHistoryInput | null {
  if (isAutosyncIdleRound(entry)) return null;
  const directionKey = autosyncDirectionMessageKey(entry.direction);
  const transport = entry.transport;
  const input: AutosyncHistoryInput = {
    result: historyResultFromAutosyncStatus(entry.status),
    sections: entry.appliedSections === undefined ? [] : [...entry.appliedSections],
    source: 'autosync',
    summary: msg('host.autosyncSummary', {
      direction: directionKey === null ? String(entry.direction ?? '') : msg(directionKey),
      transportSuffix: transport === undefined || transport === '' ? '' : msg('host.autosyncTransportSuffix', { transport }),
    }),
  };
  const error = entry.status === 'failed' ? (entry.error ?? entry.skipReason) : undefined;
  if (error !== undefined) input.error = error;
  return input;
}

/** 触发来源（常量）。 */
export type MigrationSource = 'api' | 'autosync' | 'backup-scheduler' | 'recovery' | 'cli' | 'internal';

/** 一条不可变的迁移历史记录（磁盘形态；schemaVersion 内联）。 */
export interface MigrationHistoryEntry {
  schemaVersion: number;
  at: string;
  kind: MigrationKind;
  result: MigrationResult;
  /** 涉及分区 adapter id（常量集合）。 */
  sections: string[];
  /** Journal operation id（UUID，BOUND）。 */
  operationId?: string;
  /** 快照 id（UUID，BOUND）。 */
  snapshotId?: string;
  /** run-registry runId（UUID，BOUND）。 */
  runId?: string;
  source: MigrationSource;
  /** 非敏感摘要（redact + high-entropy 后）。 */
  summary: string;
  /** 失败原因（redact + high-entropy 后）。 */
  error?: string;
}

/**
 * 磁盘形态：schemaVersion + contentHash（对除 contentHash 外全字段的 SHA-256）。
 * contentHash 用于 **append-only 篡改检测**：合法 JSON 内改字段值（含 result/summary/at）
 * → 读回 hash 不符 → 该文件被识别为损坏并跳过（满足「篡改必须被拒绝或检测」）。
 * 仅是内联字段（非 MAC/签名 / 非第二套 integrity framework；审计史非对抗性安全边界）。
 */
export interface StoredMigrationHistoryEntry extends Omit<MigrationHistoryEntry, 'schemaVersion'> {
  schemaVersion: number;
  contentHash: string;
}

/** 查询条件（纯函数过滤）。 */
export interface MigrationQuery {
  kinds?: MigrationKind[];
  /** 起始时间（epoch ms，含）。 */
  from?: number;
  /** 结束时间（epoch ms，含）。 */
  to?: number;
  result?: MigrationResult[];
  /** sections 子集匹配（条目 sections 含任一查询分区即命中）。 */
  sections?: string[];
}

/** 统计（纯函数）。 */
export interface MigrationHistoryStats {
  total: number;
  byKind: Partial<Record<MigrationKind, number>>;
  byResult: Partial<Record<MigrationResult, number>>;
}

export type ExportFormat = 'json' | 'markdown';

/** 读取历史的结果：合法条目 + 被识别为损坏/跳过的文件名（append-only 篡改检测）。 */
export interface ReadMigrationResult {
  entries: StoredMigrationHistoryEntry[];
  /** 被跳过/损坏的文件名（读取时识别，UI 可选警示；不静默接受）。 */
  corrupted: string[];
  /** 目录内**合法历史文件**总数（含被 limit 窗口挡在外的旧条目；未统计时为 undefined）。 */
  total?: number;
}

/** 追加写入结果（best-effort 调用方据此判断降级）。 */
export interface AppendResult {
  ok: boolean;
  entry: StoredMigrationHistoryEntry;
  file?: string;
  error?: string;
}

/** 可注入 IO 门面（测试注入失败点）；默认包 node:fs/promises。 */
export interface MigrationIo {
  mkdir(dir: string, opts: { recursive: boolean }): Promise<void>;
  readdirNames(dir: string): Promise<string[]>;
  readFileText(p: string): Promise<string>;
  writeAll(target: string, content: string): Promise<void>;
  rm(p: string, opts: { recursive?: boolean; force?: boolean }): Promise<void>;
  lstat(p: string): Promise<{ isSymbolicLink(): boolean } | null>;
  exists(p: string): Promise<boolean>;
}

const defaultIo: MigrationIo = {
  async mkdir(d, o) { await fs.mkdir(d, o); },
  async readdirNames(d) { try { return await fs.readdir(d); } catch { return []; } },
  async readFileText(p) { return (await fs.readFile(p, 'utf8')).toString(); },
  async writeAll(t, c) { await atomicWriteFile(t, c, { mode: 0o600, symlink: 'reject' }); },
  async rm(p, o) { await fs.rm(p, o); },
  async lstat(p) { try { return await fs.lstat(p); } catch { return null; } },
  async exists(p) { try { await fs.access(p); return true; } catch { return false; } },
};

// ---------- Redaction（双保险） ----------
// 高熵长 token 掩码与 journal 语义完全一致 → 唯一实现在 `security/redaction.ts`
// （`maskHighEntropy`；HIGH_ENTROPY_RE 带 `/g`，其 lastIndex 语义见该处注释）。

/**
 * 历史文本强脱敏：redact（结构化字段 + 已知值形状）+ 高熵长 token 掩码。
 * 用于 summary / error 等可能嵌入任意值的字段（REDACTED 不变量）。
 */
export function redactHistoryText(text: string): string {
  let out = text;
  try { out = redact(out); } catch { /* 脱敏失败保守处理 */ }
  return maskHighEntropy(out);
}

/**
 * 构造安全条目：对 summary / error 做强脱敏（scanAndRedact 高熵档 + redactHistoryText），
 * 做白名单字段规范化，并计算 contentHash（对除 contentHash 外全字段的 SHA-256）。
 * **历史写入的唯一出口入口**，禁止绕过。
 */
export function sanitizeEntry(
  raw: Omit<MigrationHistoryEntry, 'schemaVersion'> & { schemaVersion?: number },
): StoredMigrationHistoryEntry {
  // 1) 无损子串掩码（redact 值形状 + 高熵长 token），保留周边可读文本——优先，
  //    避免「一个 sk- 子串就整段清空」导致审计可读性全失。
  const masked = {
    summary: redactHistoryText(raw.summary ?? ''),
    error: redactHistoryText(raw.error ?? ''),
  };
  // 2) scanAndRedact（高熵档）作为残留防线：若掩码后仍检测到威胁，保守整值清空，
  //    绝不带敏感值落盘。（scanAndRedact 对裸 string 静默跳过 → 固定包对象。）
  const { sanitized } = scanAndRedact({ summary: masked.summary, error: masked.error }, { highEntropy: true, valuePatterns: true });
  const s = (sanitized ?? {}) as { summary?: unknown; error?: unknown };
  const summary = typeof s.summary === 'string' ? s.summary : '';
  const hasError = ((masked.error ?? '') !== '');
  const error = hasError ? (typeof s.error === 'string' ? s.error : '') : undefined;
  const entry: MigrationHistoryEntry = {
    schemaVersion: MIGRATION_HISTORY_SCHEMA_VERSION,
    at: raw.at,
    kind: raw.kind,
    result: raw.result,
    sections: Array.isArray(raw.sections) ? raw.sections.filter((s): s is string => typeof s === 'string') : [],
    source: sourceGuard(raw.source),
    summary,
    error,
  };
  if (raw.operationId !== undefined && isUuid(raw.operationId)) entry.operationId = raw.operationId;
  if (raw.snapshotId !== undefined && isUuid(raw.snapshotId)) entry.snapshotId = raw.snapshotId;
  if (raw.runId !== undefined && isUuid(raw.runId)) entry.runId = raw.runId;
  const stored = entry as StoredMigrationHistoryEntry;
  stored.contentHash = computeContentHash(entry);
  return stored;
}

const VALID_SOURCES = new Set([
  'api', 'autosync', 'backup-scheduler', 'recovery', 'cli', 'internal',
]);

/** 运行期校验 source 属合法枚举；非法回退 'internal'（防未知来源绕过/清洗不一致）。 */
function sourceGuard(v: unknown): MigrationSource {
  return typeof v === 'string' && VALID_SOURCES.has(v) ? v as MigrationSource : 'internal';
}

/** 对除 contentHash 外全字段计算稳定 SHA-256（字段序稳定、无无关缩进/空白）。 */
function computeContentHash(entry: MigrationHistoryEntry): string {
  const payload = Object.fromEntries(
    Object.entries(entry).filter(([k]) => k !== 'contentHash'),
  );
  return sha256Hex(canonicalStringify(payload));
}

/** 稳定 JSON 序列化（键排序 + 无多余空白），保证 hash 跨运行稳定。 */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** 合法 kind 判定（类型守卫 + 运行时校验）。 */
export function isValidMigrationKind(k: unknown): k is MigrationKind {
  return typeof k === 'string' && (MIGRATION_KINDS as readonly string[]).includes(k);
}

/** 判断文件 basename 是否是可追踪历史文件（<sortable>-<hex>.json）。忽略 tmp 及其它。 */
export function isHistoryBasename(name: string): boolean {
  if (!HISTORY_BASENAME_RE.test(name)) return false;
  return !name.startsWith(TMP_PREFIX);
}

/** 文件名安全：仅 basename（不含目录分隔符/穿越）。 */
export function isSafeHistoryFilename(name: string): boolean {
  if (name === '' || name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  return name !== '.' && name !== '..';
}

/**
 * 生成排序文件名（Windows-safe 定宽时间戳 + 随机后缀 + kind 标记）。
 *
 * 时间戳契约（Windows/排序可靠性）：`toISOString().replace(/[:Z]/g,'')`
 * → `2026-08-30T120000.123`（UTC 定宽、仅 ASCII、无 Windows 非法字符 `<>:"/\|?*`、
 * 字典序== 时间序）。**禁止**以原始 `toISOString()`（含 `:`）直接落文件名（Windows rename 失败）。
 * 与既有 `dateStamp`（`YYYYMMDD-HHmmss`）语义同为「定宽 + 仅 ASCII + 可排序」，本实现用 UTC 含毫秒
 * 以获得更高时序精度；排序可靠性一致。
 */
export function makeHistoryFilename(now: Date, kind: MigrationKind): string {
  const stamp = now.toISOString().replace(/[:Z]/g, '');
  const rand = crypto.randomBytes(6).toString('hex');
  return `${stamp}-${rand}.${kind}.json`;
}

// ---------- 解析 ----------

function parseEntry(text: string): StoredMigrationHistoryEntry | null {
  try {
    const p = JSON.parse(text) as StoredMigrationHistoryEntry;
    if (p === null || typeof p !== 'object') return null;
    if (p.schemaVersion !== MIGRATION_HISTORY_SCHEMA_VERSION) return null;
    if (!isValidMigrationKind(p.kind)) return null;
    if (typeof p.at !== 'string' || p.at === '') return null;
    if (!['success', 'failed', 'skipped', 'pending'].includes(p.result)) return null;
    if (typeof p.source !== 'string') return null;
    if (typeof p.summary !== 'string') return null;
    // 可选字段校验
    if (p.operationId !== undefined && !isUuid(p.operationId)) return null;
    if (p.snapshotId !== undefined && !isUuid(p.snapshotId)) return null;
    if (p.runId !== undefined && !isUuid(p.runId)) return null;
    if (p.sections !== undefined && (!Array.isArray(p.sections) || p.sections.some((s) => typeof s !== 'string'))) return null;
    if (p.error !== undefined && typeof p.error !== 'string') return null;
    // **append-only 篡改检测**：contentHash 必须匹配（对除 contentHash 外全字段）。
    // 合法 JSON 内改任意字段值 → hash 不符 → 拒绝（计入 corrupted，不静默接受）。
    if (typeof p.contentHash !== 'string' || p.contentHash === '') return null;
    const payload = Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'contentHash'));
    if (sha256Hex(canonicalStringify(payload)) !== p.contentHash) return null;
    const { contentHash, ...rest } = p;
    return { ...rest, contentHash } as StoredMigrationHistoryEntry;
  } catch {
    return null;
  }
}

// ---------- IO ----------

export interface MigrationStoreOptions {
  /** history 存放目录（<dataDir>/migration-history）。 */
  dir: string;
  io?: MigrationIo;
  /** 保留上限（retention 用；调用方可覆盖）。 */
  retention?: number;
}

/** MigrationHistory：per-file append-only 历史存储。 */
export class MigrationStore {
  private readonly dir: string;
  private readonly io: MigrationIo;

  constructor(opts: MigrationStoreOptions) {
    this.dir = opts.dir;
    this.io = opts.io ?? defaultIo;
  }

  /** 追加一条历史（原子写）。best-effort：调用方须经 tryAppendHistory 处理失败降级。 */
  async append(raw: Omit<MigrationHistoryEntry, 'schemaVersion' | 'at' | 'kind'> & { kind: MigrationKind; at?: string }): Promise<AppendResult> {
    try {
      const at = raw.at ?? new Date().toISOString();
      const entry = sanitizeEntry({ ...raw, at } as Omit<MigrationHistoryEntry, 'schemaVersion'>);
      // **防覆盖**：目标已存在（同毫秒+同随机后缀碰撞，概率极低但非零）→ 换名，
      // 绝不覆盖既有条目（APPEND-ONLY 硬不变量：条目一旦写入不可改）。
      let filename = makeHistoryFilename(new Date(at), entry.kind);
      let target = path.join(this.dir, filename);
      await this.io.mkdir(this.dir, { recursive: true });
      let guard = 0;
      while (await this.io.exists(target)) {
        if (++guard > 8) return { ok: false, entry, error: engineMsg('core.migrationHistory.filenameCollision') };
        filename = makeHistoryFilename(new Date(at + guard), entry.kind);
        target = path.join(this.dir, filename);
      }
      await this.io.writeAll(target, `${JSON.stringify(entry, null, 2)}\n`);
      return { ok: true, entry, file: filename };
    } catch (error) {
      const entry = sanitizeEntry({ ...raw, at: raw.at ?? new Date().toISOString() } as Omit<MigrationHistoryEntry, 'schemaVersion'>);
      return { ok: false, entry, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 读取合法历史条目（旧→新；损坏/非史文件跳过并计数）。
   *
   * limit>0 时只读**最近 limit 条**（按文件名排序的尾部窗口）——首屏只要最近几十条活动，
   * 整目录 readFile+parse 是历史目录唯一的慢点（真机 2360 条 ≈ 650 ms 纯 IO/解析，
   * 叠上全量 JSON 回传即首页骨架 ~9.7 s 冷启动）。total 恒为目录内合法文件总数，
   * 调用方据此区分「共 N 条，本页只含最近 M 条」。
   */
  async read(opts: { limit?: number } = {}): Promise<ReadMigrationResult> {
    const names = await this.io.readdirNames(this.dir).catch(() => []);
    const entries: StoredMigrationHistoryEntry[] = [];
    const corrupted: string[] = [];
    const sorted = names.filter(isHistoryBasename).sort();
    const limit = opts.limit !== undefined && Number.isInteger(opts.limit) ? opts.limit : 0;
    const window = limit > 0 && sorted.length > limit ? sorted.slice(sorted.length - limit) : sorted;
    for (const name of window) {
      const p = path.join(this.dir, name);
      let text: string;
      try {
        if ((await this.io.lstat(p))?.isSymbolicLink() === true) { corrupted.push(name); continue; } // symlink 防御
        text = await this.io.readFileText(p);
      } catch {
        corrupted.push(name);
        continue;
      }
      const parsed = parseEntry(text);
      if (parsed === null) { corrupted.push(name); continue; }
      entries.push(parsed);
    }
    return { entries, corrupted, total: sorted.length };
  }

  /** 目录内合法历史文件总数（只 readdir，不读文件内容；供「自动清理」行展示）。 */
  async count(): Promise<number> {
    const names = await this.io.readdirNames(this.dir).catch(() => []);
    return names.filter(isHistoryBasename).length;
  }

  /**
   * 保留清理：按文件名排序删除最旧合法历史文件，幂等。只删合法历史文件（防误删）。
   * 返回本次删除的文件名。
   */
  async retention(limit = DEFAULT_MIGRATION_RETENTION): Promise<string[]> {
    const names = (await this.io.readdirNames(this.dir).catch(() => [])).filter(isHistoryBasename).sort();
    const removed: string[] = [];
    // 0（或负数）= 不限制：调用方显式关闭自动清理时按「保留全部」处理，绝不当作「删光」。
    if (!Number.isFinite(limit) || limit <= 0) return removed;
    if (names.length <= limit) return removed;
    const toRemove = names.slice(0, names.length - limit);
    for (const name of toRemove) {
      try {
        await this.io.rm(path.join(this.dir, name), { force: true });
        removed.push(name);
      } catch { /* 单文件删失败不中断其余 */ }
    }
    return removed;
  }
}

// ---------- 查询 / 统计 / 导出（纯函数） ----------

/** 纯函数过滤（无 IO）。 */
export function queryHistory(entries: StoredMigrationHistoryEntry[], q: MigrationQuery): StoredMigrationHistoryEntry[] {
  return entries.filter((e) => {
    if (q.kinds !== undefined && q.kinds.length > 0 && !q.kinds.includes(e.kind)) return false;
    if (q.result !== undefined && q.result.length > 0 && !q.result.includes(e.result)) return false;
    if (q.sections !== undefined && q.sections.length > 0) {
      if (!e.sections.some((s) => q.sections!.includes(s))) return false;
    }
    const t = Date.parse(e.at);
    if (!Number.isNaN(t)) {
      if (q.from !== undefined && t < q.from) return false;
      if (q.to !== undefined && t > q.to) return false;
    }
    return true;
  });
}

/** 纯函数统计（kind/result 计数）。 */
export function summarizeHistory(entries: StoredMigrationHistoryEntry[]): MigrationHistoryStats {
  const stats: MigrationHistoryStats = { total: entries.length, byKind: {}, byResult: {} };
  for (const e of entries) {
    stats.byKind[e.kind] = (stats.byKind[e.kind] ?? 0) + 1;
    stats.byResult[e.result] = (stats.byResult[e.result] ?? 0) + 1;
  }
  return stats;
}

/** 导出报告（纯函数）。渲染文本统一过 redact() 兜底（安全不变量）。 */
export function renderExport(entries: StoredMigrationHistoryEntry[], format: ExportFormat, locale: 'zh' | 'en' = 'zh'): string {
  // 显式 locale 形参（不是全局语言运行时）：从本域目录直接取对应语言的文案，语义与改造前逐字一致。
  const T = (key: Parameters<typeof coreText>[1]): string => coreText(locale, key);
  const L = {
    title: T('core.migrationHistory.title'),
    total: T('core.migrationHistory.total'),
    empty: T('core.migrationHistory.empty'),
    kind: T('core.migrationHistory.kind'),
    time: T('core.migrationHistory.time'),
    result: T('core.migrationHistory.result'),
    sections: T('core.migrationHistory.sections'),
    detail: T('core.migrationHistory.detail'),
  };
  const resultLabel = (r: MigrationResult): string => r === 'success'
    ? T('core.migrationHistory.resultSuccess')
    : r === 'failed'
      ? T('core.migrationHistory.resultFailed')
      : r === 'pending'
        ? T('core.migrationHistory.resultPending')
        : T('core.migrationHistory.resultSkipped');

  if (format === 'json') {
    const stats = summarizeHistory(entries);
    return redact(JSON.stringify({ title: L.title, stats, entries }, null, 2));
  }

  if (entries.length === 0) return `# ${L.title}\n\n${L.empty}\n`;
  const lines: string[] = [];
  lines.push(`# ${L.title}`, '');
  lines.push(`> ${L.total}: ${entries.length}`, '');
  lines.push('| ' + [L.time, L.kind, L.result, L.sections, L.detail].join(' | ') + ' |');
  lines.push('|' + ' --- |'.repeat(5));
  for (const e of entries) {
    const detail = redact(e.summary + (e.error !== undefined ? ` — ${e.error}` : ''));
    lines.push(`| ${e.at} | ${e.kind} | ${resultLabel(e.result)} | ${redact(e.sections.join(', '))} | ${detail} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 解析查询参数为 MigrationQuery（宿主路由复用；过滤非法输入）。 */
export function parseHistoryQuery(raw: Record<string, unknown>): MigrationQuery {
  const q: MigrationQuery = {};
  const kinds = parseList(raw['kind']);
  if (kinds.length > 0) q.kinds = kinds.filter(isValidMigrationKind);
  const results = parseList(raw['result']);
  if (results.length > 0) q.result = results.filter((r): r is MigrationResult => r === 'success' || r === 'failed' || r === 'skipped' || r === 'pending');
  const sections = parseList(raw['sections']);
  if (sections.length > 0) q.sections = sections;
  const from = parseNum(raw['from']);
  const to = parseNum(raw['to']);
  if (from !== undefined) q.from = from;
  if (to !== undefined) q.to = to;
  return q;
}

function parseList(v: unknown): string[] {
  if (v === undefined) return [];
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x !== '');
  return [];
}

function parseNum(v: unknown): number | undefined {
  if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  return undefined;
}
