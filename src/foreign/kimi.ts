/**
 * Kimi（~\.kimi + ~/.kimi-code，双根两代布局）→ DSH bundle 的**纯**翻译层（会话类）。
 *
 * 输入 = 读盘层（read-kimi.ts）已解析好的 `ParsedTranscript`（两代 wire 词汇——旧
 * `{timestamp, message:{type,payload}}` 与新点分小写——都已在那一层归一；cwd 已按
 * 「状态文件 cwd/workDir → md5 反查 → workspaces 反查（path/root）」三档解析，标题取
 * state.json 的 custom_title）；输出 = `ForeignSource`。
 * 「草稿 → 字节」的唯一出口是共享骨架 `session-source.ts`（工具配对 / seq / surfaceOp /
 * workspaces 同源产出都在那里，本层不重造）。
 *
 * 交叉核对：三份报告都写明**双根**（`~/.kimi/sessions` + `~/.kimi-code/sessions`）且无 env 覆盖
 * —— 与 captain 的任务表一致，无出入。两代 wire 词汇差异见 read-kimi.ts 文件头。
 *
 * 真值表与取证强度（`evidence`）一律从 truth-table.ts 派生：本来源是 `fixture`
 * （夹具 + 单测可复现，**真机未验证**）。probePaths 按真值表模板展开（**双根 + 两个伴生文件
 * 全部列出**，与 registry.ts 的 probePathsOf 同口径），读盘走 joinFor。
 */
import { normalizePlatform } from './platform-paths.ts';
import { draftFromTranscript, sessionSourceOf } from './session-source.ts';
import type { RootProbeOptions } from './session-source.ts';
import { engineMsg } from './messages.ts';
import { FOREIGN_TRUTH_TABLES } from './truth-table.ts';
import type { ForeignTruthTableEntry } from './truth-table.ts';
import type { ForeignSource } from './registry.ts';
import type { ForeignSourceId } from './types.ts';
import { readKimiSessions } from './read-kimi.ts';
import type { KimiSessionFile } from './read-kimi.ts';

/** 写进 DSH request/header 的 provider 名 */
export const KIMI_PROVIDER = 'kimi';

function truthEntryOf(id: ForeignSourceId): ForeignTruthTableEntry {
  const found = FOREIGN_TRUTH_TABLES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(engineMsg('foreign.truthTableMissingSource', { id }));
  return found;
}

/** 探测位置 = 真值表的**两条 session 根 + 两个伴生文件**（按目标平台展开；读盘另走 joinFor） */
function probePathsFromTruth(id: ForeignSourceId, opts: RootProbeOptions): readonly string[] {
  const entry = truthEntryOf(id);
  return entry.defaults[normalizePlatform(opts.platform)].map((t) => t.split('<home>').join(opts.homeDir));
}

/** 装配 Kimi 来源（每次调用返回一份新定义；注册动作由 registrar 统一做） */
export function createKimiSource(): ForeignSource {
  return sessionSourceOf<KimiSessionFile>({
    id: 'kimi',
    evidence: truthEntryOf('kimi').evidence,
    probePaths: (opts) => probePathsFromTruth('kimi', opts),
    read: (opts) => readKimiSessions(opts),
    draftOf: (file) => draftFromTranscript(file.id, file.parsed, KIMI_PROVIDER),
  });
}

/** 同一份定义的实例（宿主路由 / 单测可直接用） */
export const kimiSource: ForeignSource = createKimiSource();
