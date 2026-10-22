/**
 * 恢复的逐动作 WAL（crash 后可判进度，别再退回「整笔不透明」）。
 *
 * 为什么需要：恢复是**多动作**的破坏性操作（整文件还原/删除 → 插件卸载 → file 类补偿）。
 * 执行到一半被 SIGKILL 时，journal 以前只有 operation intent（APPLYING + 零 step + snapshotId=null），
 * 于是 reconcile 只能给出「needs-attention + SAFE MODE」，说不出「哪些还原了、哪些没动」。
 *
 * 语义（与导入引擎 analyzer.ts 的 WAL 完全同构，别另立一套）：
 *  1. **首个写之前**把**全部**会动盘的动作登记为 `planned` 并带上 beforeFp —— 这是关键：
 *     没登记的动作 reconcile 根本不知道存在，只登记「已执行的」会让「崩在第 2 步」被误判成
 *     「全部完成」（recovered）。预登记把「还没做的」变成可证明的「未应用」。
 *  2. 每个动作执行完 → 更新为 `done` + afterFp（重读磁盘算）；失败/不可证明 → `attention`。
 *  3. 删除类动作的期望态是「文件不存在」，用 `ABSENT_FINGERPRINT` 哨兵表达（见 journal.ts）。
 *  4. 插件卸载是外部副作用（可能只改了 package.json 还没 prune node_modules）→ external=true、
 *     不带指纹 ⇒ reconcile 一律保守（unknown → needs-attention）。**刻意不自证**，绝不谎报完成。
 *
 * 判定端不在本模块：reconcile 用 phase3-host 的 verifyStepFingerprint / probeExternal 消费这些 step。
 */
import fs from 'node:fs/promises';

import { sha256Hex } from '../utils/hashing.ts';
import { ABSENT_FINGERPRINT } from './journal.ts';
import type { JournalStepRecord } from './types.ts';

/**
 * 会写盘的动作种类白名单。`credentialHint` / `skip` 无副作用，**不登记** ——
 * 登记它们只会给 reconcile 增加永远无法证明的项（把能判 recovered 的场景拖成 needs-attention）。
 */
const WAL_KINDS: ReadonlySet<string> = new Set([
  'hostFileRestore',
  'hostFileRemove',
  'fileRestore',
  'fileRemove',
  'pluginRemove',
]);

export function isWalActionKind(kind: string): boolean {
  return WAL_KINDS.has(kind);
}

/**
 * 引擎侧最小 journal 端口（结构上兼容 phase3-host 的 JournalRunContext）。
 * 三个回调都**可选**：只给 recordStep 也能工作（只是崩溃后没有可信快照可比对）。
 */
export interface RestoreJournalPort {
  /** 逐动作 WAL step（fail-closed：持久化失败向上传播，绝不静默丢进度）。 */
  recordStep?: (step: JournalStepRecord) => Promise<void>;
  /** 记录本操作可信的快照 id（崩溃后 reconcile 据此判断「有没有可回滚的快照」）。 */
  bindSnapshot?: (snapshotId: string) => Promise<void>;
  /** 首个写之前把 journal 推进到 APPLYING（幂等）。 */
  markApplying?: () => Promise<void>;
}

/**
 * 目标文件的内容指纹。
 *  - 正常：sha256 十六进制
 *  - 文件不存在（ENOENT/ENOTDIR）：`ABSENT_FINGERPRINT`（= 可证明「本来就没有」）
 *  - 其它 IO/权限错误：null（不可指纹 → reconcile 走保守分支，绝不猜）
 */
export async function restoreFingerprint(abs: string | null): Promise<string | null> {
  if (abs === null) return null;
  try {
    return sha256Hex(await fs.readFile(abs));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? ABSENT_FINGERPRINT : null;
  }
}

/** 预登记的一个动作（restore 计划动作的子集：只有 kind ∈ WAL_KINDS 才需要）。 */
export interface RestoreWalEntry {
  kind: string;
  /** 相对 home 的目标（文件类动作；pluginRemove 无） */
  target?: string;
  /** 插件包名（pluginRemove） */
  pluginName?: string;
  /** 文件类动作的**绝对**目标路径（reconcile 直接拿它读盘算指纹）；pluginRemove 传 null */
  abs: string | null;
}

export interface RestoreWalHandle {
  id: string;
  kind: string;
  ref: string;
  external: boolean;
  beforeFp: string | null;
}

export type RestoreWalSettleStatus = 'done' | 'attention' | 'skipped';

export interface RestoreWal {
  /**
   * 预登记全部会动盘的动作（`planned` + beforeFp）。**必须在首个写之前**调用，
   * 且一次传齐 —— 分批登记会让「尚未登记的动作」在崩溃后不可见，从而把半成品判成完成。
   * 返回与入参**同序**的 handle（调用方按动作对象/下标自行对应）。
   */
  preRegister(entries: readonly RestoreWalEntry[]): Promise<(RestoreWalHandle | undefined)[]>;
  /** 动作结束（成功/失败）后更新终态。持久化失败向上抛（fail-closed），绝不吞。 */
  settle(handle: RestoreWalHandle | undefined, status: RestoreWalSettleStatus, message?: string | null): Promise<void>;
}

/**
 * 生成 WAL 句柄。`journal` 缺失或没有 recordStep ⇒ 返回 null（零开销，旧行为不变）。
 */
export function createRestoreWal(journal: RestoreJournalPort | undefined): RestoreWal | null {
  const record = journal?.recordStep;
  if (record === undefined) return null;
  return {
    async preRegister(entries) {
      const out: (RestoreWalHandle | undefined)[] = [];
      for (const entry of entries) {
        if (!isWalActionKind(entry.kind)) {
          out.push(undefined);
          continue;
        }
        // 插件卸载：外部副作用，刻意不带指纹（probeExternal 会得 unknown → 保守）。
        const external = entry.kind === 'pluginRemove';
        const ref = external ? '' : (entry.abs ?? '');
        const beforeFp = external ? null : await restoreFingerprint(entry.abs);
        const id = stepIdOf(entry, ref);
        await record({
          id,
          adapter: 'restore',
          kind: entry.kind,
          ref,
          external,
          status: 'planned',
          beforeFp,
          afterFp: null,
        });
        out.push({ id, kind: entry.kind, ref, external, beforeFp });
      }
      return out;
    },
    async settle(handle, status, message) {
      if (handle === undefined) return;
      const afterFp = handle.external ? null : await restoreFingerprint(handle.ref === '' ? null : handle.ref);
      await record({
        id: handle.id,
        adapter: 'restore',
        kind: handle.kind,
        ref: handle.ref,
        external: handle.external,
        status,
        beforeFp: handle.beforeFp,
        afterFp,
        message: message ?? null,
      });
    },
  };
}

/**
 * step id：**由动作语义派生**而非计划下标 —— 崩溃后磁盘状态变化会让计划下标漂移
 * （已经还原过的文件不再产生 restore 动作），语义 id 才能跨两次执行对上同一条 step。
 */
function stepIdOf(entry: RestoreWalEntry, ref: string): string {
  const subject = entry.kind === 'pluginRemove' ? (entry.pluginName ?? entry.target ?? '') : (ref || (entry.target ?? ''));
  return `restore:${entry.kind}:${subject}`;
}
