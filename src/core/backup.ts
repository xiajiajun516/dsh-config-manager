/**
 * Pre-import Snapshot（规范 §16/§27）：只保存本次导入将被修改的目标原值。
 * 应用层事务的基础：所有补偿动作基于快照（rollback.ts 逆序执行）。
 *
 * 快照不保存 credential 值（DSH 永不回读值）——credential 条目只记 existed 标志，
 * 回滚时 existed=true 的条目如实标记「值需人工补录」。
 */
import { engineMsg } from './messages-core.ts';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseJsonSafe } from '../utils/json.ts';
import { sha256Hex } from '../utils/hashing.ts';
import { normalizePath } from '../utils/paths.ts';
import { atomicWriteFile } from '../utils/atomic-write.ts';
import { SECTION_IDS, isFileSection } from '../schema/config.ts';
import { isPatchLayerRel, PROFILE_PATCH_FILENAME, USER_PATCH_FILE } from './patch-layers.ts';
import { MCP_CONNECTOR_STORE_REL } from './mcp-connector-store.ts';
import type { SectionId } from '../schema/types.ts';
import type {
  ConfigAdapter, FileSystemFacade, HostContext, HostFileBackup, ImportPlan, PlanItem, Snapshot,
  SnapshotEntry, SnapshotManifest, SnapshotStatus, SnapshotStore, SnapshotTarget,
} from './types.ts';

/**
 * 「会写目标」的**单点事实源**：该计划项是否会被引擎交给 `adapter.applyItem`
 * （即可能产生目标写入）。
 *
 * 为什么必须单点：硬不变量「导入前强制快照（可回滚）」只为会写目标的项登记原值
 * （本文件 collectTargets → createSnapshot），而执行分派在 analyzer.applyOne，
 * 历史上还有一条恢复回放侧（core/config-snapshot.ts，已随灾备快照线下线）。两处各写一份 kind
 * —— 实测漂移过一次，两个方向的错都在：
 *  - PathMapping 与 Conflict(resolution='useImported') 会写目标却不在快照范围
 *    （写了撤不掉，报告却声称「已快照、可回滚」）；
 *  - 回放侧把**未采纳**的 Conflict 当可执行（settings adapter 无条件 settings.replace
 *    → 静默覆盖目标机本地值），而导入路径对同一项是 skip。
 *
 * 语义（与 analyzer.applyOne 逐条对齐）：
 *  - Skip / Warning / MissingDependency：信息项，不调用 applyItem；
 *  - Error：硬失败项，执行侧如实记 failed，不调用 applyItem；
 *  - Conflict：只有显式采纳（resolution === 'useImported'）才写；keepCurrent / review /
 *    未决策一律不写（「冲突不默认覆盖」硬不变量）；
 *  - MissingSecret：无可用秘密值时执行侧会 skip（见 PlanItemExecContext）。
 */
export interface PlanItemExecContext {
  /**
   * MissingSecret：该 ref 当前是否已有可用秘密值。
   *  - 不传（快照范围 / journal 记账）：一律视为「会写」—— 快照是**保守超集**，
   *    宁可多留一个回滚点，也绝不允许「写了却撤不掉」；
   *  - 导入执行：按 secretInputs / decryptedCredentials 真实判定；
   *  - 快照回放：没有秘密输入来源 → 传 `() => false`（与导入侧「无值 → skip」同判）。
   */
  secretValueAvailable?: (ref: string) => boolean;
}

/** 见 PlanItemExecContext 与上方说明：会写目标的项 = 必须进快照范围的项。 */
export function planItemWritesTarget(item: PlanItem, exec: PlanItemExecContext = {}): boolean {
  if (
    item.kind === 'Skip' || item.kind === 'Warning'
    || item.kind === 'MissingDependency' || item.kind === 'Error'
  ) {
    return false;
  }
  if (item.kind === 'Conflict' && item.conflict?.resolution !== 'useImported') return false;
  if (item.kind === 'MissingSecret' && exec.secretValueAvailable !== undefined) {
    return exec.secretValueAvailable(item.id.replace(/^secret:/, ''));
  }
  return true;
}

/**
 * 需要整文件备份的宿主关键文件（相对 $DSH_HOME）：
 *  - settings.yaml（DSH 配置主存储；不存在时探测 settings.json）
 *  - cordis.patch.yml（用户 patch 层）
 *  - profiles/<profile>/cordis.patch.yml（profile patch 层，宿主暴露 profile 时）
 */
const HOST_FILE_CANDIDATES: ReadonlyArray<{ relPath: string }> = [
  { relPath: 'settings.yaml' },
  { relPath: 'settings.json' },
  { relPath: USER_PATCH_FILE },
];

/**
 * 宿主整文件备份（M1）：探测存在性，存在的文件字节进 blobs Map 由 store.save 落盘，
 * 全部候选（含 existed:false）登记进 hostFileBackups，供 M2 restore 整文件还原。
 */
async function backupHostFiles(
  ctx: HostContext,
  blobs: Map<string, Uint8Array>,
): Promise<HostFileBackup[]> {
  const candidates = [...HOST_FILE_CANDIDATES];
  if (ctx.profile !== undefined && ctx.profile !== '') {
    candidates.push({ relPath: `profiles/${ctx.profile}/${PROFILE_PATCH_FILENAME}` });
    // pnpm-workspace.yaml 决定插件能否安装（allowBuilds/冷静期）→ 一并纳入宿主整文件备份
    candidates.push({ relPath: `profiles/${ctx.profile}/pnpm-workspace.yaml` });
  }

  const backups: HostFileBackup[] = [];
  for (const { relPath } of candidates) {
    // settings.yaml 与 settings.json 互斥：主存储存在时不再探测 json 备选
    if (relPath === 'settings.json' && backups.some((b) => b.relPath === 'settings.yaml' && b.existed)) {
      continue;
    }
    let existed = false;
    try {
      existed = await ctx.fs.exists(relPath);
    } catch (err) {
      // 探测自身失败 = 存在性判不出来：按「存在但不可读」登记。**绝不写 existed:false** ——
      // 那会被恢复侧读成「当时确实不存在」，进而删掉用户真实的文件。
      ctx.log.warn(`快照探测宿主文件失败 ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
      backups.push({ relPath, blobPath: '', existed: true, unreadable: true });
      continue;
    }
    if (!existed) {
      backups.push({ relPath, blobPath: '', existed: false });
      continue;
    }
    const blobPath = `blobs/host/${crypto.randomUUID()}`;
    try {
      blobs.set(blobPath, await ctx.fs.readFile(relPath));
      backups.push({ relPath, blobPath, existed: true });
    } catch (err) {
      // 文件确实存在、只是这次读不出来（占用/权限/IO）：登记 existed=true + unreadable，
      // 恢复侧据此只跳过并告警，绝不进入「删除」分支（见 HostFileBackup.unreadable）。
      ctx.log.warn(`快照读取宿主文件失败 ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
      backups.push({ relPath, blobPath: '', existed: true, unreadable: true });
    }
  }
  return backups;
}

/**
 * 文件类分区的目标基准目录（相对 homeDir；pluginFiles/self 的 ref 已是完整相对路径）。
 *
 * 这是「home 落位」事实，与注册表里的 ZIP 内 `filePrefix` 是**两件事**（例如 skills：ZIP 前缀
 * `custom/skills/` vs home 基准 `skills`），故保留在本文件；但**键集合必须由注册表校验**（见下）。
 */
const FILE_BASES: Partial<Record<SectionId, string>> = {
  skills: 'skills',
  agentPresets: '.agent-presets',
  agentInstructions: '', // homeDir 根（~/.dsh/AGENTS.md）
  pluginFiles: '',
  // 第三方插件数据：baseDir '' = home 根，ref 是**完整的 home 相对路径**
  // （.dsh-wallpaper-engine/config.json / .mnemon/data/x.db）
  pluginData: '',
  pluginAssets: '',
  sessions: 'sessions',
  self: 'dsh-config-manager',
};

// 加载期自检（注册表派生，t30）：**每个文件类分区都必须有基准目录**。漏一项不会报错，而是让
// resolveFileTarget 静默退回 homeDir 根 —— 快照/回滚会去读写**另一个路径**（与「未知分区静默按
// 其它分区语义处理」同类缺陷）。注册表新增文件类分区时若忘了在这里补，进程启动即失败。
for (const id of SECTION_IDS) {
  if (isFileSection(id) && FILE_BASES[id] === undefined) {
    throw new Error(engineMsg('core.backup.fileSectionBaseMissing', { section: id }));
  }
}

/**
 * plugins 分区中「profile 内文件」的 ref 前缀（issue #35）：`patchFile:<相对 profile 目录的路径>`。
 * 前缀的存在是为了与 patch **行** id（同样落在 plugins 分区的 ref 空间）区分开——
 * 行 id 是任意字符串，无法靠形状判断它是不是一个路径。
 */
export const PLUGIN_PATCH_REF_PREFIX = 'patchFile:'

/**
 * plugins 分区中「profile 的 package.json」这一文件目标的 ref（issue #95）。
 *
 * 声明 host 自带的 bundle 层（`dsh.profile.bundles`）就是写这个文件，因此它必须与
 * `pnpm-workspace.yaml` 同级：进导入前快照 → 回滚能整文件还原，否则一次导入留下的声明
 * 撤不掉（照抄 \`patchFile:\` 的做法，用一个符号 ref 而不是真实文件名——ref 空间里还有
 * 任意 patch 行 id，靠形状判断会撞车）。
 */
export const PLUGIN_PROFILE_MANIFEST_REF = 'profileManifest'

/** profile 目录绝对路径（plugins 分区内文件类目标的基准） */
function profileDirOf(ctx: HostContext): string {
  const profile = ctx.profile !== undefined && ctx.profile !== '' ? ctx.profile : 'web';
  return path.join(ctx.homeDir, 'profiles', profile);
}

/**
 * 以**系统 home 为根**的文件类分区（ref 是系统 home 相对路径）。
 *
 * 为什么单独一组：`FileSystemFacade` 被限制在 $DSH_HOME 内，而第三方插件的数据常在 $DSH_HOME 之外
 * （`~/.dsh-wallpaper-engine/`、`~/.mnemon/` …）。这两个分区的路径解析与 I/O 门面都换根，
 * 其余分区一字不动 —— 单根不变量只在**这两个分区**上被显式放宽，且仍然只允许白名单区域。
 */
export const OS_HOME_FILE_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>(['pluginData', 'pluginAssets']);

/** 该分区文件目标的根（`dsh` = $DSH_HOME；`osHome` = 系统 home） */
export function sectionFileRoot(adapter: SectionId): 'dsh' | 'osHome' {
  return OS_HOME_FILE_SECTIONS.has(adapter) ? 'osHome' : 'dsh';
}

/** 系统 home：宿主显式给就用它，否则进程 `homedir()`（`~` 的定义，不是猜） */
export function osHomeDirOf(ctx: HostContext): string {
  return ctx.osHomeDir !== undefined && ctx.osHomeDir !== '' ? ctx.osHomeDir : homedir();
}

/**
 * 该分区文件 I/O 应使用的门面。
 *
 * `osHome` 分区必须用 `homeFs`：缺了它**显式抛错**，绝不退回 `ctx.fs` —— 那会把
 * `~/.mnemon/x.db` 写成 `$DSH_HOME/.mnemon/x.db`（看起来成功、实际写错位置）。
 */
export function fsForSection(ctx: HostContext, adapter: SectionId): FileSystemFacade {
  if (sectionFileRoot(adapter) === 'dsh') return ctx.fs;
  if (ctx.homeFs === undefined) throw new Error(engineMsg('core.backup.osHomeUnavailable', { section: adapter }));
  return ctx.homeFs;
}

/** 解析文件类目标的绝对路径（引擎通用快照与回滚共用） */
export function resolveFileTarget(ctx: HostContext, adapter: SectionId, ref: string): string {
  // 系统 home 根的分区：整体换根（plugins 的两个 profile 特例与它们互不相干）
  if (sectionFileRoot(adapter) === 'osHome') {
    return path.join(osHomeDirOf(ctx), FILE_BASES[adapter] ?? '', ref);
  }
  // plugins 分区的 pnpm-workspace.yaml：位于 profiles/<profile>/ 下（非 FILE_BASES 静态基准）
  if (adapter === 'plugins' && ref === 'pnpm-workspace.yaml') {
    return path.join(profileDirOf(ctx), 'pnpm-workspace.yaml');
  }
  // issue #35：pnpm patch 文件同样位于 profiles/<profile>/ 下，必须能被快照与回滚覆盖，
  // 否则「导入覆盖了目标机原有 patch 文件 → 回滚」会静默丢失原文件。
  if (adapter === 'plugins' && ref.startsWith(PLUGIN_PATCH_REF_PREFIX)) {
    return path.join(profileDirOf(ctx), ref.slice(PLUGIN_PATCH_REF_PREFIX.length));
  }
  // issue #95：声明 host 自带 bundle 层 = 写 profile 的 package.json（快照/回滚必须覆盖它）
  if (adapter === 'plugins' && ref === PLUGIN_PROFILE_MANIFEST_REF) {
    return path.join(profileDirOf(ctx), 'package.json');
  }
  const base = FILE_BASES[adapter] ?? '';
  return path.join(ctx.homeDir, base, ref);
}

/**
 * 文件类目标的 home-relative 相对路径（P2-B，Phase 8）。
 * 供导入逐项指纹（analyzer 经 HostContext.fs.readFile(read rel) 读文件算 sha256）
 * 与 journal step.ref 的 posix 规范化。
 *
 * issue #35：`plugins` 分区的两个文件类 ref（`pnpm-workspace.yaml` 与
 * `patchFile:<profile 相对路径>`）不落在 FILE_BASES 的静态基准上，必须显式给 profile ——
 * 否则产出的是**不存在的** home 相对路径（如 `patchFile:patches/a.patch`），
 * 指纹恒为 null，crash 后 reconcile 无法证明该项是否已应用（保守但可避免的精度损失）。
 */
export function resolveFileTargetRel(adapter: SectionId, ref: string, profile?: string): string {
  // 系统 home 根的分区：ref 本身就是「根相对路径」，原样归一即可
  if (sectionFileRoot(adapter) === 'osHome') return normalizePath(ref);
  if (adapter === 'plugins') {
    const profileDir = `profiles/${profile !== undefined && profile !== '' ? profile : 'web'}`;
    if (ref === 'pnpm-workspace.yaml') return normalizePath(`${profileDir}/pnpm-workspace.yaml`);
    if (ref === PLUGIN_PROFILE_MANIFEST_REF) return normalizePath(`${profileDir}/package.json`);
    if (ref.startsWith(PLUGIN_PATCH_REF_PREFIX)) {
      return normalizePath(`${profileDir}/${ref.slice(PLUGIN_PATCH_REF_PREFIX.length)}`);
    }
  }
  const base = FILE_BASES[adapter] ?? '';
  return normalizePath(path.join(base, ref));
}

/**
 * 归一「快照来源 DSH 版本」（F-4）。
 *
 * 只接受**非空的真实版本串**：宿主 `resolveDshVersion` 在解析不到时返回 `'unknown'` 占位，
 * 把它写进快照会让恢复侧的「两侧都已知且不同」判定拿占位值当已知版本而误报。
 * 归一不到 → undefined（快照不写该字段，恢复时按「来源版本未知」处理，不告警）。
 */
export function normalizeDshVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'unknown') return undefined;
  return trimmed;
}

export interface CreateSnapshotOptions {
  ctx: HostContext;
  plan: ImportPlan;
  sourceZip: string;
  store: SnapshotStore;
  adapters: ConfigAdapter[];
  /** Phase 4：operation-bound binding（journal.operationId / environmentFingerprint / ownerInstanceId / operationType） */
  operationId?: string;
  operationType?: string;
  environmentFingerprint?: string;
  ownerInstanceId?: string;
}

/** 从计划中收集将被写入的 target（去重）。
 *  范围由 planItemWritesTarget 单点决定（与执行分派同源）：凡会写目标的 kind 都必须进快照，
 *  否则回滚/恢复撤不掉原值；不传 exec → MissingSecret 也一律登记（保守超集）。 */
function collectTargets(plan: ImportPlan): SnapshotTarget[] {
  const seen = new Set<string>();
  const targets: SnapshotTarget[] = [];
  for (const item of plan.items) {
    if (!planItemWritesTarget(item) || item.target === undefined) continue;
    // issue #71：patch 行目标带层（同一 lineId 可能在两层各有一行）→ 去重键必须含层，
    // 否则 profile 层的行会被 home 层的同名行吞掉，快照少记一条、回滚少还原一条。
    const key = `${item.target.adapter}\u0000${item.target.file ?? ''}\u0000${item.target.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(item.target);
  }
  return targets;
}

/** 引擎通用快照（adapter 未实现 snapshot? 时兜底） */
async function engineSnapshotEntry(ctx: HostContext, target: SnapshotTarget): Promise<SnapshotEntry> {
  switch (target.adapter) {
    case 'settings':
    case 'ui':
    case 'providers': {
      try {
        const info = await ctx.settings.describe(target.ref);
        return { kind: 'settingsNamespace', adapter: target.adapter, ref: target.ref, before: info.value, revision: info.revision, existed: true };
      } catch {
        // 目标不存在该 namespace → 快照标记 existed:false（回滚时无法恢复「不存在」，如实处理）
        return { kind: 'settingsNamespace', adapter: target.adapter, ref: target.ref, before: null, revision: 0, existed: false };
      }
    }
    case 'credentialsStatus': {
      const info = await ctx.credentials.describe(target.ref);
      return { kind: 'credential', adapter: target.adapter, ref: target.ref, before: null, existed: info.configured };
    }
    case 'workspaces': {
      const records = await ctx.workspace.listRecords();
      const rec = records.find((r) => r.id === target.ref);
      return { kind: 'workspaceRecord', adapter: target.adapter, ref: target.ref, before: rec ?? null };
    }
    case 'mcp':
    case 'plugins':
    case 'prompts': {
      // plugins 分区的 pnpm-workspace.yaml / patch 文件 → 整文件快照（file 类，回滚可整文件还原）
      if (target.adapter === 'plugins' && (target.ref === 'pnpm-workspace.yaml' || target.ref === PLUGIN_PROFILE_MANIFEST_REF || target.ref.startsWith(PLUGIN_PATCH_REF_PREFIX))) {
        const abs = resolveFileTarget(ctx, target.adapter, target.ref);
        if (!(await ctx.fs.exists(abs))) {
          return { kind: 'file', adapter: target.adapter, ref: target.ref, before: null, existed: false };
        }
        const data = await ctx.fs.readFile(abs);
        return {
          kind: 'file',
          adapter: target.adapter,
          ref: target.ref,
          before: { contentHash: sha256Hex(data) },
          existed: true,
          copiedTo: `blobs/${crypto.randomUUID()}`,
        };
      }
      // mcp 分区的第二个数据源（连接器插件的 storage domain 文件）：整文件快照。
      // 没有这条分支时，连接器导入的写入撤不回来（该文件不在 patch 层里，走 patchLine 语义会
      // 变成「读过一行 patch」→ 回滚时不还原文件 → 用户的 4 个 MCP 连接被永久改掉）。
      if (target.adapter === 'mcp' && target.ref === MCP_CONNECTOR_STORE_REL) {
        const fsFacade = fsForSection(ctx, target.adapter);
        const abs = resolveFileTarget(ctx, target.adapter, target.ref);
        if (!(await fsFacade.exists(abs))) {
          return { kind: 'file', adapter: target.adapter, ref: target.ref, before: null, existed: false };
        }
        const data = await fsFacade.readFile(abs);
        return {
          kind: 'file',
          adapter: target.adapter,
          ref: target.ref,
          before: { contentHash: sha256Hex(data) },
          existed: true,
          copiedTo: `blobs/${crypto.randomUUID()}`,
        };
      }
      // patchLine：从**该行所在的 patch 层**读取原行（issue #71）。
      // target.file 缺省 = 用户层（旧调用方 / 旧计划项），只接受合法层路径，绝不把任意字符串
      // 当文件名传给宿主门面（那会抛「仅支持管理 …」）。
      const file = target.file !== undefined && isPatchLayerRel(target.file) ? target.file : USER_PATCH_FILE;
      const lines = await ctx.patchFile.readPatchLines(file);
      const line = lines.find((l) => l.lineId === target.ref);
      return { kind: 'patchLine', adapter: target.adapter, ref: target.ref, file, before: line?.raw ?? null, existed: line !== undefined };
    }
    case 'skills':
    case 'agentPresets':
    case 'agentInstructions':
    case 'pluginFiles':
    case 'pluginData':
    case 'pluginAssets':
    case 'sessions':
    case 'self': {
      // 门面按分区选：pluginData / pluginAssets 在系统 home 根（见 fsForSection 的说明）
      const fsFacade = fsForSection(ctx, target.adapter);
      const abs = resolveFileTarget(ctx, target.adapter, target.ref);
      if (!(await fsFacade.exists(abs))) {
        return { kind: 'file', adapter: target.adapter, ref: target.ref, before: null, existed: false };
      }
      const data = await fsFacade.readFile(abs);
      // 文件字节不放进 SnapshotEntry（契约纯净），由 createSnapshot 收集进 blobs Map 统一落盘
      return {
        kind: 'file',
        adapter: target.adapter,
        ref: target.ref,
        before: { contentHash: sha256Hex(data) },
        existed: true,
        copiedTo: `blobs/${crypto.randomUUID()}`,
      };
    }
    case 'secrets':
      // secrets 已注册但**没有 adapter、也没有 ZIP 内分区 JSON**（凭据值走独立加密容器 secrets.enc）。
      // 任何计划项都不应以它为快照目标 —— 显式报错，而不是落到 default 分支。
      throw new Error(
        engineMsg('core.backup.secretsSectionNotSnapshotTarget'),
      );
    default: {
      // 编译期穷举断言：SectionId 的每一项都已被上面的 case 处理 → 此处 target.adapter 收窄为 never。
      // 新增分区若忘了在这里实现快照语义，tsc 会直接报错（不再依赖人肉核对清单）。
      const unhandled: never = target.adapter;
      // 运行期（只可能来自运行期强转：被篡改的 plan / 旧 journal 反序列化）：**显式报错**。
      // 旧实现在这里静默返回 settingsNamespace 条目（连 existed 都没有）→ 回滚把该目标当「原本不存在」
      // 而不做任何补偿：该分区的写入永远撤不掉，报告却仍说「已快照、可回滚」（审计 core-flow#F-10）。
      throw new Error(
        engineMsg('core.backup.sectionUnsupported', { section: String(unhandled) }),
      );
    }
  }
}

/** 惰性 blob 源（t51）：blobPath + 「按需读一次」的闭包 —— 保留原有读调用与异常传播。 */
interface BlobSource {
  blobPath: string;
  read: () => Promise<Uint8Array>;
}

/** 先枚举即时读入的宿主文件字节，再逐条按需读文件类条目的 blob（异步生成器 → 任一时刻只驻留一条）。 */
async function* mergedBlobSources(
  eager: Map<string, Uint8Array>,
  lazy: readonly BlobSource[],
): AsyncGenerator<readonly [string, Uint8Array]> {
  for (const [blobPath, data] of eager) yield [blobPath, data] as const;
  for (const src of lazy) yield [src.blobPath, await src.read()] as const;
}

/**
 * 把 blobs 交给 store（t51）：store 提供**接口之外**的 saveStreaming 时走流式（按需读盘 + 写盘与
 * hash 同遍），否则回退到既有 save(snapshot, eagerMap)。SnapshotStore 接口一字未改。
 */
async function saveSnapshotBlobs(
  store: SnapshotStore,
  snapshot: Snapshot,
  eager: Map<string, Uint8Array>,
  lazy: readonly BlobSource[],
): Promise<void> {
  const streaming = store as SnapshotStore & {
    saveStreaming?: (s: Snapshot, blobs: AsyncIterable<readonly [string, Uint8Array]>) => Promise<string>;
  };
  if (typeof streaming.saveStreaming === 'function') {
    await streaming.saveStreaming(snapshot, mergedBlobSources(eager, lazy));
    return;
  }
  const all = new Map<string, Uint8Array>(eager);
  for (const src of lazy) all.set(src.blobPath, await src.read());
  await store.save(snapshot, all);
}

/**
 * 生成并落盘快照：只覆盖将被写入的目标。
 * 文件字节经 store.save / saveStreaming 落盘（SnapshotEntry 契约不含二进制）。
 */
export async function createSnapshot(opts: CreateSnapshotOptions): Promise<Snapshot> {
  const { ctx, plan, sourceZip, store, adapters } = opts;
  const targets = collectTargets(plan);

  const entries: SnapshotEntry[] = [];
  const blobs = new Map<string, Uint8Array>();
  // t51：文件类条目的字节**不在这里读**（那样会把整个分区载荷读进内存）——改为登记「按需读」的源，
  // 由 store 消费时逐条读，任一时刻只驻留一条。宿主文件（3~5 个小文件）仍即时读入：它们的读失败
  // 语义是「warning + existed:false」（backupHostFiles 的 try/catch），延后读会改掉这个语义。
  const lazyBlobSources: BlobSource[] = [];

  // 1) 有 adapter.snapshot? 的优先（adapter 更懂自己的数据）
  const byAdapter = new Map<SectionId, SnapshotTarget[]>();
  for (const t of targets) {
    const list = byAdapter.get(t.adapter) ?? [];
    list.push(t);
    byAdapter.set(t.adapter, list);
  }
  for (const adapter of adapters) {
    const adapterTargets = byAdapter.get(adapter.id);
    if (!adapterTargets || adapterTargets.length === 0) continue;
    if (adapter.snapshot) {
      const adapterEntries = await adapter.snapshot(adapterTargets, ctx);
      entries.push(...adapterEntries);
      byAdapter.delete(adapter.id);
    }
  }

  // 2) 引擎通用快照兜底
  for (const [adapterId, remaining] of byAdapter) {
    for (const target of remaining) {
      const entry = await engineSnapshotEntry(ctx, target);
      // 文件字节：文件类条目在引擎快照里读出内容 → blobs
      if (entry.kind === 'file' && entry.copiedTo && entry.existed) {
        const abs = resolveFileTarget(ctx, adapterId, target.ref);
        // 与改动前**完全相同的读调用**，只是延后到被消费时执行（路径语义与异常传播不变）
        lazyBlobSources.push({ blobPath: entry.copiedTo, read: () => fsForSection(ctx, adapterId).readFile(abs) });
      }
      entries.push(entry);
    }
  }

  // 3) 宿主整文件备份（M1）：settings.yaml/settings.json + 用户/ profile 层 cordis.patch.yml
  const hostFileBackups = await backupHostFiles(ctx, blobs);

  // 4) 导入前插件清单（M2 restore 撤销插件对比基准；读取失败不阻断快照）
  let beforePlugins: Snapshot['beforePlugins'] = [];
  try {
    beforePlugins = await ctx.plugins.listInstalled();
  } catch (err) {
    ctx.log.warn(`快照登记插件清单失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    sourceZip,
    entries,
    status: 'pending',
    beforePlugins,
    hostFileBackups,
    // F-4：拍快照时的本机 DSH 版本（归一到「能证明的真实版本」；解析不到则不写该字段）。
    dshVersion: normalizeDshVersion(ctx.dshVersion),
    // Phase 4：operation-bound binding（journal ↔ snapshot 双向一致）
    ...(opts.operationId !== undefined ? { operationId: opts.operationId } : {}),
    ...(opts.operationType !== undefined ? { operationType: opts.operationType } : {}),
    ...(opts.environmentFingerprint !== undefined ? { environmentFingerprint: opts.environmentFingerprint } : {}),
    ...(opts.ownerInstanceId !== undefined ? { ownerInstanceId: opts.ownerInstanceId } : {}),
  };
  // file 条目登记 snapshotId，回滚读 blob 时定位快照目录
  for (const entry of snapshot.entries) {
    if (entry.kind === 'file') entry.snapshotId = snapshot.id;
  }
  await saveSnapshotBlobs(store, snapshot, blobs, lazyBlobSources);
  return snapshot;
}

/* ---------------- 默认文件快照存储 ---------------- */

/**
 * m-retention：保留策略的**结构形状**（故意在 core 内声明，而非 import sync/retention-policy.ts）。
 *
 * 为什么不用 sync 的类型：架构边界测试（tests/architecture-boundaries.test.ts）硬性禁止
 * `core/ → sync/` 反向依赖——core 是与 DSH 解耦的领域层，只允许 node 内置 / core 内部 /
 * schema / utils / security。sync 侧 `RetentionPolicy` 与本接口结构一致，可直接赋值（结构化类型）。
 * 分层选别算法本体在 `src/sync/retention-policy.ts`（selectPruneCandidatesByPolicy），
 * 由宿主（入口层）经 `FileSnapshotStoreOptions.pruneSelector` 注入——core 只定义契约，不反向依赖。
 */
export interface RetentionPolicyLike {
  /** 最近保留份数 */
  keepLast: number;
  /** 每月保留份数（0 = 关闭） */
  keepMonthly: number;
  /** 每年保留份数（0 = 关闭） */
  keepYearly: number;
}

/** core 侧缺省保留策略：与既有 `SNAPSHOT_RETENTION_LIMIT`（最近 10 个）逐字等价。 */
export function defaultRetentionPolicyLike(): RetentionPolicyLike {
  return { keepLast: SNAPSHOT_RETENTION_LIMIT, keepMonthly: 0, keepYearly: 0 };
}

/** 快照保留上限：save 落盘后超过该数量则删除最旧快照目录 */
export const SNAPSHOT_RETENTION_LIMIT = 10;

/** 纯函数：返回应清理的最旧快照 id（按 createdAt 升序取超限部分；恰好 limit 个 → 空数组）。
 * 参数用最小结构类型，避免引入 restore.ts 的 SnapshotMeta 造成循环 import。 */
export function selectPruneCandidates(
  metas: ReadonlyArray<{ id: string; createdAt: string }>,
  limit: number = SNAPSHOT_RETENTION_LIMIT,
): string[] {
  if (metas.length <= limit) return [];
  const sorted = [...metas].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return sorted.slice(0, sorted.length - limit).map((m) => m.id);
}

/**
 * 分层保留选择器契约（core 侧签名；实现由宿主注入，见 sync/retention-policy.ts）。
 * 入参 metas 已剔除 pinned / recovery 引用等豁免项（由 store.prune 完成）。
 */
export type PruneSelector = (
  metas: ReadonlyArray<{ id: string; createdAt: string }>,
  policy: RetentionPolicyLike,
) => string[];

/**
 * core 内置的**兜底**选择器：只按 keepLast 取最旧超限部分（= 既有 FIFO 行为）。
 * 分层（keepMonthly/keepYearly）语义需宿主注入真正的 GFS 实现；未注入时分层字段被忽略，
 * 行为等价于改造前（安全侧：宁可少删，绝不因缺实现而多删）。
 */
export const fallbackPruneSelector: PruneSelector = (metas, policy) =>
  selectPruneCandidates(metas, policy.keepLast);

export interface FileSnapshotStoreOptions {
  /** 快照根目录（宿主决定，如 ~/.dsh/dsh-config-manager/snapshots） */
  dir: string;
  /**
   * Phase 4 F3：可恢复 / 未收敛 journal 引用的 snapshotId 集合提供者。
   * prune 必须豁免这些 snapshot（绝不可删被 recovery 引用的回滚点）。
   * 缺省 = 空集合（不豁免）。宿主注入 JournalStore.listReferencedSnapshotIds。
   */
  referencedSnapshotIds?: () => Promise<Set<string>>;
  /**
   * Phase 6：自动保留清理的迁移历史回调（best-effort）。
   * prune 删除后回调被清 snapshotId 列表；宿主据其写统一审计史（snapshot-prune kind）。
   * 缺省 = 不记录（不改变 prune 行为、不污染核心引擎）。
   */
  onPrune?: (removedIds: string[]) => void;
  /**
   * m-retention：快照保留策略提供者（GFS 分层；可配置）。
   * 缺省 = `SNAPSHOT_RETENTION_LIMIT`（= 既有的「保留最近 10 个」，行为不变）。
   * 每次 prune 时调用（宿主可从 backup-schedule.json 读取最新策略，用户改完即时生效）；
   * 抛错/返回非法值 → 回退缺省策略（绝不因策略读取失败而误删或崩溃）。
   */
  retentionPolicy?: () => RetentionPolicyLike | Promise<RetentionPolicyLike>;
  /**
   * m-retention：分层保留选择器（由宿主注入 sync/retention-policy.ts 的 GFS 实现）。
   * 未注入 → `fallbackPruneSelector`（只按 keepLast，等价既有 FIFO；分层字段被忽略 = 保守少删）。
   */
  pruneSelector?: PruneSelector;
  /**
   * 诊断回调（可选）：保留清理**被放弃**或失败时的可见线索。
   * 缺省 = 不记录（不改变行为）；宿主接 `host.log.warn` —— 「这轮为什么没清理」必须能查。
   */
  onWarn?: (message: string) => void;
}

/** 文件快照存储：<dir>/<id>/snapshot.json + <dir>/<id>/blobs/* */
export class FileSnapshotStore implements SnapshotStore {
  private readonly options: FileSnapshotStoreOptions;

  constructor(options: FileSnapshotStoreOptions) {
    this.options = options;
  }

  private snapshotDir(id: string): string {
    return path.join(this.options.dir, id);
  }

  /**
   * 落盘单个 blob：写盘与**计算 hash 同遍完成**（t51）。
   * 改动前 save() 先遍历一遍写盘、再遍历一遍算 hash —— 两遍都要求整个 blobs 集合驻留。
   */
  private async writeBlob(dir: string, blobPath: string, data: Uint8Array, hashes: Record<string, string>): Promise<void> {
    const target = path.join(dir, blobPath);
    if (!target.startsWith(dir)) throw new Error(engineMsg('core.backup.blobPathEscaped', { path: blobPath }));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await atomicWriteFile(target, data);
    hashes[blobPath] = sha256Hex(data);
  }

  /** 尾段（save 与 saveStreaming 共用）：snapshot.json / manifest / 磁盘校验 / READY 发布 / prune。
   *  **不动 durable+verified 不变量**：第 4 步仍从磁盘独立重读校验（不信任内存对象）。 */
  private async finalizeSnapshot(snapshot: Snapshot, blobHashes: Record<string, string>): Promise<string> {
    const dir = this.snapshotDir(snapshot.id);
    // 2) 写 snapshot.json（readiness='CREATING'，未完成不可用）
    const creating = { ...snapshot, readiness: 'CREATING' as const };
    await atomicWriteFile(path.join(dir, 'snapshot.json'), JSON.stringify(creating, null, 2));
    // 3) 写 manifest（blob hashes + 破坏性内容 hash；metadataHash 稳定，不含 readiness/status）
    const manifest: SnapshotManifest = {
      schemaVersion: 1,
      snapshotId: snapshot.id,
      entryCount: snapshot.entries.length,
      blobHashes,
      metadataHash: computeMetadataHash(snapshot),
    };
    await atomicWriteFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    // 4) 验证（从磁盘重读，不信任内存对象）
    const verified = await verifySnapshot(this.options.dir, snapshot.id);
    if (!verified.ok) {
      throw new Error(engineMsg('core.backup.snapshotVerifyFailed', { id: snapshot.id, reason: verified.reason ?? '' }));
    }
    // 5) 原子发布 READY（重写 snapshot.json readiness='READY'；metadataHash 稳定不受影响）
    const ready = { ...snapshot, readiness: 'READY' as const };
    await atomicWriteFile(path.join(dir, 'snapshot.json'), JSON.stringify(ready, null, 2));
    // 6) 保留清理（F13：prune 失败不中止已 durable 的 READY 快照——日志记录，upgrade 可继续）
    try {
      await this.prune();
    } catch (err) {
      // 快照已 READY + verified；prune 失败（EBUSY/EPERM）不应把刚成功的快照判为 unusable ——
      // 但必须留痕：保留清理长期失败会让快照无限堆积，用户与日志都看不到线索。
      this.options.onWarn?.(engineMsg('core.backup.pruneFailed', { reason: err instanceof Error ? err.message : String(err) }));
    }
    return snapshot.id;
  }

  async save(snapshot: Snapshot, blobs: Map<string, Uint8Array> = new Map()): Promise<string> {
    const dir = this.snapshotDir(snapshot.id);
    await fs.mkdir(path.join(dir, 'blobs'), { recursive: true });
    const blobHashes: Record<string, string> = {};
    // 1) 写 blobs —— **一遍**同时算 hash（t51：原先独立的第二遍 hash 循环已融合至此）
    for (const [blobPath, data] of blobs) {
      await this.writeBlob(dir, blobPath, data, blobHashes);
    }
    return this.finalizeSnapshot(snapshot, blobHashes);
  }

  /**
   * 流式落盘（t51）：blobs 由**异步可迭代源**提供，逐条取值 → 写盘 + 算 hash（同遍）。
   *
   * 这是 SnapshotStore **接口之外**的可选能力（接口一字未改，见 src/core/types.ts:617）：
   * 调用方可以传一个**异步生成器**按需读盘，于是任一时刻只驻留一条 blob，而不必先把整个
   * 分区载荷读进内存 Map。为什么不做成「惰性 Map」：Map 的迭代协议与 get 都是**同步**的
   * （for...of 的 next() 必须同步返回 Uint8Array；get 返回 Uint8Array 而非 Promise），
   * 惰性读盘只能靠 readFileSync —— 那会把 t46 刚从压缩路径消除的同步 I/O 引回快照路径。
   * 不支持本方法的 store 由调用方经能力探测回退到 save(snapshot, eagerMap)。
   */
  async saveStreaming(snapshot: Snapshot, blobs: AsyncIterable<readonly [string, Uint8Array]>): Promise<string> {
    const dir = this.snapshotDir(snapshot.id);
    await fs.mkdir(path.join(dir, 'blobs'), { recursive: true });
    const blobHashes: Record<string, string> = {};
    for await (const [blobPath, data] of blobs) {
      await this.writeBlob(dir, blobPath, data, blobHashes);
    }
    return this.finalizeSnapshot(snapshot, blobHashes);
  }

  /** 保留清理：扫描快照根目录，超限时删除最旧快照目录（损坏/非快照目录跳过；目录缺失容错）。
 *  P1-⑧：置顶（pinned=true）的快照豁免自动清理——用户显式保留的导入前回滚点不得被
 *  自动淘汰，只能手动删除（deleteSnapshot）。
 *  Phase 4 F3：被 active/quarantine 未收敛 journal 引用的 snapshot（recovery 回滚点）
 *  必须豁免——引用提供者（referencedSnapshotIds）返回的 id 绝不自动清理。 */
  private async prune(): Promise<void> {
    const dir = this.options.dir;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    // F3：被未收敛 journal 引用的快照**绝不自动清理**。判据是「读不到 ≠ 没有引用」——
    // 引用提供者抛错时**放弃本轮清理**，绝不按空集合继续删：一次瞬时 IO 错就可能删掉
    // 事故恢复唯一的回滚点（那是 SAFE MODE 的唯一证据）。此前这里是 `.catch(() => new Set())`。
    let referenced = new Set<string>();
    if (this.options.referencedSnapshotIds !== undefined) {
      try {
        referenced = await this.options.referencedSnapshotIds();
      } catch (err) {
        this.options.onWarn?.(engineMsg('core.backup.pruneAbandoned', { reason: err instanceof Error ? err.message : String(err) }));
        return;
      }
    }
    // m-retention：策略读取失败 → 回退缺省（绝不因策略提供者异常而误删/崩溃）
    const policy = await Promise.resolve()
      .then(() => this.options.retentionPolicy?.() ?? defaultRetentionPolicyLike())
      .catch(() => defaultRetentionPolicyLike());
    const selector = this.options.pruneSelector ?? fallbackPruneSelector;
    const metas: { id: string; createdAt: string }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const parsed = parseJsonSafe(await fs.readFile(path.join(dir, entry.name, 'snapshot.json'), 'utf8')) as Snapshot;
        if (typeof parsed.id !== 'string' || parsed.id === '' || typeof parsed.createdAt !== 'string') continue;
        // 删除目标只能是**目录名**（下面 path.join(dir, id) 就是按它删的）。目录名与内部 id 不一致时
        // **绝不猜**：pinned/被引用的判断是对着这份 snapshot.json 做的，删除却会打在另一个目录上 ——
        // 跳过并留痕（手工改名/半截拷贝残留会出现这种形态）。
        if (parsed.id !== entry.name) {
          this.options.onWarn?.(engineMsg('core.backup.dirNameIdMismatch', { dir: entry.name, id: parsed.id }));
          continue;
        }
        if (parsed.pinned === true) continue; // 置顶快照豁免自动清理
        if (referenced.has(entry.name)) continue; // Phase 4 F3：recovery 引用豁免
        metas.push({ id: entry.name, createdAt: parsed.createdAt });
      } catch {
        // 损坏 / 非快照目录：跳过（与 listSnapshots 语义一致）
      }
    }
    const removedIds: string[] = [];
    for (const id of selector(metas, policy)) {
      const target = path.join(dir, id);
      if (!target.startsWith(dir)) continue; // 越界 id 跳过（不删、不抛，同 save/readBlob 包含性约定）
      await fs.rm(target, { recursive: true, force: true });
      removedIds.push(id);
    }
    // Phase 6：自动保留清理历史回调（best-effort；不改变 prune 行为）
    if (removedIds.length > 0) {
      try { this.options.onPrune?.(removedIds); } catch { /* 历史回调失败不阻断 */ }
    }
  }

  async load(id: string): Promise<Snapshot> {
    const raw = await fs.readFile(path.join(this.snapshotDir(id), 'snapshot.json'), 'utf8');
    return parseJsonSafe(raw) as Snapshot;
  }

  async readBlob(id: string, blobPath: string): Promise<Uint8Array> {
    const target = path.join(this.snapshotDir(id), blobPath);
    const dir = this.options.dir;
    if (!target.startsWith(dir)) throw new Error(engineMsg('core.backup.blobPathEscaped', { path: blobPath }));
    return fs.readFile(target);
  }

  /** 标记快照生命周期状态：重写 <dir>/<id>/snapshot.json（保留其余字段）。 */
  async updateStatus(id: string, status: SnapshotStatus): Promise<void> {
    const file = path.join(this.snapshotDir(id), 'snapshot.json');
    const snapshot = parseJsonSafe(await fs.readFile(file, 'utf8')) as Snapshot;
    snapshot.status = status;
    await atomicWriteFile(file, JSON.stringify(snapshot, null, 2));
  }
}

/* ---------------- Phase 4：manifest / verifySnapshot（F1） ---------------- */

/**
 * 破坏性内容 hash（稳定，不含 readiness/status）：entries + hostFileBackups + beforePlugins。
 * READY 发布与 status 更新不改变此 hash（B-P1-1 修复）。
 */
export function computeMetadataHash(snapshot: Snapshot): string {
  const destructive = {
    entries: snapshot.entries,
    hostFileBackups: snapshot.hostFileBackups ?? [],
    beforePlugins: snapshot.beforePlugins ?? [],
  };
  return sha256Hex(new TextEncoder().encode(JSON.stringify(destructive)));
}

export interface SnapshotVerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * 从磁盘重读并验证快照（F1）：id 合法 + snapshot.json 存在 + manifest 存在 + blob hashes 匹配 +
 * metadataHash 匹配 + 必要 blobs 存在 + 路径安全。不信任内存对象。
 */
export async function verifySnapshot(snapshotsDir: string, id: string): Promise<SnapshotVerifyResult> {
  const dir = path.join(snapshotsDir, id);
  if (!dir.startsWith(path.resolve(snapshotsDir) + path.sep)) {
    return { ok: false, reason: engineMsg('core.backup.snapshotPathEscaped') };
  }
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, 'snapshot.json'), 'utf8');
  } catch {
    return { ok: false, reason: engineMsg('core.backup.snapshotJsonMissing') };
  }
  const snapshot = parseJsonSafe(raw) as Snapshot;
  if (snapshot === null || typeof snapshot !== 'object' || typeof snapshot.id !== 'string' || snapshot.id === '') {
    return { ok: false, reason: engineMsg('core.backup.snapshotJsonInvalid') };
  }
  if (snapshot.id !== id) {
    return { ok: false, reason: engineMsg('core.backup.snapshotIdDirMismatch') };
  }
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
  } catch {
    return { ok: false, reason: engineMsg('core.backup.manifestMissing') };
  }
  const manifest = parseJsonSafe(manifestRaw) as SnapshotManifest;
  if (manifest === null || typeof manifest !== 'object' || manifest.snapshotId !== id) {
    return { ok: false, reason: engineMsg('core.backup.manifestInvalid') };
  }
  // entryCount 匹配（manifest 声明条目数与实际一致，防计数篡改）
  if (typeof manifest.entryCount !== 'number' || manifest.entryCount !== snapshot.entries.length) {
    return { ok: false, reason: engineMsg('core.backup.entryCountMismatch') };
  }
  // metadataHash 匹配（破坏性内容）
  if (computeMetadataHash(snapshot) !== manifest.metadataHash) {
    return { ok: false, reason: engineMsg('core.backup.metadataHashMismatch') };
  }
  // blob hashes 匹配 + 存在
  for (const [blobPath, expectedHash] of Object.entries(manifest.blobHashes)) {
    const target = path.join(dir, blobPath);
    if (!target.startsWith(dir)) return { ok: false, reason: engineMsg('core.backup.blobPathEscaped', { path: blobPath }) };
    let data: Uint8Array;
    try {
      data = await fs.readFile(target);
    } catch {
      return { ok: false, reason: engineMsg('core.backup.blobMissing', { path: blobPath }) };
    }
    if (sha256Hex(data) !== expectedHash) {
      return { ok: false, reason: engineMsg('core.backup.blobHashMismatch', { path: blobPath }) };
    }
  }
  // Review C P2：snapshot.json 引用的每个 blob（entries.copiedTo / hostFileBackups.blobPath）都必须被 manifest 覆盖，
  // 否则攻击者可新增未被哈希校验的 blob（restore 会读+写）→ 覆盖任意 home 文件。
  const referencedBlobs: string[] = [];
  for (const e of snapshot.entries) {
    if (e.kind === 'file' && e.copiedTo && e.copiedTo !== '') referencedBlobs.push(e.copiedTo);
  }
  for (const hb of snapshot.hostFileBackups ?? []) {
    if (hb.blobPath && hb.blobPath !== '' && hb.existed) referencedBlobs.push(hb.blobPath);
  }
  for (const relBlob of referencedBlobs) {
    if (!(relBlob in manifest.blobHashes)) {
      return { ok: false, reason: engineMsg('core.backup.blobNotInManifest', { blob: relBlob }) };
    }
  }
  return { ok: true };
}
