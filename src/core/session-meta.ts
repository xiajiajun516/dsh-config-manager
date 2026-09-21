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
import type { ExportUnit, HostContext } from './types.ts';

const SESSION_PROJCACHE = 'storages/session_projcache.json';
const WORKSPACE_STORE = 'storages/workspace.json';

/**
 * 项目目录键（与 DSH `dsh-session-persistence-jsonl` 的 `projectKey()` 同算法）：
 * 分隔符（`/` `\\` `:`）折叠成一个 `-`，非 `[A-Za-z0-9._-]` 的字符转 `~XXXX`，截断到 251，
 * 最后包成 `--…--`。用于把工作区路径映射到 `~/.dsh/sessions/<项目键>/` 目录。
 */
export function projectKeyOf(cwd: string): string {
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

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
    const meta = index.bySessionId.get(parsed.sessionId);
    const group = index.workspaceTitleByProjectKey.get(parsed.projectKey) ?? parsed.projectKey;
    return {
      ...item,
      ...(meta?.title !== undefined ? { label: meta.title } : {}),
      group,
    };
  });
}

/**
 * 给 sessions 分区的单元补上「界面标题 + 工作区分组」，并按「工作区 → 最近在前」排序。
 *
 * - `label`：会话标题（缓存里没有 → 退回会话目录名，绝不编造）；
 * - `detail`：工作区绝对路径（未知 → 不回填）；
 * - `group`：工作区标题（未知 → 用项目键兜底，保证每个会话都有归属，不出现「未归类」坟场）；
 * - 其它分区的单元原样返回（ids 不变 —— 勾选/导出契约只认 id）。
 */
export function applySessionMeta(
  units: readonly ExportUnit[],
  index: SessionMetaIndex,
  sectionId = 'sessions',
): ExportUnit[] {
  const enriched = units.map((unit) => {
    const parsed = sessionIdOfUnit(sectionId, unit.id);
    if (parsed === null) return unit;
    const meta = index.bySessionId.get(parsed.sessionId);
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
    const at = parsed === null ? undefined : index.bySessionId.get(parsed.sessionId)?.lastActivityAt;
    return at ?? -1;
  };
  return enriched.sort((a, b) => {
    const ga = a.group !== undefined ? (groupOrder.get(a.group) ?? 0) : -1;
    const gb = b.group !== undefined ? (groupOrder.get(b.group) ?? 0) : -1;
    if (ga !== gb) return ga - gb;
    const diff = atOf(b) - atOf(a);
    return diff !== 0 ? diff : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}
