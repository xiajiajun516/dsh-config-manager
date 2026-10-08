/**
 * Qoder（~\.qoder/projects）→ DSH bundle 的**纯**翻译层（会话类）。
 *
 * 输入 = 读盘层（read-qoder.ts）已解析好的 `ParsedTranscript`；输出 = `ForeignSource`。
 * 真正的「草稿 → 字节」出口是共享骨架 `session-source.ts` 的
 * `draftFromTranscript` → `transcodeSessionDraft`（工具配对 / seq / surfaceOp / workspaces
 * 同源产出全部在那里，本层**不重造**）。
 *
 * 真值表与取证强度（`evidence`）**一律从 truth-table.ts 派生**（该文件是单一事实源）：
 * 本来源在本仓是 `fixture`（夹具 + 单测可复现，真机未验证）—— 绝不在这里手写更好看的一档。
 *
 * probePaths 也按真值表**模板展开**（与 registry.ts 的 probePathsOf 同一口径）：<home> 令牌
 * 原样替换，因此三平台护栏拿合成探测值比对时逐字相同；**读盘**走 read-qoder.ts 的 joinFor
 * （目标平台原生分隔符）——两者是「探测面」与「实读面」，刻意分开（见 platform-paths.ts 文件头）。
 */
import { normalizePlatform } from './platform-paths.ts';
import { draftFromTranscript, sessionSourceOf } from './session-source.ts';
import type { RootProbeOptions } from './session-source.ts';
import { engineMsg } from './messages.ts';
import { FOREIGN_TRUTH_TABLES } from './truth-table.ts';
import type { ForeignTruthTableEntry } from './truth-table.ts';
import type { ForeignSource } from './registry.ts';
import type { ForeignSourceId } from './types.ts';
import { readQoderSessions } from './read-qoder.ts';
import type { QoderSessionFile } from './read-qoder.ts';

/** 写进 DSH `request/header` 的 provider 名（源侧概念，稳定机器标识） */
export const QODER_PROVIDER = 'qoder';

/** 按 id 取真值表条目；缺条目 = 装配期错误（宁可炸，也不悄悄少一份取证声明） */
function truthEntryOf(id: ForeignSourceId): ForeignTruthTableEntry {
  const found = FOREIGN_TRUTH_TABLES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(engineMsg('foreign.truthTableMissingSource', { id }));
  return found;
}

/** 真值表的 `<home>` 模板 → 目标平台下的绝对探测位置（与 registry.probePathsOf 同口径） */
function probePathsFromTruth(id: ForeignSourceId, opts: RootProbeOptions): readonly string[] {
  const entry = truthEntryOf(id);
  return entry.defaults[normalizePlatform(opts.platform)].map((t) => t.split('<home>').join(opts.homeDir));
}

/**
 * 装配 Qoder 来源（**每次调用返回一份新定义**，与 `builtinForeignSources()` 同语义）。
 * 注册动作由 registrar 统一做 —— 本模块不碰 registry.ts 的清单。
 */
export function createQoderSource(): ForeignSource {
  return sessionSourceOf<QoderSessionFile>({
    id: 'qoder',
    evidence: truthEntryOf('qoder').evidence,
    probePaths: (opts) => probePathsFromTruth('qoder', opts),
    read: (opts) => readQoderSessions(opts),
    draftOf: (file) => draftFromTranscript(file.id, file.parsed, QODER_PROVIDER),
  });
}

/** 同一份定义的实例（宿主路由 / 单测可直接用；语义与 `createQoderSource()` 完全相同） */
export const qoderSource: ForeignSource = createQoderSource();
