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
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { atomicWriteFile } from '../utils/atomic-write.ts';
import { redact } from '../security/redaction.ts';

/** 高熵值形状（长 hex/base64/随机 id）：redact() 覆盖不了任意 secret，journal 级强脱敏补挡。 */
const HIGH_ENTROPY_RE = /([A-Za-z0-9+/_=-]{28,})/g;

/** 结构化时间戳/文件名形态：日期段必须由连字符连接（ISO 日期或紧凑时间戳）。
 *  连字符不存在于 hex/base64 token 中，豁免不会误放行随机密钥。 */
const DATE_STAMP_RE = /\d{4}-\d{2}-\d{2}|\d{8}-\d{6}/;

/** 高熵长 token 掩码（日期戳形态豁免；回调逐个 run 判定，避免误伤文件名/时间戳）。 */
function maskHighEntropy(text: string): string {
  return text.replace(HIGH_ENTROPY_RE, (run) => (DATE_STAMP_RE.test(run) ? run : '[REDACTED]'));
}

/**
 * journal 专用文本脱敏（Security P1-1 / §29 已并入）：
 * 现有 redact()（结构字段 + 已知值形状）+ 高熵长 token 掩码。
 * 用于 error / recovery.reason 等可能嵌入任意值的字段。
 */
export function redactJournalText(text: string): string {
  let out = text;
  try { out = redact(out); } catch { /* 脱敏失败保守处理 */ }
  return maskHighEntropy(out);
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
  /** 该项的结论文案（issue #35：安装失败曾被记成 `skipped` 且无 message，
   *  事后审计只能看到「用户跳过了这些插件」的错误结论）。可选，历史 journal 无此字段。 */
  message?: string | null;
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

/** Phase 5 post-recovery verification verdict（§6.3）。 */
export type RecoveryVerificationVerdict =
  | 'MATCH'            // 所有关键状态与 trusted snapshot 匹配 → terminal（可 COMMITTED）
  | 'PARTIAL_MATCH'    // 关键状态匹配，但存在不可验证项（如凭据值不可回读）→ terminal + 警告
  | 'MISMATCH'         // 关键状态不匹配（恢复未生效 / 部分残留）→ NEEDS_ATTENTION（不 COMMITTED）
  | 'VERIFICATION_ERROR'; // 验证本身失败（无法读文件 / 快照损坏）→ NEEDS_ATTENTION（不 COMMITTED）

/** Phase 5 post-recovery verification 结果（journal 可选字段，additive，不 bump schema）。 */
export interface RecoveryVerification {
  verdict: RecoveryVerificationVerdict;
  /** 每项检查结果（写入前过 redactJournalText 强脱敏）。 */
  details: string[];
  /** 需人工处理项（凭据等；写入前过 redactJournalText 强脱敏）。 */
  manualHints: string[];
  at: string;
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
  /**
   * Phase 5：post-recovery verification 结果（可选，additive）。
   * 旧 journal 无此字段（parseSafe 不受影响，schemaVersion 仍为 1）。
   * details/manualHints 写入前必须过 redactJournalText（journal 安全不变量：不保存 secret）。
   */
  recoveryVerification?: RecoveryVerification;
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

  /**
   * 收集已被「可恢复 / 未收敛 journal」引用的 snapshotId（Phase 4 F3 prune 保护）：
   * 扫描 active/ + quarantine/ + completed/ 下的 journal，凡「快照仍可能被 recovery/人工恢复用到」
   * 且 snapshotId 合法 → 收集。返回 Set<string>。该集合用于 FileSnapshotStore.prune 豁免 ——
   * 引用的 recovery snapshot 绝不可被自动淘汰。
   *
   * 什么算「已消费」（不保护）：
   *  - COMMITTED：apply 成功，快照用完；
   *  - ROLLED_BACK 且 rollback.full === true：完整回滚，盘面已回到导入前状态。
   * 审计 P0-3：**半回滚态**（ROLLED_BACK + full === false）与 NEEDS_ATTENTION / ROLLING_BACK /
   * RECOVERING 仍需 recovery 或人工恢复 —— 它们会被规整进 completed/，所以 completed/ 必须一起扫，
   * 否则「已回滚但没回滚干净」的回滚点会在 10 次快照后被静默淘汰（而它正是用户唯一的退路）。
   */
  async listReferencedSnapshotIds(): Promise<Set<string>> {
    const out = new Set<string>();
    const dirs = [this.activeDir(), this.quarantineDir(), this.completedDir()];
    for (const dir of dirs) {
      for (const name of await this.io.readdirNames(dir)) {
        if (!isJournalBasename(name)) continue;
        const text = await this.io.readFileText(path.join(dir, name)).catch(() => null);
        if (text === null) continue;
        const j = parseSafe(text);
        if (j === null) continue;
        if (j.state === 'COMMITTED') continue; // 已消费，不保护
        if (j.state === 'ROLLED_BACK' && j.rollback.full === true) continue; // 完整回滚：已回到导入前状态
        if (typeof j.snapshotId === 'string' && j.snapshotId !== '') out.add(j.snapshotId);
      }
    }
    return out;
  }

  // ---------- SAFE MODE ----------

  /** 祖先布局核对链（SAFE MODE 判定用）：<transactionsDir> → 其父目录。 */
  private safeModeLayoutRoots(): string[] {
    return [this.transactionsDir, path.dirname(this.transactionsDir)];
  }

  /**
   * 读 SAFE MODE 标记（三态）。
   *
   * 审计 t26 收敛：本方法过去自带**第二份判定**（`/blocked|true/i` 正则 + `io.exists` 判存在），
   * 与宿主/CLI 的 `readSafeModeMarkerSync` 是两套判据 —— 同一 marker 在「无法判定」场景下结论相反
   * （旧实现把 IO 错误/目录占位当成「没有标记」→ 放行；同步侧返回 unknown 让调用方 fail-closed）。
   * 现在判定（含祖先布局核对）**只有 readSafeModeMarkerStateSync 一处实现**，两侧天然一致。
   */
  async readSafeModeState(): Promise<SafeModeMarkerState> {
    return readSafeModeMarkerStateSync(this.safeModePath(), this.safeModeLayoutRoots());
  }

  /** 读 SAFE MODE（boolean 兼容面）：只有 'blocked' 视为阻断；'unknown' 的 fail-closed 决策由上层做
   *  （与 `Phase3Recovery.probeSafeModeSync` 同姿态：本层不把无法判定提升为阻断）。 */
  async readSafeMode(): Promise<boolean> {
    return (await this.readSafeModeState()) === 'blocked';
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

/* ------------------------------------------------------- SAFE MODE 标记（判定单一来源） */

/**
 * durable SAFE MODE 标记的**路径 + 内容判据 + 三态分类**（唯一来源）。
 *
 * 审计 t26：标记的三件事（路径 / 正则 / 「无法判定」如何处理）过去分散在 journal.ts（本类的
 * readSafeMode）与 phase3-host.ts（readSafeModeMarkerSync）两处，任一侧改动都会让同一 marker
 * 得出不同结论。现在：
 *  - 路径：本函数的 safeModeMarkerPath（phase3-host 只做 re-export）；
 *  - 内容判据：isSafeModeMarkerBlocking（**唯一正则**）；
 *  - 三态分类：classifySafeModeMarker（纯函数：IO 事实 → 三态；当前唯一采集方是
 *    syncSafeModeMarkerFacts —— 将来新增读取路径必须复用它，而不是再写一份判据）；
 *  - 读取实现：readSafeModeMarkerStateSync（宿主 apply() 同步阶段、CLI 离线门与
 *    JournalStore.readSafeModeState 共用同一份）。
 */
export type SafeModeMarkerState = 'blocked' | 'clear' | 'unknown';

/** durable SAFE MODE 标记的规范路径：`<dataDir>/transactions/safe-mode`。
 *  host 同步探测与 CLI 离线安全门必须走这一处定义，不得在别处再写一份字面量（审计 P0-11）。 */
export function safeModeMarkerPath(dataDir: string): string {
  return path.join(dataDir, TRANSACTIONS_DIR, SAFE_MODE_MARKER);
}

/** 标记内容判据（**唯一正则**）：内容含 blocked/true 即视为阻断。 */
export function isSafeModeMarkerBlocking(text: string): boolean {
  return /blocked|true/i.test(text);
}

/** 判定事实：两条 IO 后端各自采集，判定规则统一走 classifySafeModeMarker。 */
export type SafeModeMarkerFacts =
  | { kind: 'file'; text: string }              // 标记存在、是普通文件、内容已读出
  | { kind: 'absent'; layoutTrusted: boolean }  // 标记不存在；layoutTrusted=false = 路径被非目录/断链挡住
  | { kind: 'not-file' }                        // 目录/设备等占位：布局不可信
  | { kind: 'unreadable' };                     // 存在但读不出（权限 / IO 失败）

/**
 * 标记判定的**单一分类规则**（纯函数；同步/异步两条读取路径共用）：
 *  - 普通文件 → 内容判据（blocked / clear）；
 *  - 不存在且祖先布局可信 → clear（数据目录里本来没有标记，不误伤正常路径）；
 *  - 其余（不存在但路径被挡、存在却读不出、非普通文件）→ **unknown**：
 *    调用方必须 fail-closed，绝不当成「没有标记」放行（审计 P0-11 / t15 实测教训）。
 */
export function classifySafeModeMarker(facts: SafeModeMarkerFacts): SafeModeMarkerState {
  if (facts.kind === 'file') return isSafeModeMarkerBlocking(facts.text) ? 'blocked' : 'clear';
  if (facts.kind === 'absent') return facts.layoutTrusted ? 'clear' : 'unknown';
  return 'unknown';
}

/**
 * 单层祖先判定：'dir'（存在且是目录）/ 'absent'（确实不存在）/ 'unknown'（存在但不可穿透 / 不是目录 / 其它 IO 失败）。
 * statSync 跟随链接；若 stat 报 ENOENT 但 lstat 仍能命中（悬空符号链接）→ unknown，不放行。
 */
function classifyAncestor(dir: string): 'dir' | 'absent' | 'unknown' {
  try {
    return fssync.statSync(dir).isDirectory() ? 'dir' : 'unknown';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'unknown';
  }
  try {
    fssync.lstatSync(dir);
    return 'unknown'; // ENOENT 但条目仍在（悬空链接 / 无法穿透）
  } catch {
    return 'absent';
  }
}

/**
 * marker 报 ENOENT 时区分「确实不存在」与「祖先不是目录 / 不可访问」：
 * 逐层核对 layoutRoots（从最近到最远）：命中 'unknown' → 布局不可信 → unknown；
 * 命中 'dir' → 标记确实不存在 → 可信；全部 'absent' → 数据目录都不存在 → 可信。
 */
function isMarkerLayoutTrusted(layoutRoots: readonly string[]): boolean {
  for (const ancestor of layoutRoots) {
    const verdict = classifyAncestor(ancestor);
    if (verdict === 'unknown') return false;
    if (verdict === 'dir') return true;
  }
  return true;
}

/** 按真实文件系统采集标记事实（同步路径）。 */
function syncSafeModeMarkerFacts(markerPath: string, layoutRoots: readonly string[]): SafeModeMarkerFacts {
  let st: ReturnType<typeof fssync.statSync>;
  try {
    st = fssync.statSync(markerPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'unreadable' };
    return { kind: 'absent', layoutTrusted: isMarkerLayoutTrusted(layoutRoots) };
  }
  // 目录/设备等占位：不是「没有标记」，而是布局不可信 → fail-closed
  if (!st.isFile()) return { kind: 'not-file' };
  try {
    return { kind: 'file', text: fssync.readFileSync(markerPath, 'utf8') };
  } catch {
    return { kind: 'unreadable' };
  }
}

/**
 * 同步读取 SAFE MODE 标记（**唯一读取实现**）：宿主 apply() 同步阶段、CLI 离线门与
 * `JournalStore.readSafeModeState()` 共用，保证同一 marker 只有一种判定。
 *
 * **不得用 existsSync 判存在**：它对 ENOTDIR（祖先不是目录）/ 权限类 stat 失败一律返回 false，
 * 会把「无法判定」误判成「没有标记」而放行（审计 P0-11 残留；t15 实测 `transactions` 是普通文件
 * 时 existsSync=false → 旧实现判 clear → destructive 静默放行）。Windows 上路径穿过普通文件时
 * statSync 报 ENOENT（不是 ENOTDIR），故 errno 分类必须配合祖先目录核对。
 */
export function readSafeModeMarkerStateSync(
  markerPath: string,
  layoutRoots: readonly string[],
): SafeModeMarkerState {
  return classifySafeModeMarker(syncSafeModeMarkerFacts(markerPath, layoutRoots));
}

/** 便捷入口：按规范布局（`<dataDir>/transactions/safe-mode`，祖先核对 transactions → dataDir）。 */
export function readSafeModeMarkerSync(dataDir: string): SafeModeMarkerState {
  return readSafeModeMarkerStateSync(safeModeMarkerPath(dataDir), [path.join(dataDir, TRANSACTIONS_DIR), dataDir]);
}

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
