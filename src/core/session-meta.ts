/**
 * DSH 会话元数据读取（导出选择器的「工作区分组 + 会话标题」数据源）。
 *
 * 为什么不去解压会话日志：`.jsonl.zstd` 是**多帧**容器，而 Node 的 zstd 解压器只解第一帧
 * （实测：598 KB 的文件只解出 294 字节的 header 行，流式也一样），要拿标题就得自己做帧边界
 * 解析并把整棵树（用户实测 379 MB）解一遍。DSH 自己已经把这些信息缓存在
 * `$DSH_HOME/storages/` 下，直接读缓存既快又不需要碰二进制：
 *
 *  - `storages/session_projcache.json` → `tables.sessions[<id>].rows.title.val`（界面上的会话标题）
 *    、`identity.cwd`、`rows.sessionListMetadata.val.lastPromptAt`；
 *  - `storages/workspace.json` → `tables.workspaces[<id>] = { path, title, sessionIds }`（工作区注册表）。
 *
 * 可靠性姿态（DSH 内部存储，格式可能变）：**只读、尽力而为、绝不抛错** —— 任何读取/解析失败
 * 都退化成空索引，导出与预览照常工作（选择器退回「显示目录名」的旧行为）。不认识的形状一律忽略。
 */
import type { ExportUnit, HostContext, SessionParentRelation } from './types.ts';

const SESSION_PROJCACHE = 'storages/session_projcache.json';
const WORKSPACE_STORE = 'storages/workspace.json';

// projectKeyOf 已下移到**零依赖**模块 `session-select.ts`（客户端勾选联动要按 cwd 目录键认领工作区，
// 而本模块会用 Buffer 读 DSH 存储缓存，不能进浏览器 bundle）。这里 re-export，既有导入路径逐字不变。
import { projectKeyOf, sessionIdKey } from './session-select.ts';
export { projectKeyOf };

/** 单个会话的可用元数据（全部可选：缓存里缺哪项就少哪项，绝不猜）。 */
export interface SessionMetaEntry {
  /** 界面上的会话标题（`rows.title.val`） */
  title?: string;
  /** 会话的工作目录（`identity.cwd`） */
  cwd?: string;
  /** 最后一条用户消息时间（毫秒）；用于「最近的在前面」排序 */
  lastActivityAt?: number;
  /** 空会话标记（`sessionListMetadata.blank`） */
  blank?: boolean;
}

/** 会话元数据索引（键 = 会话目录名，即 SessionId 去掉 `session-` 前缀）。 */
export interface SessionMetaIndex {
  bySessionId: Map<string, SessionMetaEntry>;
  /** 项目键 → 工作区标题 */
  workspaceTitleByProjectKey: Map<string, string>;
  /** 项目键 → 工作区绝对路径 */
  workspacePathByProjectKey: Map<string, string>;
}

/** 空索引（读不到任何缓存时的安全返回值）。 */
export function emptySessionMeta(): SessionMetaIndex {
  return { bySessionId: new Map(), workspaceTitleByProjectKey: new Map(), workspacePathByProjectKey: new Map() };
}

/** 读 JSON（失败 → null；不抛错）。 */
async function readJsonSafe(ctx: HostContext, rel: string): Promise<unknown> {
  try {
    const text = Buffer.from(await ctx.fs.readFile(rel)).toString('utf8');
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * 读取会话标题与工作区注册表。任何一步失败都只让**对应部分**退化，绝不影响导出。
 */
export async function readSessionMeta(ctx: HostContext): Promise<SessionMetaIndex> {
  const index = emptySessionMeta();

  const cache = asRecord(await readJsonSafe(ctx, SESSION_PROJCACHE));
  const sessions = asRecord(asRecord(cache?.['tables'])?.['sessions']);
  for (const [key, raw] of Object.entries(sessions ?? {})) {
    const entry = asRecord(raw);
    const identity = asRecord(entry?.['identity']);
    const rows = asRecord(entry?.['rows']);
    const title = asRecord(rows?.['title'])?.['val'];
    const listMeta = asRecord(asRecord(rows?.['sessionListMetadata'])?.['val']);
    const lastPromptAt = listMeta?.['lastPromptAt'];
    const createdAt = identity?.['createdAt'];
    const cwd = identity?.['cwd'];
    const meta: SessionMetaEntry = {};
    if (typeof title === 'string' && title.trim() !== '') meta.title = title.trim();
    if (typeof cwd === 'string' && cwd !== '') meta.cwd = cwd;
    const at = typeof lastPromptAt === 'number' ? lastPromptAt : (typeof createdAt === 'number' ? createdAt : undefined);
    if (at !== undefined) meta.lastActivityAt = at;
    if (listMeta?.['blank'] === true) meta.blank = true;
    // 键有 `session-<uuid>` 与裸 `<uuid>` 两种形态（实测同一台机器上都存在），统一去前缀存
    index.bySessionId.set(key.replace(/^session-/, ''), meta);
  }

  const store = asRecord(await readJsonSafe(ctx, WORKSPACE_STORE));
  const workspaces = asRecord(asRecord(store?.['tables'])?.['workspaces']);
  for (const raw of Object.values(workspaces ?? {})) {
    const rec = asRecord(raw);
    const path = rec?.['path'];
    const title = rec?.['title'];
    if (typeof path !== 'string' || path === '') continue;
    const key = projectKeyOf(path);
    if (typeof title === 'string' && title.trim() !== '') index.workspaceTitleByProjectKey.set(key, title.trim());
    index.workspacePathByProjectKey.set(key, path);
  }

  return index;
}

/** 单元 id（`sessions:<项目键>/<会话目录名>`）→ 会话目录名；形状不符 → null。 */
function sessionIdOfUnit(sectionId: string, unitId: string): { projectKey: string; sessionId: string } | null {
  const prefix = sectionId + ':';
  if (!unitId.startsWith(prefix)) return null;
  const rest = unitId.slice(prefix.length);
  const slash = rest.lastIndexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { projectKey: rest.slice(0, slash), sessionId: rest.slice(slash + 1) };
}

/**
 * 给 **导入计划项**（sessions 分区）补上「界面标题 + 工作区分组」。
 *
 * 与 `applySessionMeta` 的区别：导出侧富化 `ExportUnit`，导入侧富化 `PlanItem`；两者共用同一份
 * 索引与同一套 id 形状（`sessions:<项目键>/<会话目录名>`），所以标题口径完全一致（用户实测：
 * 导入页此前只显示会话**目录名**，因为计划项没有展示名可用）。
 *
 * 只写 `label`/`group`（纯展示字段），**不碰** id/kind/target —— 勾选与执行契约不受影响；
 * 缓存里没有标题的会话保持 `label` 缺省（UI 回退显示目录名，不编造）。
 */
export function applySessionMetaToPlanItems<
  T extends { id: string; unitId?: string; adapter: string; label?: string; group?: string },
>(items: readonly T[], index: SessionMetaIndex, sectionId = 'sessions'): T[] {
  return items.map((item) => {
    if (item.adapter !== sectionId) return item;
    const parsed = sessionIdOfUnit(sectionId, item.unitId ?? item.id);
    if (parsed === null) return item;
    // 索引键 = **去掉 `session-` 前缀**的裸键，而单元 id 末段是**目录名**（两种形态并存）→ 必须先归一化，
    // 否则 `session-<uuid>` 形态的会话永远拿不到标题（真机实测：同一项目 731 个会话目录里 164 个是这种形态）。
    const meta = index.bySessionId.get(sessionIdKey(parsed.sessionId));
    const group = index.workspaceTitleByProjectKey.get(parsed.projectKey) ?? parsed.projectKey;
    return {
      ...item,
      ...(meta?.title !== undefined ? { label: meta.title } : {}),
      group,
    };
  });
}

/**
 * 「子代理会话 → 父对话」映射（**裸键**）：DSH 会话存储的父子关系 → `Map<子会话裸键, 父对话裸键>`。
 *
 * 只收 `subagent === true` 的会话 —— origin 非 subagent 的会话即使带 parentSession 也是**顶层行**
 * （DSH 工作区列表口径，与 `SessionsAdapter.coupleSessionParents` 完全一致）；非法形状一律忽略。
 */
export function subagentParentMap(
  relations: ReadonlyMap<string, SessionParentRelation> | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  if (relations === undefined) return out;
  for (const [childId, relation] of relations) {
    if (!relation.subagent) continue;
    const parent = sessionIdKey(relation.parent);
    const child = sessionIdKey(childId);
    if (parent === '' || child === '') continue;
    out.set(child, parent);
  }
  return out;
}

/**
 * 给 sessions 单元标出「父对话」（纯联动/展示字段，不动 id/kind/target）：只有子代理会话会有值。
 *
 * 用途：导出选择器的「父 ↔ 子会话」勾选联动（勾父自动勾上它的子代理会话、勾子自动带上父）。
 * 非 sessions 分区 / 形状不符 / 映射里查不到 → 原样返回（**不猜**：宁可不联动，也不凭 id 编关系）。
 */
export function applySessionParentLinks<T extends { id: string; parentSessionId?: string }>(
  units: readonly T[],
  parentOf: ReadonlyMap<string, string> | undefined,
  sectionId = 'sessions',
): T[] {
  if (parentOf === undefined || parentOf.size === 0) return [...units];
  return units.map((unit) => {
    const parsed = sessionIdOfUnit(sectionId, unit.id);
    if (parsed === null) return unit;
    const parent = parentOf.get(sessionIdKey(parsed.sessionId));
    return parent === undefined ? unit : { ...unit, parentSessionId: parent };
  });
}

/**
 * 给 sessions 分区的单元补上「界面标题 + 工作区分组」，并按「工作区 → 最近在前」排序。
 *
 * - `label`：会话标题（缓存里没有 → 退回会话目录名，绝不编造）；
 * - `detail`：工作区绝对路径（未知 → 不回填）；
 * - `group`：工作区标题（未知 → 用项目键兜底，保证每个会话都有归属，不出现「未归类」坟场）；
 * - 其它分区的单元原样返回（ids 不变 —— 勾选/导出契约只认 id）。
 *
 * @param activityAt 会话**裸键**（`sessionIdKey`）→ 最近活跃时间（毫秒），由宿主在预览期用会话日志
 *   文件 mtime 现算（`ConfigAdapter.unitActivityTimes`）。为什么必须有这条兜底：元数据缓存
 *   （`storages/session_projcache.json`）只覆盖**一部分**会话（真机实测：同一项目 731 个会话目录里
 *   347 个不在缓存内），只用缓存时间会让这些会话全部落到组尾、退化成按 uuid 字典序排 ——
 *   用户看到的就是「历史对话没有按最新到最旧排序」。缓存里有精确的 lastPromptAt 时仍以它为第一口径。
 */
export function applySessionMeta(
  units: readonly ExportUnit[],
  index: SessionMetaIndex,
  sectionId = 'sessions',
  activityAt?: ReadonlyMap<string, number>,
): ExportUnit[] {
  const enriched = units.map((unit) => {
    const parsed = sessionIdOfUnit(sectionId, unit.id);
    if (parsed === null) return unit;
    // 同 applySessionMetaToPlanItems：索引键是裸键，单元 id 末段是目录名 → 查表前必须归一化
    const meta = index.bySessionId.get(sessionIdKey(parsed.sessionId));
    const workspaceTitle = index.workspaceTitleByProjectKey.get(parsed.projectKey);
    const workspacePath = index.workspacePathByProjectKey.get(parsed.projectKey);
    const detail = workspacePath ?? meta?.cwd ?? unit.detail;
    return {
      ...unit,
      label: meta?.title ?? unit.label,
      ...(detail !== undefined ? { detail } : {}),
      group: workspaceTitle ?? parsed.projectKey,
    };
  });
  // 排序：先按工作区（保持首次出现顺序），组内最近活跃的在前；无时间的排在组内末尾。
  const groupOrder = new Map<string, number>();
  for (const unit of enriched) {
    const g = unit.group;
    if (g !== undefined && !groupOrder.has(g)) groupOrder.set(g, groupOrder.size);
  }
  const atOf = (unit: ExportUnit): number => {
    const parsed = sessionIdOfUnit(sectionId, unit.id);
    if (parsed === null) return -1;
    const bare = sessionIdKey(parsed.sessionId);
    // 第一口径 = 元数据缓存的「最后一次提问时间」；缓存里没有这条会话 → 退回宿主现算的日志 mtime
    return index.bySessionId.get(bare)?.lastActivityAt ?? activityAt?.get(bare) ?? -1;
  };
  return enriched.sort((a, b) => {
    const ga = a.group !== undefined ? (groupOrder.get(a.group) ?? 0) : -1;
    const gb = b.group !== undefined ? (groupOrder.get(b.group) ?? 0) : -1;
    if (ga !== gb) return ga - gb;
    const diff = atOf(b) - atOf(a);
    return diff !== 0 ? diff : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}
