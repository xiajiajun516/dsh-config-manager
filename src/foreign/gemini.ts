/**
 * Gemini CLI（~\.gemini/history）→ DSH bundle 的**纯**翻译层（会话类）。
 *
 * 输入 = 读盘层（read-gemini.ts）已解析好的 `ParsedTranscript`；输出 = `ForeignSource`。
 * 「草稿 → 字节」的唯一出口是共享骨架 `session-source.ts`（工具配对 / seq / surfaceOp /
 * workspaces 同源产出都在那里，本层不重造）。
 *
 * 交叉核对结论（详见 read-gemini.ts 文件头）：四份报告里**根**逐字一致，但**形态**有两说 ——
 * captain 的 PLAN-B §0.3 写 JSONL，read-chat-import.md §3.1/§8.4 两处明确写「JSON（单文件
 * 一对象，非 JSONL）」。按任务纪律「有出入以 chat-import 为准」，本来源按**单对象 JSON** 实现。
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
import { readGeminiSessions } from './read-gemini.ts';
import type { GeminiSessionFile } from './read-gemini.ts';

/** 写进 DSH request/header 的 provider 名 */
export const GEMINI_PROVIDER = 'gemini';

function truthEntryOf(id: ForeignSourceId): ForeignTruthTableEntry {
  const found = FOREIGN_TRUTH_TABLES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(engineMsg('foreign.truthTableMissingSource', { id }));
  return found;
}

function probePathsFromTruth(id: ForeignSourceId, opts: RootProbeOptions): readonly string[] {
  const entry = truthEntryOf(id);
  return entry.defaults[normalizePlatform(opts.platform)].map((t) => t.split('<home>').join(opts.homeDir));
}

/** 装配 Gemini CLI 来源（每次调用返回一份新定义；注册动作由 registrar 统一做） */
export function createGeminiSource(): ForeignSource {
  return sessionSourceOf<GeminiSessionFile>({
    id: 'gemini',
    evidence: truthEntryOf('gemini').evidence,
    probePaths: (opts) => probePathsFromTruth('gemini', opts),
    read: (opts) => readGeminiSessions(opts),
    draftOf: (file) => draftFromTranscript(file.id, file.parsed, GEMINI_PROVIDER),
  });
}

/** 同一份定义的实例（宿主路由 / 单测可直接用） */
export const geminiSource: ForeignSource = createGeminiSource();
