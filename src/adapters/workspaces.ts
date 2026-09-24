/**
 * workspaces 分区 adapter（设计 §3.3/§11）：
 * 数据源 = ~/.dsh/storages/workspace.json 的 tables.workspaces（经 ctx.workspace 门面）。
 * workspace.path 为绝对路径 → 跨设备必须 PathMapping（analyzeImport 生成 PathMapping 项，
 * 映射由引擎 PathMapper 先行应用到 sections，applyItem 拿到的已是映射后数据）。
 */
import { isDeepStrictEqual } from 'node:util';
import { normalizePath } from '../utils/paths.ts';
import { zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { WorkspaceRecord, WorkspacesSection } from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, ExportUnit, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../core/types.ts';
import { validateJsonSection } from './json-section.ts';
// issue #45 勾选联动第二判据：工作区 path 的 cwd 目录键（DSH 就是按它把会话显示在工作区下的）
import { projectKeyOf } from '../core/session-meta.ts';
// issue #45 ③：本次导入**真正带数据**的会话（按 cwd 目录键归属到工作区）
import { bundledSessionDirs, sessionIdKey } from '../core/session-select.ts';

/**
 * 可安全创建的绝对目录路径（issue #45 已知缺口①）。
 *
 * 路径来自备份 = **不可信输入**，所以只放行「完全限定 + 不含 `..` 段」的路径：
 * 相对路径会跟随进程 cwd，`..` 段则可能把目录建到预期之外的位置。
 */
export function isCreatableWorkspacePath(path: string, platform: string = process.platform): boolean {
  if (path === '') return false;
  if (path.split(/[\\/]+/).includes('..')) return false;
  return platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(path) : path.startsWith('/');
}

/** 错误 → 单行原因（消息里带原始文本，便于排查；不抛错）。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WorkspacesAdapter implements ConfigAdapter<WorkspacesSection> {
  readonly id = 'workspaces' as const;
  readonly displayName = 'Workspaces';
  readonly defaultIncluded = true;
  readonly portability = 'platformSpecific' as const;

  async export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<WorkspacesSection>> {
    const records = await ctx.workspace.listRecords();
    // Phase 1 条目级选择：单元 = 一条工作区记录（id 与导入侧 `workspace:<id>` 一致）
    const allow = options.includeItems?.['workspaces'];
    const kept = allow === undefined ? records : records.filter((r) => allow.includes(`workspace:${r.id}`));
    return {
      sectionId: 'workspaces',
      data: { version: 1, workspaces: kept },
      counts: { workspaces: kept.length },
      warnings: [],
    };
  }

  /** 单元清单（零 I/O）：一条工作区记录 = 一个单元；标题缺失时退回 id。 */
  listUnits(section: ExportSection<WorkspacesSection>): ExportUnit[] {
    return section.data.workspaces.map((rec) => ({
      id: `workspace:${rec.id}`,
      label: rec.title !== undefined && rec.title !== '' ? rec.title : rec.id,
      detail: rec.path,
      sizeBytes: 0,
      // issue #45：把「本工作区拥有的会话 id」带给选择器（会话↔工作区联动勾选）
      ...(rec.sessionIds.length > 0 ? { sessionIds: rec.sessionIds } : {}),
      // issue #45 第二判据：sessionIds 覆盖不到的会话靠「cwd 目录键相同」认领（与 DSH 的显示分组同口径）
      projectKey: projectKeyOf(rec.path),
    }));
  }

  async analyzeImport(data: WorkspacesSection, ctx: ImportContext): Promise<PlanItem[]> {
    const msg = ctx.msg;
    const items: PlanItem[] = [];
    for (const rec of data.workspaces) {
      const id = `workspace:${rec.id}`;
      /** issue #45：本工作区拥有的会话 id 随计划项带上（导入选择器据此联动勾选会话） */
      const ownedSessions = {
        ...(rec.sessionIds.length > 0 ? { sessionIds: rec.sessionIds } : {}),
        // 第二判据：sessionIds 覆盖不到的会话按「cwd 目录键相同」认领（与导出侧同一口径）
        projectKey: projectKeyOf(rec.path),
      };
      const existing = (await ctx.target.workspace.listRecords()).find((r) => r.id === rec.id);
      if (!existing) {
        items.push({
          id, kind: 'Create', adapter: 'workspaces',
          ...ownedSessions,
          description: msg('adapter.workspaceCreate', { title: rec.title ?? rec.id, path: rec.path }), severity: 'info',
          target: { adapter: 'workspaces', ref: rec.id },
        });
      } else if (isDeepStrictEqual(existing, rec)) {
        items.push({ id, kind: 'Skip', adapter: 'workspaces', ...ownedSessions, description: msg('adapter.workspaceSame', { id: rec.id }), severity: 'info' });
      } else {
        items.push({
          id, kind: 'Conflict', adapter: 'workspaces',
          ...ownedSessions,
          description: msg('adapter.workspaceDiff', { id: rec.id }),
          detail: `current=${JSON.stringify(existing)} imported=${JSON.stringify(rec)}`.slice(0, 200),
          severity: 'warning', target: { adapter: 'workspaces', ref: rec.id },
        });
      }
      // 绝对路径 → 路径映射提示（oldPrefix 先用整条路径占位，newPrefix 由 UI 确认）
      if (rec.path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rec.path)) {
        items.push({
          id: `${id}:path`, kind: 'PathMapping', adapter: 'workspaces',
          description: msg('adapter.workspacePathMapping', { path: rec.path }), severity: 'warning',
          pathMapping: { oldPrefix: rec.path, newPrefix: '', appliesTo: ['workspaces'] },
          target: { adapter: 'workspaces', ref: rec.id },
        });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    // PathMapping 项：数据已由 PathMapper 应用到 sections，无需额外写入
    if (item.kind === 'PathMapping') return { ok: true };
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: ctx.msg('adapter.missingTargetRef') };
    const data = ctx.sections.get('workspaces') as WorkspacesSection | undefined;
    const rec = data?.workspaces.find((r) => r.id === ref);
    if (!rec) return { ok: false, message: ctx.msg('adapter.workspaceMissing', { ref }) };
    const notes: string[] = [];
    // issue #45 已知缺口①：备份里的工作区路径在本机不存在时，DSH registry.create() 的
    // realpath 直接 ENOENT → 只留一句非致命警告，工作区（以及它的会话归属）全丢。
    // 这里先在**可安全创建的绝对路径**下把缺失目录建出来；失败仍退回原有非致命警告。
    const ensureDir = ctx.target.fs.ensureDir;
    if (ensureDir !== undefined) {
      if (isCreatableWorkspacePath(rec.path, ctx.targetPlatform)) {
        try {
          const created = await ensureDir.call(ctx.target.fs, rec.path);
          if (created.length > 0) notes.push(ctx.msg('adapter.workspaceDirCreated', { dirs: created.join(' / ') }));
        } catch (error) {
          notes.push(ctx.msg('adapter.workspaceDirFailed', { path: rec.path, msg: reasonOf(error) }));
        }
      } else {
        notes.push(ctx.msg('adapter.workspaceDirUnsafe', { path: rec.path }));
      }
    }
    try {
      await ctx.target.workspace.writeRecord(rec);
    } catch (err) {
      // 目标端无法写入（如路径 realpath 失败/目录不存在）→ 非致命警告（§34.17），
      // 不触发整体回滚——否则一个失效路径会拖垮已成功导入的其余配置。
      const reason = err instanceof Error ? err.message : String(err);
      const detail = notes.length > 0 ? '（' + notes.join('；') + '）' : '';
      return {
        ok: false,
        warning: true,
        message: ctx.msg('adapter.workspaceWriteFailed', { ref, msg: reason }) + detail,
      };
    }
    return { ok: true, ...(notes.length > 0 ? { message: notes.join('；') } : {}) };
  }

  /**
   * 全部分区收尾之后（finalizeImport）：把本次导入的工作区记录里声明的会话登记进工作区（issue #45 缺口②）。
   *
   * 为什么要等所有分区收尾：DSH 的 attachSession 要读会话日志的 header 并按 cwd 的 realpath 校验，
   * 而 workspaces 在 APPLY_ORDER 里排在 sessions 之前 —— 在 applyItem 里登记等于「会话还没写完/还没
   * 按映射改写」就去登记，必然被拒。所以这条动作必须等会话分区写完且首帧改写/归位完成之后。
   *
   * 登记目标 = 备份记录声明的 sessionIds **∪ 本包真正带数据的会话**（后者是 issue #45 ③ 的兜底：
   * 注册表 sessionIds 覆盖率极低，旧包甚至完全不含用户勾选那几次对话的 id）。
   *
   * 结果如实上报：**带数据却登记不上**（含 attach 能力缺失 / 找不到工作区实体）→ warning 并给出真实原因；
   * 只是「备份声明了、本次没带数据」的包外会话不计入失败（路径映射救不了它，误导用户去改映射更糟）。
   * 绝不静默失败（导入不因会话登记失败而整体失败，但报告里必须看得见）。
   */
  async finalizeImport(ctx: ImportContext): Promise<ApplyResult[]> {
    const data = ctx.sections.get('workspaces') as WorkspacesSection | undefined;
    if (data === undefined || !Array.isArray(data.workspaces)) return [];
    // issue #45 ③：备份里工作区记录的 sessionIds 覆盖率极低（真机实测 570 条会话里只有 23 条在里面），
    // 旧构建导出的包更是**根本不含**用户勾选那几次对话的 id —— 只按记录的 sessionIds 登记，那几次对话在
    // 目标机上就永远显示不出来（真机复现：3 次对话导入后全部不可见）。所以这里额外按「包内实际带了数据的
    // 会话」登记一遍，属于对旧包/第三方导出器的向后兼容兜底。
    const bundled = bundledSessionDirs(ctx.sections.get('sessions'));
    const results: ApplyResult[] = [];
    for (const rec of data.workspaces) {
      const note = await registerImportedSessions(ctx, rec, bundled.get(projectKeyOf(rec.path)));
      if (note === undefined) continue;
      results.push({
        ok: note.failed === 0,
        ...(note.failed > 0 ? { warning: true } : {}),
        message: note.message,
      });
    }
    return results;
  }

  async validate(data: WorkspacesSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    return validateJsonSection<WorkspacesSection>('workspaces', data, msg, (section, issues) => {
      if (!Array.isArray(section.workspaces)) {
        issues.push({ path: 'workspaces', message: msg('adapter.validate.array', { subject: 'workspaces' }), severity: 'error' });
      } else {
        for (const w of section.workspaces as WorkspaceRecord[]) {
          if (w === null || typeof w !== 'object' || typeof w.id !== 'string' || typeof w.path !== 'string') {
            issues.push({ path: 'workspaces[]', message: msg('adapter.validate.workspaceIdentity'), severity: 'error' });
          }
        }
      }
    });
  }
}

/** 一个待登记会话：同一会话在注册表与日志 header 里可能写成两种形态，两种都要试。 */
interface SessionTarget {
  /** 先试的形态（备份记录声明的优先，其次日志侧目录名） */
  primary: string;
  /** 兜底形态（另一种命名写法 / 日志侧目录名） */
  fallbacks: string[];
  /** 本包是否真的带了它的数据（决定失败算不算问题） */
  inBundle: boolean;
}

/** 同一会话的另一种命名形态（`<uuid>` ↔ `session-<uuid>`）。 */
function otherIdForm(sessionId: string): string {
  const bare = sessionIdKey(sessionId);
  return sessionId === 'session-' + bare ? bare : 'session-' + bare;
}

/**
 * 组装登记目标：备份记录声明的 ∪ 本包带数据的，按**裸键**去重（同一条会话只登记一次）。
 *
 * 为什么要按裸键去重：注册表写 `session-<uuid>`，而日志目录名/header id 两种形态并存——同一个会话
 * 若两种写法都进 targets，会在工作区里出现两次。
 */
function sessionTargets(declared: readonly string[], units: ReadonlyMap<string, string> | undefined): SessionTarget[] {
  const targets: SessionTarget[] = [];
  const byBare = new Map<string, SessionTarget>();
  for (const id of declared) {
    if (id === '') continue;
    const key = sessionIdKey(id);
    if (byBare.has(key)) continue;
    const dir = units?.get(key);
    const fallbacks = [...new Set([
      ...(dir !== undefined && dir !== id ? [dir] : []),
      otherIdForm(id),
    ])].filter((candidate) => candidate !== id);
    const target: SessionTarget = { primary: id, fallbacks, inBundle: dir !== undefined };
    byBare.set(key, target);
    targets.push(target);
  }
  for (const [key, dir] of units ?? []) {
    if (byBare.has(key)) continue;
    const target: SessionTarget = {
      primary: dir,
      fallbacks: [otherIdForm(dir)].filter((candidate) => candidate !== dir),
      inBundle: true,
    };
    byBare.set(key, target);
    targets.push(target);
  }
  return targets;
}

/**
 * 依次试候选 id 登记；成功返回 undefined，全失败返回**第一次**失败原因。
 *
 * 为什么必须试两种形态（真机复现）：DSH 会话日志首帧 header 的 `id` 就是注册表认的 id，而它有
 * `session-<uuid>` 与裸 `<uuid>` 两种并存形态，**与目录名同形但备份记录未必这么写**。旧包（以及
 * 我们按目录名推导的 id）有一半概率与 header 不同形，attach 会以
 * `session persistence holds no such session` 被拒 —— 用户看到的就是「导入后对话不显示」。
 * 试一次另一种写法即可覆盖，且不需要把会话日志容器格式带进 core。
 */
async function attachSessionByCandidates(
  attach: (workspaceId: string, sessionId: string) => Promise<void>,
  facade: unknown,
  workspaceId: string,
  target: SessionTarget,
): Promise<string | undefined> {
  let firstReason: string | undefined;
  for (const candidate of [target.primary, ...target.fallbacks]) {
    try {
      await attach.call(facade, workspaceId, candidate);
      return undefined;
    } catch (error) {
      if (firstReason === undefined) firstReason = reasonOf(error);
    }
  }
  return firstReason ?? '';
}

/**
 * 把备份记录里声明的会话登记进目标机工作区（issue #45 已知缺口②）。
 *
 * 为什么必须补这一步：DSH `workspaceRegistry.create(path, title)` **不接收** sessionIds
 * （成员关系由 registry 自己按 header cwd 维护），所以只导入工作区记录时，那些「文件已恢复、
 * 只存在于备份记录 sessionIds 里」的会话不会出现在任何工作区下 —— 正是报告人看到的
 * 「会话数据恢复了却显示不出来」。
 *
 * 做法：按 path 找到目标工作区实体，对「备份声明的 ∪ 本包带数据的」逐个调 `attachSession`
 * （DSH 自己读 header、按 cwd 的 realpath 校验后才落库；跨机 cwd 不可解析的会被拒），结果如实计数成
 * 一条说明，并把**第一条真实失败原因**带进文案（此前被 `catch {}` 吞掉，报告里只剩一句猜测）。
 * 绝不抛错、绝不静默失败（导入不因会话登记失败而整体失败）。
 */
async function registerImportedSessions(
  ctx: ImportContext,
  rec: WorkspaceRecord,
  units: ReadonlyMap<string, string> | undefined,
): Promise<{ message: string; failed: number } | undefined> {
  const targets = sessionTargets(rec.sessionIds.filter((id) => id !== ''), units);
  if (targets.length === 0) return undefined;
  const attach = ctx.target.workspace.attachSession;
  if (attach === undefined) {
    return { message: ctx.msg('adapter.workspaceSessionsManual', { count: String(targets.length) }), failed: targets.length };
  }
  let owner: WorkspaceRecord | undefined;
  try {
    const records = await ctx.target.workspace.listRecords();
    owner = records.find((r) => normalizePath(r.path) === normalizePath(rec.path)) ?? records.find((r) => r.id === rec.id);
  } catch {
    owner = undefined;
  }
  if (owner === undefined) {
    return { message: ctx.msg('adapter.workspaceSessionsOwnerMissing', { count: String(targets.length) }), failed: targets.length };
  }
  let attached = 0;
  // 失败必须**按「这次有没有带它的数据」分类**，不能靠错误文本猜：
  //  - 带数据却登记不上 = 真问题（要报出原因，用户才能修映射/归位）；
  //  - 没带数据 = 包外会话（目标机本来也没有）—— 路径映射救不了它，把用户支去改映射反而更糟
  //    （真机复现：旧包把它误报成 156 条「cwd 未映射」，用户按提示改映射永远无效）。
  let bundledFailed = 0;
  let outsideFailed = 0;
  let firstReason = '';
  for (const target of targets) {
    const reason = await attachSessionByCandidates(attach, ctx.target.workspace, owner.id, target);
    if (reason === undefined) {
      attached += 1;
      continue;
    }
    if (target.inBundle) {
      bundledFailed += 1;
      if (firstReason === '') firstReason = reason;
    } else {
      outsideFailed += 1;
    }
  }
  const outsideNote = outsideFailed > 0
    ? ctx.msg('adapter.workspaceSessionsOutsideBundle', { count: String(outsideFailed) })
    : '';
  const compose = (head: string): string => (outsideNote === '' || head === '' ? head + outsideNote : head + '；' + outsideNote);
  if (bundledFailed > 0) {
    return {
      message: compose(ctx.msg('adapter.workspaceSessionsPending', {
        ok: String(attached), count: String(bundledFailed), reason: firstReason,
      })),
      failed: bundledFailed,
    };
  }
  const head = attached > 0 ? ctx.msg('adapter.workspaceSessionsAttached', { count: String(attached) }) : '';
  return { message: compose(head), failed: 0 };
}
