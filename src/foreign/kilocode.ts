/**
 * kilocode 会话来源的**翻译层**（wiring + draftOf；纯装配，零 I/O）。
 *
 * 位置真值与取证强度都取自 `truth-table.ts`（该表是 evidence/probePaths 的单一事实源；
 * 与四份竞品调研交叉核对：read-chat-import §3.1、read-movein 附录 A、read-vault §10、
 * read-claude-move §8，有出入以 chat-import 为准）：
 * 真值表：`<home>/.local/share/kilo/kilo.db`（**目录名是 kilo**；opencode fork）。
 *
 * **evidence 取自真值表（本来源 = 'fixture'）**（真机未验证；读盘层用**真实临时库夹具 + 单测**端到端跑同一形态）。
 * 真机上这些库的具体 schema 未取证 —— 读盘层因此一律走「PRAGMA 自适应列 + 读不到返回 null」，
 * 不硬编码列名。
 *
 * 转码三段式（不在本层重复实现）：读盘（read-kilocode.ts）→ 归一记录 → `draftFromTranscript`
 * → `session-source.ts` 的统一出口（合成 DSH 行 + 连 workspaces 一起产出）。
 */
import { draftFromTranscript } from './session-source.ts';
import type { RootProbeOptions, SessionDraft } from './session-source.ts';
import { sessionSourceOf } from './session-source.ts';
import type { ForeignSource } from './registry.ts';
import { engineMsg } from './messages.ts';
import { FOREIGN_TRUTH_TABLES } from './truth-table.ts';
import type { ForeignTruthTableEntry } from './truth-table.ts';
import type { ForeignEvidenceKind, ForeignSourceId } from './types.ts';
import type { SqliteSessionFile } from './read-opencode.ts';
import { kilocodeDbPath, readKilocode } from './read-kilocode.ts';

/** 真值表条目（找不到即装配期炸：宁可炸，也不让来源悄悄少一份取证声明 —— 与 registry.ts 同口径） */
function truthEntryOf(id: ForeignSourceId): ForeignTruthTableEntry {
  const found = FOREIGN_TRUTH_TABLES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(engineMsg('foreign.truthTableMissingSource', { id }));
  return found;
}

/** 取证强度只从真值表取用（来源定义里不得自己填更好看的一档） */
function truthEvidenceOf(id: ForeignSourceId): ForeignEvidenceKind {
  return truthEntryOf(id).evidence;
}

/** 静态探测位置（只 stat；真值表函数显式收 platform，绝不读运行平台） */
export function kilocodeProbePaths(opts: RootProbeOptions): readonly string[] {
  return [kilocodeDbPath(opts)];
}

/** 归一记录 → 草稿（唯一出口；provider = 来源 id） */
export function kilocodeDraftOf(file: SqliteSessionFile): SessionDraft {
  return draftFromTranscript(file.id, file.parsed, 'kilocode');
}

/** 装配成注册表可用的 `ForeignSource`（detect 只 stat 真值表位置；build 走 sqlite.ts 的能力探测） */
export function createKilocodeSource(): ForeignSource {
  return sessionSourceOf<SqliteSessionFile>({
    id: 'kilocode',
    evidence: truthEvidenceOf('kilocode'),
    probePaths: kilocodeProbePaths,
    read: readKilocode,
    draftOf: kilocodeDraftOf,
  });
}

/** 模块级单例（无状态；每个进程一份即可，注册表按引用装配） */
export const kilocodeSource: ForeignSource = createKilocodeSource();
