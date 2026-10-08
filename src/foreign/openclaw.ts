/**
 * OpenClaw（~\.openclaw/agents）→ DSH bundle 的**纯**翻译层（会话类）。
 *
 * 输入 = 读盘层（read-openclaw.ts）已解析好的 `ParsedTranscript`（标题已按伴生
 * `sessions.json` 索引的 displayName 回填）；输出 = `ForeignSource`。
 * 「草稿 → 字节」的唯一出口是共享骨架 `session-source.ts`（工具配对 / seq / surfaceOp /
 * workspaces 同源产出都在那里，本层不重造）。
 *
 * 两条纪律：
 *  ① 索引只贡献**显示名**（一个字符串）；索引里的其它字段连内存都不进 → 凭据值无从进包；
 *  ② 记录里没有 cwd 的会话按 `session-missing-cwd` 跳过并报码（绝不产出一条指向不存在
 *     目录的会话）。
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
import { readOpenclawSessions } from './read-openclaw.ts';
import type { OpenclawSessionFile } from './read-openclaw.ts';

/** 写进 DSH request/header 的 provider 名 */
export const OPENCLAW_PROVIDER = 'openclaw';

function truthEntryOf(id: ForeignSourceId): ForeignTruthTableEntry {
  const found = FOREIGN_TRUTH_TABLES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(engineMsg('foreign.truthTableMissingSource', { id }));
  return found;
}

function probePathsFromTruth(id: ForeignSourceId, opts: RootProbeOptions): readonly string[] {
  const entry = truthEntryOf(id);
  return entry.defaults[normalizePlatform(opts.platform)].map((t) => t.split('<home>').join(opts.homeDir));
}

/** 装配 OpenClaw 来源（每次调用返回一份新定义；注册动作由 registrar 统一做） */
export function createOpenclawSource(): ForeignSource {
  return sessionSourceOf<OpenclawSessionFile>({
    id: 'openclaw',
    evidence: truthEntryOf('openclaw').evidence,
    probePaths: (opts) => probePathsFromTruth('openclaw', opts),
    read: (opts) => readOpenclawSessions(opts),
    draftOf: (file) => draftFromTranscript(file.id, file.parsed, OPENCLAW_PROVIDER),
  });
}

/** 同一份定义的实例（宿主路由 / 单测可直接用） */
export const openclawSource: ForeignSource = createOpenclawSource();
