/**
 * sessions 分区 adapter（默认关，设计 §3.3/§15）：
 * 数据源 = ~/.dsh/sessions/<projectKey>/<sessionId>/…（zstd jsonl，含敏感信息）。
 * defaultIncluded=false：Quick Export 不包含，用户显式勾选才导出（v1 文件级复制）。
 * 研究报告 §4.9：DSH 无会话批量导出 API，逐会话文件复制是唯一通道。
 *
 * issue #39 Feature 1：支持按数量筛选（`ExportOptions.sessions.limit`），挑选规则与排序在
 * core/session-select.ts（单位 = 会话目录、文件名判据不写死、按日志最新 mtime 倒序）。
 */
import { FileCollectionAdapter } from './file-collection.ts';
import { listFilesDetailed } from './link-report.ts';
import { msgOf } from '../core/messages.ts';
import { groupSessionUnits, isSessionLogFileName, normalizeSessionLimit, pickLatestSessionUnits, sessionIdKey } from '../core/session-select.ts';
import { projectKeyOf } from '../core/session-meta.ts';
import { applyPathMapping } from '../core/path-mapping.ts';
import { toNativePath } from '../utils/paths.ts';
import { sha256Hex } from '../utils/hashing.ts';
import { readLogHeaderFromBytes, type SessionLogHeader } from '../utils/session-log.ts';
import type { ApplyResult, ExportOptions, ExportSection, HostContext, ImportContext } from '../core/types.ts';
import type { FilesSection } from '../schema/types.ts';
import { toPosixRel } from './units.ts';

/** 逐批并发 stat 的批大小：会话树可能有上千个日志文件，一次性开满 Promise 会打爆 libuv 线程池 */
const MTIME_BATCH = 16;

export class SessionsAdapter extends FileCollectionAdapter {
  readonly id = 'sessions' as const;
  readonly displayName = 'Sessions';
  readonly defaultIncluded = false;
  readonly portability = 'deviceSpecific' as const;
  readonly baseDir = 'sessions';

  /**
   * 单元 = `<projectKey>/<sessionId>`。
   *
   * 不能用基类默认的「首个路径段」——那会把**整个项目的所有会话**捆成一个单元，
   * 粒度粗到用户无法只挑几次会话；也不能取全部路径段，那会把一次会话的文件拆散
   * （jsonl / 附件 / 索引必须同进同出）。
   */
  protected override unitIdOf(relativePath: string): string {
    const parts = toPosixRel(relativePath).split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : toPosixRel(relativePath);
  }

  /**
   * 「最新 N 个会话」预筛选（issue #39 Feature 1）。
   *
   * 语义与 `ExportOptions.sessions.limit` 一致：缺省 / 负数 = 不筛选；0 = 一个都不带；
   * 正数 = 最新 N 个（按会话目录下最新一份会话日志的 mtime 倒序）。
   * 宿主门面不提供 `mtimeMs`（或整棵树的日志都读不到时间）时**退回全量 + 告警** ——
   * 绝不把「时间未知」当成「最旧」，那会静默丢掉最近的会话。
   */
  protected override async restrictUnits(
    ctx: HostContext,
    rels: readonly string[],
    options: ExportOptions,
  ): Promise<{ keep: Set<string> | null; warnings: string[] } | null> {
    const limit = normalizeSessionLimit(options.sessions?.limit);
    if (limit === undefined || limit < 0) return null;
    const msg = msgOf(ctx);
    // baseDir 相对路径 → homeDir 相对路径（FileSystemFacade 只认后者）
    const homeRelOf = new Map<string, string>();
    const relPaths: string[] = [];
    for (const rel of rels) {
      const relPath = toPosixRel(this.relPathOf(rel));
      homeRelOf.set(relPath, rel);
      relPaths.push(relPath);
    }
    const logRels = relPaths.filter((p) => isSessionLogFileName(p.split('/').pop() ?? ''));
    if (ctx.fs.mtimeMs === undefined) {
      return { keep: null, warnings: [msg('export.sessionsLimitNoMtime')] };
    }
    const mtimes = await this.logMtimes(ctx, logRels, homeRelOf);
    const units = groupSessionUnits(relPaths, (rel) => mtimes.get(rel) ?? null);
    // 一个会话的日志时间都读不到 → 排序无意义，退回全量（宁可多带，不可静默少带）
    if (units.length > 0 && units.every((u) => u.latestMtimeMs === null)) {
      return { keep: null, warnings: [msg('export.sessionsLimitNoMtime')] };
    }
    const keep = pickLatestSessionUnits(units, limit);
    const warnings = limit === 0
      ? [msg('export.sessionsNone')]
      : [msg('export.sessionsLimited', { count: String(keep.size), total: String(units.length) })];
    return { keep, warnings };
  }

  /**
   * 本机**全部**会话单元 id（P1-5 会话删除墓碑的「本机现存集合」）。
   *
   * 只做「列目录 + 按单元分组」，**不 stat 时间**（时间只用于排序，这里只要集合）——比
   * restrictUnits 少一轮 stat，扫描千级会话库的代价可接受。目录不可读 → 空数组：调用方
   * 据此**跳过**本轮删除检测（把「读不到」当成「全删了」会误标一大片墓碑）。
   */
  async listAllUnitIds(ctx: HostContext): Promise<string[]> {
    let listing: Awaited<ReturnType<typeof listFilesDetailed>>;
    try {
      listing = await listFilesDetailed(ctx.fs, this.baseDir);
    } catch {
      return [];
    }
    const relPaths = listing.paths.map((rel) => toPosixRel(this.relPathOf(rel)));
    // mtime 恒 null：只要「哪些单元存在」，排序规则在此无意义（绝不因此丢单元）
    return groupSessionUnits(relPaths, () => null).map((u) => `${this.id}:${u.unitId}`);
  }

  /**
   * 会话日志文件 → mtime（毫秒；读不到 = null）。批量并发 stat，避免一次性开满 Promise 打爆 libuv 线程池。
   *
   * 两个调用方共用同一实现（口径不许漂移）：
   *  - `restrictUnits`：「最新 N 个会话」预筛选（issue #39 Feature 1）；
   *  - `unitActivityTimes`：导出选择器「历史对话按最新到最旧排序」的时间来源。
   *
   * @param rels 调用方的键（这里一律是 baseDir 相对路径）；@param homeRelOf 把它们映射到
   *   FileSystemFacade 认的 homeDir 相对路径（缺省 = 键本身就是 homeDir 相对路径）。
   */
  private async logMtimes(
    ctx: HostContext,
    rels: readonly string[],
    homeRelOf: ReadonlyMap<string, string> = new Map(),
  ): Promise<Map<string, number | null>> {
    const mtimeMs = ctx.fs.mtimeMs;
    const out = new Map<string, number | null>();
    if (mtimeMs === undefined) {
      for (const rel of rels) out.set(rel, null);
      return out;
    }
    for (let i = 0; i < rels.length; i += MTIME_BATCH) {
      const batch = rels.slice(i, i + MTIME_BATCH);
      const read = await Promise.all(batch.map(async (rel): Promise<number | null> => {
        try {
          return await mtimeMs.call(ctx.fs, homeRelOf.get(rel) ?? rel);
        } catch {
          return null;
        }
      }));
      batch.forEach((rel, idx) => out.set(rel, read[idx] ?? null));
    }
    return out;
  }

  /**
   * 导出选择器的排序时间源（宿主 `/export-preview` 调用）：会话裸键 → 该会话**最新一份**日志的 mtime。
   *
   * 为什么需要它：会话标题与活跃时间来自 DSH 的 `storages/session_projcache.json`，而那份缓存只覆盖
   * **一部分**会话（真机实测：同一项目 731 个会话目录里 347 个不在缓存内）。这些会话拿不到时间，
   * 只能按 uuid 字典序排在组尾 —— 用户看到的就是「历史对话没有按最新到最旧排序」。会话日志 mtime
   * 对每个会话都存在，且与「最新 N 个会话」预筛选（restrictUnits）**同一口径**（同一门面、同一批大小）。
   *
   * 返回键 = `sessionIdKey(目录名)`（`session-<uuid>` 与裸 `<uuid>` 归一化成同一个会话，取较大者）；
   * 时间读不到的会话**不进 Map**（调用方按「时间未知」处理，绝不把未知当成 0 —— 那会把它排到最旧）。
   * 宿主不提供 `mtimeMs` 门面 → 返回空 Map（调用方退回元数据缓存时间，行为与改造前一致）。
   */
  async unitActivityTimes(ctx: HostContext, section: ExportSection<FilesSection>): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const logRels: string[] = [];
    const homeRelOf = new Map<string, string>();
    const keyOfRel = new Map<string, string>();
    for (const file of section.data.files) {
      const relPath = toPosixRel(file.relativePath);
      const name = relPath.split('/').pop() ?? '';
      if (!isSessionLogFileName(name)) continue;
      const dir = toPosixRel(this.unitIdOf(relPath)).split('/')[1] ?? '';
      if (dir === '') continue;
      logRels.push(relPath);
      homeRelOf.set(relPath, toPosixRel(this.baseDir + '/' + relPath));
      keyOfRel.set(relPath, sessionIdKey(dir));
    }
    const mtimes = await this.logMtimes(ctx, logRels, homeRelOf);
    for (const [rel, at] of mtimes) {
      if (at === null) continue;
      const key = keyOfRel.get(rel);
      if (key === undefined) continue;
      const prev = out.get(key);
      if (prev === undefined || at > prev) out.set(key, at);
    }
    return out;
  }

  /**
   * 分区收尾（issue #45）：把用户填的路径映射**同时**作用到会话日志首帧 cwd 与目录位置。
   *
   * 为什么必须做：DSH 判定工作区成员要求 realpath(会话首帧 cwd) == workspace.path 且 id 在
   * sessionIds 里；跨机恢复时 header 还是源机路径，attachSession 必然被拒 —— 这正是
   * 「会话数据恢复了却显示不出来」。workspace.path 侧已由 analyzer 应用了同一份映射，
   * 这里补上会话侧，两边共用同一个 applyPathMapping（口径不许漂移）。
   *
   * 顺序与一致性（DSH 启动时校验「日志位置 == projectKeyOf(header.cwd)/id」，不一致直接拒绝启动）：
   *   ① 先改写首帧（全部 generation）→ ② 再按映射后的 cwd 归位目录 → ③ 目录搬不动就回滚首帧。
   * 任何一步失败都如实报告，绝不留「header 与位置不一致」的半套状态；回滚也失败时按硬失败上报
   * （宁可让 rollbackOnError 把这次导入整体回滚，也不要悄悄留下坏状态）。
   *
   * 没有命中映射时退回原有护栏：只校验「目录段 == projectKeyOf(首帧 cwd)」，不一致就归位。
   * 读不出 cwd（非日志 / 非 zstd / 首帧不完整）→ 跳过该单元：不猜、不动、也不谎报通过。
   */
  /**
   * 导出收尾：选中子代理会话时**连带它的父对话**（真机事故：导入全部成功，工作区里却看不见）。
   *
   * 为什么（DSH 客户端源码 dsh-client-ui-workspace 的 sessionVisible）：
   *   session.origin !== "subagent" && ...
   * —— 工作区列表**只显示** origin !== 'subagent' 的会话；子代理会话只在**父对话之下**出现。
   * 于是「只导出子会话、不带父对话」的包在导入侧一切成功（文件落盘、workspace.json 也登记了），
   * 用户在 DSH 工作区里却一条都看不到（真机：用户勾了 4 条子代理会话导出再导入，全无踪影）。
   * 所以导出侧按父链补齐（父对话本身也可能是子代理会话 → 继续往上追），并在报告里如实说明；
   * 追不到（本机没有 / 超出分区上限）也绝不静默。
   */
  override async export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<FilesSection>> {
    const section = await super.export(ctx, options);
    return await this.coupleSessionParents(ctx, section);
  }

  /** 一个会话单元的 header（取该单元第一份日志；读不出 → undefined，不猜）。 */
  private firstUnitHeader(files: readonly FilesSection['files'][number][]): SessionLogHeader | undefined {
    for (const file of files) {
      const name = toPosixRel(file.relativePath).split('/').pop() ?? '';
      if (!isSessionLogFileName(name)) continue;
      const header = readLogHeaderFromBytes(file.data);
      if (header !== undefined) return header;
    }
    return undefined;
  }

  /**
   * 按「父会话 id」在本机找它的会话目录（两种命名形态 + 子会话所在项目键优先）。
   * 只认「目录里真有会话日志」的候选：空目录 / 同名目录不算命中（不猜）。
   */
  private async findSessionDir(
    ctx: HostContext,
    parentId: string,
    childKey: string,
    otherKeys: readonly string[],
  ): Promise<string | null> {
    const bare = sessionIdKey(parentId);
    const names = parentId.startsWith('session-') ? [parentId, bare] : ['session-' + bare, bare];
    for (const key of [childKey, ...otherKeys]) {
      if (key === '') continue;
      for (const name of names) {
        if (name === '') continue;
        const dirRel = this.baseDir + '/' + key + '/' + name;
        let listing;
        try {
          listing = await listFilesDetailed(ctx.fs, dirRel);
        } catch {
          continue;
        }
        if (listing.paths.some((p) => isSessionLogFileName(p.split(/[\\/]/).pop() ?? ''))) return dirRel;
      }
    }
    return null;
  }

  /**
   * 目标机上是否已有该父对话。
   *
   * 探测面 = 两种目录命名形态（`session-<uuid>` / 裸 `<uuid>`）× 目录本身 + 三种已知日志文件名：
   * 目录级探测在真实宿主上就够，文件级探测则让内存 fs（单测）与「日志名不按常见形态」的机器也能命中。
   * 探针异常按「不知道」处理 —— 宁可多告警一条（可解释），也不静默放过。
   */
  private async parentExistsLocally(ctx: ImportContext, parentId: string, key: string): Promise<boolean> {
    if (key === '') return false;
    const bare = sessionIdKey(parentId);
    const names = parentId.startsWith('session-') ? [parentId, bare] : ['session-' + bare, bare];
    const probes: string[] = [];
    for (const name of names) {
      if (name === '') continue;
      const dir = this.baseDir + '/' + key + '/' + name;
      probes.push(dir);
      for (const file of ['session.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl']) probes.push(dir + '/' + file);
    }
    for (const rel of probes) {
      try {
        if (await ctx.target.fs.exists(rel)) return true;
      } catch {
        // 探测失败继续试下一个候选
      }
    }
    return false;
  }

  /**
   * 导出侧会话族补齐：**只向上补父对话**（选中子代理会话 → 连带它的父对话，否则 DSH 工作区列表里
   * 一条都看不见）。追不到（本机没有 / 超出分区上限）一律进报告，绝不静默。
   *
   * **引擎为什么不再向下展开**（历史上这里还有一条「勾父带子」）：条目级白名单是**用户意图的唯一事实**，
   * 而引擎看不到「界面为什么没勾这条子会话」—— 一旦自己向下补，「用户在界面上单独取消某条子代理会话」
   * 就会被无声地加回包里（真机事故：只勾 2 条，导出 41 个会话目录）。所以「勾父带子」改由**界面**在
   * 勾选时联动完成（`src/ui/selection-model.ts` 的 `applySessionParentCoupling`：勾父自动勾上它的子代理
   * 会话、勾子自动带上父、取消父连带取消子），引擎只保留这条「不让用户吃亏」的**向上**兜底
   * （父对话缺席 = 导入后在工作区里完全看不见）。
   */
  private async coupleSessionParents(
    ctx: HostContext,
    section: ExportSection<FilesSection>,
  ): Promise<ExportSection<FilesSection>> {
    const files = section.data.files;
    if (!Array.isArray(files) || files.length === 0) return section;
    const msg = msgOf(ctx);
    const byUnit = new Map<string, FilesSection['files']>();
    for (const file of files) {
      const unit = toPosixRel(this.unitIdOf(file.relativePath));
      const list = byUnit.get(unit) ?? [];
      list.push(file);
      byUnit.set(unit, list);
    }
    const present = new Set<string>();
    const headers = new Map<string, SessionLogHeader>();
    for (const [unit, members] of byUnit) {
      const header = this.firstUnitHeader(members);
      if (header === undefined) continue;
      headers.set(unit, header);
      present.add(sessionIdKey(header.id ?? unit.split('/')[1] ?? ''));
    }
    const allKeys = [...new Set([...byUnit.keys()].map((unit) => unit.split('/')[0] ?? '').filter((key) => key !== ''))];
    /** 待补齐的父对话（key 只用于「优先在同一项目里找」）。 */
    const queue: { sessionId: string; key: string }[] = [];
    // 向上：子代理会话缺父对话 → 补（父对话本身也可能是子代理会话 → 循环里继续往上追）
    for (const [unit, header] of headers) {
      if (header.origin !== 'subagent') continue;
      const parentId = header.parentSessionId;
      if (parentId === undefined || parentId === '') continue;
      if (present.has(sessionIdKey(parentId))) continue;
      queue.push({ sessionId: parentId, key: unit.split('/')[0] ?? '' });
    }
    if (queue.length === 0) return section;
    const addedParents: string[] = [];
    const uncoupled: string[] = [];
    const limit = this.sectionByteLimit();
    let usedBytes = files.reduce((n, file) => n + file.data.byteLength, 0);
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      if (present.has(sessionIdKey(next.sessionId))) continue;
      const dirRel = await this.findSessionDir(ctx, next.sessionId, next.key, allKeys);
      if (dirRel === null) {
        uncoupled.push(next.sessionId + '（' + msg('export.sessionRelationNotFound') + '）');
        continue;
      }
      const listing = await listFilesDetailed(ctx.fs, dirRel);
      const loaded: FilesSection['files'] = [];
      let unitBytes = 0;
      let tooLarge = false;
      for (const rel of listing.paths) {
        const data = await ctx.fs.readFile(rel);
        unitBytes += data.byteLength;
        if (usedBytes + unitBytes > limit) { tooLarge = true; break; }
        loaded.push({ relativePath: this.relPathOf(rel), data, contentHash: sha256Hex(data) });
      }
      if (tooLarge || loaded.length === 0) {
        uncoupled.push(next.sessionId + '（' + msg('export.sessionParentTooLarge') + '）');
        continue;
      }
      usedBytes += unitBytes;
      const unit = toPosixRel(this.unitIdOf(this.relPathOf(dirRel)));
      for (const file of loaded) files.push(file);
      byUnit.set(unit, loaded);
      const header = this.firstUnitHeader(loaded);
      const bare = sessionIdKey(header?.id ?? unit.split('/')[1] ?? '');
      present.add(bare);
      addedParents.push(unit);
      // 连带进来的父对话自己还可能是子代理会话（父链多层）→ 继续向上追
      if (header?.origin === 'subagent' && header.parentSessionId !== undefined && !present.has(sessionIdKey(header.parentSessionId))) {
        queue.push({ sessionId: header.parentSessionId, key: unit.split('/')[0] ?? '' });
      }
    }
    if (addedParents.length > 0) {
      section.counts.files = files.length;
      section.warnings.push(msg('export.sessionParentsCoupled', { count: String(addedParents.length) }));
    }
    if (uncoupled.length > 0) {
      section.warnings.push(msg('export.sessionParentsUncoupled', {
        count: String(uncoupled.length),
        detail: uncoupled.slice(0, 5).join(', '),
      }));
    }
    return section;
  }

  /**
   * 导入侧：子代理会话的父对话**既不在本包内、本机也没有** → 一条 warning。
   *
   * 为什么要探测「本机有没有」：目标机本来就有该父对话时（例如把旧包导回同机），子会话会正常
   * 挂在本地父对话之下 —— 无脑告警会把正常情况说成「看不到」，比不告警更糟。
   */
  private async orphanSubagentWarnings(
    ctx: ImportContext,
    byUnit: Map<string, FilesSection['files']>,
  ): Promise<ApplyResult[]> {
    const imported = new Set<string>();
    const headers = new Map<string, SessionLogHeader>();
    for (const [unit, files] of byUnit) {
      const header = this.firstUnitHeader(files);
      if (header === undefined) continue;
      headers.set(unit, header);
      imported.add(sessionIdKey(header.id ?? unit.split('/')[1] ?? ''));
    }
    const orphans: string[] = [];
    for (const [unit, header] of headers) {
      if (header.origin !== 'subagent') continue;
      const parentId = header.parentSessionId;
      if (parentId === undefined || parentId === '') continue;
      if (imported.has(sessionIdKey(parentId))) continue;
      if (await this.parentExistsLocally(ctx, parentId, unit.split('/')[0] ?? '')) continue;
      orphans.push(unit.split('/')[1] ?? unit);
    }
    if (orphans.length === 0) return [];
    return [{
      ok: false,
      warning: true,
      message: ctx.msg('import.subagentSessionsWithoutParents', {
        count: String(orphans.length),
        units: orphans.slice(0, 5).join(', '),
      }),
    }];
  }

  async finalizeApply(ctx: ImportContext): Promise<ApplyResult[]> {
    const data = ctx.sections.get('sessions') as FilesSection | undefined;
    if (data === undefined || !Array.isArray(data.files)) return [];
    const byUnit = new Map<string, FilesSection['files']>();
    for (const file of data.files) {
      const unit = toPosixRel(this.unitIdOf(file.relativePath));
      const list = byUnit.get(unit) ?? [];
      list.push(file);
      byUnit.set(unit, list);
    }
    // 父对话缺席的子代理会话：先如实告警（这是数据层面的结论，与本机有没有归位能力无关）
    const results: ApplyResult[] = await this.orphanSubagentWarnings(ctx, byUnit);
    const store = ctx.target.sessions;
    if (store?.readLogCwd === undefined || store.relocateDir === undefined) return results;
    const mappings = ctx.pathMappings ?? [];
    const rewrite = store.rewriteLogDir;
    const reindex = store.reindexSessionHeader;
    for (const [unit, files] of byUnit) {
      let cwd: string | undefined;
      for (const file of files) {
        const name = toPosixRel(file.relativePath).split('/').pop() ?? '';
        if (!isSessionLogFileName(name)) continue;
        try {
          cwd = store.readLogCwd(file.data);
        } catch {
          cwd = undefined;
        }
        if (cwd !== undefined && cwd !== '') break;
      }
      if (cwd === undefined || cwd === '') continue;
      const parts = unit.split('/');
      const current = parts[0] ?? '';
      const sessionDir = parts[1] ?? '';
      if (current === '' || sessionDir === '') continue;
      const dirRel = current + '/' + sessionDir;
      // ① 命中路径映射 → 同一条映射也改会话首帧（用户只填一次）
      const mapped = applyPathMapping(cwd, mappings);
      if (mapped !== null) {
        // 写进首帧的 cwd 必须与 DSH 工作区记录里的 path **逐字一致**（issue #45 不变量）：
        // 工作区一侧由 DSH 按 realpath 落库（Windows 上是反斜杠原生形），而 applyPathMapping 的
        // 输出统一是正斜杠 —— 直接写进去两边只差分隔符，如今全靠 DSH 的 realpath 兜着
        // （真机实测：能列出、重启不被剪，但任何按字符串比较的校验都会判不一致）。
        const mappedNative = toNativePath(mapped, ctx.targetPlatform);
        const expectedMapped = projectKeyOf(mappedNative);
        if (rewrite === undefined) {
          results.push({ ok: false, warning: true, message: ctx.msg('import.sessionRewriteFailed', { unit, reason: 'unavailable' }) });
          continue;
        }
        const rewritten = await rewrite.call(store, dirRel, mappedNative);
        if (!rewritten.ok) {
          results.push({ ok: false, warning: true, message: ctx.msg('import.sessionRewriteFailed', { unit, reason: rewritten.reason ?? 'unavailable' }) });
          continue;
        }
        // ② 目录必须跟着 header 一起归位
        if (current !== expectedMapped) {
          const moved = await store.relocateDir(dirRel, expectedMapped);
          if (!moved.moved && moved.reason !== 'already-there') {
            // ③ 搬不动 → 回滚首帧，绝不留半套
            let back: { ok: boolean } = { ok: false };
            try {
              back = await rewrite.call(store, dirRel, cwd);
            } catch {
              back = { ok: false };
            }
            results.push({
              ok: false,
              ...(back.ok ? { warning: true } : {}),
              message: ctx.msg(back.ok ? 'import.sessionRewriteRolledBack' : 'import.sessionRewriteRollbackFailed', { unit, reason: moved.reason ?? 'unavailable' }),
            });
            continue;
          }
        }
        // 注册表内存里可能仍是旧 cwd（改写后 attachSession 会拿旧值校验）→ 尽力刷新，失败不谎报
        if (reindex !== undefined) {
          try {
            await reindex.call(store, sessionDir);
          } catch {
            // 尽力而为：不影响已完成的改写与归位
          }
        }
        results.push({ ok: true, message: ctx.msg('import.sessionRewritten', { unit, from: cwd, to: mappedNative, key: expectedMapped }) });
        continue;
      }
      // ② 未命中映射 → 原有位置护栏（只搬目录，不改内容）
      const expected = projectKeyOf(cwd);
      if (current === expected) continue;
      const moved = await store.relocateDir(dirRel, expected);
      if (moved.moved) {
        results.push({ ok: true, message: ctx.msg('import.sessionRelocated', { unit, from: current, to: expected }) });
      } else {
        results.push({ ok: false, message: ctx.msg('import.sessionRelocateFailed', { unit, reason: moved.reason ?? 'unavailable' }) });
      }
    }
    return results;
  }
}
