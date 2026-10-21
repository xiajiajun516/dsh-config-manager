/**
 * m-autosync-realtime：**监听范围**（纯函数，host 侧）。
 *
 * 自动同步要「像 VS Code 一样」在本地改动后立刻上行，就必须知道**哪些磁盘路径承载了
 * 可同步的分区内容**。这份映射不能从注册表的 ZIP 内路径推出来 —— 两者是两件事：
 *   - 注册表 `SECTION_JSON_PATHS` / `SECTION_FILE_PREFIXES` 说的是**快照 ZIP 内部**的布局；
 *   - 真正被监视的是 `$DSH_HOME` 下的落盘位置（`skills/`、`settings.yaml`、
 *     `profiles/<p>/cordis.patch.yml` … 见 `src/core/backup.ts` 的 FILE_BASES 与
 *     `src/core/patch-layers.ts` 的两层 patch）。
 *
 * 因此本文件是「分区 → home 相对路径」的**唯一静态表**，只做事实声明，不做 I/O。
 * 监听器（`sync-watcher.ts`）只负责 fs.watch + 去抖；判定「变了哪些分区」始终回到引擎的
 * `hasLocalChanges()`（按分区 hash 比对基线），这里绝不猜。
 *
 * 关键取舍（勿“优化”成监听整个 home）：
 *  - **不递归监听 `$DSH_HOME` 根**：`sessions/`（会话日志，可能几个 GB）、
 *    `node_modules`、`dsh-config-manager/{sync/work,snapshots,exports,tmp}` 全在里面，
 *    一旦监听就会自己把自己点着（同步写工作副本 → 触发 → 再同步），且与「sessions 绝不自动
 *    上下行」的铁律直接冲突；
 *  - **只监听 `profiles/<p>` 下的具体文件与 `patches/`**，绝不递归 `profiles/`：
 *    那下面有整个 pnpm 依赖树；
 *  - `self` 分区只监听白名单里那几个 `*.json`（与 `src/adapters/self.ts` 的
 *    SELF_CONFIG_FILES 对齐），**刻意不监听 `sync/sync-state.json` / `sync/sync-history.json` /
 *    `sync/sync-autosync.json` / `sync/backup-schedule.json`** —— 调度器每轮都会改写它们，
 *    监听就是自激循环；
 *  - `node_modules` / `.git` / 原子写临时文件在任何层级都被过滤。
 */
import path from 'node:path';

import type { SectionId } from '../schema/types.ts';

/** 监听目标的形态：单个文件，或（递归）目录。 */
export type WatchTargetKind = 'file' | 'dir';

export interface WatchTarget {
  /** home 相对路径，posix 分隔符（Windows 上也用 `/`，便于比较与日志） */
  relPath: string;
  kind: WatchTargetKind;
  /** 目录目标是否递归（file 恒 false） */
  recursive: boolean;
  /** 该路径承载的分区（诊断/日志用，不参与「是否触发」判定） */
  sections: readonly SectionId[];
}

/** 组装监听目标所需的宿主事实（只读）。 */
export interface WatchScopeInput {
  /** `$DSH_HOME` 绝对路径 */
  homeDir: string;
  /** 当前 profile（决定 plugins / prompts / mcp 的落盘位置）；缺省 'web'（与 core/backup.ts 一致） */
  profile?: string;
}

/** 任意层级都要过滤的目录名（依赖树、git 内部、同步工作副本）。 */
export const WATCH_IGNORED_SEGMENTS: readonly string[] = ['node_modules', '.git'];

/** 任意层级都要过滤的文件名模式（原子写临时文件：`x.json.tmp-1234-0`）。 */
const TMP_FILE_RE = /\.tmp-/u;

/**
 * 组装监听目标清单。
 *
 * 清单顺序即日志顺序（稳定，便于测试与排查）；路径一律 posix 相对 `$DSH_HOME`。
 */
export function buildWatchTargets(input: WatchScopeInput): WatchTarget[] {
  const profile = input.profile !== undefined && input.profile !== '' ? input.profile : 'web';
  const profileDir = `profiles/${profile}`;
  const dataBase = 'dsh-config-manager';
  return [
    // settings / providers / ui：同一个 settings.yaml 的顶层 namespace
    { relPath: 'settings.yaml', kind: 'file', recursive: false, sections: ['settings', 'providers', 'ui'] },
    // prompts / mcp：两层组合 patch 的 home 层
    { relPath: 'cordis.patch.yml', kind: 'file', recursive: false, sections: ['prompts', 'mcp'] },
    // agentInstructions：home 根 AGENTS.md
    { relPath: 'AGENTS.md', kind: 'file', recursive: false, sections: ['agentInstructions'] },
    // prompts / mcp / plugins：两层组合 patch 的 profile 层 + pnpm 工作区声明 + profile manifest
    { relPath: `${profileDir}/cordis.patch.yml`, kind: 'file', recursive: false, sections: ['prompts', 'mcp', 'plugins'] },
    { relPath: `${profileDir}/pnpm-workspace.yaml`, kind: 'file', recursive: false, sections: ['plugins'] },
    { relPath: `${profileDir}/package.json`, kind: 'file', recursive: false, sections: ['plugins'] },
    // plugins：pnpm patch 文件（`patchFile:<profile 相对路径>`）
    { relPath: `${profileDir}/patches`, kind: 'dir', recursive: true, sections: ['plugins'] },
    // skills / agentPresets：整棵目录
    { relPath: 'skills', kind: 'dir', recursive: true, sections: ['skills'] },
    { relPath: '.agent-presets', kind: 'dir', recursive: true, sections: ['agentPresets'] },
    // self：**只**监听白名单配置文件（与 adapters/self.ts 的 SELF_CONFIG_FILES 对齐）。
    // 刻意不含 sync-state.json / sync-history.json / sync-autosync.json / backup-schedule.json。
    { relPath: `${dataBase}/sync/sync-config.json`, kind: 'file', recursive: false, sections: ['self'] },
    { relPath: `${dataBase}/sync/sync-selection.json`, kind: 'file', recursive: false, sections: ['self'] },
    { relPath: `${dataBase}/sync/ui-prefs.json`, kind: 'file', recursive: false, sections: ['self'] },
    { relPath: `${dataBase}/market/market-config.json`, kind: 'file', recursive: false, sections: ['self'] },
    { relPath: `${dataBase}/exports/.backup-notes.json`, kind: 'file', recursive: false, sections: ['self'] },
  ];
}

/** 把任一绝对路径转成 home 相对 posix 路径；不在 home 内 → null。 */
export function toHomeRelPath(homeDir: string, absPath: string): string | null {
  const rel = path.relative(homeDir, absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * 该 home 相对路径是否属于「绝不该触发同步」的噪声。
 *
 * 判据只有两类（宁少不多：漏过滤只是多跑一轮空同步，误过滤会漏掉真实改动）：
 * 依赖树 / git 内部目录，以及原子写临时文件。
 */
export function isNoiseRelPath(relPath: string): boolean {
  if (relPath === '') return true;
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (WATCH_IGNORED_SEGMENTS.includes(segment)) return true;
  }
  const base = segments[segments.length - 1] ?? '';
  return TMP_FILE_RE.test(base);
}

/** 监视目标的绝对路径。 */
export function targetAbsPath(homeDir: string, target: WatchTarget): string {
  return path.join(homeDir, target.relPath.split('/').join(path.sep));
}
