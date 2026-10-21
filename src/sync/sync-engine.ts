/**
 * m-sync-flow：push/pull 编排（SyncEngine）。
 *
 * push：createAdapters 逐个 export（includeSecrets=false 恒成立）→ SecretScanner 剥离 →
 *       组装 SyncSnapshot（只含 portable 分区）→ 本地散文件副本（复用 t2 layout，不写 ZIP）→
 *       transport.upload → 更新 sync-state（每分区 hash + updatedAt + lastSyncAt + transport 绑定）。
 * pull：transport.list/download 取远端快照 → 过滤 portable 分区 → 转临时标准 ZIP
 *       （buildManifest + checksums，喂给现有 Importer）→ analyzeImport/createImportPlan 预览差异。
 *       绝不直接写配置、绝不执行导入（executeImportPlan 由上层按用户确认驱动）。
 *
 * 安全不变量：
 *  - 默认（includeSecrets=false）secret 值永不参与同步：敏感字段扫描剥离 + 凭据分区结构性排除断言；
 *  - 显式勾选「导出密钥」（includeSecrets=true）时，凭据值**只能**以 scrypt+AES-256-GCM 密文
 *    随加密快照上行（`snapshot.credentials` 独立载荷；强制 encrypt，绝不明文进通道）；
 *  - 远端快照声明 containsSecrets=true 且未加密 → 拒绝拉取；
 *  - 同步只做 portable 分区（deviceSpecific/platformSpecific 永不进入同步通道）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAdapters } from '../adapters/index.ts';
import { defaultSecretScanner } from '../core/exporter.ts';
import { Importer } from '../core/importer.ts';
// issue #91：只读预览与基线 hash 的口径判定（本地源插件在预览里不会被 npm pack）
import { isLocalPluginSpec } from '../core/local-plugin-pack.ts';
import type {
  ConfigAdapter, ExportSection, GlobalConflictStrategy, HostContext,
  ImportAnalysis, ImportPlan, ImportResult, PathMapping, PlanItem, PlanItemKind, RollbackReport, SecretScanner,
} from '../core/types.ts';
import { isFileSection, SECTION_FILE_PREFIXES, SECTION_JSON_PATHS } from '../schema/config.ts';
import { buildManifest, CHECKSUMS_FILE, MANIFEST_FILE } from '../schema/manifest.ts';
import type { FilesSection, Platform, SectionData, SectionId } from '../schema/types.ts';
import { CURRENT_SCHEMA_VERSION } from '../schema/versions.ts';
import { buildChecksums } from '../utils/hashing.ts';
import { stringifyJsonSafe } from '../utils/json.ts';
import { writeZip } from '../utils/zip.ts';
import type { ZipWriteEntry } from '../utils/zip.ts';
import { createSnapshotFs, joinFs } from './fs.ts';
import type { SnapshotFs } from './fs.ts';
import { writeSnapshotToDir } from './layout.ts';
import {
  credentialsMapFromYaml, decryptCredentialsPayload, decryptSectionsPayload,
  encryptCredentialsPayload, encryptSectionsPayload,
} from './snapshot-crypto.ts';
import { OPT_IN_SYNC_SECTIONS } from './sync-selection.ts';
import { nextSessionTombstones, sessionUnitIdsOfSection, stripTombstonedUnits } from './session-tombstones.ts';
import { DEFAULT_RETENTION_POLICY, selectPruneCandidatesByPolicy } from './retention-policy.ts';
import type { RetentionPolicy } from './retention-policy.ts';
import { hashSection, loadSyncState, resolveDeviceIdentity, saveSyncState } from './sync-state.ts';
import type { PendingMerge, SyncState } from './sync-state.ts';
import type { EncryptedCredentials, SyncProbeResult, SyncSnapshot, SyncSnapshotMeta, SyncTransport } from './transport.ts';
import { isEncryptedSections, PROBE_UNSUPPORTED_CODE, SyncTransportError } from './transport.ts';
import { msgOf, zhMsg } from '../core/messages.ts';
import { engineMsg } from './messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import { DEFAULT_ANCESTOR_KEEP, pruneAncestors, tryLoadAncestor, writeAncestor } from './ancestor.ts';
import type { MergeConflictReason, MergePlan, MergeSectionResult } from './merge.ts';
import { merge as mergeSections } from './merge.ts';
import { classifyMergePlan } from './risk.ts';
import type { SyncApplyPlan } from './risk.ts';
import { redact } from '../security/redaction.ts';
import { registerMessageCatalog } from '../core/engine-locale.ts';
import { createSnapshot, selectPruneCandidates } from '../core/backup.ts';
import { rollback } from '../core/rollback.ts';
import { FileSnapshotStore } from '../core/backup.ts';
import type { Snapshot, SnapshotStore, TransactionSnapshotContext } from '../core/types.ts';
import type { PlanItemProgress } from '../core/analyzer.ts';

/* ------------------------------------------- 合并预览：本域追加文案目录 + 可读预览工具 */

/**
 * 本模块新增文案的追加目录（zh 源 / en 镜像；与 adapters / foreign 域同模式）。
 *
 * 为什么不写进 `src/sync/messages.ts`：该文件由**并行会话**维护、且不在本任务写入范围内；
 * 追加目录的查找顺序是「既有目录（当前语言）→ 注册目录 → 键名」，新键不可能遮蔽既有键。
 */
const zh = {
  'sync.pushRemoteAdvanced': '远端最新快照 {remote} 与本地基线 {base} 不一致：本次推送未执行（远端未写入、基线未改动）。请先同步远端改动；确认要用本机覆盖远端时，再显式选择强制推送。',
  'sync.pushAdvanceCheckFailed': '无法确认远端是否已被其它设备推进（{reason}）：本次推送按原样继续',
  'sync.applyMergeResolutionsNoImporter': 'applyMergeResolutions: SyncEngine 缺少 importer（需在 options 中注入）',
  'sync.mergePendingConflicts': '仍有 {count} 个分区未裁决（{sections}）：已裁决的部分已写入本机，但基线不推进，冲突下一轮会重新出现',
  'sync.baselineRexportFailed': '写回成功但重新导出本机分区失败（{sections}）：无法证明基线与本机一致，本次**不记基线**（远端指针保持原值，下一轮重新合并收敛）',
} as const;

const en: Record<keyof typeof zh, string> = {
  'sync.pushRemoteAdvanced': 'The newest remote snapshot {remote} differs from the local baseline {base}: this push did not run (nothing written remotely, baseline untouched). Sync the remote changes first, or explicitly force the push if this machine should overwrite the remote.',
  'sync.pushAdvanceCheckFailed': 'Cannot tell whether another device advanced the remote ({reason}): this push continues as-is',
  'sync.applyMergeResolutionsNoImporter': 'applyMergeResolutions: SyncEngine is missing the importer (must be injected via options)',
  'sync.mergePendingConflicts': '{count} section(s) still have no decision ({sections}): the decided parts were written locally, but the baseline is not advanced, so the conflicts will reappear next round',
  'sync.baselineRexportFailed': 'The write succeeded but re-exporting the local section(s) failed ({sections}): the baseline cannot be proven to match this machine, so no baseline was recorded (the remote pointer keeps its old value and the next merge converges again)',
};

registerMessageCatalog({ id: 'sync-engine-merge', zh, en });

/**
 * 单侧预览文本上限（2 KiB **字符**预算）：超出截断并追加省略号。
 *
 * 顺序恒为「先 redact 再截断」：反过来会把跨边界的敏感值切成半个形状，让脱敏匹配不到它
 * （等于把秘密截一半发出去）。redact 之后的剩余文本已不含秘密形状，截断才安全。
 */
const MERGE_PREVIEW_TEXT_LIMIT = 2048;

/** 严格 UTF-8 解码器：非法字节序列直接抛错（用于区分文本与二进制文件冲突）。 */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** 把任意冲突侧值转成**可读字符串**；二进制只回传形状与字节数，绝不回传原始值对象。 */
function previewTextOf(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return finalizePreviewText(value);
  if (value instanceof Uint8Array) {
    try {
      return finalizePreviewText(STRICT_UTF8.decode(value));
    } catch {
      // 二进制内容解码只会得到乱码（同样误导用户）→ 只回传形状；JSON 是数据形态，不是文案
      return JSON.stringify({ binary: true, bytes: value.length });
    }
  }
  try {
    return finalizePreviewText(JSON.stringify(value) ?? '');
  } catch {
    return finalizePreviewText(String(value));
  }
}

/** 预览文本统一出口：先 redact（敏感值绝不回传浏览器），再截断到 2 KiB。 */
function finalizePreviewText(text: string): string {
  const masked = redact(text);
  return masked.length > MERGE_PREVIEW_TEXT_LIMIT ? `${masked.slice(0, MERGE_PREVIEW_TEXT_LIMIT)}…` : masked;
}

/** plan 的单个分区结果 → 预览视图（三侧都只回传可读文本，绝不回传原始值）。 */
function mergePreviewSectionView(result: MergeSectionResult): MergePreviewSectionView {
  const conflicts: MergePreviewConflictView[] = result.conflicts.map((c) => ({
    path: c.path,
    kind: c.kind,
    ...(c.reason !== undefined ? { reason: c.reason } : {}),
    localPreview: previewTextOf(c.local),
    remotePreview: previewTextOf(c.remote),
    ancestorPreview: previewTextOf(c.ancestor),
  }));
  return {
    id: result.id,
    decision: result.decision,
    ...(result.autoMerged !== undefined ? { autoMerged: result.autoMerged } : {}),
    conflictCount: result.conflicts.length,
    conflicts,
  };
}

export interface SyncEngineOptions {
  ctx: HostContext;
  transport: SyncTransport;
  /** sync-state.json 所在目录 */
  stateDir: string;
  /** 分区 adapter 列表（缺省 createAdapters()；宿主应注入 namespaces 等） */
  adapters?: ConfigAdapter[];
  /** 秘密扫描器（缺省 defaultSecretScanner：敏感字段名剥离） */
  scanner?: SecretScanner;
  /** pull 需要；不注入则 pull 抛错（push 不受影响） */
  importer?: Importer;
  now?: () => Date;
  /** 快照 id 生成器（缺省 sync-<uuid>；须符合通道安全字符集） */
  snapshotId?: () => string;
  /** 记录到 sync-state.transport.ref（如 git 分支名） */
  transportRef?: string;
  /** 本地散文件快照副本目录（push 落盘审计副本；不传则跳过本地落盘） */
  localSnapshotsDir?: string;
  /** 一键回滚兜底快照目录（apply-items / apply-merge-plan 落盘；缺省 <stateDir>/snapshots，
   *  与 Host /sync/rollback 路由读取的目录保持一致，否则回滚找不到 snapshot.json） */
  rollbackSnapshotsDir?: string;
  /** pull 临时 ZIP 目录（缺省 os.tmpdir()） */
  zipDir?: string;
  exporterVersion?: string;
  fsx?: SnapshotFs;
  /** 消息翻译器（缺省 ctx.msg ?? zh） */
  msg?: MsgFunc;
  /**
   * 本次运行**显式放行的「可选分区」集合**（拉取/合并/应用 + 推送两侧共用）。
   *
   * 缺省空集 —— 可选分区默认永不参与同步。宿主按「该分区允许哪种驱动」决定传什么：
   *  - 手动 push/pull / 一键同步 → 持久化选择里的全部可选分区（OPT_IN_SYNC_SECTIONS ∩ 勾选）；
   *  - 自动同步 / model-tools → 只传 'auto' 档（AUTO_SYNC_OPT_IN_SECTION_IDS ∩ 勾选），
   *    sessions（'manual'）因此**绝不悄悄下行/上行**。
   *
   * 为什么是集合而不是布尔：布尔只能表达「全放行 / 全不放行」，勾了 mcp 会连带放行
   * sessions（issue #78 的回归点）。集合化后每个分区独立放行。
   */
  optInSections?: readonly SectionId[];
  /**
   * 同步范围（高级/自定义导出模式持久化配置）：只处理这些 portable 分区。
   * 缺省 = 全部 portable 推荐分区。应用于 push / merge / applyMergePlan / applyItems
   * 等全部链路（portableAdapters 层过滤），供自动同步等后台流程复用用户选择；
   * 手动请求仍可用 push(opts.sections) 覆盖。
   */
  sections?: SectionId[];
  /**
   * 远端快照保留策略提供者（m-retention 接线）：缺省 = DEFAULT_RETENTION_POLICY
   * （keepLast=10，与改造前的硬编码 FIFO 逐字等价）。
   *
   * 注入后远端 prune 走 GFS 分层（最近 N / 每月一份 / 每年一份），与本地备份产物、
   * 本地快照共用同一份 RetentionPolicy——「对话寿命 = 推了几次配置」这个反直觉行为
   * 由此消除：策略按月/年分层时，早先同步到远端的会话不再被后续 push 冲掉。
   * 提供者抛错 → 回退缺省策略（保守多留，绝不因读取失败而误删远端快照）。
   */
  retentionPolicy?: () => RetentionPolicy | Promise<RetentionPolicy>;
}

export interface SyncPushOptions {
  /** 覆盖自动生成的快照 id */
  snapshotId?: string;
  /** 仅同步指定分区（缺省 = 全部 portable 推荐分区，即「默认/快速导出」模式）。
   *  传入非 portable 或未知分区 → 忽略并告警（同步通道安全约束：
   *  deviceSpecific/platformSpecific 默认永不进入同步通道；未知 id 不静默吞掉）。
   *  例外：构造期显式放行的可选分区（SyncEngineOptions.optInSections）才纳入 ——
   *  未被放行的一律按非 portable 跳过并告警（不静默）。 */
  sections?: SectionId[];
  /**
   * sessions（历史会话）分区的**导出参数**（「最新 N 个会话」上限 / 逐会话点名）。
   *
   * 注意：它**不再兼任放行开关** —— 是否允许 sessions 进通道只由构造期
   * SyncEngineOptions.optInSections 决定（issue #78 把「放行」与「参数」拆开，
   * 否则勾了 mcp 会顺带解锁 sessions）。这里只决定「带哪几个会话」。
   *
   * include（显式勾选的会话单元 id，形如 sessions:<projectKey>/<sessionId>）非空时
   * **优先于 limit**：用户点名的对话必须赢；此时不施加「最新 N 个」数量筛选，否则会退化成
   * 「最新 N 个里被我勾中的那几个」。宿主侧由 sync-selection.json 的 sessionsInclude 持久化。
   */
  sessions?: { limit?: number; include?: string[] };
  /** 加密快照：sections 载荷整体加密（AES-256-GCM），manifest.encrypted=true。
   *  开启时必须提供 password（仅本次调用内存使用，绝不落盘/落日志）。 */
  encrypt?: boolean;
  /** 加密密码（仅内存；encrypt=true 时必填）。 */
  password?: string;
  /** 导出真实凭据值：读取 `$DSH_HOME/.credentials.yaml` 原文，加密后作为快照的独立
   *  凭据载荷（`snapshot.credentials`）随快照上行（issue #38）。安全不变量：
   *  includeSecrets=true 必须同时 encrypt=true，否则拒绝（密钥绝不明文进入同步通道）；
   *  自动同步恒 includeSecrets=false（推普通快照）。 */
  includeSecrets?: boolean;
  /**
   * 强制推送（缺省 false）：跳过「远端已被其它设备推进」的前置检测。
   *
   * 为什么默认要拦：本机基线 X、别的设备推了 Y、本机再推 Z（不含 Y 的改动）时，
   * 远端保留策略随后会淘汰 Y ⇒ **Y 的改动在远端与本机都消失**（静默丢数据）。
   * 只有用户明确知道「要用本机覆盖远端」时才传 true。
   */
  force?: boolean;
}

export interface SyncPullOptions {
  /** 指定远端快照 id（缺省 = 最新） */
  snapshotId?: string;
  /** 冲突全局策略（缺省 merge：冲突保留待决策） */
  strategy?: GlobalConflictStrategy;
  /** 解密密码（加密快照需要；仅内存，绝不落盘/落日志） */
  password?: string;
  /**
   * 用户路径映射（issue #45）：与导入向导同一套 PathMapping，排在**自动重定基之后**生效。
   * 缺省 [] = 只用自动重定基（导出机 home ≠ 本机时由 analyzer.rebaseMapping 生成）。
   * 只作用于结构化分区的路径叶值 + 会话首帧 cwd，永不改写文件集合分区的 relativePath。
   */
  pathMappings?: PathMapping[];
}

export interface SyncPushReport {
  ok: boolean;
  snapshotId: string;
  /** 实际进入同步的 portable 分区 */
  sections: SectionId[];
  /** 分区级告警（单项失败不拖垮整体，§34.17 语义） */
  warnings: string[];
  message?: string;
  /**
   * 本次推送**被前置检测拒绝**（远端已被其它设备推进）：未写远端、未记基线、未改 sync-state。
   * 这是「需要先合并远端」的冲突态，不是通道/凭据故障 —— 调用方（自动同步 / 路由）应按冲突处理，
   * 而不是记成「同步失败」。
   */
  conflict?: boolean;
}

/** 差异报告中的单个变更项（PlanItem 摘要，不含敏感细节） */
export interface PullChange {
  id: string;
  adapter: SectionId;
  kind: PlanItemKind;
  description: string;
  severity: PlanItem['severity'];
}

export interface SyncPullReport {
  ok: boolean;
  snapshotId: string;
  changes: PullChange[];
  /** 是否存在需要人工决策的项（Conflict / MissingSecret / MissingDependency / 路径问题）。
   * 插件 Install 不算 —— 插件安装随同步自动采用（product requirement）。 */
  needsReview: boolean;
  message?: string;
}

/** P0-②：push 前只读预览 ——「将推送什么」的单分区摘要（不写远端、不落盘）。 */
export interface SyncPushPreviewSection {
  /** 分区 id（将进入快照的 portable 分区） */
  section: SectionId;
  /** 分区内条目计数（adapter.export 的 counts 聚合；无计数时为 0） */
  count: number;
  /** 相对上次基线（sync-state）是否变化：true = 本次会更新该分区；false = 与基线一致 */
  changed: boolean;
}

/** P0-②：push 前预览结果（零写入）。 */
export interface SyncPushPreview {
  ok: boolean;
  /** 将推送的分区清单（含计数与变化标记） */
  sections: SyncPushPreviewSection[];
  /** 远端现有快照数（0 = 首次推送将创建首个基线） */
  remoteSnapshotCount: number;
  /** 加密快照：载荷将整体加密（分区计数与基线比较不可得） */
  encrypted: boolean;
  /** 本次推送是否真的会带上凭据载荷（.credentials.yaml 可读且非空；issue #38） */
  credentialsIncluded: boolean;
  message?: string;
}

/** 一键 sync 预览结果（preview() 返回；临时 ZIP 由调用方持有并负责清理）。 */
export interface SyncPreviewResult {
  ok: boolean;
  /** 临时标准 ZIP 路径（apply-items 复用 executeImportPlan 需要；调用方清理） */
  zipPath: string;
  plan: ImportPlan | null;
  analysis: ImportAnalysis | null;
  snapshotId: string;
  /**
   * 从快照凭据载荷解密出的 `Map<ref, value>`（issue #38；无凭据载荷 → undefined）。
   * **仅内存**：绝不落盘、绝不进响应体/日志/报告；apply-items 时作为
   * executeImportPlan 的 decryptedCredentials 交给 credentials adapter 写回本机。
   */
  credentials?: Map<string, string>;
  message?: string;
}

/** 自动应用执行器（P2b）报告 */
export interface ApplyReport {
  ok: boolean;
  /** 实际写入本地的分区 id 列表 */
  applied: string[];
  /** 应用前快照 id（UI 可借此一键回滚）；失败时仍透传以便排查 */
  restoreId: string;
  /** 是否触发了整体回滚 */
  rolledBack: boolean;
  /**
   * 整体回滚是否**完整**（诚实性，2026-10）。rolledBack=true 只说明触发了回滚，
   * 不代表每一项都补偿成功（典型：原本已存在的凭据值 DSH 不可回读、无法自动恢复）。
   * false 时失败项已并入 warnings，界面不得渲染成「整体成功回滚」。
   * 缺省 undefined = 没触发回滚（既有布尔字段语义不变）。
   */
  rollbackFull?: boolean;
  /** 失败时移到 review 队列的项（ReviewQueueItem 形态供 UI 直接渲染） */
  review: import('./review-queue.ts').ReviewQueueItem[];
  /** 来自 Importer.ImportResult 的 warnings；UI 可用于红条提示（含回滚未完成项） */
  warnings: string[];
}

/**
 * 失败路径的**显式兜底回滚**：把 core 的 RollbackReport 翻成「是否完整 + 告警行」。
 *
 * 为什么不能像改造前那样 catch 后 noop：回滚抛错或部分补偿失败会被静默吞掉，而调用方
 * 紧接着写 rolledBack: true，界面于是把「有改动没恢复」渲染成「已整体回滚」。
 * 现在失败项逐条进 warnings，完整度经 rollbackFull 如实回传。
 */
async function rollbackForFailure(
  ctx: HostContext,
  snapshot: Snapshot,
  store: SnapshotStore,
  adapters: ConfigAdapter[] | undefined,
): Promise<{ full: boolean; warnings: string[] }> {
  try {
    const report = await rollback({ ctx, snapshot, store, adapters })
    return { full: report.full, warnings: rollbackFailureWarnings(report, msgOf(ctx)) }
  } catch (err) {
    // 回滚自身抛错 = 无法证明任何一项已还原：如实报「不完整」并留痕，绝不 noop
    return {
      full: false,
      warnings: [engineMsg('sync.rollbackProofFailed', { err: err instanceof Error ? err.message : String(err) })],
    }
  }
}

/** RollbackReport.failed → 可读告警行（带 manualHint：人工怎么补）。 */
function rollbackFailureWarnings(report: RollbackReport, msg: MsgFunc = engineMsg): string[] {
  return report.failed.map((f) => {
    const hint = f.manualHint !== undefined && f.manualHint !== '' ? msg('sync.rollbackManualHintParen', { hint: f.manualHint }) : ''
    return msg('sync.rollbackIncomplete', { item: f.item, reason: f.reason, hint })
  })
}

/** applyItems 报告（§3.4 ApplyItemsResponse 的服务端形态） */
export interface ApplyItemsReport {
  ok: boolean;
  /** 实际写入的分区 id 列表（去重） */
  applied: string[];
  /** 未采纳的 itemId 列表 */
  skipped?: string[];
  /** 应用前快照 id（UI 一键回滚用；失败时仍透传以便排查） */
  restoreId: string;
  /** 任一失败是否整体回滚 */
  rolledBack: boolean;
  /**
   * 整体回滚是否**完整**（诚实性，2026-10；与 ApplyReport.rollbackFull 同一语义）：
   * rolledBack=true 只说明触发了整体回滚。false = 有改动没能恢复，失败项已并入 warnings。
   * 缺省 undefined = 未触发回滚（既有布尔字段语义不变）。
   */
  rollbackFull?: boolean;
  warnings: string[];
  failed: { itemId: string; message?: string }[];
  /**
   * 未生效项（issue #56 第二条线）：`status='warning'` 的计划项 —— **非致命但确实没写进去**。
   *
   * 为什么同步层要有自己的字段：`ok` 不因 warning 变 false（刻意如此），所以上层
   * （路由 / 历史 / 界面）必须靠这个字段才能把「部分成功」讲出来，而不是只报一句「同步完成」。
   * 真机：插件安装失败（warning）排在凭据写入之前，密钥因此没导进来，用户以为成功了。
   */
  ineffective: { itemId: string; adapter: string; message?: string }[];
  /** 透传 executeImportPlan 结果 */
  result: ImportResult | null;
  needsRestart?: boolean;
}

/** 同步通道结构性排除的敏感分区（即使 portable 判定有误也双保险拒绝；
 * 注：'credentials' 不是合法 SectionId——凭据状态分区为 credentialsStatus） */
const FORBIDDEN_SECTIONS: readonly SectionId[] = ['credentialsStatus', 'secrets'];

/**
 * 远端快照保留数量上限（**缺省策略**的 keepLast 层）：每次 push 上传成功后对远端裁剪，
 * 保留最新 N 个（按 createdAt 升序的最末 N 个，含刚 push 的），更旧的逐个删除。
 * 删除失败只告警（进 push 的 warnings），不上抛阻断主流程。
 *
 * m-retention：真正的裁剪规则来自 SyncEngineOptions.retentionPolicy（GFS 三层）；
 * 本常量只是**缺省策略**的 keepLast 取值（= 10，与改造前的硬编码 FIFO 逐字等价），
 * 保留导出是为了让既有调用方/测试仍能引用「缺省保留份数」这一事实，不再作为唯一判据。
 */
export const MAX_REMOTE_SNAPSHOTS = DEFAULT_RETENTION_POLICY.keepLast;

/**
 * issue #91：走只读 `preview()` 拿到的产物，能否直接与该分区**基线 hash**（push 时按 export() 产物记录）比对。
 *
 * 为什么需要这个判定：`plugins` 适配器的 `preview()` 走 `collect(…, pack=false)` —— 刻意**不做**
 * 本地源（`link:` / `file:`）插件的 `npm pack`。于是当 profile 里存在本地源插件时，预览产物既没有
 * `localTarballs`、插件 spec 也保持原样（export() 会改写成 `file:<tarball>`），与基线**不同口径**：
 * 此时既不能断言「无变化」（本地插件源码改了体积/内容，预览看不见），也不该为了比对去打包
 * （那正是本 issue 的缺陷本身）。
 *
 * 返回 true = 该分区本趟**不可比** ⇒ 调用方只能保守报「有变化」并如实说明原因。
 * 其余分区的 preview() 产物与 export() 逐字节相同（文件类分区不走 preview()，见 previewPush）。
 */
function previewCaliberDiffersFromExport(sectionId: SectionId, data: SectionData): boolean {
  if (sectionId !== 'plugins') return false;
  const plugins = (data as { plugins?: { spec?: string }[] }).plugins;
  return Array.isArray(plugins) && plugins.some((p) => isLocalPluginSpec(p?.spec));
}

/** previewMerge 的单条冲突视图（三侧文本都已截断 + redact；绝不回传原始值对象）。 */
export interface MergePreviewConflictView {
  /** 冲突位置：JSON 分区是 top-level key；文件类分区是 relativePath；'$' = 整分区冲突。 */
  path: string;
  kind: 'key' | 'file';
  /** 冲突成因（可选：旧数据/旧 merge 结果没有该字段，界面缺省按 'both-modified' 措辞）。 */
  reason?: MergeConflictReason;
  /** 本机侧的可读预览（≤ 2 KiB，超出截断加省略号；已过 redact()）。 */
  localPreview: string;
  /** 远端侧的可读预览（同上）。 */
  remotePreview: string;
  /** 共同祖先侧的可读预览（同上；无祖先时为空串）。 */
  ancestorPreview: string;
}

/** previewMerge 的单个分区视图。 */
export interface MergePreviewSectionView {
  id: SectionId;
  decision: MergeSectionResult['decision'];
  /** 自动合并并入的变更点数量（仅 decision === 'merge' 时有意义；缺省 = 未统计）。 */
  autoMerged?: number;
  conflictCount: number;
  conflicts: MergePreviewConflictView[];
}

/** previewMerge 结果（只读、零写入）。 */
export interface MergePreview {
  /** 预览是否成功产出（远端无快照 → false + message，分区清单为空）。 */
  ok: boolean;
  /** 本次预览针对的**远端**快照 id；'' = 远端无快照。 */
  snapshotId: string;
  /** 是否拿到了本地祖先副本（false = 退化为两方合并 → 所有双侧差异都会呈现为 conflict）。 */
  hasAncestor: boolean;
  sections: MergePreviewSectionView[];
  /** 与 risk.ts 的 classifyMergePlan 同口径计数：
   *  auto = 可自动应用的非冲突项，review = 需人工，conflicts = decision === 'conflict'，skipped = 'skip'。 */
  summary: { auto: number; review: number; conflicts: number; skipped: number };
  message?: string;
}

/**
 * 用户对**单个分区**的裁决（分区粒度：没有冲突项粒度 / 复合 id）。
 *  - useRemote：用远端整分区原值（对键级冲突而言 = 放弃本机该分区里除冲突键以外的改动）；远端没有该分区 → 无法表达删除，计入 pendingConflicts；
 *  - keepLocal ：保持本机整分区原值（本机没有该分区 = 无写入，直接跳过）；
 *  - useMerged ：取 merge() 的 merged 结果 —— 仅 decision === 'merge' 的分区有效；'conflict' 分区没有 merged，按冲突处理并计入 pendingConflicts；
 *  - skip     ：本轮不裁决该分区 → 计入 pendingConflicts，基线不推进（冲突下一轮重新出现）。
 */
export type MergeResolution = { id: SectionId; action: 'keepLocal' | 'useRemote' | 'useMerged' | 'skip' };

/** applyMergeResolutions 报告：ApplyReport + 仍未裁决的冲突分区（非空 = 基线未推进）。 */
export type ApplyMergeResolutionsReport = ApplyReport & { pendingConflicts: SectionId[] };

export class SyncEngine {
  private readonly ctx: HostContext;
  private readonly transport: SyncTransport;
  private readonly stateDir: string;
  private readonly adapters: ConfigAdapter[];
  private readonly scanner: SecretScanner;
  private readonly importer: Importer | undefined;
  private readonly now: () => Date;
  private readonly snapshotIdFn: () => string;
  private readonly transportRef: string;
  private readonly localSnapshotsDir: string | undefined;
  private readonly rollbackSnapshotsDir: string;
  private readonly zipDir: string;
  private readonly exporterVersion: string;
  private readonly fsx: SnapshotFs;
  private readonly msg: MsgFunc;
  private readonly sections: readonly SectionId[] | undefined;
  /** 本次显式放行的可选分区（构造期已归一：只可能是 OPT_IN_SYNC_SECTIONS 的注册项） */
  private readonly optInSections: ReadonlySet<SectionId>;
  /** 远端快照保留策略提供者（缺省 = 保守的「保留最近 10 个」，与改造前逐字等价） */
  private readonly retentionPolicyProvider: () => RetentionPolicy | Promise<RetentionPolicy>;
  /**
   * 最近一次 merge() 命中的**远端**快照 id（P0-7）：紧接其后的 applyMergePlan() 用它写基线远端指针，
   * 避免把本地临时快照 id 当成远端 id（那会让 hasNewRemoteSnapshot() 永远判「远端有新生」）。
   * 每次 merge() 重设；merge 失败/远端为空时置 null（= 远端 id 未知）。
   */
  private lastMergedRemoteSnapshotId: string | null = null;
  /**
   * 最近一次 merge() 命中的**远端**快照的 sourceHome（issue #45 跨机重定基）。
   * applyMergePlan 构造临时 ZIP 时把它写进 manifest.sourceHome，Importer 才会生成
   * 「源机 home → 本机 home」的重定基规则；'' = 旧快照/未知（不猜，行为不变）。
   */
  private lastMergedRemoteSourceHome = '';
  /** 最近一次 merge() 收到的用户路径映射（applyMergePlan 复用；缺省 []） */
  private lastMergedPathMappings: PathMapping[] = [];
  /**
   * 最近一次 merge() 是否拿到了本地祖先副本（false = 两方合并）。
   * previewMerge 用它如实告诉界面「为什么全都是冲突」，绝不让两方差异看起来像三方结论。
   */
  private lastMergeHadAncestor = false;
  /**
   * 最近一次 merge() 的三方输入（仅内存）。
   * applyMergeResolutions 需要它还原「整分区」语义：merge() 的 MergePlan 只携带冲突处的
   * 原始值（键级冲突只给键值），而 'useRemote' / 'keepLocal' 必须落**整分区**数据才能进导入计划。
   */
  private lastMergeInputs: {
    local: Partial<Record<SectionId, SectionData>>;
    remote: Partial<Record<SectionId, SectionData>>;
    ancestor: Partial<Record<SectionId, SectionData>>;
  } | null = null;

  constructor(opts: SyncEngineOptions) {
    if (opts.ctx === null || typeof opts.ctx !== 'object') throw new Error(zhMsg('sync.missingCtx'));
    if (opts.transport === null || typeof opts.transport !== 'object'
      || typeof opts.transport.upload !== 'function' || typeof opts.transport.list !== 'function'
      || typeof opts.transport.download !== 'function' || typeof opts.transport.delete !== 'function') {
      throw new Error(zhMsg('sync.missingTransport'));
    }
    if (typeof opts.stateDir !== 'string' || opts.stateDir.length === 0) {
      throw new Error(zhMsg('sync.missingStateDir'));
    }
    this.ctx = opts.ctx;
    this.transport = opts.transport;
    this.stateDir = opts.stateDir;
    this.adapters = opts.adapters ?? createAdapters();
    this.scanner = opts.scanner ?? defaultSecretScanner();
    this.importer = opts.importer;
    this.now = opts.now ?? (() => new Date());
    this.snapshotIdFn = opts.snapshotId ?? (() => `sync-${crypto.randomUUID()}`);
    this.transportRef = opts.transportRef ?? '';
    this.localSnapshotsDir = opts.localSnapshotsDir;
    this.rollbackSnapshotsDir = opts.rollbackSnapshotsDir ?? path.join(opts.stateDir, 'snapshots');
    this.zipDir = opts.zipDir ?? os.tmpdir();
    this.exporterVersion = opts.exporterVersion ?? '0.1.0';
    this.fsx = opts.fsx ?? createSnapshotFs();
    this.msg = opts.msg ?? msgOf(opts.ctx);
    this.sections = opts.sections !== undefined && opts.sections.length > 0 ? [...opts.sections] : undefined;
    // 归一：只有注册表声明的「可选分区」能被放行 —— 调用方传错 id 不会凭空解锁别的分区
    this.optInSections = new Set(
      (opts.optInSections ?? []).filter((id) => OPT_IN_SYNC_SECTIONS.includes(id)),
    );
    this.retentionPolicyProvider = opts.retentionPolicy ?? (() => DEFAULT_RETENTION_POLICY);
  }

  /** 同步只做 portable 分区（deviceSpecific/platformSpecific 永不参与）。
   *  构造注入 sections（同步范围）时再按注入范围过滤 —— 自动同步等后台流程
   *  merge/apply/push 全链路复用用户选择；手动请求仍可用 push(opts.sections) 覆盖。 */
  private portableAdapters(): ConfigAdapter[] {
    const portable = this.adapters.filter((a) => a.portability === 'portable');
    if (this.sections === undefined) return portable;
    const wanted = new Set(this.sections);
    return portable.filter((a) => wanted.has(a.id));
  }

  /**
   * 拉取/合并侧的分区范围 id 集合：portable（受注入的同步范围约束）
   * + **本次显式放行**的可选分区（optInSections）。
   *
   * 为什么单独一个助手：pull/preview/merge 都要把「远端快照里的哪些分区转进临时 ZIP」，
   * 三处必须同一口径；散开写 `portableAdapters().map(...)` 迟早漏掉一处（漏掉的表现是
   * 「推上去了、拉下来静默没有」）。
   */
  private pullSectionIds(): Set<SectionId> {
    const ids = this.portableAdapters().map((a) => a.id);
    for (const a of this.optInAdapters()) ids.push(a.id);
    return new Set(ids);
  }

  /** 本次显式放行的「可选分区」adapter（空集 = 一个都不放行；顺序跟随 adapters） */
  private optInAdapters(): ConfigAdapter[] {
    if (this.optInSections.size === 0) return [];
    return this.adapters.filter((a) => this.optInSections.has(a.id));
  }

  /**
   * push 候选 adapter：
   * - sections 缺省/空 → 全部 portable（「默认/快速导出」模式）；
   * - sections 显式给出 → 只取 portable 且命中的（「高级/自定义导出」模式）；
   *   非 portable / 未知分区 → 警告跳过（安全约束 + 不静默，用户能看见自己勾了哪个无效项）；
   * - 例外：本次构造显式放行的可选分区（optInSections，见 SyncEngineOptions）作为候选取出。
   *   缺省空集 → 与改造前逐字等价（可选分区一律不进同步通道）。
   */
  private pushTargets(
    sections: readonly SectionId[] | undefined,
    warnings: string[],
  ): ConfigAdapter[] {
    const portable = this.portableAdapters();
    const optIn = this.optInAdapters();
    // 默认模式（未指定 sections）：portable 全量 + 本次显式放行的可选分区。
    // 自动同步的 push() 不带 sections，可选分区能否上榜完全由构造期 optInSections 决定
    // （scheduler 只传 'auto' 档 → sessions 永不悄悄上行）。
    if (sections === undefined || sections.length === 0) return [...portable, ...optIn];
    const byId = new Map(portable.map((a) => [a.id, a]));
    for (const a of optIn) byId.set(a.id, a);
    const out: ConfigAdapter[] = [];
    for (const id of sections) {
      const adapter = byId.get(id);
      if (adapter === undefined) {
        warnings.push(this.msg('sync.skipNonPortable', { section: id }));
        continue;
      }
      out.push(adapter);
    }
    return out;
  }

  /** 结构性断言：凭据/秘密分区绝不进入同步载荷（双保险，portable 过滤之上） */
  private assertNoForbiddenSections(sections: Record<string, unknown>): void {
    for (const sid of FORBIDDEN_SECTIONS) {
      if (sid in sections) {
        throw new Error(this.msg('sync.denySensitiveSection', { section: sid }));
      }
    }
  }

  /**
   * 快照读取准备（download 后、使用前）：
   * - 加密快照（manifest.encrypted）→ 用 password 解密回明文 sections（原地替换）；
   *   无密码 → 明确报错（自动同步等无密码场景在调用方先行跳过）。
   * - 普通快照声明 containsSecrets=true → 拒绝（同步通道永不携带秘密，防御篡改/旧坏数据）。
   * 密码仅本次调用内存使用，绝不落盘/落日志。
   */
  private async prepareSnapshot(snapshot: SyncSnapshot, password?: string): Promise<void> {
    if (snapshot.manifest.encrypted) {
      if (password === undefined || password === '') {
        throw new Error(this.msg('sync.encryptedNeedsPassword', { id: snapshot.id }));
      }
      if (!isEncryptedSections(snapshot.sections)) {
        throw new Error(this.msg('sync.encryptedNeedsPassword', { id: snapshot.id }));
      }
      const decrypted = await decryptSectionsPayload(snapshot.sections.encrypted, password);
      snapshot.sections = decrypted;
      return;
    }
    if (snapshot.manifest.containsSecrets) {
      throw new Error(this.msg('sync.remoteContainsSecrets', { id: snapshot.id }));
    }
    // issue #38 双保险：凭据载荷只允许存在于加密快照。未加密快照携带凭据载荷 = 与
    // 「明文快照携带秘密」同类（防御篡改/旧坏数据），一律拒绝，绝不尝试解密后静默使用。
    if (snapshot.credentials !== undefined) {
      throw new Error(this.msg('sync.remoteContainsSecrets', { id: snapshot.id }));
    }
  }

  /* ------------------------------------------------ issue #38：凭据载荷（导出密钥） */

  /**
   * push 侧凭据载荷：includeSecrets=true 时读取 `$DSH_HOME/.credentials.yaml` 原文并加密。
   * 读不到 / 解析不出任何凭据 → 返回 undefined 并**告警**（不阻断推送：其余配置照常同步，
   * 但用户必须能看见「勾了导出密钥却没导出任何值」，而不是静默成功）。
   */
  private async buildCredentialsPayload(
    password: string,
    warnings: string[],
  ): Promise<EncryptedCredentials | undefined> {
    const credentialsFile = path.join(this.ctx.homeDir, '.credentials.yaml');
    let plaintext: string;
    try {
      plaintext = Buffer.from(await this.ctx.fs.readFile(credentialsFile)).toString('utf8');
    } catch (err) {
      warnings.push(this.msg('sync.credentialsReadFailed', { reason: err instanceof Error ? err.message : String(err) }));
      return undefined;
    }
    if (credentialsMapFromYaml(plaintext).size === 0) {
      warnings.push(this.msg('sync.credentialsEmpty'));
      return undefined;
    }
    return await encryptCredentialsPayload(plaintext, password);
  }

  /**
   * pull/preview 侧凭据载荷解密：快照携带凭据载荷时用同一次调用的密码解开为
   * `Map<ref, value>`（与宿主导入路径 tryDecryptCredentials 同口径）。无载荷 → undefined。
   * 值仅在内存流转：绝不落盘、绝不进日志/报告/响应体。
   */
  private async decryptSnapshotCredentials(
    snapshot: SyncSnapshot,
    password?: string,
  ): Promise<Map<string, string> | undefined> {
    const payload = snapshot.credentials;
    if (payload === undefined) return undefined;
    if (password === undefined || password === '') {
      throw new Error(this.msg('sync.credentialsNeedPassword', { id: snapshot.id }));
    }
    return credentialsMapFromYaml(await decryptCredentialsPayload(payload, password));
  }

  /**
   * 把「随加密快照迁移的凭据」补进导入计划：**需要写回**的 ref 生成 MissingSecret 项，
   * 本机值已与快照逐字节相同的 ref 生成 Skip（info）——写回是 no-op，不该再让用户确认。
   * 执行阶段由 credentials adapter 经 ImportContext.decryptedCredentials（仅内存）
   * 调用 credentials.set(ref, value) 写回本机 —— 与手动补录走同一条已验证路径。
   *
   * 判定与导入路径同规则（**值的有无优先于本机状态**），并多做一步「值是否已经相同」：
   *  - 有值 + 本机不同 / 本机没有 → MissingSecret（确认后写回）。**不因本机已配置而跳过**：
   *    快照显式带了值（用户勾了「导出密钥」），跳过就等于「密钥没同步过来」；
   *    要逐项放过用确认列表的批量按钮（sync-view 的 isBulkDecidable）。
   *  - 有值 + 本机逐字节相同 → Skip（info）。这是对上一轮「有值一律 MissingSecret」的**收窄**
   *    （真机反馈：本机 refs 一条不缺，列表却全标「缺密钥」+ 黄色警告）：只有真的会改动本机的
   *    ref 才需要人工确认。
   *  - 本机凭据文件读不到 → 无法比较 → 保守按 MissingSecret 处理，绝不静默跳过。
   *  - 「只有 ref 名、没有值」的情形由 createImportPlan → buildCredentialPlanItems 处理
   *    （那里才做本机已配置 → Skip 的判定）。
   *  - 同 id 已是 **Skip**（上面那条规则在「无值」时先判成了 Skip）→ 值不同时**升级**为
   *    MissingSecret：否则有值也会被 Skip 挡住，值永远不会写回；值相同时保持 Skip。
   */
  private async appendCredentialPlanItems(plan: ImportPlan, credentials: Map<string, string> | undefined): Promise<void> {
    if (credentials === undefined || credentials.size === 0) return;
    const local = await this.readLocalCredentials();
    const byId = new Map(plan.items.map((i) => [i.id, i] as const));
    for (const [ref, value] of credentials) {
      const id = `secret:${ref}`;
      const prev = byId.get(id);
      if (local?.get(ref) === value) {
        const description = this.msg('sync.credentialsItemSame', { ref });
        if (prev === undefined) {
          const same: PlanItem = {
            id, kind: 'Skip', adapter: 'credentialsStatus', description,
            severity: 'info', target: { adapter: 'credentialsStatus', ref },
          };
          plan.items.push(same);
          byId.set(id, same);
        } else if (prev.kind === 'Skip' || prev.kind === 'MissingSecret') {
          prev.kind = 'Skip';
          prev.severity = 'info';
          prev.description = description;
        }
        continue;
      }
      if (prev !== undefined) {
        if (prev.kind !== 'Skip') continue; // 已有可执行项 → 不重复
        prev.kind = 'MissingSecret';
        prev.severity = 'warning';
        prev.description = this.msg('sync.credentialsItemDesc', { ref });
        continue;
      }
      const item: PlanItem = {
        id,
        kind: 'MissingSecret',
        adapter: 'credentialsStatus',
        description: this.msg('sync.credentialsItemDesc', { ref }),
        severity: 'warning',
        target: { adapter: 'credentialsStatus', ref },
      };
      plan.items.push(item);
      byId.set(id, item);
    }
    // missingSecrets 与 items 必须同源：否则「随快照恢复的凭据」不进补录统计/结果报告
    plan.missingSecrets = plan.items
      .filter((i) => i.kind === 'MissingSecret')
      .map((i) => ({ ref: i.id.replace(/^secret:/, ''), required: true }));
  }

  /**
   * 读本机 `$DSH_HOME/.credentials.yaml` → `Map<ref, value>`，**只用于**「值是否已经相同」比对。
   * 与 push 侧 buildCredentialsPayload 读同一个文件、同一解析口径（credentialsMapFromYaml）；
   * 不新增任何能力，也不回读凭据值到 UI。
   * 读不到 / 解析失败 → undefined = **无法比较**：调用方必须按「未知」保守处理（照旧要求确认），
   * 绝不因为读失败就静默跳过写回。
   * 安全：值只在进程内存里比较 —— 不落盘、不进日志/报告/响应体。
   */
  private async readLocalCredentials(): Promise<Map<string, string> | undefined> {
    try {
      const file = path.join(this.ctx.homeDir, '.credentials.yaml');
      const raw = Buffer.from(await this.ctx.fs.readFile(file)).toString('utf8');
      return credentialsMapFromYaml(raw);
    } catch {
      return undefined;
    }
  }

  /**
   * sessions 分区的导出选项（opt-in 分区）：显式勾选清单优先于「最新 N 个」。
   *
   * 为什么 include 非空时必须让 limit 失效：adapter 里 restrictUnits（最新 N 个）先于
   * includeItems 白名单执行 —— 两者叠加得到的是交集，用户要的是他勾中的那些。
   * 返回值直接展开进 adapter.export 的 options，其余分区恒返回 {}（零变化）。
   */
  private sessionExportOptions(
    sectionId: SectionId,
    sessions: { limit?: number; include?: string[] } | undefined,
  ): { sessions?: { limit?: number }; includeItems?: Partial<Record<SectionId, string[]>> } {
    if (sectionId !== 'sessions' || sessions === undefined) return {};
    const include = (sessions.include ?? []).filter((id) => typeof id === 'string' && id !== '');
    if (include.length > 0) return { sessions: {}, includeItems: { sessions: include } };
    return { sessions: sessions.limit === undefined ? {} : { limit: sessions.limit } };
  }

  /**
   * push：导出 portable 分区 → 组装快照 → 本地散文件副本 → transport.upload → 更新 sync-state。
   * 单项分区导出失败只告警跳过（§34.17），全部失败才整体失败。
   * opts.sections：指定仅同步这些分区（高级/自定义模式）；缺省 = 全部 portable 推荐分区。
   * opts.encrypt/password/includeSecrets：加密快照（含可选密钥导出）。
   * 安全不变量：includeSecrets ⇒ encrypt（密钥绝不明文进入同步通道）；密码仅内存。
   *
   * 前置：**远端已被其它设备推进时默认拒绝写入**（见 assertRemoteNotAdvanced）—— 这一条在导出
   * 之前执行，因为「本机这一版要不要推」是被远端状态决定的，先别做无谓的导出（plugins 还会 npm pack）。
   */
  async push(opts: SyncPushOptions = {}): Promise<SyncPushReport> {
    const warnings: string[] = [];
    const includeSecrets = opts.includeSecrets ?? false;
    const encrypt = opts.encrypt ?? false;
    // 安全不变量：导出密钥必须加密；加密必须给密码（密码绝不落盘）
    if (includeSecrets && !encrypt) {
      throw new Error(this.msg('sync.includeSecretsRequiresEncryption'));
    }
    if (encrypt && (opts.password === undefined || opts.password === '')) {
      throw new Error(this.msg('sync.encryptRequiresPassword'));
    }
    // 远端推进检测：不一致 = 远端被别的设备推过（或本机基线已被裁剪）。
    // 此时推上去会覆盖/架空别人的改动 → 直接返回冲突（**不抛错**、不 upload、不记基线、不改 sync-state）。
    if (opts.force !== true) {
      const check = await this.remoteAdvancedCheck();
      if (check.reason !== undefined) {
        // 读不到远端列表 ⇒ 无法判定。按原样继续（上传本身会再暴露通道问题），但如实说明。
        warnings.push(this.msg('sync.pushAdvanceCheckFailed', { reason: check.reason }));
      } else if (check.blocked) {
        return {
          ok: false,
          snapshotId: '',
          sections: [],
          warnings,
          conflict: true,
          message: this.msg('sync.pushRemoteAdvanced', { remote: check.latest, base: check.base }),
        };
      }
    }
    const plainSections: Partial<Record<SectionId, SectionData>> = {};
    const targets = this.pushTargets(opts.sections, warnings);
    for (const adapter of targets) {
      let section: ExportSection;
      try {
        section = await adapter.export(this.ctx, {
          includeSecrets,
          // 可选分区（sessions）：显式勾选清单 > 「最新 N 个」上限（其余分区零变化）
          ...this.sessionExportOptions(adapter.id, opts.sessions),
        });
      } catch (err) {
        warnings.push(this.msg('sync.sectionFailed', { adapter: adapter.id, reason: err instanceof Error ? err.message : String(err) }));
        continue;
      }
      warnings.push(...section.warnings);
      // includeSecrets=true：凭据值保留（随后整体加密）；否则过 SecretScanner 剥离（默认安全）
      const data = isFileSection(adapter.id) || includeSecrets
        ? section.data
        : this.scanner.scanAndRedact(section.data).sanitized;
      plainSections[adapter.id] = data as SectionData;
    }

    if (Object.keys(plainSections).length === 0) {
      return { ok: false, snapshotId: '', sections: [], warnings, message: this.msg('sync.noPortableSections') };
    }
    this.assertNoForbiddenSections(plainSections as Record<string, unknown>);

    // 加密：整个明文 sections 载荷加密为密文（manifest 只存非秘密参数）
    let sections: SyncSnapshot['sections'] = plainSections;
    const encrypted = encrypt;
    if (encrypt) {
      sections = await encryptSectionsPayload(plainSections, opts.password!);
    }
    // issue #38：勾选「导出密钥」→ 读取 .credentials.yaml 并加密为独立凭据载荷随快照上行。
    // includeSecrets ⇒ encrypt（上方已强制），故凭据载荷永远是密文；读不到/为空则只告警。
    const credentials = includeSecrets
      ? await this.buildCredentialsPayload(opts.password!, warnings)
      : undefined;

    // P1-5：会话删除墓碑（上一次推过、本机已不存在的会话 = 用户删掉了）
    const bookkeeping = await this.computeSessionBookkeeping(targets, plainSections);
    if (bookkeeping.deletedNow.length > 0) {
      warnings.push(this.msg('sync.sessionDeletionsRecorded', { count: String(bookkeeping.deletedNow.length) }));
    }

    // ⑥ 设备身份（cloud-sync 借鉴项 ⑥）：首次生成后持久化在 sync-state.json（已有则纯读），
    // 随 manifest 上行 → 别的设备在历史列表里能看到「这份快照是哪台机器推的」。
    const device = await resolveDeviceIdentity(this.stateDir, os.hostname(), this.fsx, this.msg);

    const nowIso = this.now().toISOString();
    const id = opts.snapshotId ?? this.snapshotIdFn();
    const snapshot: SyncSnapshot = {
      id,
      createdAt: nowIso,
      manifest: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        dshVersion: this.ctx.dshVersion,
        platform: this.ctx.platform as Platform,
        sectionIds: Object.keys(plainSections) as SectionId[],
        containsSecrets: includeSecrets,
        // 记录触发通道（git/webdav），供同步历史展示「由哪个通道触发」
        transport: this.transport.type,
        // issue #45：记录导出机 DSH home → 跨机拉取时由 Importer 自动重定基
        // （工作区 path + 会话首帧 cwd 一并改写；缺字段的旧快照不猜，行为不变）
        ...(this.ctx.homeDir !== '' ? { sourceHome: this.ctx.homeDir } : {}),
        // P1-5：累积墓碑随每份快照传播（拉取侧据此不让旧快照复活已删除的对话）
        ...(bookkeeping.tombstones.length > 0 ? { deletedSessions: bookkeeping.tombstones } : {}),
        // ⑥：产生该快照的设备身份（历史列表展示「哪台机器推的」；旧读侧忽略未知字段）
        deviceId: device.id,
        deviceName: device.name,
        ...(encrypted ? { encrypted: true } : {}),
      },
      sections,
      ...(credentials !== undefined ? { credentials } : {}),
    };

    // ① 本地散文件快照副本（审计；复用 t2 layout，不写 ZIP）。
    //    加密快照不写本地散文件副本（磁盘不落任何密文/明文载荷；远端已存密文）。
    if (this.localSnapshotsDir !== undefined && !encrypted) {
      await writeSnapshotToDir(snapshot, joinFs(this.localSnapshotsDir, id), this.fsx);
    }
    // ② 上传远端（传输通道负责散文件落盘 + 提交推送）
    await this.transport.upload(snapshot);
    // ②·1 裁剪远端快照：保留最新 MAX_REMOTE_SNAPSHOTS 个（含刚 push 的）。
    //      删除失败只告警（进 warnings），不上抛 —— 不阻断 push 主流程。
    //      放在 upload 之后（保证新快照已推送成功）与 recordBaseline 之前（先管好远端再记基线）。
    await this.pruneRemoteSnapshots(id, warnings);
    // ③ 记录祖先基线：写 sync-state（lastSnapshotId + 每分区 hash/updatedAt + lastSyncAt + transport）+ 裁剪。
    //    基线 hash 用明文（hasLocalChanges 与本地明文可比）；加密快照不写明文祖先副本（密钥不落盘）。
    await this.recordBaseline(id, plainSections, nowIso, {
      writeAncestor: !encrypted,
      // 只有本轮真的跟踪了 sessions 才覆盖这两个字段（见 computeSessionBookkeeping）
      ...(bookkeeping.tracked
        ? { sessionUnits: bookkeeping.sessionUnits, deletedSessions: bookkeeping.tombstones }
        : {}),
    });

    return { ok: true, snapshotId: id, sections: Object.keys(plainSections) as SectionId[], warnings };
  }

  /**
   * P0-②：push 前只读预览「将推送什么」—— 零写入、零远端变更：
   *  - 导出目标 portable 分区（与 push 同口径：sections 过滤 + secret 剥离）；
   *  - 逐分区相对上次基线（sync-state.sections hash）的 changed 标记；
   *  - 远端现有快照数（list 只读；首次推送 = 0）。
   * 加密快照（encrypt）时不再比较基线（密文不可比），sections 只带计数。
   * 任何失败都不写任何内容；预览只是 push 的「确认前说明书」。
   */
  async previewPush(opts: SyncPushOptions = {}): Promise<SyncPushPreview> {
    const warnings: string[] = [];
    const includeSecrets = opts.includeSecrets ?? false;
    const encrypted = opts.encrypt ?? false;
    if (includeSecrets && !encrypted) {
      throw new Error(this.msg('sync.includeSecretsRequiresEncryption'));
    }
    // issue #38：只读探测「本次是否真的会带上凭据」（不解密、不返回值，只看有没有可用凭据）
    let credentialsIncluded = false;
    if (includeSecrets) {
      try {
        const raw = Buffer.from(
          await this.ctx.fs.readFile(path.join(this.ctx.homeDir, '.credentials.yaml')),
        ).toString('utf8');
        credentialsIncluded = credentialsMapFromYaml(raw).size > 0;
      } catch {
        credentialsIncluded = false; // 读不到 = 不会带凭据；预览如实显示 false
      }
    }
    const targets = this.pushTargets(opts.sections, warnings);
    const plainSections: Partial<Record<SectionId, SectionData>> = {};
    const counts: Partial<Record<SectionId, number>> = {};
    /** issue #91：本趟只读预览省掉了本地源打包 ⇒ 与基线不可比的分区（不可断言「无变化」） */
    const unpackedSections = new Set<SectionId>();
    for (const adapter of targets) {
      const exportOptions = {
        includeSecrets,
        // 与 push 同口径：显式勾选清单 > 「最新 N 个」上限
        ...this.sessionExportOptions(adapter.id, opts.sessions),
      };
      let section: ExportSection;
      try {
        // issue #91：**非文件类**分区优先走 adapter.preview()。只读预览必须零进程副作用，而
        // plugins 的 export() 会对每个 `link:`/`file:` 插件真的跑一次 `npm pack`
        // （真机 2 GB 本地源插件 = 297 s；这段时间全局写锁被该请求占满 ⇒ 界面上所有写操作静默 423）。
        // 为什么文件类分区**不能**走 preview()：其预览产物是「无内容」形态（条目 data 为空、
        // contentHash 为空串），既不能与基线 hash 比对，也不能进 assertNoForbiddenSections
        // —— 那会让预览谎报「每个文件分区都变了」。
        const summary = !isFileSection(adapter.id) && adapter.preview !== undefined
          ? await adapter.preview(this.ctx, exportOptions)
          : undefined;
        section = summary?.section ?? await adapter.export(this.ctx, exportOptions);
        if (summary !== undefined && previewCaliberDiffersFromExport(adapter.id, section.data as SectionData)) {
          unpackedSections.add(adapter.id);
        }
      } catch (err) {
        warnings.push(this.msg('sync.sectionFailed', { adapter: adapter.id, reason: err instanceof Error ? err.message : String(err) }));
        continue;
      }
      const data = isFileSection(adapter.id) || includeSecrets
        ? section.data
        : this.scanner.scanAndRedact(section.data).sanitized;
      plainSections[adapter.id] = data as SectionData;
      counts[adapter.id] = section.counts ? Object.values(section.counts).reduce((a, b) => a + b, 0) : 0;
    }
    if (Object.keys(plainSections).length === 0) {
      return { ok: false, sections: [], remoteSnapshotCount: 0, encrypted, credentialsIncluded, message: this.msg('sync.noPortableSections') };
    }
    this.assertNoForbiddenSections(plainSections as Record<string, unknown>);

    // 基线对比（非加密）：sync-state.sections 存每分区 hash；缺基线分区 → 视为新增
    let baselineHashes: Record<string, string> = {};
    if (!encrypted) {
      try {
        const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
        // 基线条目是 SyncSectionState（{hash, updatedAt}），**不是**裸 hash 字符串。
        // 这里曾把整个对象 as Record<string,string> 直接比对 ⇒ 对象 !== 字符串 恒真
        // ⇒ 预览对**每一个**分区都报「有变化」，「N 个有变化」这句永远是「全都有变化」。
        for (const [sid, rec] of Object.entries(state.sections)) {
          if (rec !== undefined && typeof rec.hash === 'string') baselineHashes[sid] = rec.hash;
        }
      } catch {
        baselineHashes = {};
      }
    }
    if (unpackedSections.size > 0) {
      // 如实说明：本次预览没有为本地源插件执行 npm pack，故这些分区的基线比对不可得
      warnings.push(this.msg('sync.pushPreviewUnpackedLocalSources', { sections: [...unpackedSections].join(', ') }));
    }
    const sections: SyncPushPreviewSection[] = Object.keys(plainSections).map((sid) => {
      const id = sid as SectionId;
      const changed = encrypted
        // issue #91：只读预览省掉了本地源打包 ⇒ 产物与基线不同口径，**绝不**据此断言「无变化」
        || unpackedSections.has(id)
        || baselineHashes[id] === undefined
        || baselineHashes[id] !== hashSection(plainSections[id] as SectionData);
      return { section: id, count: counts[id] ?? 0, changed };
    });

    let remoteSnapshotCount = 0;
    try {
      const metas = await this.transport.list();
      remoteSnapshotCount = metas.length;
    } catch {
      // list 失败只影响展示（首次推送提示），不阻断预览
    }
    return { ok: true, sections, remoteSnapshotCount, encrypted, credentialsIncluded, message: warnings.length > 0 ? warnings.join('; ') : undefined };
  }

  /**
   * P1-5：会话删除墓碑簿记（只在**本次真的推送 sessions** 时才做，避免无谓的全树扫描）。
   *
   * `tracked=false` 的三种情形一律**不动既有记录**：没推 sessions / 适配器不支持全量枚举 /
   * 本机枚举失败或为空。用「读不到」覆盖成「全删了」会一次性标错几百条墓碑，绝不猜。
   */
  private async computeSessionBookkeeping(
    targets: readonly ConfigAdapter[],
    plainSections: Partial<Record<SectionId, SectionData>>,
  ): Promise<{ tracked: boolean; sessionUnits: string[]; tombstones: string[]; deletedNow: string[] }> {
    const sessions = targets.find((a) => a.id === 'sessions');
    if (sessions === undefined || sessions.listAllUnitIds === undefined) {
      return { tracked: false, sessionUnits: [], tombstones: [], deletedNow: [] };
    }
    let localUnits: string[];
    try {
      localUnits = await sessions.listAllUnitIds(this.ctx);
    } catch {
      return { tracked: false, sessionUnits: [], tombstones: [], deletedNow: [] };
    }
    if (localUnits.length === 0) {
      return { tracked: false, sessionUnits: [], tombstones: [], deletedNow: [] };
    }
    const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
    const { tombstones, deletedNow } = nextSessionTombstones({
      previousUnits: state.sessionUnits ?? [],
      localUnits,
      previousTombstones: state.deletedSessions ?? [],
    });
    return {
      tracked: true,
      sessionUnits: sessionUnitIdsOfSection(plainSections['sessions']),
      tombstones,
      deletedNow,
    };
  }

  /**
   * P1-5：按远端墓碑剔除**将要导入**的会话（旧快照不得复活已删除的对话）。
   * 只动载荷，不动本机已有数据 —— 墓碑不代用户删除本机文件（那是不可回滚的用户动作）。
   * @returns 被剔除的会话单元 id（调用方据此出可见报告，绝不静默）
   */
  private stripTombstonedSessions(snapshot: SyncSnapshot): string[] {
    const tombstones = snapshot.manifest.deletedSessions ?? [];
    if (tombstones.length === 0 || isEncryptedSections(snapshot.sections)) return [];
    const plain = snapshot.sections as Partial<Record<SectionId, SectionData>>;
    const stripped = stripTombstonedUnits(plain['sessions'], tombstones);
    if (stripped.removed.length === 0) return [];
    plain['sessions'] = stripped.section as SectionData;
    return stripped.removed;
  }

  /**
   * 裁剪远端快照：调用 transport.list() 获取全部快照（按 createdAt 升序），
   * 按 retentionPolicyProvider() 给出的 GFS 策略（最近 N / 每月一份 / 每年一份）
   * 算出待清理的 id，逐个调用 transport.delete()。
   *
   * 与改造前的关系：缺省策略（keepLast=10，无分层）走 core 的 selectPruneCandidates 快速路径
   * → 与旧的「保留最新 10 个」**逐字等价**；用户启用分层后，远端保留不再绑死在
   * 「推了几次配置」上（早先同步的会话不会被后续 push 冲掉）。
   *
   * 两条硬保证：
   *  - **刚 push 的 pushedId 恒保留**（策略三层全关时也不删它，否则等于推完立刻删）；
   *  - 策略提供者抛错 → 回退缺省策略（保守多留）。
   *
   * 失败语义：list/delete 失败均只 push 进 warnings，不上抛 —— 裁剪是「尽力而为」的后台整理，
   * 绝不影响 push 主流程的成功与否（§34.17 分区级告警同款语义）。
   */
  private async pruneRemoteSnapshots(pushedId: string, warnings: string[]): Promise<void> {
    let metas: SyncSnapshotMeta[];
    try {
      metas = await this.transport.list();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(this.msg('sync.pruneListFailed', { reason }));
      return;
    }
    const policy = await this.resolveRetentionPolicy();
    // selectPruneCandidates 作为缺省策略的快速路径 → 与改造前逐字等价（见 retention-policy.ts）
    const doomed = selectPruneCandidatesByPolicy(
      metas.map((m) => ({ id: m.id, createdAt: m.createdAt })),
      policy,
      selectPruneCandidates,
    );
    // 刚 push 的快照永不进删除集（防御性：策略三层全关时也保住它）
    const keep = new Set<string>([pushedId]);
    for (const m of metas) {
      if (doomed.includes(m.id) && !keep.has(m.id)) {
        try {
          await this.transport.delete(m.id);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          warnings.push(this.msg('sync.pruneDeleteFailed', { id: m.id, reason }));
        }
      }
    }
  }

  /** 读取远端保留策略；提供者缺失/抛错 → 缺省策略（保守多留，绝不因读取失败误删）。 */
  private async resolveRetentionPolicy(): Promise<RetentionPolicy> {
    try {
      return await this.retentionPolicyProvider();
    } catch {
      return DEFAULT_RETENTION_POLICY;
    }
  }

  /**
   * push 前置：远端是否已被别的设备推进（防「推上去把别人的改动架空」）。
   *
   * 判据与 hasNewRemoteSnapshot() 同源但方向相反：
   *  - 首次同步（lastSnapshotId === ''）→ **不拦**（本机没有基线可丢，第一次推送就是建立基线）；
   *  - 远端为空 → 不拦（没有可比对的快照）；
   *  - 其余：远端最新快照 id !== lastSnapshotId ⇒ 远端被推进（或本机基线已被裁剪）→ 拦。
   *    两种情况都**无法安全断言「远端没变」**，保守拒绝并给出 force 出口。
   *  - list() 抛错 → 返回 reason（调用方按原样继续并告警），绝不把「读不到」当成「没变」。
   */
  private async remoteAdvancedCheck(): Promise<{ blocked: boolean; base: string; latest: string; reason?: string }> {
    const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
    const base = state.lastSnapshotId;
    if (base === '') return { blocked: false, base, latest: '' };
    let metas: SyncSnapshotMeta[];
    try {
      metas = await this.transport.list();
    } catch (err) {
      return { blocked: false, base, latest: '', reason: err instanceof Error ? err.message : String(err) };
    }
    if (metas.length === 0) return { blocked: false, base, latest: '' };
    const latest = metas[metas.length - 1]!.id; // list 按 createdAt 升序 → 最新在末
    return { blocked: latest !== base, base, latest };
  }

  /**
   * pull：拉取远端最新（或指定）快照 → 过滤 portable 分区 → 转临时标准 ZIP →
   * 复用 Importer 预览流程（analyzeImport/createImportPlan）产出差异报告。
   * 绝不直接写配置、绝不执行导入；执行由上层按用户确认后走 Importer.executeImportPlan。
   */
  async pull(opts: SyncPullOptions = {}): Promise<SyncPullReport> {
    if (!this.importer) {
      throw new Error(this.msg('sync.missingImporter'));
    }
    const metas = await this.transport.list();
    if (metas.length === 0) {
      return { ok: true, snapshotId: '', changes: [], needsReview: false, message: this.msg('sync.remoteEmpty') };
    }
    const targetId = opts.snapshotId ?? metas[metas.length - 1]!.id; // list 按 createdAt 升序 → 最新
    const snapshot = await this.transport.download(targetId);
    // 加密快照 → 用密码解密回明文（无密码明确报错）；普通快照 → containsSecrets 拒绝
    await this.prepareSnapshot(snapshot, opts.password);
    // P1-5：按远端墓碑剔除已删除的会话（旧快照不复活）
    const tombstoned = this.stripTombstonedSessions(snapshot);
    // issue #38：快照携带凭据载荷 → 解密出 ref→值（仅内存），供计划项与后续 apply 使用
    const credentials = await this.decryptSnapshotCredentials(snapshot, opts.password);

    const portableIds = this.pullSectionIds();
    const zipPath = await this.snapshotToZip(snapshot, portableIds);
    try {
      const analysis = await this.importer.analyzeImport(zipPath);
      const plan = await this.importer.createImportPlan(zipPath, {
        strategy: opts.strategy ?? 'merge',
        resolutions: {},
        // issue #45：自动重定基（导出机 home ≠ 本机）由 analyzer 依快照 manifest.sourceHome 生成，
        // 排在用户映射之前；同步链路此前恒传 [] → 跨机拉取的会话 cwd/工作区 path 不重定基。
        pathMappings: opts.pathMappings ?? [],
      });
      // 凭据迁移项（ref 名进计划/报告，值绝不进）
      await this.appendCredentialPlanItems(plan, credentials);
      const changes: PullChange[] = plan.items.map((i) => ({
        id: i.id,
        adapter: i.adapter,
        kind: i.kind,
        description: i.description,
        severity: i.severity,
      }));
      const needsReview =
        plan.items.some((i) =>
          i.kind === 'Conflict' || i.kind === 'MissingSecret' || i.kind === 'MissingDependency'
          || i.kind === 'Error')
        || analysis.pathIssues.length > 0;
      const baseMessage = changes.length === 0
        ? this.msg('sync.unchanged')
        : this.msg('sync.changesSummary', { compatibility: analysis.compatibility, count: String(changes.length) });
      // P1-5：墓碑剔除必须可见（绝不静默少带）
      const tombstoneNote = tombstoned.length === 0
        ? ''
        : ' · ' + this.msg('sync.sessionsTombstoned', { count: String(tombstoned.length) });
      // 分析期告警（会话格式不可读、包内会话缺工作区…）必须随差异报告一起可见：
      // 这条链路只回一个 message 字符串，没有独立 warnings 通道 —— 不并进来就是静默。
      const analysisNote = analysis.warnings.length === 0 ? '' : ' · ' + analysis.warnings.join(' · ');
      const message = baseMessage + tombstoneNote + analysisNote;
      return { ok: analysis.valid, snapshotId: targetId, changes, needsReview, message };
    } finally {
      await fs.rm(path.dirname(zipPath), { recursive: true, force: true });
    }
  }

  /**
   * 把远端快照**落地成本机 ZIP**（供「拉取即导入」）。
   *
   * 与 `pull()` 的区别：pull 只做只读差异预览并在 finally 里删掉临时 ZIP；
   * 本方法把 ZIP 留在**调用方指定的目录**（由调用方负责清理），返回它的绝对路径。
   *
   * 三条边界：
   *  - **只读远端**：不改远端、不写 sync-state（同步基线只在 apply 之后才动）；
   *  - **加密快照仍要密码**：`prepareSnapshot` 会在缺密码时明确报错，绝不静默产出空包；
   *  - **墓碑剔除同样生效**：与 pull 一致，已删除的会话不随包复活。
   */
  async downloadSnapshot(opts: { snapshotId?: string; password?: string; dir: string; name?: string }): Promise<{ path: string; snapshotId: string; tombstonedSessions?: number }> {
    const metas = await this.transport.list()
    if (metas.length === 0) throw new Error(this.msg('sync.remoteEmpty'))
    const targetId = opts.snapshotId ?? metas[metas.length - 1]!.id
    const snapshot = await this.transport.download(targetId)
    await this.prepareSnapshot(snapshot, opts.password)
    // audit-sync sync-F6：剔除结果必须**可见**（与 pull/preview 同一口径）。
    // 此前返回值丢弃了它 —— 产物里少了哪些会话，调用方与用户都无从得知（绝不静默少带）。
    const tombstonedSessions = this.stripTombstonedSessions(snapshot).length
    const portableIds = this.pullSectionIds()
    const zipPath = await this.snapshotToZip(snapshot, portableIds)
    // snapshotToZip 产出在临时目录；搬到调用方指定目录（同盘 rename，跨盘退化为复制）
    // name 由调用方给（产物库「下载」需要一个可辨识的文件名，而不是固定的 snapshot.zip）。
    // **只接受 basename 形态**：校验在宿主路由（isValidExportFileName 白名单），引擎侧只做拼接。
    const dest = path.join(opts.dir, opts.name ?? path.basename(zipPath))
    await fs.mkdir(opts.dir, { recursive: true })
    try {
      await fs.rename(zipPath, dest)
    } catch {
      await fs.copyFile(zipPath, dest)
      await fs.rm(path.dirname(zipPath), { recursive: true, force: true }).catch(() => undefined)
    }
    return { path: dest, snapshotId: targetId, ...(tombstonedSessions > 0 ? { tombstonedSessions } : {}) }
  }

  /**
   * 删除**远端**的一份快照（产物库「远端快照 → 删除」，不可恢复）。
   *
   * 三条边界：
   *  - **只动远端**：不写 sync-state、不碰本机配置 —— 本机的 `lastSnapshotId` 只是「上次共同祖先」
   *    的记录，远端少一份不会让本机配置变坏；若删掉的正是它，下一次 `hasNewRemoteSnapshot()`
   *    会把远端最新快照当作新的可拉项（远端为空时它返回 false，不会拿空列表去取快照）；
   *  - **与保留策略裁剪共用同一条 `transport.delete`**（两条通道的删除语义只有一份实现），
   *    区别只在「谁点名」：这里是用户显式指定的 id，pruneRemoteSnapshots 由 RetentionPolicy 挑；
   *  - **不存在视为成功**（SyncTransport 契约），所以重复点删除 / 已被裁剪掉都不会报错。
   */
  async deleteSnapshot(id: string): Promise<void> {
    await this.transport.delete(id)
  }

  /** 列出远端已有快照（按 createdAt 升序）—— 供「选择历史快照」下拉。 */
  async listSnapshots(): Promise<SyncSnapshotMeta[]> {
    return this.transport.list();
  }

  /**
   * 列表时**读不出来/解析失败**的远端快照（issue #59）：通道实现可选暴露该诊断。
   *
   * 为什么要有：列表把坏快照跳过是必要防御（不能因为一条坏数据让整体失败），但**静默跳过**
   * 会让「push 报成功 + 远端列表为空」变成用户无从自查的矛盾状态。路由层把它随列表一起回传。
   */
  unreadableSnapshots(): readonly { file: string; reason: string }[] {
    const fn = (this.transport as unknown as { unreadableSnapshots?: readonly { file: string; reason: string }[] }).unreadableSnapshots;
    return Array.isArray(fn) ? fn : [];
  }

  /**
   * 远端是否出现比本地共同祖先更新的快照（§3.2「检测到远端新快照」）。
   * - 远端为空 → false（无物可拉）；
   * - 远端指针未知（lastSnapshotId=''：从未同步 / 远端 id 未知）且远端非空 → true（首次可拉）；
   * - 否则比较远端最新快照 id 与 lastSnapshotId。
   * 只读远端列表（transport.list），不做下载/合并。
   *
   * 前提：lastSnapshotId 必须是**远端**快照 id（P0-7）。旧实现把本地生成的快照 id 也写进去，
   * 于是合并/应用之后这里恒为 true → 每轮白跑 list + download + merge。
   *
   * `listed` 可选：调用方本轮已经 list 过（如自动同步先查加密快照）时直接传进来，
   * 避免同一个回合对远端做两次 list —— 每条通道的 list 都是一次真实网络往返
   * （git 通道 = `pull --ff-only`，webdav 通道 = PROPFIND/GET）。
   */
  async hasNewRemoteSnapshot(listed?: readonly SyncSnapshotMeta[]): Promise<boolean> {
    const metas = listed ?? await this.transport.list();
    if (metas.length === 0) return false;
    const latestId = metas[metas.length - 1]!.id; // list 按 createdAt 升序 → 最新在末
    const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
    if (state.lastSnapshotId === '') return true;
    return latestId !== state.lastSnapshotId;
  }

  /**
   * 连通性探针（cloud-sync 借鉴项 ②）：把当前通道的**只读**自检透出给宿主路由。
   *
   * 通道没实现 probe（如 git 通道按 fast-forward 语义自证）时**如实报不支持**，
   * 绝不返回「连接正常」—— 谎报成功比不支持更糟。
   */
  async probe(): Promise<SyncProbeResult> {
    const probe = this.transport.probe;
    if (typeof probe !== 'function') {
      // 带稳定错误码：路由/UI 据此把它当**能力边界**（中性提示）而不是「操作失败」
      throw new SyncTransportError(this.msg('sync.probeUnsupported'), { kind: 'client', retryable: false, code: PROBE_UNSUPPORTED_CODE });
    }
    return await probe.call(this.transport);
  }

  /**
   * 本地 portable 配置当前内容与上次基线（sync-state.sections hash）相比是否有变化（§3.1 上传「看变化」）。
   * - 从未同步（sync-state.sections 为空）→ true；
   * - 任一 portable 分区当前导出 hash ≠ 基线 hash → true；
   * - 全部一致 → false（无本地改动，不上传）。
   * 只读本地导出 + sync-state，不写任何东西、不碰远端。
   */
  async hasLocalChanges(): Promise<boolean> {
    const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
    if (Object.keys(state.sections).length === 0) return true;
    for (const adapter of this.portableAdapters()) {
      let section: ExportSection;
      try {
        section = await adapter.export(this.ctx, { includeSecrets: false });
      } catch {
        continue; // 单项导出失败不影响判定（与 push 单项跳过语义一致）
      }
      const data = isFileSection(adapter.id) ? section.data : this.scanner.scanAndRedact(section.data).sanitized;
      const recorded = state.sections[adapter.id];
      if (recorded === undefined) return true; // 基线缺该分区 → 视为有变化
      if (recorded.hash !== hashSection(data as SectionData)) return true;
    }
    return false;
  }

  /**
   * 一键同步预览：拉取远端（最新或指定历史快照）→ 转临时 ZIP → Importer 分析出计划。
   * 与 pull 的区别：临时 ZIP **不清理**（由调用方 / 会话持有，供 apply-items 复用），
   * 并返回完整 plan/analysis/snapshotId 供会话登记。
   * 调用方负责在会话消费或取消后清理 zipPath 所在目录。
   */
  async preview(opts: SyncPullOptions = {}): Promise<SyncPreviewResult> {
    if (!this.importer) {
      throw new Error(this.msg('sync.missingImporter'));
    }
    const metas = await this.transport.list();
    if (metas.length === 0) {
      return { ok: false, zipPath: '', plan: null, analysis: null, snapshotId: '', message: this.msg('sync.remoteEmpty') };
    }
    const targetId = opts.snapshotId ?? metas[metas.length - 1]!.id;
    const snapshot = await this.transport.download(targetId);
    // 加密快照 → 用密码解密回明文（无密码明确报错）；普通快照 → containsSecrets 拒绝
    await this.prepareSnapshot(snapshot, opts.password);
    // P1-5：按远端墓碑剔除已删除的会话（旧快照不复活；一键同步复用本 plan）
    const tombstoned = this.stripTombstonedSessions(snapshot);
    // issue #38：凭据载荷解密（仅内存；由调用方登记进同步会话，apply-items 时写回本机）
    const credentials = await this.decryptSnapshotCredentials(snapshot, opts.password);
    const portableIds = this.pullSectionIds();
    const zipPath = await this.snapshotToZip(snapshot, portableIds);
    const analysis = await this.importer.analyzeImport(zipPath);
    const plan = await this.importer.createImportPlan(zipPath, {
      strategy: opts.strategy ?? 'merge',
      resolutions: {},
      // issue #45：自动重定基 + 用户映射（与 pull 同口径；一键同步的 apply-items 复用本 plan）
      pathMappings: opts.pathMappings ?? [],
    });
    await this.appendCredentialPlanItems(plan, credentials);
    return {
      ok: analysis.valid, zipPath, plan, analysis, snapshotId: targetId, credentials,
      message: tombstoned.length === 0
        ? undefined
        : this.msg('sync.sessionsTombstoned', { count: String(tombstoned.length) }),
    };
  }

  /**
   * 三方合并（不写本地配置、不执行导入）：local = 现场 export，remote = 下载的远端快照，
   * ancestor = 本地祖先副本；副本缺失 → 退化为两方合并（整分区 conflict 交用户裁决）。
   * 副作用只有进程内备忘（远端快照 id / sourceHome / 用户映射 / 祖先可用性 / plan / 三方输入），
   * 供紧随其后的 previewMerge / applyMergePlan / applyMergeResolutions 复用：同一次调用只下载一次远端。
   */
  async merge(opts: { snapshotId?: string; password?: string; pathMappings?: PathMapping[] } = {}): Promise<MergePlan> {
    const metas = await this.transport.list();
    if (metas.length === 0) {
      this.lastMergedRemoteSnapshotId = null;
      this.lastMergedRemoteSourceHome = '';
      this.lastMergedPathMappings = [];
      // 远端为空：清掉全部缓存（绝不把上一轮的输入留在内存里被后续调用误用）
      this.lastMergeHadAncestor = false;
      this.lastMergeInputs = null;
      return { sections: [] };
    }
    const targetId = opts.snapshotId ?? metas[metas.length - 1]!.id;
    const remote = await this.transport.download(targetId);
    // 加密快照 → 用密码解密；普通快照 containsSecrets=true → 拒绝（防御）
    await this.prepareSnapshot(remote, opts.password);
    // P1-5：按远端墓碑剔除已删除的会话（三方合并的 remote 侧同样不许复活）
    this.stripTombstonedSessions(remote);
    // 本次合并的远端基准（P0-7）：紧随其后的 applyMergePlan() 用它写基线远端指针
    this.lastMergedRemoteSnapshotId = targetId;
    // issue #45：把远端快照的 sourceHome 与用户映射一并备忘 —— applyMergePlan 重建临时 ZIP 时
    // 写进 manifest.sourceHome，Importer 才能对工作区 path / 会话首帧 cwd 做跨机重定基。
    this.lastMergedRemoteSourceHome = remote.manifest.sourceHome ?? '';
    this.lastMergedPathMappings = opts.pathMappings ?? [];
    // 共同祖先用本地祖先**副本目录名** = state.ancestorId（'' = 无本地祖先副本）。
    // 不能用 state.lastSnapshotId —— 那是远端快照 id；混用会让 merge 去 load 一个并不存在的目录
    // （加密快照 push 不落副本）→ 抛「快照目录缺少 manifest.json」→ 整轮自动同步 failed 且每轮复现。
    const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
    const ancestorId = state.ancestorId ?? '';
    let ancestor: SyncSnapshot | undefined;
    if (ancestorId !== '' && this.localSnapshotsDir !== undefined) {
      // 副本缺失/被裁剪/损坏 → undefined（两方合并），绝不上抛成整轮失败（P0-7）
      ancestor = await tryLoadAncestor(this.localSnapshotsDir, ancestorId, this.fsx);
    }
    // 本地当前：现场 export（含 secret 剥离），与 push 同口径
    const localSections: Partial<Record<SectionId, SectionData>> = {};
    const localIds = this.pullSectionIds();
    for (const adapter of this.adapters.filter((a) => localIds.has(a.id))) {
      let section: ExportSection;
      try {
        section = await adapter.export(this.ctx, { includeSecrets: false });
      } catch {
        continue;
      }
      const data = isFileSection(adapter.id) ? section.data : this.scanner.scanAndRedact(section.data).sanitized;
      localSections[adapter.id] = data as SectionData;
    }
    const portableIds = this.pullSectionIds();
    const remotePortable: Partial<Record<SectionId, SectionData>> = {};
    for (const [id, data] of Object.entries(remote.sections)) {
      if (portableIds.has(id as SectionId)) remotePortable[id as SectionId] = data as SectionData;
    }
    const ancestorPortable: Partial<Record<SectionId, SectionData>> = {};
    if (ancestor) {
      for (const [id, data] of Object.entries(ancestor.sections)) {
        if (portableIds.has(id as SectionId)) ancestorPortable[id as SectionId] = data as SectionData;
      }
    }
    const plan = mergeSections(localSections, remotePortable, ancestorPortable);
    // 结果**经返回值**交给调用方（previewMerge / applyMergeResolutions 都用这一份，不会二次下载）；
    // 这里只留两个进程内备忘：祖先可用性（预览要如实说明「为什么全是冲突」）与三方输入
    // （applyMergeResolutions 要把分区级裁决落回**整分区**数据）。
    this.lastMergeHadAncestor = ancestor !== undefined;
    this.lastMergeInputs = { local: localSections, remote: remotePortable, ancestor: ancestorPortable };
    return plan;
  }

  /**
   * 合并预览（只读、零写入）：把 merge() 的三方结果翻成界面可渲染的结构化视图。
   *
   * 与 merge() 的关系：**复用**同一次调用（同一实例上只下载一次远端快照、只 export 一次本地），
   * 不改远端、不写 sync-state、不落祖先副本、不动本机配置。
   *
   * 安全：每侧预览文本都先过 redact() 再截断到 2 KiB（敏感值绝不回传浏览器）；原始值对象
   * （对象 / 数组 / 字节数组）**绝不**上抛给调用方。
   */
  async previewMerge(opts: { snapshotId?: string; password?: string; pathMappings?: PathMapping[] } = {}): Promise<MergePreview> {
    const plan = await this.merge(opts);
    const summary = { auto: 0, review: 0, conflicts: 0, skipped: 0 };
    const snapshotId = this.lastMergedRemoteSnapshotId;
    if (snapshotId === null) {
      // merge() 已清掉全部缓存；这里如实报「远端无快照」（ok:false，而不是一个空成功）
      return { ok: false, snapshotId: '', hasAncestor: false, sections: [], summary, message: this.msg('sync.remoteEmpty') };
    }
    const split = classifyMergePlan(plan, { firstSync: false });
    summary.auto = split.autoApply.length;
    summary.review = split.review.length;
    summary.skipped = split.skipped.length;
    summary.conflicts = plan.sections.filter((s) => s.decision === 'conflict').length;
    return {
      ok: true,
      snapshotId,
      hasAncestor: this.lastMergeHadAncestor,
      sections: plan.sections.map(mergePreviewSectionView),
      summary,
    };
  }

  /**
   * 按用户裁决应用合并结果（**分区粒度**），并严守基线纪律。
   *
   * 与 applyMergePlan 的关系：把 resolutions 映射成 SyncApplyPlan 后走**同一条执行路径**
   * （applyMergePlan：兜底快照 + 失败整体回滚 + 成功才记基线）。本方法只额外负责两件事：
   *  1. 把 merge() 的分区级结论翻成「远端整分区 / 本机整分区 / 自动合并结果」的实际数据
   *     （键级冲突的 conflicts 只带键值，进不了导入计划，必须回到整分区语义）；
   *  2. 基线纪律 —— 只要还有未裁决分区，就**不推进远端基线指针**并记 pendingMerge
   *     （冲突下一轮重新出现）；全部裁决完才清空 pendingMerge 并推进基线。
   *
   * 裁决语义（与 MergeResolution 的文档一致）：
   *  - 未点名的分区按 merge() 的既有结论处理：可决断（useRemote / keepLocal / merge）→ 应用；
   *    'skip' → 跳过；'conflict' → 计入 pendingConflicts；
   *  - action='skip'（点名了但不裁决）：该分区若有内容可裁决 → 计入 pendingConflicts（**不算解决**，
   *    否则基线推进会让它下一轮不再被提出 = 静默丢改动）；本来就无变化的 'skip' 分区 → 跳过；
   *  - useMerged 而 merge() 没给 merged（典型：'conflict' 分区）→ 计入 pendingConflicts；
   *  - useRemote 而远端没有该分区（= 远端删了它）→ 导入计划表达不了删除 → 计入 pendingConflicts；
   *  - keepLocal 而本机没有该分区 → 保持现状（无写入）→ 跳过。
   */
  async applyMergeResolutions(
    resolutions: MergeResolution[],
    opts: {
      snapshotId?: string;
      password?: string;
      pathMappings?: PathMapping[];
      snapshotBinding?: TransactionSnapshotContext;
    } = {},
  ): Promise<ApplyMergeResolutionsReport> {
    if (!this.importer) {
      throw new Error(this.msg('sync.applyMergeResolutionsNoImporter'));
    }
    // 1) 先合并一次（一次下载）：plan / 三方输入留在实例缓存里，供本次裁决取整分区值
    const plan = await this.merge({ snapshotId: opts.snapshotId, password: opts.password, pathMappings: opts.pathMappings });
    const remoteSnapshotId = this.lastMergedRemoteSnapshotId;
    if (remoteSnapshotId === null) {
      return { ok: true, applied: [], restoreId: '', rolledBack: false, review: [], warnings: [], pendingConflicts: [] };
    }
    const inputs = this.lastMergeInputs ?? { local: {}, remote: {}, ancestor: {} };
    const byId = new Map<SectionId, MergeResolution>();
    for (const r of resolutions) byId.set(r.id, r);

    const autoApply: MergeSectionResult[] = [];
    const skipped: MergeSectionResult[] = [];
    const pendingConflicts: SectionId[] = [];
    for (const section of plan.sections) {
      const res = byId.get(section.id);
      if (res === undefined) {
        if (section.decision === 'skip') { skipped.push(section); continue; }
        if (section.decision === 'conflict' || section.merged === undefined) { pendingConflicts.push(section.id); continue; }
        autoApply.push(section);
        continue;
      }
      switch (res.action) {
        case 'skip': {
          if (section.decision === 'skip') skipped.push(section);
          else pendingConflicts.push(section.id);
          break;
        }
        case 'useMerged': {
          if (section.merged === undefined) { pendingConflicts.push(section.id); break; }
          autoApply.push({ ...section, decision: 'merge', merged: section.merged, conflicts: [] });
          break;
        }
        case 'useRemote': {
          const remoteData = inputs.remote[section.id];
          if (remoteData === undefined) { pendingConflicts.push(section.id); break; }
          autoApply.push({ id: section.id, decision: 'useRemote', merged: remoteData, conflicts: [] });
          break;
        }
        case 'keepLocal': {
          const localData = inputs.local[section.id];
          if (localData === undefined) { skipped.push(section); break; } // 本机本就没有 → 无写入
          autoApply.push({ id: section.id, decision: 'keepLocal', merged: localData, conflicts: [] });
          break;
        }
      }
    }

    const applyPlan: SyncApplyPlan = { autoApply, review: [], skipped };
    const hasPending = pendingConflicts.length > 0;
    const pendingMessage = this.msg('sync.mergePendingConflicts', {
      count: String(pendingConflicts.length),
      sections: pendingConflicts.join(', '),
    });
    const stateBefore = await loadSyncState(this.stateDir, this.fsx, this.msg);

    // 2) 无物可应用：只落基线纪律的状态（待裁决记录 / 清空 + 按需推进远端指针），
    //    不构造临时 ZIP、不碰本机配置、不动祖先副本。
    if (autoApply.length === 0) {
      await this.writeMergeBaseline(
        hasPending
          ? { pending: this.pendingMergeFor(stateBefore, remoteSnapshotId, pendingConflicts) }
          // 全部裁决完但无需写入任何分区（全部是本来就无变化的 'skip'）→ 基线可以推进到这一版
          : { advanceRemoteId: remoteSnapshotId },
      );
      return {
        ok: true, applied: [], restoreId: '', rolledBack: false, review: [],
        warnings: hasPending ? [pendingMessage] : [],
        pendingConflicts,
      };
    }

    // 3) 有物可应用 → 复用 applyMergePlan 的既有执行路径（兜底快照 + 失败整体回滚 + 成功才记基线）
    const report = await this.applyMergePlan(applyPlan, {
      ...(hasPending
        ? {
            // 待裁决：**不推进**远端指针（首同步时如实留空），并把祖先副本保持为共同基线 ——
            // 已裁决分区下一轮 local === remote → skip，既不会被重判成冲突，也不会被远端覆盖。
            remoteSnapshotId: stateBefore.lastSnapshotId,
            preserveAncestor: true,
            pendingMerge: this.pendingMergeFor(stateBefore, remoteSnapshotId, pendingConflicts),
          }
        : { pendingMerge: null }),
      ...(opts.snapshotBinding !== undefined ? { snapshotBinding: opts.snapshotBinding } : {}),
      ...(opts.pathMappings !== undefined ? { pathMappings: opts.pathMappings } : {}),
    });
    if (!report.ok) {
      // 失败已整体回滚：基线未动、本机配置没变 → 不写 pendingMerge（冲突下一轮照旧出现）
      return { ...report, pendingConflicts };
    }
    return {
      ...report,
      warnings: hasPending ? [...report.warnings, pendingMessage] : report.warnings,
      pendingConflicts,
    };
  }

  /** 组装 pendingMerge 记录：同一远端快照上的连续待裁决**保留首次时间**（界面据此讲「挂了多久」）。 */
  private pendingMergeFor(state: SyncState, remoteSnapshotId: string, sections: SectionId[]): PendingMerge {
    const since = state.pendingMerge !== undefined && state.pendingMerge.remoteSnapshotId === remoteSnapshotId
      ? state.pendingMerge.since
      : this.now().toISOString();
    return { remoteSnapshotId, sections, since };
  }

  /**
   * 基线纪律的**纯状态**写入（不写祖先副本、不碰远端）：仅在本机没有任何配置写入时使用。
   *
   * - pending 提供 → 写 pendingMerge；undefined → 清除该字段（「全部裁决完」）；
   * - advanceRemoteId 提供 → 把远端指针推进到该快照 id（缺省 = 保持不变）。
   *
   * 为什么不走 recordBaseline：那条路径会重建祖先副本并只带本次应用的分区 —— 在「没有应用任何分区」
   * 或「仍有未裁决冲突」时都会把共同基线改坏（下一轮所有分区都退化成「无祖先 → 冲突」）。
   */
  private async writeMergeBaseline(opts: { pending?: PendingMerge; advanceRemoteId?: string }): Promise<void> {
    const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
    if (opts.pending === undefined) delete state.pendingMerge;
    else state.pendingMerge = opts.pending;
    if (opts.advanceRemoteId !== undefined) {
      state.lastSnapshotId = opts.advanceRemoteId;
      state.lastSyncAt = this.now().toISOString();
    }
    await saveSyncState(this.stateDir, state, this.fsx);
  }

  /**
   * 重新导出**已应用**的分区（F-2，2026-10）：基线的唯一正确来源是「实际落地的本机内容」。
   *
   * 为什么不能用计划/远端的 merged 载荷：写回时 adapter 会自增本机侧字段（如
   * settings.namespaces[*].revision），而 merged 记录的是**远端快照里的值**；据此记基线会让
   * 下一轮 merge 同时判「本地改了」与「远端改了」→ both-modified 冲突 → 每轮重复冲突。
   *
   * 口径与 merge() 的本地侧导出一致：文件类分区直接取 data，其余过 SecretScanner 剥离。
   * 任一分区导出失败 → 返回 null（调用方**不推进基线**并明确告警）：绝不写半个基线。
   */
  private async exportAppliedSections(ids: readonly SectionId[]): Promise<Record<string, SectionData> | null> {
    const wanted = new Set<string>(ids);
    const out: Record<string, SectionData> = {};
    for (const adapter of this.adapters) {
      if (!wanted.has(adapter.id)) continue;
      try {
        const section = await adapter.export(this.ctx, { includeSecrets: false });
        out[adapter.id] = (isFileSection(adapter.id)
          ? section.data
          : this.scanner.scanAndRedact(section.data).sanitized) as SectionData;
      } catch {
        return null;
      }
    }
    return out;
  }

  /**
   * 记录祖先基线：写本地祖先副本 + 更新 sync-state（每分区 hash/updatedAt、lastSyncAt、transport、
   * 远端指针 lastSnapshotId、本地祖先目录名 ancestorId）+ 裁剪到 keep。
   *
   * **两个 id 语义严格分开（P0-7），不要再混用同一个字段**：
   * - `snapshotId`：本次基线的**本地**快照对象 id，同时是本地祖先副本的目录名（写入 `ancestorId`）；
   * - `opts.remoteSnapshotId`：该基线在**远端**对应的快照 id（写入 `lastSnapshotId`）。缺省 = snapshotId
   *   （push 路径两者天然相同）；合并/应用路径**必须显式传**，否则 lastSnapshotId 会退化成「一个远端
   *   并不存在的本地 id」→ hasNewRemoteSnapshot() 恒判「远端有新生」，每轮白跑 list + download + merge。
   *   传入 `''` 表示「远端 id 未知」——宁可留空，也不要把本地 id 冒充成远端 id。
   * - `opts.writeAncestor === false`（加密快照 push）：不落本地祖先副本，`ancestorId` 一并置 '' ——
   *   绝不把一个本地并不存在的目录名写进状态（旧实现正是这样让下一轮 merge 直接抛错）。
   * - `opts.preserveAncestor === true`（合并仍有未裁决冲突）：祖先副本与 ancestorId **保持不动** ——
   *   共同基线必须仍是「本机与远端都认可的上一版」；拿只带本次应用分区的副本去覆盖它，会让
   *   下一轮所有分区都退化成「无祖先 → 冲突」。
   * - `opts.pendingMerge`（基线纪律）：提供即写入；`null` = 清除该字段；缺省 = 不动（既有行为不变）。
   */
  async recordBaseline(
    snapshotId: string,
    sections: SyncSnapshot['sections'],
    nowIso?: string,
    opts: {
      writeAncestor?: boolean;
      remoteSnapshotId?: string;
      /** 保留当前祖先副本与 ancestorId（缺省 false = 既有行为逐字不变） */
      preserveAncestor?: boolean;
      /** 待裁决冲突记录：null = 清除；缺省 = 不动该字段 */
      pendingMerge?: PendingMerge | null;
      /** P1-5：本轮**实际带走**的会话单元（提供即覆盖；缺省 = 保留原记录） */
      sessionUnits?: string[];
      /** P1-5：本轮累积的删除墓碑（提供即覆盖；缺省 = 保留原记录） */
      deletedSessions?: string[];
    } = {},
  ): Promise<void> {
    const ts = nowIso ?? this.now().toISOString();
    const preserveAncestor = opts.preserveAncestor === true;
    const writesAncestorCopy = !preserveAncestor && this.localSnapshotsDir !== undefined && opts.writeAncestor !== false;
    // 1) 写本地祖先副本（如有 localSnapshotsDir）。
    //    writeAncestor=false（加密快照基线）：不写明文祖先副本（磁盘不落密钥；
    //    基线仅用 sync-state 的明文 hash，供 hasLocalChanges 比较）。
    if (writesAncestorCopy) {
      const snapshot: SyncSnapshot = {
        id: snapshotId,
        createdAt: ts,
        manifest: {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          dshVersion: this.ctx.dshVersion,
          platform: this.ctx.platform as Platform,
          sectionIds: Object.keys(sections) as SectionId[],
          containsSecrets: false,
          // 记录触发通道（git/webdav），供同步历史展示「由哪个通道触发」
          transport: this.transport.type,
        },
        sections,
      };
      await writeAncestor(this.localSnapshotsDir, snapshot, this.fsx);
    }
    // 2) 更新 sync-state：远端指针 + 本地祖先目录名 + 每分区 hash/updatedAt + lastSyncAt + transport
    const state = await loadSyncState(this.stateDir, this.fsx, this.msg);
    state.lastSnapshotId = opts.remoteSnapshotId ?? snapshotId;
    // preserveAncestor：祖先目录名一并保持不动（既不是 snapshotId，也不是 ''）
    if (!preserveAncestor) state.ancestorId = writesAncestorCopy ? snapshotId : '';
    state.lastSyncAt = ts;
    state.transport = { type: this.transport.type, ref: this.transportRef };
    // 基线纪律：null = 清除（全部裁决完）；undefined = 不动该字段（既有调用方零感知）
    if (opts.pendingMerge === null) delete state.pendingMerge;
    else if (opts.pendingMerge !== undefined) state.pendingMerge = opts.pendingMerge;
    // P1-5：只在调用方明确提供时覆盖（否则保留既有记录，绝不因某条路径不跟踪而清空）
    if (opts.sessionUnits !== undefined) state.sessionUnits = [...opts.sessionUnits];
    if (opts.deletedSessions !== undefined) state.deletedSessions = [...opts.deletedSessions];
    for (const [sid, data] of Object.entries(sections)) {
      state.sections[sid as SectionId] = { hash: hashSection(data as SectionData), updatedAt: ts };
    }
    await saveSyncState(this.stateDir, state, this.fsx);
    // 3) 裁剪祖先副本（最近 N 个）；preserveAncestor 时本轮没有新副本，不参与裁剪
    if (!preserveAncestor && this.localSnapshotsDir !== undefined) {
      await pruneAncestors(this.localSnapshotsDir, DEFAULT_ANCESTOR_KEEP, this.fsx);
    }
  }

  /**
   * 应用自动应用计划：写本地（走 Importer.executeImportPlan 标准路径；应用前调 backup.createSnapshot 兜底）；
   * 任一 auto 项失败 → 整体 rollback；成功后 recordBaseline 更新祖先基线。
   * 返回 ApplyReport；不抛错到调用方（失败返回 ok:false + rolledBack:true）。
   * 不再写 review-queue（§2.3/§7.4：待审语义改由同步历史 skipped 标记表达）。
   *
   * @param opts.snapshotBinding journal 绑定面（审计 P0-23）——由 runJournaled / runExternalIntent 的
   *   ctx 透传。**自动同步路径必须传**：否则 ctx 里的 recordRollback 到不了引擎，applyMergePlan 内部
   *   完成的整体回滚会被 executeImportPlan 正常返回，最终被记成 COMMITTED（已回滚却报成功）。
   * @param opts.remoteSnapshotId 本次应用对应的**远端**快照 id（写进 sync-state.lastSnapshotId，P0-7）。
   *   缺省 = 同一实例上最近一次 merge() 命中的远端快照（「自动同步 merge → applyMergePlan」的调用形态，
   *   引擎实例由宿主每次运行新建）；都拿不到则写 ''（远端 id 未知，不冒充远端 id）。
   */
  async applyMergePlan(apply: SyncApplyPlan, opts: {
    remoteSnapshotId?: string;
    snapshotBinding?: TransactionSnapshotContext;
    /**
     * issue #45：路径映射。缺省 = 复用最近一次 merge() 记下的用户映射；
     * 自动重定基则取自 merge() 记下的远端 sourceHome（写进临时 ZIP 的 manifest.sourceHome，
     * 由 analyzer.rebaseMapping 生成「源机 home → 本机 home」规则并排在用户映射之前）。
     */
    pathMappings?: PathMapping[];
    /** 覆盖自动重定基的源 home（缺省 = merge() 记下的远端 sourceHome） */
    sourceHome?: string;
    /**
     * 保留祖先副本与 ancestorId（缺省 false = 既有行为逐字不变）。
     * applyMergeResolutions 在**仍有未裁决冲突**时必须传 true：共同基线仍是「本机与远端都认可的上一版」。
     */
    preserveAncestor?: boolean;
    /**
     * 待裁决冲突记录（基线纪律）：null = 清除（全部裁决完）；缺省 = 不动该字段。
     * 与 recordBaseline 同语义，随本次成功的基线写入**同一次落盘**（原子，不留中间态）。
     */
    pendingMerge?: PendingMerge | null;
  } = {}): Promise<ApplyReport> {
    if (!this.importer) {
      throw new Error(this.msg('sync.applyMergePlanNoImporter'));
    }
    const appliedIds = apply.autoApply.map((r) => r.id);
    // 0) 空 autoApply：无物可应用，直接短路（不构造 ZIP、不调 Importer）
    if (appliedIds.length === 0) {
      return { ok: true, applied: [], restoreId: '', rolledBack: false, review: [], warnings: [] };
    }
    // 1) 构造临时 ZIP（仅含 autoApply 项的 merged payload）+ 分析 + 计划
    const portableIds = this.pullSectionIds();
    // issue #45：临时 ZIP 带上远端快照的 sourceHome → Importer 自动重定基（跨机时才有实际作用）
    const effectiveSourceHome = opts.sourceHome ?? this.lastMergedRemoteSourceHome;
    const tempSnapshot: SyncSnapshot = {
      id: this.snapshotIdFn(),
      createdAt: this.now().toISOString(),
      manifest: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        dshVersion: this.ctx.dshVersion,
        platform: this.ctx.platform as Platform,
        sectionIds: apply.autoApply.map((r) => r.id) as SectionId[],
        containsSecrets: false,
        ...(effectiveSourceHome !== '' ? { sourceHome: effectiveSourceHome } : {}),
      },
      sections: apply.autoApply.reduce<Record<string, SectionData>>((acc, r) => {
        if (r.merged !== undefined) acc[r.id] = r.merged as SectionData;
        return acc;
      }, {}),
    };
    const zipPath = await this.snapshotToZip(tempSnapshot, portableIds);
    try {
      const plan = await this.importer.createImportPlan(zipPath, {
        strategy: 'replace', // auto 路径：冲突已在外部分流；这里 replace = 接受导入值
        resolutions: {},
        // issue #45：合并路径的映射来自 merge() 记下的远端 sourceHome + 用户映射
        pathMappings: opts.pathMappings ?? this.lastMergedPathMappings,
      });
      if (!plan.items.length) {
        // 没有可执行项 → 视为 ok 但空 applied
        return { ok: true, applied: [], restoreId: '', rolledBack: false, review: [], warnings: [] };
      }
      // 2) 兜底：先建快照（拿到 restoreId 给 UI 一键回滚用）
      const store: SnapshotStore = new FileSnapshotStore({ dir: this.rollbackSnapshotsDir });
      let snapshot: Snapshot | undefined;
      try {
        snapshot = await createSnapshot({
          ctx: this.ctx,
          plan,
          sourceZip: zipPath,
          store,
          adapters: this.adapters,
        });
      } catch (backupErr) {
        return {
          ok: false,
          applied: [],
          restoreId: '',
          rolledBack: false,
          review: [],
          warnings: [this.msg('sync.preApplySnapshotFailed', { err: backupErr instanceof Error ? backupErr.message : String(backupErr) })],
        };
      }
      // 3) 真正执行：Importer.executeImportPlan（rollbackOnError=true → 任一失败整体回滚）
      // 自动同步路径没有密码（凭据载荷无法解密），因此恒不注入 decryptedCredentials；
      // 加密快照本就不会进入自动同步（无密码无法 prepareSnapshot）。
      const result = await this.importer.executeImportPlan(zipPath, plan, {
        confirm: true,
        rollbackOnError: true,
        secretInputs: undefined,
        decryptedCredentials: undefined,
        // 审计 P0-23：把 journal 绑定面透传给引擎（自动同步路径由 autosync-scheduler 提供），
        // 使 fn 内部的整体回滚能经 recordRollback 上报 → 终态 ROLLED_BACK 而非 COMMITTED。
        snapshotBinding: opts.snapshotBinding,
      });
      if (!result.ok) {
        // 兜底回滚：把「是否完整」与失败项一并回传（绝不吞掉，也绝不把部分回滚说成整体回滚）
        const rb = await rollbackForFailure(this.ctx, snapshot, store, this.adapters)
        // 失败路径不再写 review-queue（§7.4）：历史 skipped/failed 标记由上层（路由/调度器）写入。
        return {
          ok: false,
          applied: [],
          restoreId: snapshot.id,
          rolledBack: true,
          review: [],
          warnings: [...(result.warnings ?? []), ...rb.warnings],
          rollbackFull: rb.full,
        };
      }
      // 5) 全成功 → recordBaseline（更新祖先基线）。
      //    **基线必须以「实际落地的本地导出」为准（F-2，2026-10）**：写回时 adapter 会自增本机侧字段
      //    （如 settings.namespaces[*].revision），而 merged 携带的是**远端快照里的值**；用它记基线
      //    会让下一轮 merge 判「本地也改了」+「远端也改了」→ both-modified 冲突 → 每轮重复冲突。
      const landed = await this.exportAppliedSections(appliedIds);
      if (landed === null) {
        // 重新导出失败 = 无法证明「基线 == 本机现状」→ **不推进基线**（远端指针保持原值，
        // 下一轮重新合并收敛）并明确告警；绝不写半个基线。
        return {
          ok: true,
          applied: appliedIds,
          restoreId: snapshot.id,
          rolledBack: false,
          review: [],
          warnings: [...(result.warnings ?? []), this.msg('sync.baselineRexportFailed', { sections: appliedIds.join(', ') })],
        };
      }
      await this.recordBaseline(tempSnapshot.id, landed, undefined, {
        remoteSnapshotId: opts.remoteSnapshotId ?? this.lastMergedRemoteSnapshotId ?? '',
        ...(opts.preserveAncestor !== undefined ? { preserveAncestor: opts.preserveAncestor } : {}),
        ...(opts.pendingMerge !== undefined ? { pendingMerge: opts.pendingMerge } : {}),
      });
      return {
        ok: true,
        applied: appliedIds,
        restoreId: snapshot.id,
        rolledBack: false,
        review: [],
        warnings: result.warnings ?? [],
      };
    } finally {
      try { await fs.rm(path.dirname(zipPath), { recursive: true, force: true }); } catch { /* noop */ }
    }
  }

  /**
   * applyItems：按用户对差异项的逐项决策执行导入（§3.4/§5.3）。
   *
   * 与 applyMergePlan 的区别：applyItems 接收「会话级临时 ZIP + 子计划」，
   * 直接执行（backup.createSnapshot 兜底 → importer.executeImportPlan →
   * 成功 recordBaseline / 失败 rollback），不构造中间 SyncApplyPlan。
   *
   * @param zipPath 会话级临时标准 ZIP（由 sync/sync 生成，包含采纳项的 merged payload）
   * @param subPlan 子计划（仅含采纳项的 ImportPlan；globalStrategy/pathMappings/needsRestart 沿用会话 plan）
   * @param opts 执行选项（onItem 进度回调）
   * @returns ApplyItemsReport（ok/applied/restoreId/rolledBack/warnings/result）
   */
  async applyItems(
    zipPath: string,
    subPlan: ImportPlan,
    opts: {
      onItem?: (info: PlanItemProgress) => void;
      /** Phase 4 生产 journal↔snapshot 绑定（deferred；透传给 Importer.executeImportPlan） */
      snapshotBinding?: TransactionSnapshotContext;
      /**
       * issue #38：快照凭据载荷解密出的 `Map<ref, value>`（由 preview() 交给会话保管，
       * 仅内存）→ 透传为 executeImportPlan 的 decryptedCredentials，credentials adapter
       * 据此 credentials.set(ref, value) 写回本机。缺省 = 无凭据可写。
       */
      credentials?: Map<string, string>;
      /**
       * P0-7：本次应用对应的**远端**快照 id（宿主应从同步会话的 SyncSession.snapshotId 透传）→
       * sync-state.lastSnapshotId。缺省 ''：远端 id 未知就留空，绝不把本地随机快照 id 冒充成远端 id
       * （那会让 hasNewRemoteSnapshot() 恒判「远端有新生」，每轮白跑 list + download + merge）。
       */
      remoteSnapshotId?: string;
    } = {},
  ): Promise<ApplyItemsReport> {
    if (!this.importer) {
      throw new Error(this.msg('sync.applyItemsNoImporter'));
    }
    if (subPlan.items.length === 0) {
      return { ok: true, applied: [], restoreId: '', rolledBack: false, warnings: [], failed: [], ineffective: [], result: null };
    }

    // 兜底快照（拿到 restoreId 给 UI 一键回滚用）
    const store: SnapshotStore = new FileSnapshotStore({ dir: this.rollbackSnapshotsDir });
    let snapshot: Snapshot | undefined;
    try {
      snapshot = await createSnapshot({
        ctx: this.ctx,
        plan: subPlan,
        sourceZip: zipPath,
        store,
        adapters: this.adapters,
      });
    } catch (backupErr) {
      return {
        ok: false,
        applied: [],
        restoreId: '',
        rolledBack: false,
        warnings: [this.msg('sync.preApplySnapshotFailed', { err: backupErr instanceof Error ? backupErr.message : String(backupErr) })],
        failed: subPlan.items.map((i) => ({ itemId: i.id })),
        // 快照都没建成 ⇒ 一项都没执行，全部项都未生效（与 failed 同源，界面按硬失败处理）
        ineffective: [],
        result: null,
      };
    }

    // 真正执行：Importer.executeImportPlan（confirm:true + rollbackOnError:true → 任一失败整体回滚）
    const result = await this.importer.executeImportPlan(zipPath, subPlan, {
      confirm: true,
      rollbackOnError: true,
      secretInputs: undefined,
      // issue #38：快照凭据载荷解出的 ref→值（仅内存）→ credentials adapter 写回本机
      decryptedCredentials: opts.credentials,
      onItem: opts.onItem,
      snapshotBinding: opts.snapshotBinding,
    });

    if (!result.ok) {
      // executeImportPlan 已内部回滚（rollbackOnError）；这里再显式 rollback 兜底（幂等），
      // 并把「是否完整」与失败项如实回传（改造前 noop + 硬编码 rolledBack:true 会掩盖半回滚）
      const rb = await rollbackForFailure(this.ctx, snapshot, store, this.adapters)
      return {
        ok: false,
        applied: [],
        restoreId: snapshot.id,
        rolledBack: true,
        warnings: [...(result.warnings ?? []), ...rb.warnings],
        failed: result.executed.filter((e) => e.status === 'failed').map((e) => ({ itemId: e.itemId, message: e.message })),
        ineffective: result.ineffective ?? [],
        result,
        rollbackFull: rb.full,
      };
    }

    // 成功：recordBaseline 更新祖先基线。
    // **基线以「实际落地的本地导出」为准（F-2，2026-10；一键同步路径同样适用）**——
    // 用计划/远端载荷记基线会因为 adapter 自增 revision 等本机字段而在下一轮造成假冲突。
    const appliedIds = [...new Set(subPlan.items.map((i) => i.adapter))];
    const landed = await this.exportAppliedSections(appliedIds);
    if (landed === null) {
      // 无法证明「基线 == 本机现状」→ 不推进基线（下一轮重新合并收敛）+ 明确告警，绝不写半个基线
      return {
        ok: true,
        applied: appliedIds,
        skipped: subPlan.items.filter((i) => i.kind === 'Skip').map((i) => i.id),
        restoreId: snapshot.id,
        rolledBack: false,
        warnings: [...(result.warnings ?? []), this.msg('sync.baselineRexportFailed', { sections: appliedIds.join(', ') })],
        failed: [],
        ineffective: result.ineffective ?? [],
        needsRestart: result.needsRestart,
        result,
      };
    }
    const snapshotId = this.snapshotIdFn();
    await this.recordBaseline(snapshotId, landed, undefined, {
      remoteSnapshotId: opts.remoteSnapshotId ?? '',
    });

    return {
      ok: true,
      applied: appliedIds,
      skipped: subPlan.items.filter((i) => i.kind === 'Skip').map((i) => i.id),
      restoreId: snapshot.id,
      rolledBack: false,
      warnings: result.warnings ?? [],
      failed: [],
      // ok:true 也可以带着「未生效项」——这正是 issue #56 里被藏起来的那一半事实
      ineffective: result.ineffective ?? [],
      needsRestart: result.needsRestart,
      result,
    };
  }

  /** 散文件快照 → 标准导出 ZIP（临时目录，用完即删）：buildManifest + checksums + 平铺分区 */
  private async snapshotToZip(snapshot: SyncSnapshot, portableIds: Set<SectionId>): Promise<string> {
    // 防御：加密快照必须已由调用方解密（prepareSnapshot）；此处不处理密文载荷
    if (isEncryptedSections(snapshot.sections)) {
      throw new Error(this.msg('sync.snapshotStillEncrypted'));
    }
    const entries: ZipWriteEntry[] = [];
    const sectionFlags = {} as Record<SectionId, boolean>;
    for (const sid of portableIds) {
      const data = snapshot.sections[sid];
      if (data === undefined) continue;
      sectionFlags[sid] = true;
      if (isFileSection(sid)) {
        const prefix = SECTION_FILE_PREFIXES[sid]!;
        const files = (data as FilesSection).files ?? [];
        for (const f of files) {
          entries.push({ name: `${prefix}${f.relativePath}`, data: f.data });
        }
      } else {
        const jsonPath = SECTION_JSON_PATHS[sid];
        if (jsonPath === undefined) continue;
        entries.push({ name: jsonPath, data: Buffer.from(stringifyJsonSafe(data, { space: 2 }), 'utf8') });
      }
    }
    const manifest = buildManifest({
      exporterVersion: this.exporterVersion,
      dshVersion: snapshot.manifest.dshVersion,
      platform: snapshot.manifest.platform as Platform,
      arch: 'unknown', // ManifestSummary 不含 arch；仅影响展示，不影响导入决策
      sections: sectionFlags,
      containsSecrets: false,
      encrypted: false,
      encryption: null,
      exportedAt: snapshot.createdAt,
      // issue #45：把快照记录的导出机 home 透传进临时 ZIP —— Importer 依它生成
      // 「源机 home → 本机 home」的重定基规则（工作区 path + 会话首帧 cwd 一并改写）。
      sourceHome: snapshot.manifest.sourceHome,
    });
    // checksums：覆盖除 manifest/checksums 外全部条目（与 exporter 一致）
    const contentEntries = entries.filter((e) => e.name !== MANIFEST_FILE && e.name !== CHECKSUMS_FILE);
    entries.push({
      name: CHECKSUMS_FILE,
      data: Buffer.from(stringifyJsonSafe(buildChecksums(contentEntries), { space: 2 }), 'utf8'),
    });
    entries.push({ name: MANIFEST_FILE, data: Buffer.from(stringifyJsonSafe(manifest, { space: 2 }), 'utf8') });

    const dir = await fs.mkdtemp(path.join(this.zipDir, 'dsh-sync-pull-'));
    const zipPath = path.join(dir, 'snapshot.zip');
    await writeZip(zipPath, entries);
    return zipPath;
  }
}
