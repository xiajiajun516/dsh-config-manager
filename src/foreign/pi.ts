/**
 * Pi（~\.pi/agent/sessions）→ DSH bundle 的**纯**翻译层（会话类）。
 *
 * 输入 = 读盘层（read-pi.ts）已解析好的 `ParsedTranscript`（专用事件流解析：会话头单独处理、
 * 活动分支按 id/parentId 还原、工具结果按 toolCallId 挂回声明步、目录名反解已过存在性检查）；
 * 输出 = `ForeignSource`。
 * 「草稿 → 字节」的唯一出口是共享骨架 `session-source.ts`（工具配对 / seq / surfaceOp /
 * workspaces 同源产出都在那里，本层不重造）。
 *
 * 三条纪律：
 *  ① 会话头（`type:"session"`）不是消息（按 JSONL 逐行当消息会把头当成一条空消息）；
 *  ② cwd 只认「头里的字段」或「目录名反解 + 本机存在」，两者都不成立 → 交给下游
 *     `session-missing-cwd`（绝不产出一条指向不存在目录的会话）；
 *  ③ 只转**活动分支**（末条目沿 parentId 走到根；旁支在 `read-pi.ts` 已丢弃并计数）。
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
import { readPiSessions } from './read-pi.ts';
import type { PiSessionFile } from './read-pi.ts';

/** 写进 DSH request/header 的 provider 名 */
export const PI_PROVIDER = 'pi';

function truthEntryOf(id: ForeignSourceId): ForeignTruthTableEntry {
  const found = FOREIGN_TRUTH_TABLES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(engineMsg('foreign.truthTableMissingSource', { id }));
  return found;
}

function probePathsFromTruth(id: ForeignSourceId, opts: RootProbeOptions): readonly string[] {
  const entry = truthEntryOf(id);
  return entry.defaults[normalizePlatform(opts.platform)].map((t) => t.split('<home>').join(opts.homeDir));
}

/** 装配 Pi 来源（每次调用返回一份新定义；注册动作由 registrar 统一做） */
export function createPiSource(): ForeignSource {
  return sessionSourceOf<PiSessionFile>({
    id: 'pi',
    evidence: truthEntryOf('pi').evidence,
    probePaths: (opts) => probePathsFromTruth('pi', opts),
    read: (opts) => readPiSessions(opts),
    draftOf: (file) => draftFromTranscript(file.id, file.parsed, PI_PROVIDER),
  });
}

/** 同一份定义的实例（宿主路由 / 单测可直接用） */
export const piSource: ForeignSource = createPiSource();
