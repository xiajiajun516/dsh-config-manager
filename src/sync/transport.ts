/**
 * m-sync-transport：SyncTransport 抽象层。
 * 纯类型 + 纯 helper，零副作用、零 fs —— 传输通道实现（git 等）由后续波次提供。
 * 与核心引擎同原则：只依赖 src/schema/types.ts 的纯类型，不 import 任何 DSH 运行时包。
 */
import type { EncryptionInfo, Manifest, SectionData, SectionId } from '../schema/types.ts';
import { hashSection } from './sync-state.ts';

/** manifest 摘要：快照列表展示 / 变更判断所需的轻量来源信息 */
export interface ManifestSummary {
  schemaVersion: number;
  dshVersion: string;
  platform: string;
  /** 快照包含的分区（按 manifest.sections 中为 true 的键） */
  sectionIds: SectionId[];
  containsSecrets: boolean;
  /** 快照是否加密（sections 为 EncryptedSections 密文载荷）；缺省 false（旧快照兼容） */
  encrypted?: boolean;
  /** 产生该快照的同步通道（git / webdav；供同步历史展示触发来源；旧快照缺省 undefined） */
  transport?: string;
  /**
   * 导出机的 DSH home（$DSH_HOME；issue #45 跨机基础路径重定基）。
   *
   * 为什么同步通道必须透传它：从另一台机器拉取时，工作区 path 与会话日志首帧 cwd 里
   * 的**源机**前缀不会被改写成目标机 home → 会话落到目标机不存在的 cwd 下，而 DSH
   * 按 realpath(cwd) 判定工作区归属，用户看到的是「同步成功、对话一条都不显示」。
   * 导入向导早有这条重定基（analyzer.rebaseMapping），同步侧此前缺这一段。
   * 缺省 undefined = 旧快照 / 未记录（不猜，行为与改造前一致）。
   */
  sourceHome?: string;
  /**
   * P1-5：累积的**会话删除墓碑**（会话单元 id）。
   *
   * 随每份快照一起走：拉取侧据此把命中的会话从「将要导入的载荷」里剔除，
   * 使旧快照无法复活已删除的对话。缺省 = 旧快照（无墓碑信息，行为与改造前一致）。
   */
  deletedSessions?: string[];
}

/** 快照元信息：list() 条目 / upload() 返回值 */
export interface SyncSnapshotMeta {
  id: string;
  createdAt: string; // ISO-8601 UTC
  /** 各分区内容 hash（sectionId → hashSection 结果），用于变更检测。
   *  加密快照的 sections 为密文载荷，不参与明文 hash 比较 → 空对象。 */
  sections: Partial<Record<SectionId, string>>;
  manifest: ManifestSummary;
}

/** 加密快照的 sections 载荷：整个明文 sections 对象序列化后整体加密（AES-256-GCM）。 */
export interface EncryptedSections {
  encrypted: {
    /** 加密参数（salt/iv/authTag base64；与 security/encryption.ts 的 EncryptionInfo 对齐） */
    info: EncryptionInfo;
    /** base64：带 DSC1 头的密文（明文 = 序列化的 sections Record） */
    data: string;
  };
}

/**
 * 加密快照的凭据载荷（issue #38）：`$DSH_HOME/.credentials.yaml` 原文整体加密。
 *
 * 为什么不放进 sections：`credentialsStatus`/`secrets` 是结构性拒绝分区
 * （SyncEngine.FORBIDDEN_SECTIONS 断言），凭据值必须走 sections 之外的独立载荷。
 * 只在 `includeSecrets=true`（由引擎强制 `encrypt=true`）的快照上出现，
 * 因此**永远**与 sections 一样是密文，明文既不落盘也不进 manifest。
 */
export interface EncryptedCredentials {
  /** 加密参数（salt/iv/authTag base64；与 security/encryption.ts 的 EncryptionInfo 对齐） */
  info: EncryptionInfo;
  /** base64：带 DSC1 头的密文（明文 = .credentials.yaml 原文） */
  data: string;
}

/** 快照载荷：upload() 入参 / download() 返回 */
export interface SyncSnapshot {
  id: string;
  createdAt: string; // ISO-8601 UTC
  manifest: ManifestSummary;
  /** JSON 分区数据 + 文件类分区（FilesSection）；加密快照为 EncryptedSections 密文载荷 */
  sections: Partial<Record<SectionId, SectionData>> | EncryptedSections;
  /** 加密凭据载荷（仅 includeSecrets=true 的加密快照携带；缺省 = 不含任何凭据值） */
  credentials?: EncryptedCredentials;
}

/**
 * 远端快照传输通道契约。
 * 实现约定：同 id 重复 upload 视为覆盖（幂等友好）；download 对不存在的 id 必须抛错。
 */
export interface SyncTransport {
  readonly type: string;
  /** 列出远端已有快照（按 createdAt 升序） */
  list(): Promise<SyncSnapshotMeta[]>;
  /** 上传快照，返回其元信息（含各分区 hash） */
  upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta>;
  /** 下载快照完整载荷 */
  download(id: string): Promise<SyncSnapshot>;
  /** 删除远端快照（不存在视为成功） */
  delete(id: string): Promise<void>;
}

/* ---------------- 统一错误面 / 重试 / 超时（两条通道共用，t24） ---------------- */

/** 传输层错误分类：上层（同步引擎 / 调度器 / 宿主）可按 kind / retryable 分流，不必解析 message。
 *  - network：连接层故障（DNS / 连接重置 / 网络不可达）—— 瞬时，可重试；
 *  - timeout：命令 / 请求超时 —— 瞬时，可重试；
 *  - server：5xx 与 429（限流）—— 瞬时，可重试；
 *  - auth：认证 / 授权失败 —— 重试无意义；
 *  - notfound：远端实体不存在 —— 重试无意义；
 *  - conflict：并发 / 非快进 / 锁冲突 —— 需人工决策；
 *  - client：其它 4xx（请求本身有问题）—— 重试无意义；
 *  - protocol：响应或载荷不符合契约（解析失败、目录缺 manifest、重定向超限）；
 *  - unknown：无法归类（宁可当不可重试）。 */
export type SyncTransportErrorKind =
  | 'network'
  | 'timeout'
  | 'server'
  | 'auth'
  | 'notfound'
  | 'conflict'
  | 'client'
  | 'protocol'
  | 'unknown';

/** 默认可重试分类 = 瞬时网络故障；其余一律不重试（语义不明不冒险）。 */
const RETRYABLE_KINDS: readonly SyncTransportErrorKind[] = ['network', 'timeout', 'server'];

export interface SyncTransportErrorOptions {
  kind?: SyncTransportErrorKind;
  /** 显式覆盖由 kind 推导出的默认可重试性（一般不需要） */
  retryable?: boolean;
  /** HTTP 状态码（webdav 通道；git 通道无） */
  status?: number;
  cause?: unknown;
}

/**
 * 同步通道**统一错误基类**。GitTransportError / WebDavTransportError 都继承它，
 * 于是上层可以 `err instanceof SyncTransportError` 拿到 kind / retryable / status，
 * 而不是只能 `err instanceof Error ? err.message : String(err)` 读字符串。
 */
export class SyncTransportError extends Error {
  readonly kind: SyncTransportErrorKind;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(message: string, opts: SyncTransportErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'SyncTransportError';
    this.kind = opts.kind ?? 'unknown';
    this.retryable = opts.retryable ?? RETRYABLE_KINDS.includes(this.kind);
    this.status = opts.status;
  }
}

/** 是否为同步传输层错误（跨通道统一判定） */
export function isSyncTransportError(err: unknown): err is SyncTransportError {
  return err instanceof SyncTransportError;
}

/** 是否值得重试：只有带可重试分类的传输层错误才重试；未知错误一律不重试。 */
export function isRetryableTransportError(err: unknown): boolean {
  return err instanceof SyncTransportError && err.retryable;
}

/** 有限次指数退避重试参数（两条通道共用；宿主可经 transport options.retry 覆盖） */
export interface SyncRetryOptions {
  /** 总尝试次数（含首次）；<= 1 视为不重试。缺省 3。 */
  attempts?: number;
  /** 首次退避（指数：base、2*base、4*base…）毫秒；缺省 250 */
  baseDelayMs?: number;
  /** 单次退避上限毫秒；缺省 2000 */
  maxDelayMs?: number;
  /** 可注入 sleep（测试用，避免真实等待） */
  sleep?: (ms: number) => Promise<void>;
  /** 每次重试前的观测回调（抛错不影响主流程） */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/** 重试缺省值 */
export const DEFAULT_SYNC_RETRY: { attempts: number; baseDelayMs: number; maxDelayMs: number } = {
  attempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2000,
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 有限次指数退避重试。**调用约定：只包在幂等操作上**（读：list / download / GET）。
 *  - 只对 isRetryableTransportError 判定为可重试的错误重试；其它错误（含任何非传输层错误）立即上抛；
 *  - 重试耗尽 → 上抛**最后一次**的错误对象，kind / retryable 分类原样保留，供上层分流；
 *  - 写操作（upload / delete）**禁止**使用：webdav 的「PUT 快照 + PUT index」之间失败会留孤儿文件，
 *    git 的 push 有远端副作用。
 */
export async function withSyncRetry<T>(fn: () => Promise<T>, opts: SyncRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? DEFAULT_SYNC_RETRY.attempts));
  const baseDelayMs = Math.max(0, opts.baseDelayMs ?? DEFAULT_SYNC_RETRY.baseDelayMs);
  const maxDelayMs = Math.max(baseDelayMs, opts.maxDelayMs ?? DEFAULT_SYNC_RETRY.maxDelayMs);
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isRetryableTransportError(err)) throw err;
      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      try {
        opts.onRetry?.({ attempt, delayMs, error: err });
      } catch {
        /* 观测回调不得影响主流程 */
      }
      await sleep(delayMs);
    }
  }
}

/**
 * 两条同步通道**共用的默认超时**（不再各自硬编码 60s / 120s）。
 * 取原两条通道中的较大者（webdav 120s）：统一只能放宽不能收紧，否则原本 120s 够大的快照上传会被判超时。
 * 需要不同值时由宿主经 transport 的 options.timeoutMs 注入。
 */
export const DEFAULT_SYNC_TIMEOUT_MS = 120_000;

/** HTTP 状态码 → 错误分类：429 / 5xx 可重试，401/403/404/409/423 与其它 4xx 不重试。 */
export function classifyHttpStatus(status: number): { kind: SyncTransportErrorKind; retryable: boolean; status: number } {
  if (status === 429) return { kind: 'server', retryable: true, status };
  if (status >= 500) return { kind: 'server', retryable: true, status };
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false, status };
  if (status === 404) return { kind: 'notfound', retryable: false, status };
  if (status === 409 || status === 423) return { kind: 'conflict', retryable: false, status };
  return { kind: 'client', retryable: false, status };
}

/**
 * 网络层错误**文本** → 错误分类（git 的 stderr 与 webdav 的 request 异常共用同一口径）。
 * 判定顺序有讲究：git 会把真实原因包进 `unable to access ... :` 这类宽泛措辞，因此先判具体原因
 * （超时 / 连接层 / 5xx / 鉴权 / 404 / 冲突），最后才把宽泛包装词当作网络故障。
 */
export function classifyNetworkErrorText(text: string): { kind: SyncTransportErrorKind; retryable: boolean } {
  const t = text.toLowerCase();
  const has = (...needles: string[]): boolean => needles.some((n) => t.includes(n));
  // 状态码边界判定（不用转义序列，避免 \b 与数字粘连；等价于「前后非数字」）
  const status = (code: number): boolean => new RegExp('(^|[^0-9])' + String(code) + '([^0-9]|$)').test(t);
  if (has('etimedout', 'timed out', 'timeout', 'time out', 'socket hang up', 'operation was aborted')) {
    return { kind: 'timeout', retryable: true };
  }
  if (has('econnreset', 'econnrefused', 'eai_again', 'enotfound', 'enotreach', 'network is unreachable',
    'connection reset', 'connection refused', 'connection closed', 'broken pipe', 'epipe',
    'resolve host', 'name or service not known', 'failed to connect', 'could not connect',
    'remote end hung up', 'early eof')) {
    return { kind: 'network', retryable: true };
  }
  if (status(429) || has('too many requests') || status(500) || status(502) || status(503) || status(504)
    || has('internal server error', 'bad gateway', 'service unavailable', 'gateway timeout')) {
    return { kind: 'server', retryable: true };
  }
  if (status(401) || status(403) || has('authentication failed', 'permission denied', 'access denied',
    'unauthorized', 'invalid credentials', 'could not read username', 'invalid username or password')) {
    return { kind: 'auth', retryable: false };
  }
  if (status(404) || has('not found', 'does not exist', 'no such file')) {
    return { kind: 'notfound', retryable: false };
  }
  if (has('non-fast-forward', 'would be overwritten', 'already exists', 'rejected', 'conflict', 'locked')) {
    return { kind: 'conflict', retryable: false };
  }
  if (has('unable to access', 'could not read from remote')) {
    return { kind: 'network', retryable: true };
  }
  return { kind: 'unknown', retryable: false };
}

/** 由快照计算元信息：sections hash 记录 + manifest 摘要透传。
 *  加密快照（sections 为密文载荷）→ sections hash 记录为空（密文无法与本地明文比较）。 */
export function computeSnapshotMeta(snapshot: SyncSnapshot): SyncSnapshotMeta {
  const sections: SyncSnapshotMeta['sections'] = {};
  if (!isEncryptedSections(snapshot.sections)) {
    for (const [id, data] of Object.entries(snapshot.sections)) {
      sections[id as SectionId] = hashSection(data as SectionData);
    }
  }
  return { id: snapshot.id, createdAt: snapshot.createdAt, sections, manifest: snapshot.manifest };
}

/** 判定远端索引条目与本地快照「内容相同」（快照级跳过判定，供 webdav 通道增量上传用）：
 *  仅比较各分区内容 hash（sections 全等），不比较 createdAt / manifest 摘要
 *  （同 id 重复上传但内容未变 → 视为幂等覆盖，无需重新 PUT 载荷）。
 *  - 本地 sections 为空对象（加密快照：密文无法与远端明文 hash 比较）→ 返回 false，
 *    「无法比较」必须照常上传，绝不跳过；
 *  - 键集合与每个键的 hash 值全部相等 → true；否则 false。
 */
export function sectionsEqual(remote: SyncSnapshotMeta, local: SyncSnapshotMeta): boolean {
  const r = remote.sections;
  const l = local.sections;
  if (Object.keys(l).length === 0) return false; // 本地为空（加密快照）→ 无法比较
  if (Object.keys(r).length !== Object.keys(l).length) return false;
  for (const key of Object.keys(r)) {
    if (r[key as SectionId] !== l[key as SectionId]) return false;
  }
  return true;
}

/** 判定是否为加密凭据载荷（duck-typing：含 info 对象 + 非空 data 字符串）。 */
export function isEncryptedCredentials(v: unknown): v is EncryptedCredentials {
  if (v === null || typeof v !== 'object') return false;
  const c = v as { info?: unknown; data?: unknown };
  return typeof c.data === 'string' && c.data !== '' && c.info !== null && typeof c.info === 'object';
}

/** 判定 sections 是否为加密密文载荷（duck-typing：含 encrypted.info + encrypted.data 字符串）。 */
export function isEncryptedSections(sections: unknown): sections is EncryptedSections {
  if (sections === null || typeof sections !== 'object') return false;
  const enc = (sections as { encrypted?: unknown }).encrypted;
  if (enc === null || typeof enc !== 'object') return false;
  const e = enc as { info?: unknown; data?: unknown };
  return typeof e.data === 'string' && e.data !== '' && e.info !== null && typeof e.info === 'object';
}

/** 从导出 Manifest 提取摘要 */
export function manifestSummaryFrom(manifest: Manifest): ManifestSummary {
  return {
    schemaVersion: manifest.schemaVersion,
    dshVersion: manifest.source.dshVersion,
    platform: manifest.source.platform,
    sectionIds: Object.entries(manifest.sections)
      .filter(([, included]) => included)
      .map(([id]) => id) as SectionId[],
    containsSecrets: manifest.security.containsSecrets,
    ...(manifest.sourceHome !== undefined && manifest.sourceHome !== '' ? { sourceHome: manifest.sourceHome } : {}),
  };
}
