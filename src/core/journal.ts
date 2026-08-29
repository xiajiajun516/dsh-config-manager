/**
 * Durable Operation Journal（Phase 3：Crash Journal）。
 *
 * 职责（严格限定）：journal 的 schema / 状态机 / 持久化 / atomic 更新 / active 扫描 /
 * terminal 判定 / move（active→completed）/ quarantine / recovery-history / retention /
 * safe-mode 标记 / environmentFingerprint 存储辅助。
 *
 * **JournalStore 不决定** rollback / resume / transaction outcome —— 那些属于
 * `MutationTransactionCoordinator`（transaction-coordinator.ts）与 `Reconciler`（reconcile.ts）。
 *
 * 安全不变量（Phase 1 + Phase 3 Rev 3）：
 *  - journal 更新一律经 Phase 1 `atomicWriteFile`（单文件 old-or-new，不 truncate-write）。
 *  - journal 文件 mode 0600；transactions 目录 0700；symlink reject 写 + lstat 读。
 *  - 只把 `<uuid>.json` 当作 journal；忽略 `.dshcm.*.tmp` 及其它非 journal 文件。
 *  - 不保存任何 secret（错误/recovery.reason 须过强 redaction）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { atomicWriteFile } from '../utils/atomic-write.ts';
import { redact } from '../security/redaction.ts';

/** 高熵值形状（长 hex/base64/随机 id）：redact() 覆盖不了任意 secret，journal 级强脱敏补挡。 */
const HIGH_ENTROPY_RE = /([A-Za-z0-9+/_=-]{28,})/g;

/**
 * journal 专用文本脱敏（Security P1-1 / §29 已并入）：
 * 现有 redact()（结构字段 + 已知值形状）+ 高熵长 token 掩码。
 * 用于 error / recovery.reason 等可能嵌入任意值的字段。
 */
export function redactJournalText(text: string): string {
  let out = text;
  try { out = redact(out); } catch { /* 脱敏失败保守处理 */ }
  out = out.replace(HIGH_ENTROPY_RE, '[REDACTED]');
  return out;
}

// ---------- 常量 ----------

export const JOURNAL_SCHEMA_VERSION = 1;
export const TRANSACTIONS_DIR = 'transactions';
export const ACTIVE_DIR = 'active';
export const COMPLETED_DIR = 'completed';
export const QUARANTINE_DIR = 'quarantine';
export const RECOVERY_HISTORY_DIR = 'recovery-history';
export const SAFE_MODE_MARKER = 'safe-mode';
export const NEEDS_ATTENTION_SIDECAR_SUFFIX = '.needs-attention';
/** 只把 `<uuid>.json` 视作 journal（uuid v4 / v4-like），忽略 tmp 等。 */
const UUID_BASENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
const TMP_PREFIX = '.dshcm.';

export const VALID_OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- Journal 类型 ----------

export type JournalState =
  | 'CREATED' | 'SNAPSHOT_CREATED' | 'APPLYING' | 'VALIDATING' | 'COMMITTED'
  | 'ROLLING_BACK' | 'ROLLED_BACK'
  | 'RECOVERING' | 'RECOVERED'
  | 'NEEDS_ATTENTION';

/** terminal states：进入后 operation 不可再改向（只可 move/quarantine/retention） */
export const TERMINAL_STATES: ReadonlySet<JournalState> = new Set<JournalState>([
  'COMMITTED', 'ROLLED_BACK', 'RECOVERED', 'NEEDS_ATTENTION',
]);

/** 合法状态迁移表（严格；禁止无效 transition）。纯函数，供单测。 */
export const ALLOWED_TRANSITIONS: Record<JournalState, JournalState[]> = {
  CREATED: ['SNAPSHOT_CREATED', 'APPLYING', 'NEEDS_ATTENTION', 'RECOVERED', 'ROLLED_BACK'],
  SNAPSHOT_CREATED: ['APPLYING', 'NEEDS_ATTENTION', 'RECOVERED', 'ROLLED_BACK'],
  APPLYING: ['VALIDATING', 'ROLLING_BACK', 'NEEDS_ATTENTION', 'RECOVERED'],
  VALIDATING: ['COMMITTED', 'ROLLING_BACK', 'NEEDS_ATTENTION', 'RECOVERED'],
  COMMITTED: ['RECOVERED'],                    // COMMITTED 后只能由 recovery 规整为 RECOVERED（补记）
  ROLLING_BACK: ['ROLLED_BACK', 'NEEDS_ATTENTION'],
  ROLLED_BACK: ['RECOVERED'],                  // ROLLED_BACK 后 recovery 可规整为 RECOVERED（幂等）
  RECOVERING: ['RECOVERED', 'ROLLED_BACK', 'NEEDS_ATTENTION'],
  RECOVERED: [],
  NEEDS_ATTENTION: ['RECOVERING', 'ROLLED_BACK', 'RECOVERED'], // 用户确认后可进入 recovery 流程
};

export function isValidTransition(from: JournalState, to: JournalState): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalState(s: JournalState): boolean {
  return TERMINAL_STATES.has(s);
}

export type StepStatus = 'planned' | 'done' | 'failed' | 'skipped' | 'attention';

export interface JournalStep {
  adapter: string;
  ref: string;
  kind: string;
  /** 外部副作用（插件/Git/WebDAV/reinstall）——crash 后不可证明，一律保守 */
  external: boolean;
  /** side effect 前目标内容指纹（null = 不可指纹） */
  beforeFp: string | null;
  /** side effect 完成后重读磁盘算出的指纹（null = 不可指纹） */
  afterFp: string | null;
  status: StepStatus;
  appliedAt: string | null;
}

export interface JournalCommit { at: string | null; validated: boolean; validationWarnings: string[]; }
export interface JournalRollback {
  attemptedAt: string | null;
  full: boolean;
  failed: string[];
  /** 回滚 WAL：已补偿的 entry 序号（crash during rollback 判定用） */
  entryDone: Record<number, boolean>;
}
/** recovery 元数据；outcome 为 true 表示已达 terminal */
export interface JournalRecovery {
  attemptedAt: string | null;
  outcome: 'RECOVERED' | 'ROLLED_BACK' | 'NEEDS_ATTENTION' | null;
  reason: string;
  attempts: number;
}

/** 单个 operation 的 durable journal。不保存任何 secret 值。 */
export interface OperationJournal {
  schemaVersion: number;
  operationId: string;
  operationType: string;
  createdAt: string;
  updatedAt: string;
  state: JournalState;
  /** Journal→Lock 单向绑定（不回填 environment.lock） */
  ownerInstanceId: string;
  lockId: string;
  packageVersion: string;
  environmentFingerprint: string;
  snapshotId: string | null;
  plannedSteps: string[];
  steps: Record<string, JournalStep>;
  commit: JournalCommit;
  rollback: JournalRollback;
  recovery: JournalRecovery;
  /** 最后错误/原因文本（已 redact；非 secret） */
  error: string;
}

export function createJournalEntry(
  operationType: string,
  lockCtx: { operationId: string; ownerInstanceId: string; lockId: string; packageVersion: string; environmentFingerprint: string },
  now: string,
): OperationJournal {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    operationId: lockCtx.operationId,
    operationType,
    createdAt: now,
    updatedAt: now,
    state: 'CREATED',
    ownerInstanceId: lockCtx.ownerInstanceId,
    lockId: lockCtx.lockId,
    packageVersion: lockCtx.packageVersion,
    environmentFingerprint: lockCtx.environmentFingerprint,
    snapshotId: null,
    plannedSteps: [],
    steps: {},
    commit: { at: null, validated: false, validationWarnings: [] },
    rollback: { attemptedAt: null, full: false, failed: [], entryDone: {} },
    recovery: { attemptedAt: null, outcome: null, reason: '', attempts: 0 },
    error: '',
  };
}

/** 把 journal 从旧状态迁移到新状态（校验合法 transition；非法抛错）。纯函数。 */
export function transitionJournalState(j: OperationJournal, to: JournalState): OperationJournal {
  if (!isValidTransition(j.state, to)) {
    throw new Error(`非法 journal state transition: ${j.state} → ${to} (op ${j.operationId})`);
  }
  return { ...j, state: to, updatedAt: new Date().toISOString() };
}

// ---------- IO / 存储 ----------

/** 可注入 IO（测 failure injection；默认包 node:fs/promises）。 */
export interface JournalIo {
  mkdir(dir: string, opts: { recursive: boolean }): Promise<void>;
  readFileText(p: string): Promise<string>;
  writeAll(target: string, content: string): Promise<void>;
  rename(a: string, b: string): Promise<void>;
  readdirNames(dir: string): Promise<string[]>;
  readdirEntries(dir: string): Promise<Array<{ name: string; isDirectory(): boolean }>>;
  lstat(p: string): Promise<{ isSymbolicLink(): boolean } | null>;
  rm(p: string, opts: { recursive?: boolean; force?: boolean }): Promise<void>;
  exists(p: string): Promise<boolean>;
}

const defaultIo: JournalIo = {
  async mkdir(d, o) { await fs.mkdir(d, o); },
  async readFileText(p) { return (await fs.readFile(p, 'utf8')).toString(); },
  async writeAll(t, c) { await atomicWriteFile(t, c, { mode: 0o600, symlink: 'reject' }); },
  async rename(a, b) { await fs.rename(a, b); },
  async readdirNames(d) { try { return await fs.readdir(d); } catch { return []; } },
  async readdirEntries(d) { try { return await fs.readdir(d, { withFileTypes: true }); } catch { return []; } },
  async lstat(p) { try { return await fs.lstat(p); } catch { return null; } },
  async rm(p, o) { await fs.rm(p, o); },
  async exists(p) { try { await fs.access(p); return true; } catch { return false; } },
};

export interface JournalStoreOptions {
  transactionsDir: string;
  io?: JournalIo;
}

/** journal 严格 UUID 校验（防文件名穿越）。 */
export function isValidOperationId(id: unknown): id is string {
  return typeof id === 'string' && VALID_OPERATION_ID_RE.test(id);
}

/** 判断文件 basename 是否是可追踪的 journal（<uuid>.json）。忽略 tmp 及其它。 */
export function isJournalBasename(name: string): boolean {
  if (!UUID_BASENAME_RE.test(name)) return false;
  return !name.startsWith(TMP_PREFIX);
}

function parseSafe(text: string): OperationJournal | null {
  try {
    const parsed = JSON.parse(text) as OperationJournal;
    if (parsed === null || typeof parsed !== 'object') return null;
    if (parsed.schemaVersion !== JOURNAL_SCHEMA_VERSION) return null;
    if (isValidOperationId(parsed.operationId) !== true) return null;
    if (typeof parsed.state !== 'string' || !isTerminalState(parsed.state) && !Object.keys(ALLOWED_TRANSITIONS).includes(parsed.state)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** JournalStore：journal 持久化原语。不决定 transaction outcome。 */
export class JournalStore {
  private readonly transactionsDir: string;
  private readonly io: JournalIo;

  constructor(opts: JournalStoreOptions) {
    this.transactionsDir = opts.transactionsDir;
    this.io = opts.io ?? defaultIo;
  }

  private activeDir(): string { return path.join(this.transactionsDir, ACTIVE_DIR); }
  private completedDir(): string { return path.join(this.transactionsDir, COMPLETED_DIR); }
  private quarantineDir(): string { return path.join(this.transactionsDir, QUARANTINE_DIR); }
  private recoveryHistoryDir(): string { return path.join(this.transactionsDir, RECOVERY_HISTORY_DIR); }
  private safeModePath(): string { return path.join(this.transactionsDir, SAFE_MODE_MARKER); }
  private activePath(id: string): string { return path.join(this.activeDir(), `${id}.json`); }
  private completedPath(id: string): string { return path.join(this.completedDir(), `${id}.json`); }
  private quarantinePath(id: string): string { return path.join(this.quarantineDir(), `${id}.json`); }

  async ensureDirs(): Promise<void> {
    await this.io.mkdir(this.transactionsDir, { recursive: true });
    await this.io.mkdir(this.activeDir(), { recursive: true });
    await this.io.mkdir(this.completedDir(), { recursive: true });
    await this.io.mkdir(this.quarantineDir(), { recursive: true });
    await this.io.mkdir(this.recoveryHistoryDir(), { recursive: true });
  }

  /** 写 journal（atomic + 0600 + symlink reject）。返回写入后的 journal。 */
  async persist(operationId: string, j: OperationJournal): Promise<OperationJournal> {
    if (!isValidOperationId(operationId)) throw new Error(`非法 operationId: ${JSON.stringify(operationId)}`);
    await this.ensureDirs();
    const updated = { ...j, updatedAt: new Date().toISOString() };
    await this.io.writeAll(this.activePath(operationId), `${JSON.stringify(updated, null, 2)}\n`);
    return updated;
  }

  /** 创建新 journal（CREATED）。调用方保证 active≤1。 */
  async create(entry: OperationJournal): Promise<OperationJournal> {
    return this.persist(entry.operationId, entry);
  }

  async load(operationId: string): Promise<OperationJournal | null> {
    if (!isValidOperationId(operationId)) return null;
    const p = this.activePath(operationId);
    if (await this.io.exists(p)) {
      const text = await this.io.readFileText(p);
      return parseSafe(text);
    }
    const c = this.completedPath(operationId);
    if (await this.io.exists(c)) {
      const text = await this.io.readFileText(c);
      return parseSafe(text);
    }
    return null;
  }

  async loadActive(operationId: string): Promise<OperationJournal | null> {
    if (!isValidOperationId(operationId)) return null;
    const p = this.activePath(operationId);
    if (!(await this.io.exists(p))) return null;
    if ((await this.io.lstat(p))?.isSymbolicLink() === true) return null; // symlink 防御
    const text = await this.io.readFileText(p);
    return parseSafe(text);
  }

  /** 更新 journal（按 updater 修改后原子持久化）。不负责 transition 校验（调用方经 transitionJournalState）。 */
  async update(operationId: string, updater: (j: OperationJournal) => OperationJournal): Promise<OperationJournal> {
    const cur = await this.loadActive(operationId);
    if (cur === null) throw new Error(`journal 不存在或损坏: ${operationId}`);
    return this.persist(operationId, updater(cur));
  }

  /** 原子迁移状态（校验合法 transition），并立即持久化。 */
  async transition(operationId: string, to: JournalState): Promise<OperationJournal> {
    return this.update(operationId, (j) => transitionJournalState(j, to));
  }

  /** 扫描 active/ 下全部 journal op id（只认 <uuid>.json；忽略 tmp/损坏）。 */
  async scanActive(): Promise<string[]> {
    const names = await this.io.readdirNames(this.activeDir());
    const out: string[] = [];
    for (const n of names) {
      if (!isJournalBasename(n)) continue;
      out.push(n.slice(0, -'.json'.length));
    }
    return out;
  }

  /** 判断某 op 是否已 terminal（读 active 或 completed 的 journal state）。 */
  async isTerminal(operationId: string): Promise<boolean> {
    const j = await this.load(operationId);
    return j !== null && isTerminalState(j.state);
  }

  async isActive(operationId: string): Promise<boolean> {
    return (await this.loadActive(operationId)) !== null;
  }

  async terminalStateOf(operationId: string): Promise<JournalState | null> {
    const j = await this.load(operationId);
    return j === null ? null : j.state;
  }

  /** move active → completed（terminal journal 规整；复用 rename，失败抛错由调用方策略处理）。 */
  async moveToCompleted(operationId: string): Promise<void> {
    if (!isValidOperationId(operationId)) throw new Error(`非法 operationId`);;
    await this.ensureDirs();
    const src = this.activePath(operationId);
    if (!(await this.io.exists(src))) return; // 已不在 active（幂等）
    // 只 move terminal 或已规整的；调用方保证
    const j = await this.loadActive(operationId);
    if (j === null) return;
    if (!isTerminalState(j.state)) {
      throw new Error(`moveToCompleted 仅接受 terminal journal: ${operationId} state=${j.state}`);
    }
    const dst = this.completedPath(operationId);
    if (await this.io.exists(dst)) {
      // 目标已存在（重复规整）→ 删 active 副本（两者内容一致才删；保守：直接覆盖 dst）
      await this.io.rm(src, { force: true });
      return;
    }
    await this.io.rename(src, dst);
  }

  /** quarantine 损坏/无法 parse/绑定失败的 journal（+ attention sidecar）。幂等。 */
  async quarantine(operationId: string, reason: string): Promise<void> {
    if (!isValidOperationId(operationId)) return; // 非法文件名不 quarantine（避免穿越）
    await this.ensureDirs();
    const src = this.activePath(operationId);
    if (!(await this.io.exists(src))) return;
    const dst = this.quarantinePath(operationId);
    if (await this.io.exists(dst)) {
      // 已 quarantine 过（幂等）：移除 active 副本，不重复 move
      await this.io.rm(src, { force: true });
      return;
    }
    await this.io.rename(src, dst);
    await this.io.writeAll(`${dst}${NEEDS_ATTENTION_SIDECAR_SUFFIX}`, `${JSON.stringify({ operationId, reason, at: new Date().toISOString() }, null, 2)}\n`);
  }

  /** 追加 recovery-history 事件（审计；best-effort 由调用方 try/catch 包裹）。 */
  async appendRecoveryHistory(marker: string, entry: unknown): Promise<void> {
    await this.ensureDirs();
    const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${marker}.json`;
    await this.io.writeAll(path.join(this.recoveryHistoryDir(), name), `${JSON.stringify(entry, null, 2)}\n`);
  }

  async listRecoveryHistory(): Promise<string[]> {
    const names = await this.io.readdirNames(this.recoveryHistoryDir());
    return names.sort();
  }

  // ---------- SAFE MODE ----------

  /** 读 SAFE MODE（RECOVERY_REQUIRED / NEEDS_ATTENTION）持久标记。存在且内容为 blocked → true。 */
  async readSafeMode(): Promise<boolean> {
    const p = this.safeModePath();
    if (!(await this.io.exists(p))) return false;
    const text = await this.io.readFileText(p);
    return /blocked|true/i.test(text);
  }

  /** 写/清 SAFE MODE 标记（atomic）。 */
  async writeSafeMode(blocked: boolean): Promise<void> {
    await this.ensureDirs();
    const p = this.safeModePath();
    if (!blocked) {
      if (await this.io.exists(p)) await this.io.rm(p, { force: true });
      return;
    }
    await this.io.writeAll(p, `${JSON.stringify({ blocked: true, at: new Date().toISOString() }, null, 2)}\n`);
  }

  // ---------- retention ----------

  /** 保留策略：completed 保留 N，recovery-history 保留 M。删最旧。幂等。 */
  async retention(completedLimit = 50, historyLimit = 200): Promise<void> {
    const completed = (await this.io.readdirNames(this.completedDir()))
      .filter(isJournalBasename).sort();
    await this.pruneOldest(this.completedDir(), completed, completedLimit);

    const hist = (await this.io.readdirNames(this.recoveryHistoryDir())).sort();
    await this.pruneOldest(this.recoveryHistoryDir(), hist, historyLimit);
  }

  private async pruneOldest(dir: string, names: string[], limit: number): Promise<void> {
    if (names.length <= limit) return;
    const toRemove = names.slice(0, names.length - limit);
    for (const n of toRemove) {
      await this.io.rm(path.join(dir, n), { force: true }).catch(() => undefined);
    }
  }
}

// ---------- Environment Fingerprint ----------

/**
 * 环境指纹：hash(hostname + 持久化 per-install 随机 token)。
 * token 存 <dataDir>/environment-fingerprint.token（0600，atomic），重启稳定、跨安装不同。
 * 不能用 Date.now/pid/临时 id。
 */
export async function environmentFingerprint(dataDir: string, io: JournalIo = defaultIo): Promise<string> {
  const tokenPath = path.join(dataDir, 'environment-fingerprint.token');
  let token: string;
  try {
    const tokenDir = path.dirname(tokenPath);
    await io.mkdir(tokenDir, { recursive: true });
    if (await io.exists(tokenPath)) {
      const raw = (await io.readFileText(tokenPath)).trim();
      token = /^[0-9a-f]{32,}$/i.test(raw) ? raw : crypto.randomBytes(24).toString('hex');
    } else {
      token = crypto.randomBytes(24).toString('hex');
      await io.writeAll(tokenPath, `${token}\n`);
    }
  } catch {
    token = crypto.randomBytes(24).toString('hex'); // 读不到 → 新 token（跨启动变化，保守 fallback）
    // 尽力落盘失败不阻塞（本指纹仅用于「是否同环境」，非安全边界）
  }
  const hostname = (() => { try { return os.hostname(); } catch { return 'unknown'; } })();
  return crypto.createHash('sha256').update(`${hostname}|${token}`).digest('hex');
}

/** 生成 operationId（UUID v4，严格 <uuid>.json 形态）。 */
export function generateOperationId(): string {
  return crypto.randomUUID();
}
