/**
 * 会话体检的**纯分类器**（T3；零 IO、零字节操作）—— 设计稿 §10.2 的损坏分类 + 可见性维度。
 *
 * 分层纪律（AGENTS.md）：core 不得 import 会话字节工具（`utils/session-log*` / `utils/zstd-frame`）。
 * 所以本模块只消费**已经读出来的事实**（首帧 header 字段 / 结构扫描结论 / 可选深度校验结论），
 * 真正的读字节在宿主侧 `utils/session-health-scan.ts`。
 *
 * 严重级排序（设计稿 §10.4，最高在前）：
 *   blocksStartup > unloadable > nextRequestFails > invisible > ok
 * 为什么「会让 DSH 起不来」必须最高：workspace 插件启动期枚举到一份坏会话日志时，
 * Web 会**永远到不了工作区选择页**（handbook #4855）—— 那不是「少一条对话」，是整机不可用。
 *
 * 绝不猜：读不到 = 对应事实缺省 → 不产生该条结论（宁可不报，也绝不谎报「已验证」）。
 */
import { projectKeyOf } from './session-meta.ts';
import { sessionIdKey } from './session-select.ts';

/** 供宿主复用：cwd/路径 → projectKey（避免两处口径漂移）。 */
export { projectKeyOf };

/** 严重级（数组顺序 = 由重到轻；排序与展示都用这一份）。 */
export type SessionHealthSeverity = 'blocksStartup' | 'unloadable' | 'nextRequestFails' | 'invisible' | 'ok';

export const SESSION_HEALTH_SEVERITIES: readonly SessionHealthSeverity[] = [
  'blocksStartup', 'unloadable', 'nextRequestFails', 'invisible', 'ok',
];

const SEVERITY_RANK: Record<SessionHealthSeverity, number> = {
  blocksStartup: 0, unloadable: 1, nextRequestFails: 2, invisible: 3, ok: 4,
};

/** 问题码（机器可读；文案由宿主/界面映射，core 不产出用户文案）。 */
export type SessionHealthIssueCode =
  /** 同一会话 id 出现在多个 projectKey 目录（DSH 启动直接报 duplicate JSONL session id） */
  | 'duplicate-id'
  /** 日志位置与 header 的 cwd 推导出的 projectKey 不一致（DSH 启动报 corrupt session log） */
  | 'location-mismatch'
  /** 首帧 header 读不出（损坏 / 非 zstd / 空文件） */
  | 'header-unreadable'
  /** 末尾 zstd 帧被截断（DSH 会自愈，仅提示） */
  | 'torn-tail'
  /** 容器里有非法帧（保留位 / 保留块类型 / 魔数错误） */
  | 'corrupt-frame'
  /** 深度校验发现已提交事件不可解析 */
  | 'unparsable-event'
  /** 重放族：字节相同的重复行（零损失可丢弃） */
  | 'replay-duplicate-rows'
  /** 重放族：合成 closer 块撞上真实续写 */
  | 'synthetic-closer'
  /** 真实 seq 空洞 */
  | 'seq-gap'
  /** 消息载体缺 message id（缺失 / 非字符串 / 空串）——当前格式的 replay 边界直接拒载整份日志 */
  | 'missing-message-id'
  /** tool/call.callId 或 assistant/message 内容里 tool-call 块的 id 为空 / 非字符串 */
  | 'empty-tool-call-id'
  /** 已关闭的 step 里存在没有配对 tool/result 的 tool/call（按 message.source.callId 配对） */
  | 'dangling-tool-call'
  /** tool/result 的 toolCallId 缺失 / 非字符串 / 与 message.source.callId 不一致 */
  | 'tool-result-id-mismatch'
  /** 同一步（同 data.turn + data.step）内同一个 callId 被通告多次 */
  | 'duplicate-tool-call-id'
  /** assistant/message|attempt 的 settlement 字段非法 */
  | 'invalid-settlement'
  /** 步进继续了已关闭的 turn */
  | 'closed-turn-continued'
  /** 会话格式版本高于本机 DSH 支持（DSH 静默跳过 → 看不见） */
  | 'format-newer'
  /** 没有工作区记录指向它的 cwd（DSH 工作区列表里看不见） */
  | 'unregistered-workspace'
  /** 子代理会话的父对话既不在本机也不在包内（工作区里只会在父对话之下显示） */
  | 'subagent-without-parent';

export interface SessionHealthIssue {
  code: SessionHealthIssueCode;
  severity: SessionHealthSeverity;
  /** 人类可读的补充（**不猜**：只写事实，如「seq 12→18」） */
  detail?: string;
}

/** 宿主的结构扫描结论（读不出任何东西时也如实说明原因）。 */
export interface SessionStructuralProbe {
  /** 能完整解析容器与首帧 header */
  ok: boolean;
  /** 帧数（能扫描时给出） */
  frames?: number;
  /** 末尾存在不完整帧 */
  tornTail?: boolean;
  /** 非法帧（抛错的位置信息） */
  corruptReason?: string;
  /** 首帧 header 读不出 */
  headerUnreadable?: boolean;
}

/** 可选深度校验结论（DSH codec 能力探测成功后才有；拿不到 = undefined）。 */
export interface SessionDeepProbe {
  /** 是否用 DSH codec 真的校验过（false = 未验证，不得据此宣称可读） */
  verified: boolean;
  /**
   * 问题清单。`severity` 可选：**行档采集器实测出的严重级优先**（同一个 code 在旧格式迁移路径下
   * 的后果可能与当前格式不同），缺省时回落到 {@link DEEP_SEVERITY} 的静态默认。
   */
  issues?: { code: SessionHealthIssueCode; severity?: SessionHealthSeverity; detail?: string }[];
  /** 校验器自身失败的原因（未验证的原因） */
  unverifiedReason?: string;
}

/** 一条会话的输入事实（宿主读盘得出；core 只做判定）。 */
export interface SessionHealthInput {
  /** 会话单元 id（`<projectKey>/<会话目录>`；与计划项/admin 同口径） */
  unitId: string;
  /** 会话目录名 */
  sessionId: string;
  /** 当前所在的 projectKey 段（= 父目录名） */
  projectKey: string;
  /** 首帧 header（读不出时字段全部缺省） */
  headerVersion?: number;
  headerCwd?: string;
  origin?: string;
  parentSessionId?: string;
  /** 会话日志文件数（0 = 目录里一份日志都没有） */
  logFiles: number;
  sizeBytes?: number;
  mtimeMs?: number;
  structural: SessionStructuralProbe;
  deep?: SessionDeepProbe;
}

/** 分类上下文（工作区归属 / 本机已知会话 / 重复 id / 目标格式版本）。 */
export interface SessionHealthContext {
  /** 本机 DSH 支持的会话格式版本（读不到 = undefined → 不做「超前」判定） */
  targetFormatVersion?: number;
  /**
   * 本机工作区记录的 cwd 目录键集合（`projectKeyOf(path)`）。
   *
   * 判据**刻意**是「`size > 0` 才判未登记」：调用方读不到注册表（catch 分支）与注册表确实为空
   * 在 UI 侧不可区分，把空集当「确知本机没有工作区」会让**每一条会话**都被报未登记 —— 那是另一种误报。
   */
  workspaceKeys: ReadonlySet<string>;
  /**
   * 本机全部已知会话 id 的归一化键（sessionIdKey；父对话存在性判定用）。
   *
   * **「未知」与「确知为空集」必须分开**（否则会谎报）：
   *  · `undefined` = **未知** —— 调用方根本拿不到本机会话全量清单 → **不判**父子存在性；
   *  · 空集 = **确知本机一条会话都没有** → 照判（保留真缺陷检测：父对话真的不在了）。
   * 旧实现由采集器用 `?? new Set()` 把「未知」伪造成「确知为空集」，于是 CLI / 救急台这类
   * **不传上下文**的调用把本机**每一个**子代理会话都判成「缺父对话」（真机实测 1199 条里 800 条误报）。
   */
  knownSessionIds?: ReadonlySet<string>;
  /** 出现在多个 projectKey 目录的会话 id 的归一化键 */
  duplicateSessionIds?: ReadonlySet<string>;
}

/** 一行体检结果。 */
export interface SessionHealthRow {
  unitId: string;
  sessionId: string;
  /**
   * 界面标题（**宿主侧补**，不是分类判定的一部分）。
   *
   * 来源 = DSH 会话缓存 `storages/session_projcache.json` 的 `rows.title.val`，由宿主在扫描后用
   * `core/session-meta.ts` 的 `applySessionTitles` 统一补上（本模块零 IO，自己不读盘）。
   * 读不到 = 缺省 → 界面回落显示会话目录名（绝不编造标题）。
   */
  title?: string;
  projectKey: string;
  severity: SessionHealthSeverity;
  issues: SessionHealthIssue[];
  version?: number;
  cwd?: string;
  origin?: string;
  /**
   * 空白会话（从未提问过；宿主侧从会话投影补的**事实**）。
   *
   * 用途：这类会话在 DSH 自己那里也没有标题（显示本地化的「新会话」）—— 界面据此显示同样的
   * 占位名，而不是把 `session-<uuid>` 当标题。只下发事实，文案由界面按当前语言解析。
   */
  blank?: boolean;
  sizeBytes?: number;
  mtimeMs?: number;
}

export interface SessionHealthSummary {
  /** 扫描到的会话单元总数 */
  total: number;
  /** 按严重级计数（含 ok） */
  bySeverity: Record<SessionHealthSeverity, number>;
  /** 真正做过**结构**体检的条数 */
  structurallyChecked: number;
  /** 做过**深度**校验的条数（0 = 全部未验证，界面必须如实显示） */
  deepVerified: number;
  /** 未做深度校验的条数（限额内/能力不可用） */
  deepUnverified: number;
}

/**
 * 一条会话的全部问题（顺序 = 严重级由重到轻，同级按检查顺序）。
 *
 * 每个分支都只在**事实存在**时产出问题：读不到的字段不产生结论。
 */
export function sessionHealthIssues(input: SessionHealthInput, ctx: SessionHealthContext): SessionHealthIssue[] {
  const issues: SessionHealthIssue[] = [];
  // 同一 code 只留一条：重复出现时取**更重**的严重级（不因一条较轻的重复记录把结论说轻）。
  const push = (code: SessionHealthIssueCode, severity: SessionHealthSeverity, detail?: string): void => {
    const existing = issues.find((issue) => issue.code === code);
    if (existing !== undefined) {
      if (SEVERITY_RANK[severity] < SEVERITY_RANK[existing.severity]) {
        existing.severity = severity;
        if (detail !== undefined) existing.detail = detail;
      }
      return;
    }
    issues.push(detail === undefined ? { code, severity } : { code, severity, detail });
  };

  // ---- 1. 会让 DSH 起不来的两件事（最高优先级） ----
  if (ctx.duplicateSessionIds?.has(sessionIdKey(input.sessionId)) === true) {
    push('duplicate-id', 'blocksStartup', input.sessionId);
  }
  const cwd = input.headerCwd;
  if (cwd !== undefined && cwd !== '') {
    const expected = projectKeyOf(cwd);
    if (expected !== input.projectKey) {
      push('location-mismatch', 'blocksStartup', input.projectKey + ' ≠ ' + expected);
    }
  }

  // ---- 2. 结构层面：容器/首帧读不出来 ----
  if (input.structural.headerUnreadable === true) {
    push('header-unreadable', 'unloadable', String(input.logFiles === 0 ? 'no-log' : 'header'));
  }
  if (input.structural.corruptReason !== undefined) {
    push('corrupt-frame', 'unloadable', input.structural.corruptReason);
  } else if (input.structural.ok === false && input.structural.headerUnreadable !== true) {
    // 结构扫描明确失败但读不出 header（如 0 字节文件）：不猜具体原因，只如实标记
    push('header-unreadable', 'unloadable', 'unreadable');
  }
  if (input.structural.tornTail === true) {
    // 设计稿 §10.2：撕裂的末尾帧 DSH **自愈**（无需修复）—— 只提示，不升级严重级
    push('torn-tail', 'ok', 'self-healing');
  }

  // ---- 3. 深度校验（可选）：只有真的用 DSH codec 校验过才下结论 ----
  const deep = input.deep;
  if (deep !== undefined && deep.verified) {
    for (const issue of deep.issues ?? []) {
      // 行档采集器可给出**实测**的严重级（如「step 已闭合的悬空 tool/call」）；缺省才回落静态表。
      push(issue.code, issue.severity ?? DEEP_SEVERITY[issue.code] ?? 'unloadable', issue.detail);
    }
  }

  // ---- 4. 可见性（DSH 不报错，但用户看不见/请求会失败） ----
  if (ctx.targetFormatVersion !== undefined && input.headerVersion !== undefined
    && input.headerVersion > ctx.targetFormatVersion) {
    push('format-newer', 'invisible', 'v' + String(input.headerVersion) + ' > v' + String(ctx.targetFormatVersion));
  }
  if (cwd !== undefined && cwd !== '' && ctx.workspaceKeys.size > 0 && !ctx.workspaceKeys.has(projectKeyOf(cwd))) {
    push('unregistered-workspace', 'invisible', projectKeyOf(cwd));
  }
  // 父子存在性只在**已知集合确实可用**时判：undefined（未知）→ 不报；空集（确知本机没有该父）→ 报。
  // 绝不把「调用方没给集合」读成「本机没有任何会话」。
  if (input.origin === 'subagent' && input.parentSessionId !== undefined && input.parentSessionId !== ''
    && ctx.knownSessionIds !== undefined
    && !ctx.knownSessionIds.has(sessionIdKey(input.parentSessionId))) {
    push('subagent-without-parent', 'invisible', input.parentSessionId);
  }
  // 首帧能读但**没有 cwd**（DSH 的 _no-cwd 会话）：归属无法判定 → 只报告，不猜归属，
  // 也不升级严重级（DSH 能加载它，只是工作区列表里挂不上）。
  if ((cwd === undefined || cwd === '') && input.structural.ok === true && input.structural.headerUnreadable !== true) {
    push('unregistered-workspace', 'invisible', 'no-cwd');
  }

  return issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * 深度校验问题码 → **回落**严重级（与 §10.2 的后果分类一致）。
 *
 * 这是「问题没有自带 severity 时」的静态默认，不是唯一事实源：行档采集器对四类生命周期问题
 * （缺 message id / 空 tool-call id / 悬空 tool-call / 重复 tool-call id）会用**真 codec 实测**
 * 出的严重级覆盖它（见 `utils/session-health-scan.ts` 的校准注释）。
 */
const DEEP_SEVERITY: Partial<Record<SessionHealthIssueCode, SessionHealthSeverity>> = {
  'unparsable-event': 'unloadable',
  'replay-duplicate-rows': 'nextRequestFails',
  'synthetic-closer': 'nextRequestFails',
  'seq-gap': 'unloadable',
  'missing-message-id': 'unloadable',
  'empty-tool-call-id': 'unloadable',
  /** 采集器只在**证明 step 已闭合**时才发这个码，而真 codec 对该形状直接拒读（step/end leaves unresolved tool call） */
  'dangling-tool-call': 'unloadable',
  'tool-result-id-mismatch': 'unloadable',
  /** v4/pre-v4 实测被 current/Session.fromRestore 闸门拒读（`assistant/message repeats advertised tool call`） */
  'duplicate-tool-call-id': 'unloadable',
  'invalid-settlement': 'nextRequestFails',
  'closed-turn-continued': 'nextRequestFails',
};

/** 行的严重级 = 其问题里最重的一档（无问题 = ok）。 */
export function sessionHealthSeverityOf(issues: readonly SessionHealthIssue[]): SessionHealthSeverity {
  let worst: SessionHealthSeverity = 'ok';
  for (const issue of issues) {
    if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[worst]) worst = issue.severity;
  }
  return worst;
}

/** 单条会话 → 体检行。 */
export function classifySessionHealth(input: SessionHealthInput, ctx: SessionHealthContext): SessionHealthRow {
  const issues = sessionHealthIssues(input, ctx);
  return {
    unitId: input.unitId,
    sessionId: input.sessionId,
    projectKey: input.projectKey,
    severity: sessionHealthSeverityOf(issues),
    issues,
    ...(input.headerVersion !== undefined ? { version: input.headerVersion } : {}),
    ...(input.headerCwd !== undefined ? { cwd: input.headerCwd } : {}),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
    ...(input.mtimeMs !== undefined ? { mtimeMs: input.mtimeMs } : {}),
  };
}

/**
 * 汇总（纯函数）。
 *
 * 注意 `deepUnverified` 的语义：**不做深度校验也要计入**（界面必须能说「另外 N 条只做了
 * 结构体检，未做深度校验」）—— 把「没检查」说成「没问题」是本轮明确要消灭的那类谎报。
 */
export function analyzeSessionHealth(
  inputs: readonly SessionHealthInput[],
  ctx: SessionHealthContext,
): { rows: SessionHealthRow[]; summary: SessionHealthSummary } {
  const rows = inputs.map((input) => classifySessionHealth(input, ctx));
  const bySeverity: Record<SessionHealthSeverity, number> = {
    blocksStartup: 0, unloadable: 0, nextRequestFails: 0, invisible: 0, ok: 0,
  };
  let structurallyChecked = 0;
  let deepVerified = 0;
  for (const input of inputs) {
    if (input.structural.ok || input.structural.headerUnreadable === true || input.structural.corruptReason !== undefined) {
      structurallyChecked += 1;
    }
    if (input.deep?.verified === true) deepVerified += 1;
  }
  for (const row of rows) bySeverity[row.severity] += 1;
  return {
    rows: rows.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.unitId.localeCompare(b.unitId)),
    summary: {
      total: rows.length,
      bySeverity,
      structurallyChecked,
      deepVerified,
      deepUnverified: rows.length - deepVerified,
    },
  };
}

/** 会话目录名 → 裸会话键（`session-<uuid>` 与裸 `<uuid>` 归一）。 */
export function bareSessionKey(sessionId: string): string {
  return sessionIdKey(sessionId);
}

/** 一条会话是否「需要人工介入」（非 ok）。 */
export function sessionHealthNeedsAttention(row: SessionHealthRow): boolean {
  return row.severity !== 'ok';
}
