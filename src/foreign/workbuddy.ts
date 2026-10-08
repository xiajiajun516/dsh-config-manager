/**
 * WorkBuddy（~\.workbuddy/projects）→ DSH bundle 的**纯**翻译层（会话类）。
 *
 * 输入 = 读盘层（read-workbuddy.ts）已解析好的 `ParsedTranscript`；输出 = `ForeignSource`。
 * 「草稿 → 字节」的唯一出口是共享骨架 `session-source.ts`（工具配对 / seq / surfaceOp /
 * workspaces 同源产出都在那里，本层不重造）。
 *
 * 本来源的两条**结构性**事实（都是「不猜」）：
 *  ① 会话目录名是 cwd 的哈希 → cwd **只能**来自记录字段；没有就交给下游按
 *     `session-missing-cwd` 跳过（绝不产出一条指向不存在目录的会话）；
 *  ② 记录形态未知的字段一律由通用 JSONL 映射逐类计数进 `unsupported-session-record`，绝不静默。
 *
 * 真值表与取证强度（`evidence`）一律从 truth-table.ts 派生：本来源是 `fixture`
 * （夹具 + 单测可复现，**真机未验证**）。probePaths 按真值表模板展开（与 registry.ts 的
 * probePathsOf 同口径），读盘走 joinFor —— 探测面与实读面刻意分开。
 */
import { normalizePlatform } from './platform-paths.ts';
import { draftFromTranscript, sessionSourceOf } from './session-source.ts';
import type { RootProbeOptions } from './session-source.ts';
import { engineMsg } from './messages.ts';
import { FOREIGN_TRUTH_TABLES } from './truth-table.ts';
import type { ForeignTruthTableEntry } from './truth-table.ts';
import type { ForeignSource } from './registry.ts';
import type { ForeignSourceId } from './types.ts';
import { readWorkbuddySessions } from './read-workbuddy.ts';
import type { WorkbuddySessionFile } from './read-workbuddy.ts';

/** 写进 DSH request/header 的 provider 名 */
export const WORKBUDDY_PROVIDER = 'workbuddy';

function truthEntryOf(id: ForeignSourceId): ForeignTruthTableEntry {
  const found = FOREIGN_TRUTH_TABLES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(engineMsg('foreign.truthTableMissingSource', { id }));
  return found;
}

function probePathsFromTruth(id: ForeignSourceId, opts: RootProbeOptions): readonly string[] {
  const entry = truthEntryOf(id);
  return entry.defaults[normalizePlatform(opts.platform)].map((t) => t.split('<home>').join(opts.homeDir));
}

/** 装配 WorkBuddy 来源（每次调用返回一份新定义；注册动作由 registrar 统一做） */
export function createWorkbuddySource(): ForeignSource {
  return sessionSourceOf<WorkbuddySessionFile>({
    id: 'workbuddy',
    evidence: truthEntryOf('workbuddy').evidence,
    probePaths: (opts) => probePathsFromTruth('workbuddy', opts),
    read: (opts) => readWorkbuddySessions(opts),
    draftOf: (file) => draftFromTranscript(file.id, file.parsed, WORKBUDDY_PROVIDER),
  });
}

/** 同一份定义的实例（宿主路由 / 单测可直接用） */
export const workbuddySource: ForeignSource = createWorkbuddySource();
