/**
 * 本地插件打包的**宿主侧**接线（T1）。
 *
 * 与 `local-plugin-pack.ts` 的分工：
 *  - `local-plugin-pack.ts` 是纯逻辑（spec 分类/路径推导/编排），零 node 子进程依赖，可离线单测；
 *  - 本文件只负责把真实世界接上：`npm pack` 的 execFile 包装、真实读写、临时目录生命周期。
 * 放在独立文件是为了让 adapter 与 core 引擎都不需要 import `node:child_process`
 * （降低被误打进 client bundle 的风险，且便于测试替身）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { packLocalPlugins, parsePackOutput } from './local-plugin-pack.ts';
import { quoteCmdArg } from './plugin-cli.ts';
import type { PackExec, PackExecResult, PackLocalPluginsResult } from './local-plugin-pack.ts';
import type { HostContext } from './types.ts';

/**
 * 本地源插件打包钩子签名。
 *
 * 刻意在 core 内**重新声明**该签名（而非从 adapters 反向 import）：架构边界测试
 * （tests/architecture-boundaries.test.ts F7）规定 core 层只允许依赖
 * node 内置 / core 内部 / schema / utils / security —— core → adapters 是违规方向。
 * adapters 侧的 `LocalPluginPackHook` 与这是**结构等价**的，故可直接互赋（TS 结构化类型）。
 * 注意：这里 host ctx 参数只需 HostContext，无需 adapters 的任何类型。
 */
export type LocalPluginPackHook = (
  plugins: readonly { name: string; version: string; spec?: string }[],
  ctx: Pick<HostContext, 'profile'>,
) => Promise<PackLocalPluginsResult>;

/** `npm pack` 单次调用的超时上限（慢网络/大插件留足余量，但不得无限挂起） */
const PACK_TIMEOUT_MS = 5 * 60 * 1000;

/** cmd.exe 垫片路径（Windows 上 npm 是 .cmd；与 core/plugin-cli.ts 的 spawnShim 同源做法） */
const COMSPEC = process.env.ComSpec ?? 'cmd.exe';

/**
 * 默认 exec：把 `npm pack` 作为子进程执行并收集 stdout/stderr。
 *
 * **刻意不用 `execFile(..., { shell: true })`**：该组合会触发 Node 的 DEP0190
 * （`shell:true` + args 数组只做拼接不做转义，存在注入面）。仓库既有解法是
 * 在 Windows 上显式走 `cmd.exe /d /s /c "<转义后的命令行>"`（见 core/plugin-cli.ts
 * 的 spawnShim + quoteCmdArg），本模块复用同一做法。
 *
 * 失败**不 reject**（把退出码交回调用方判定），只有 spawn 本身失败才 reject——
 * 这样「npm 报错」与「npm 不存在」能被分开处理（前者是插件问题，后者是环境问题）。
 */
const defaultExec: PackExec = (file, args, opts) =>
  new Promise<PackExecResult>((resolve, reject) => {
    const useShim = process.platform === 'win32';
    const [bin, argv] = useShim
      ? [COMSPEC, ['/d', '/s', '/c', `"${[file, ...args].map(quoteCmdArg).join(' ')}"`]]
      : [file, [...args]];

    const child = spawn(bin, argv, {
      cwd: opts.cwd,
      windowsHide: true,
      windowsVerbatimArguments: useShim,
      shell: false, // 显式关闭：Windows 路径已由 cmd.exe 自行处理
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = opts.timeoutMs ?? PACK_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ stdout, stderr: `${stderr}\nnpm pack 超时（${timeoutMs}ms）已终止`, code: 1 });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (d: Buffer | string) => { stdout += String(d); });
    child.stderr?.on('data', (d: Buffer | string) => { stderr += String(d); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err); // spawn 层失败（ENOENT 等）：环境问题，如实上抛
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });

export interface LocalPluginPackHookOptions {
  /** $DSH_HOME 绝对路径 */
  homeDir: string;
  /** 插件数据目录（临时打包目录建在其下，保证与既有目录生命周期一致） */
  dataDir: string;
  /** 覆盖 exec（测试注入） */
  exec?: PackExec;
}

/**
 * 构造注入给 `PluginsAdapter` 的打包钩子。
 *
 * 临时目录建在 `<dataDir>/tmp/`（与既有 tmp 语义一致），构造时不清扫、用完即删：
 * 单次导出内建一个 `<dataDir>/tmp/local-pack-<random>` 目录，导出结束（无论成败）删除，
 * 避免 tarball 残留在用户磁盘上。
 */
export function createLocalPluginPackHook(opts: LocalPluginPackHookOptions): LocalPluginPackHook {
  const exec = opts.exec ?? defaultExec;

  return async (plugins, ctx) => {
    // 无本地源插件时零开销返回（不建目录、不 spawn）——由 packLocalPlugins 内部短路，
    // 这里先做便宜的判定避免无谓的 mkdtemp。
    if (!plugins.some((p) => p.spec !== undefined && /^\s*(link|file):/i.test(p.spec))) {
      return { packed: [], rewritten: {}, warnings: [] };
    }

    const tmpRoot = path.join(opts.dataDir, 'tmp');
    let packDir: string;
    try {
      await fsp.mkdir(tmpRoot, { recursive: true });
      packDir = await fsp.mkdtemp(path.join(tmpRoot, 'local-pack-'));
    } catch (err) {
      return {
        packed: [],
        rewritten: {},
        warnings: [`本地插件打包临时目录创建失败，已跳过本地插件打包: ${err instanceof Error ? err.message : String(err)}`],
      };
    }

    try {
      // profile 目录：profiles/<profile>（profile 缺省 web，与仓库既有约定一致）
      const profile = ctx.profile !== undefined && ctx.profile !== '' ? ctx.profile : 'web';
      return await packLocalPlugins({
        plugins: plugins.map((p) => ({ name: p.name, version: p.version, spec: p.spec })),
        homeDir: opts.homeDir,
        profileDir: path.join(opts.homeDir, 'profiles', profile),
        packDir,
        exec,
        readFile: (abs) => fsp.readFile(abs),
        mkdir: async (abs) => { await fsp.mkdir(abs, { recursive: true }); },
        timeoutMs: PACK_TIMEOUT_MS,
      });
    } finally {
      // 无论成败都清掉临时目录：tarball 字节已读进内存并随备份走，无需留盘
      await fsp.rm(packDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

/** 供其他模块复用（避免重复实现 npm 输出解析） */
export { parsePackOutput };
