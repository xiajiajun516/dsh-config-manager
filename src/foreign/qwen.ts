/**
 * 千问办公 / Qwen（~\.qwenworkcn/projects）→ DSH bundle 的**纯**翻译层（会话类）。
 *
 * 输入 = 读盘层（read-qwen.ts）已解析好的 `ParsedTranscript`；输出 = `ForeignSource`。
 * 「草稿 → 字节」的唯一出口是共享骨架 `session-source.ts`（工具配对 / seq / surfaceOp /
 * workspaces 同源产出都在那里，本层不重造）。
 *
 * cwd 的**唯一权威**是 `workspace-directories` 里第一个非 `.qwenworkcn` 目录（用户选的
 * 项目文件夹）；记录内 `cwd` 是千问临时工作区、`<slug>` 编码语义未经取证 —— 两者都
 * **丢弃**（见 read-qwen.ts 文件头）。没有真实项目目录就按 `session-missing-cwd` 跳过并报码。
 * 宁可少搬，也绝不产出一条指向不存在目录的会话（DSH 启动时校验「日志位置 == projectKey(cwd)/id」）。
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
import { readQwenSessions } from './read-qwen.ts';
import type { QwenSessionFile } from './read-qwen.ts';

/** 写进 DSH request/header 的 provider 名 */
export const QWEN_PROVIDER = 'qwen';

function truthEntryOf(id: ForeignSourceId): ForeignTruthTableEntry {
  const found = FOREIGN_TRUTH_TABLES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(engineMsg('foreign.truthTableMissingSource', { id }));
  return found;
}

function probePathsFromTruth(id: ForeignSourceId, opts: RootProbeOptions): readonly string[] {
  const entry = truthEntryOf(id);
  return entry.defaults[normalizePlatform(opts.platform)].map((t) => t.split('<home>').join(opts.homeDir));
}

/** 装配 Qwen 来源（每次调用返回一份新定义；注册动作由 registrar 统一做） */
export function createQwenSource(): ForeignSource {
  return sessionSourceOf<QwenSessionFile>({
    id: 'qwen',
    evidence: truthEntryOf('qwen').evidence,
    probePaths: (opts) => probePathsFromTruth('qwen', opts),
    read: (opts) => readQwenSessions(opts),
    draftOf: (file) => draftFromTranscript(file.id, file.parsed, QWEN_PROVIDER),
  });
}

/** 同一份定义的实例（宿主路由 / 单测可直接用） */
export const qwenSource: ForeignSource = createQwenSource();
