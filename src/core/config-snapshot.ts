/**
 * 配置状态快照（Phase 1 P0-1 / P0-2 的持久化与回放层）。
 *
 * 与既有 `core/backup.ts` 的 `Snapshot` 的分工：
 *  - `Snapshot`（backup.ts）：**导入计划驱动**，只登记「本次导入将写入的目标」的原值，
 *    用于导入失败回滚。它不描述「整体配置在某时刻是什么样」。
 *  - `ConfigSnapshot`（本模块）：**状态驱动**，记录整份配置在某一时刻的分区数据 + 分区指纹，
 *    用于自动快照、撤销/重做、最后正常状态定位。恢复方式是**回放 adapter**
 *    （validate → analyzeImport → applyItem，与导入/Profile 切换同一条管线），
 *    因此天然覆盖 settings 命名空间、patch 行、文件类分区与插件安装。
 *
 * 存储布局：`<dir>/<id>/config-snapshot.json` = `{ meta, data }`。
 * `data` 为各分区的 ExportSection.data；其中的 Uint8Array（文件类分区的字节）
 * 经 `__u8` base64 包封做可逆 JSON 编码（JSON.stringify 会把字节变成 {0:..,1:..}）。
 *
 * 安全：快照 id 严格白名单校验（防穿越）；写入走 atomicWriteFile；分区数据只含
 * `includeSecrets: false` 的导出结果，密钥值从不进入本模块。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../utils/atomic-write.ts';
import { parseJsonSafe } from '../utils/json.ts';
import { SECTION_IDS, isSectionId } from '../schema/config.ts';
import { CURRENT_SCHEMA_VERSION } from '../schema/versions.ts';
import { msgOf, zhMsg } from './messages.ts';
import type { MsgFunc } from './messages.ts';
import { isValidSnapshotId } from './restore.ts';
import { planItemWritesTarget } from './backup.ts';
import { statesEqual, type ConfigState } from './config-state.ts';
import type { ConfigSnapshotKind, UndoCandidate } from './undo.ts';
import type { ConfigAdapter, ExportSection, HostContext, ImportContext } from './types.ts';
import type { Manifest, SectionId } from '../schema/types.ts';

/** 快照文件名（每个快照一个目录） */
export const CONFIG_SNAPSHOT_FILE = 'config-snapshot.json';

/** 可逆 JSON 编码：Uint8Array → { __u8: base64 } */
const U8_KEY = '__u8';

function encodeForJson(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [U8_KEY]: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encodeForJson);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = encodeForJson(v);
    return out;
  }
  return value;
}

function decodeFromJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeFromJson);
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length === 1 && keys[0] === U8_KEY && typeof rec[U8_KEY] === 'string') {
      return new Uint8Array(Buffer.from(rec[U8_KEY] as string, 'base64'));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = decodeFromJson(v);
    return out;
  }
  return value;
}

/** 快照元数据（落盘部分） */
export interface ConfigSnapshotMeta {
  id: string;
  createdAt: string;
  kind: ConfigSnapshotKind;
  /** 人类可读原因（如 'plugin-change' / 'before-restore:<id>' / 'manual'） */
  reason: string;
  /** 触发源（watcher / route / tool / schedule / undo / baseline） */
  trigger?: string;
  /** 参与采集的分区（升序） */
  sections: SectionId[];
  /** 采集到的配置状态（分区指纹；撤销/重做的内容比对基准） */
  state: ConfigState;
  note?: string;
  tags?: string[];
  pinned?: boolean;
  /** pre-restore：是否已被重做消费 */
  consumed?: boolean;
  /** 被撤销跨过（见 undo.ts steppedIds） */
  stepped?: boolean;
  /** pre-restore：本次撤销的目标快照 id */
  undoOf?: string;
  /** 落盘字节数（快照体积，供 UI 展示与容量告警） */
  totalBytes: number;
}

/** 完整快照（元数据 + 分区数据） */
export interface ConfigSnapshot extends ConfigSnapshotMeta {
  data: Partial<Record<SectionId, unknown>>;
}

/** 供 undo.ts 使用的最小候选视图 */
export function toUndoCandidate(meta: ConfigSnapshotMeta): UndoCandidate {
  return {
    id: meta.id,
    createdAt: meta.createdAt,
    kind: meta.kind,
    state: meta.state,
    consumed: meta.consumed,
  };
}

/* ------------------------------------------------------------ 读写 */

function snapshotDir(dir: string, id: string): string {
  if (!isValidSnapshotId(id)) throw new Error(`非法配置快照 id: ${JSON.stringify(id)}`);
  const target = path.join(dir, id);
  if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error(`配置快照路径越界: ${id}`);
  return target;
}

export interface SaveConfigSnapshotOptions {
  dir: string;
  kind: ConfigSnapshotKind;
  reason: string;
  trigger?: string;
  /** 本次采集的各分区导出结果（adapter.export 产出） */
  sections: Map<SectionId, ExportSection>;
  state: ConfigState;
  note?: string;
  tags?: string[];
  now?: () => Date;
  idFactory?: () => string;
  /** 落盘上限（字节；缺省 64 MiB，超出抛错而不是静默截断） */
  maxBytes?: number;
}

/** 生成快照 id：时间戳 + 随机短串（可读 + 唯一；与既有 uuid 风格区分开） */
export function makeConfigSnapshotId(now: () => Date = () => new Date()): string {
  const d = now();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${stamp}-${rand}`;
}

/**
 * 写入一个配置快照。返回落盘后的元数据。
 * id 冲突时自动追加后缀重试（同一秒内多次快照）。
 */
export async function saveConfigSnapshot(opts: SaveConfigSnapshotOptions): Promise<ConfigSnapshotMeta> {
  const { dir, kind, reason, sections, state } = opts;
  const now = opts.now ?? ((): Date => new Date());
  const idFactory = opts.idFactory ?? ((): string => makeConfigSnapshotId(now));
  const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;

  await fs.mkdir(dir, { recursive: true });
  let id = idFactory();
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fs.access(path.join(dir, id));
      id = `${idFactory()}-${Math.random().toString(36).slice(2, 5)}`;
    } catch {
      break; // 不存在 → 可用
    }
  }

  const data: Record<string, unknown> = {};
  for (const [sectionId, exported] of sections) {
    data[sectionId] = encodeForJson(exported.data);
  }

  const sectionsList = [...sections.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const payload = { meta: null as unknown, data };
  const metaBase: Omit<ConfigSnapshotMeta, 'totalBytes'> = {
    id,
    createdAt: now().toISOString(),
    kind,
    reason,
    ...(opts.trigger !== undefined ? { trigger: opts.trigger } : {}),
    sections: sectionsList,
    state,
    ...(opts.note !== undefined ? { note: opts.note } : {}),
    ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
  };
  payload.meta = metaBase;
  const serialized = JSON.stringify(payload, null, 2);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maxBytes) {
    throw new Error(`配置快照超出上限（${bytes} > ${maxBytes} 字节）；请缩小分区范围后重试`);
  }
  const meta: ConfigSnapshotMeta = { ...metaBase, totalBytes: bytes };
  payload.meta = meta;

  const finalText = JSON.stringify(payload, null, 2);
  const target = snapshotDir(dir, id);
  await fs.mkdir(target, { recursive: true });
  await atomicWriteFile(path.join(target, CONFIG_SNAPSHOT_FILE), finalText);
  return meta;
}

/**
 * meta.state 形状校验。
 * 语义：
 *  - 缺失 / undefined → **放行**（旧格式快照，撤销侧会按「无法比对」剔除，
 *    但它仍应出现在列表里可见/可恢复）；
 *  - 存在但不是 `{ sections: [...] }` → 判为损坏并整条丢弃：继续信任它会让
 *    statesEqual/planUndo 拿到形状不对的对象（历史上会直接抛 TypeError，
 *    一条坏文件就能让整个灾备面板 500）。
 */
function isValidStateField(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Array.isArray((value as { sections?: unknown }).sections);
}

/** 读单个快照的元数据；缺失/损坏/非法 id → null（绝不抛）。 */
export async function readConfigSnapshotMeta(dir: string, id: string): Promise<ConfigSnapshotMeta | null> {
  if (!isValidSnapshotId(id)) return null;
  try {
    const raw = await fs.readFile(path.join(dir, id, CONFIG_SNAPSHOT_FILE), 'utf8');
    const parsed = parseJsonSafe(raw) as { meta?: ConfigSnapshotMeta } | null;
    const meta = parsed?.meta;
    if (meta === null || meta === undefined || typeof meta !== 'object') return null;
    if (meta.id !== id || typeof meta.createdAt !== 'string' || typeof meta.kind !== 'string') return null;
    if (!isValidStateField((meta as { state?: unknown }).state)) return null;
    return meta;
  } catch {
    return null;
  }
}

/** 列出全部快照元数据（按 createdAt 倒序；损坏条目跳过，不阻断其余）。 */
export async function listConfigSnapshots(dir: string): Promise<ConfigSnapshotMeta[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas: ConfigSnapshotMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await readConfigSnapshotMeta(dir, entry.name);
    if (meta !== null) metas.push(meta);
  }
  metas.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return metas;
}

/** 读完整快照（含分区数据）。缺失/损坏抛出。 */
export async function loadConfigSnapshot(dir: string, id: string): Promise<ConfigSnapshot> {
  const target = snapshotDir(dir, id);
  const raw = await fs.readFile(path.join(target, CONFIG_SNAPSHOT_FILE), 'utf8');
  const parsed = parseJsonSafe(raw) as { meta?: ConfigSnapshotMeta; data?: Record<string, unknown> } | null;
  const meta = parsed?.meta;
  if (meta === null || meta === undefined || typeof meta !== 'object' || meta.id !== id) {
    throw new Error(`配置快照 ${id} 的 ${CONFIG_SNAPSHOT_FILE} 不是合法对象`);
  }
  const data: Partial<Record<SectionId, unknown>> = {};
  for (const [k, v] of Object.entries(parsed?.data ?? {})) {
    data[k as SectionId] = decodeFromJson(v);
  }
  return { ...meta, data };
}

/** 更新的元数据字段（写入时保留分区数据不变）。 */
export type ConfigSnapshotMetaPatch = Partial<
  Pick<ConfigSnapshotMeta, 'note' | 'tags' | 'pinned' | 'consumed' | 'stepped' | 'undoOf'>
>;

/** 原地更新元数据字段；快照不存在返回 null。 */
export async function updateConfigSnapshotMeta(
  dir: string, id: string, patch: ConfigSnapshotMetaPatch,
): Promise<ConfigSnapshotMeta | null> {
  if (!isValidSnapshotId(id)) return null;
  const target = path.join(dir, id, CONFIG_SNAPSHOT_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseJsonSafe(raw) as { meta?: ConfigSnapshotMeta; data?: unknown } | null;
  if (parsed?.meta === null || parsed?.meta === undefined) return null;
  const meta: ConfigSnapshotMeta = { ...parsed.meta };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    (meta as unknown as Record<string, unknown>)[k] = v;
  }
  await atomicWriteFile(target, JSON.stringify({ meta, data: parsed.data ?? {} }, null, 2));
  return meta;
}

/** 删除单个快照（幂等：不存在视为成功）。 */
export async function deleteConfigSnapshot(dir: string, id: string): Promise<boolean> {
  if (!isValidSnapshotId(id)) throw new Error(`非法配置快照 id: ${JSON.stringify(id)}`);
  const target = snapshotDir(dir, id);
  try {
    await fs.stat(target);
  } catch {
    return false;
  }
  await fs.rm(target, { recursive: true, force: true });
  return true;
}

/* ------------------------------------------------------------ 保留策略 */

export interface ConfigSnapshotPruneOptions {
  /** auto / baseline / undo 三类共用的保留份数（缺省 20） */
  keepAuto?: number;
  /** pre-restore 保留份数（缺省 10） */
  keepPreRestore?: number;
  /** manual 保留份数（缺省 Infinity = 永不自动清理） */
  keepManual?: number;
}

/**
 * 保留清理：按 kind 分桶，各自保留最新 N 份，删除更旧的。
 * pinned 快照**一律豁免**（用户显式保留的回滚点不得被自动淘汰）。
 * 返回被删除的快照 id 列表。
 */
export async function pruneConfigSnapshots(
  dir: string, opts: ConfigSnapshotPruneOptions = {},
): Promise<string[]> {
  const keepAuto = opts.keepAuto ?? 20;
  const keepPre = opts.keepPreRestore ?? 10;
  const keepManual = opts.keepManual ?? Number.POSITIVE_INFINITY;
  const metas = (await listConfigSnapshots(dir)).filter((m) => m.pinned !== true);
  const bucket = (kind: ConfigSnapshotKind): number => {
    if (kind === 'pre-restore') return keepPre;
    if (kind === 'manual') return keepManual;
    return keepAuto;
  };
  const grouped = new Map<number, ConfigSnapshotMeta[]>();
  for (const meta of metas) {
    const limit = bucket(meta.kind);
    const list = grouped.get(limit) ?? [];
    list.push(meta);
    grouped.set(limit, list);
  }
  // metas 已按 createdAt 倒序 → 每桶内前 limit 个保留，其余删除
  const removed: string[] = [];
  for (const [limit, list] of grouped) {
    if (!Number.isFinite(limit)) continue;
    for (const meta of list.slice(Math.max(0, limit))) {
      await fs.rm(path.join(dir, meta.id), { recursive: true, force: true });
      removed.push(meta.id);
    }
  }
  return removed;
}

/* ------------------------------------------------------------ 回放恢复 */

/** 构建回放用 manifest（与导入/导出管道的合成 manifest 同构） */
function buildReplayManifest(ctx: HostContext): Manifest {
  const sections: Record<string, boolean> = {};
  for (const id of SECTION_IDS) sections[id] = false;
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exporter: { name: 'DSH Config Manager', version: '0.1.0' },
    source: {
      dshVersion: ctx.dshVersion,
      platform: ctx.platform as Manifest['source']['platform'],
      arch: ctx.arch,
    },
    exportedAt: new Date().toISOString(),
    sections: sections as Manifest['sections'],
    security: { containsSecrets: false, encrypted: false, encryption: null },
  };
}

export interface RestoreConfigSnapshotOptions {
  dir: string;
  id: string;
  adapters: readonly ConfigAdapter[];
  ctx: HostContext;
  /**
   * 分区应用顺序（缺省 = adapters 传入顺序）。宿主应传入与导入管线一致的顺序
   * （副作用大的 patch/安装最后），避免半途失败留下不一致的中间态。
   */
  applyOrder?: readonly SectionId[];
  /** 只回放这些分区（缺省 = 快照内的全部分区） */
  only?: readonly SectionId[];
  msg?: MsgFunc;
  /** 逐项进度回调（UI 进度条） */
  onItem?: (info: { index: number; total: number; detail: string }) => void;
}

export interface ConfigSnapshotRestoreReport {
  ok: boolean;
  snapshotId: string;
  /** 成功应用的计划项 `${section}:${itemId}` */
  applied: string[];
  /** 跳过（Skip/Warning/MissingSecret 等非破坏性项） */
  skipped: string[];
  failed: { item: string; reason: string }[];
  /** 校验不通过而整体跳过的分区 */
  invalidSections: { section: SectionId; reason: string }[];
  needsRestart: boolean;
}

/**
 * 回放的执行上下文：回放**没有**秘密输入来源（不传 secretInputs / decryptedCredentials），
 * 因此 MissingSecret 恒不可执行 —— 与导入路径「无值 → skip」同一判定，
 * 绝不是又一份 kind 清单（可执行集合单点派生自 backup.planItemWritesTarget）。
 */
const REPLAY_EXEC_CONTEXT = { secretValueAvailable: (): boolean => false } as const;

/**
 * 回放一个配置快照：对每个分区 validate → analyzeImport → applyItem。
 * 与导入/Profile 切换共用 adapter 管线**与同一套可执行集合判定**
 * （backup.planItemWritesTarget，单点）：未采纳的 Conflict 与导入路径一致地 skip，
 * 绝不再出现「导入是 skip、回放却 applyItem 静默覆盖」的双语义。
 * 单项失败不拖垮其余（如实计入 failed），与 rollback.ts 的尽力语义一致。
 */
export async function restoreConfigSnapshot(
  opts: RestoreConfigSnapshotOptions,
): Promise<ConfigSnapshotRestoreReport> {
  const { dir, id, adapters, ctx } = opts;
  const msg = opts.msg ?? ctx.msg ?? zhMsg;
  const snapshot = await loadConfigSnapshot(dir, id);
  const only = opts.only !== undefined ? new Set(opts.only) : null;

  const sections = new Map<SectionId, unknown>();
  /** 快照里出现的**未注册分区**（旧版本写入 / 手改快照 / 未来分区被降级） */
  const unknownSections: string[] = [];
  for (const [k, v] of Object.entries(snapshot.data)) {
    // t30：未注册分区**显式记录**（与 `only` 无关 —— 它本来就不会被回放），绝不静默丢弃、
    // 更不按其它分区语义回放（旧缺陷见 backup.ts `engineSnapshotEntry` 的 default 分支）。
    if (!isSectionId(k)) { unknownSections.push(k); continue; }
    if (only !== null && !only.has(k)) continue;
    sections.set(k, v);
  }

  const importCtx: ImportContext = {
    manifest: buildReplayManifest(ctx),
    targetPlatform: ctx.platform,
    target: ctx,
    sections,
    pathMappings: [],
    resolutions: {},
    secretInputs: {},
    log: ctx.log,
    msg,
  };

  const ordered = opts.applyOrder !== undefined
    ? [...adapters].sort((a, b) => {
        const ia = opts.applyOrder!.indexOf(a.id);
        const ib = opts.applyOrder!.indexOf(b.id);
        return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
      })
    : [...adapters];

  const report: ConfigSnapshotRestoreReport = {
    ok: true,
    snapshotId: id,
    applied: [],
    skipped: [],
    failed: [],
    invalidSections: unknownSections.map((k) => ({
      section: k as SectionId,
      reason: `未注册分区「${k}」：已跳过回放（不按其它分区语义处理；新增分区需在 schema/section-registry.ts 注册）`,
    })),
    needsRestart: false,
  };

  for (const adapter of ordered) {
    const data = sections.get(adapter.id);
    if (data === undefined) continue;
    let items;
    try {
      const validation = await adapter.validate(data, msg);
      if (!validation.valid) {
        const reason = validation.issues
          .filter((i) => i.severity === 'error')
          .map((i) => `${i.path}: ${i.message}`)
          .join('; ');
        report.invalidSections.push({ section: adapter.id, reason: reason === '' ? 'validation failed' : reason });
        continue;
      }
      items = await adapter.analyzeImport(data, importCtx);
    } catch (err) {
      report.invalidSections.push({
        section: adapter.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    let index = 0;
    for (const item of items) {
      index += 1;
      opts.onItem?.({ index, total: items.length, detail: `${adapter.id}:${item.id}` });
      if (item.kind === 'Error') {
        report.failed.push({ item: `${adapter.id}:${item.id}`, reason: item.description });
        report.ok = false;
        continue;
      }
      if (!planItemWritesTarget(item, REPLAY_EXEC_CONTEXT)) {
        // 信息项 / 未采纳的 Conflict / 无值凭据：不写目标，如实进报告（不静默）
        report.skipped.push(`${adapter.id}:${item.id}`);
        continue;
      }
      try {
        const result = await adapter.applyItem(item, importCtx);
        if (result.ok) {
          report.applied.push(`${adapter.id}:${item.id}`);
          if (result.needsRestart === true) report.needsRestart = true;
        } else if (result.warning === true) {
          report.skipped.push(`${adapter.id}:${item.id}`);
        } else {
          report.failed.push({
            item: `${adapter.id}:${item.id}`,
            reason: result.message ?? 'applyItem 返回失败',
          });
          report.ok = false;
        }
      } catch (err) {
        report.failed.push({
          item: `${adapter.id}:${item.id}`,
          reason: err instanceof Error ? err.message : String(err),
        });
        report.ok = false;
      }
    }
  }

  return report;
}

/** 便捷：两个快照的分区指纹是否等价（供 UI「与当前一致」提示） */
export function snapshotsEquivalent(a: ConfigSnapshotMeta, b: ConfigSnapshotMeta): boolean {
  return statesEqual(a.state, b.state);
}

/** 供调用方取翻译器（保持与 core 其他模块一致的导出面） */
export const configSnapshotMsgOf = msgOf;
