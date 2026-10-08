/**
 * Continue（`CONTINUE_GLOBAL_DIR` → ~/.continue）→ DSH bundle 的**纯**翻译层（会话类）。
 *
 * 输入 = 读盘层（read-continue.ts）已解析好的 `ParsedTranscript`；输出 = `ForeignSource`。
 * 「草稿 → 字节」的唯一出口是共享骨架 `session-source.ts`（工具配对 / seq / surfaceOp /
 * workspaces 同源产出都在那里，本层不重造）。
 *
 * 两条与其它来源**刻意不同**的点（都在 read-continue.ts 里落地，这里只声明契约）：
 *  ① `CONTINUE_GLOBAL_DIR` 是**替换**语义（vibe 的 `VIBE_HOME` 是追加 —— read-vault §10.3-3
 *     专门点名这两种语义并存）→ 由 `probeEnvKeys` 只报**键名**，命中即报
 *     `source-location-overridden`，**值绝不进包/日志/回传**；
 *  ② probePaths 直接复用 env-aware 的 `continueSessionsDir`：env 生效时 detect 也看得到真实
 *     位置；而真值表护栏在**空环境**下得到的仍是 `<home>/.continue/sessions`（与
 *     truth-table.ts 的 defaults 逐字相同）。
 *
 * 真值表与取证强度（`evidence`）一律从 truth-table.ts 派生：本来源是 `fixture`
 * （夹具 + 单测可复现，**真机未验证**）。
 */
import { envValue, normalizePlatform } from './platform-paths.ts';
import { draftFromTranscript, sessionSourceOf } from './session-source.ts';
import type { RootProbeOptions } from './session-source.ts';
import { engineMsg } from './messages.ts';
import { FOREIGN_TRUTH_TABLES } from './truth-table.ts';
import type { ForeignTruthTableEntry } from './truth-table.ts';
import type { ForeignSource } from './registry.ts';
import type { ForeignSourceId } from './types.ts';
import { CONTINUE_ENV_KEY, readContinueSessions } from './read-continue.ts';
import type { ContinueSessionFile } from './read-continue.ts';

/** 写进 DSH request/header 的 provider 名 */
export const CONTINUE_PROVIDER = 'continue';

function truthEntryOf(id: ForeignSourceId): ForeignTruthTableEntry {
  const found = FOREIGN_TRUTH_TABLES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(engineMsg('foreign.truthTableMissingSource', { id }));
  return found;
}

/**
 * 探测位置（两条口径同时成立，缺一不可）：
 *  ① **空环境**下必须与 truth-table.ts 的 `<home>/.continue/sessions` **逐字相同**
 *     （真值表护栏正是拿空环境比对的）；
 *  ② `CONTINUE_GLOBAL_DIR` 生效时必须指向**真实位置**（否则 detect 会在用户明明装了 Continue
 *     时报「未安装」）。
 * 因此：env 命中 → 用它拼 `/sessions`；否则用真值表模板展开。两者都是「路径」，
 * 回给 GUI 的标签仍由 probeConfiguredPaths 折成相对 home 的 POSIX 串，**env 的值绝不回传**。
 */
function probePathsOf(opts: RootProbeOptions): readonly string[] {
  const overridden = envValue(opts.env, CONTINUE_ENV_KEY);
  if (overridden !== undefined) return [overridden.split(String.fromCharCode(92)).join('/').replace(/\/+$/, '') + '/sessions'];
  const entry = truthEntryOf('continue');
  return entry.defaults[normalizePlatform(opts.platform)].map((t) => t.split('<home>').join(opts.homeDir));
}

/** 装配 Continue 来源（每次调用返回一份新定义；注册动作由 registrar 统一做） */
export function createContinueSource(): ForeignSource {
  return sessionSourceOf<ContinueSessionFile>({
    id: 'continue',
    evidence: truthEntryOf('continue').evidence,
    probePaths: probePathsOf,
    probeEnvKeys: [CONTINUE_ENV_KEY],
    read: (opts) => readContinueSessions(opts),
    draftOf: (file) => draftFromTranscript(file.id, file.parsed, CONTINUE_PROVIDER),
  });
}

/** 同一份定义的实例（宿主路由 / 单测可直接用） */
export const continueSource: ForeignSource = createContinueSource();

/** 真值表里声明的默认根（三平台展开；仅用于文档/测试比对，不参与运行时） */
export function continueDefaultProbe(platform: string, homeDir: string): readonly string[] {
  const entry = truthEntryOf('continue');
  return entry.defaults[normalizePlatform(platform)].map((t) => t.split('<home>').join(homeDir));
}
