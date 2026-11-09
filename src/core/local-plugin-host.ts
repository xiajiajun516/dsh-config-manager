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
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

import { packLocalPlugins, parsePackOutput, resolveLocalPluginPath } from './local-plugin-pack.ts';
import { quoteCmdArg } from './plugin-cli.ts';
import type { OversizeLocalPlugin, PackedLocalPlugin, PackExec, PackExecResult, PackLocalPluginsResult } from './local-plugin-pack.ts';
import type { HostContext } from './types.ts';
import { engineMsg } from './messages-core.ts';

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
  ctx: Pick<HostContext, 'profile' | 'profileDir'>,
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
      resolve({ stdout, stderr: engineMsg('core.localPluginHost.packTimeout', { stderr, timeoutMs }), code: 1 });
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
  /**
   * 超限负缓存 TTL（缺省 OVERSIZE_NEGATIVE_TTL_MS；**0 = 关闭缓存**，测试用）。
   * 命中条件 = 源指纹未变 且 距上次实测超限不足 TTL。
   */
  oversizeTtlMs?: number;
  /** 源指纹（测试注入；缺省见 defaultSourceFingerprint） */
  sourceFingerprint?: (absPath: string) => Promise<string | null>;
  /** tarball 体积上限（缺省 MAX_LOCAL_TARBALL_BYTES；测试用小值验证超限负缓存） */
  maxTarballBytes?: number;
  /**
   * 内容缓存上限（字节；缺省 PACKED_CACHE_MAX_BYTES，**0 = 关闭**）。
   * 命中判据 = 源目录的**内容指纹**（递归 rel/size/mtime）未变：命中即复用上次的 tarball 字节，跳过 npm pack。
   */
  packedCacheMaxBytes?: number;
  /** 内容缓存条目上限（缺省 PACKED_CACHE_MAX_ENTRIES）。 */
  packedCacheMaxEntries?: number;
  /** 内容指纹（测试注入；缺省 deepSourceFingerprint）。 */
  contentFingerprint?: (absPath: string) => Promise<string | null>;
}

/**
 * 构造注入给 `PluginsAdapter` 的打包钩子。
 *
 * 临时目录建在 `<dataDir>/tmp/`（与既有 tmp 语义一致），构造时不清扫、用完即删：
 * 单次导出内建一个 `<dataDir>/tmp/local-pack-<random>` 目录，导出结束（无论成败）删除，
 * 避免 tarball 残留在用户磁盘上。
 */
/** 超限负缓存 TTL：命中后这段时间内不再为同一源重复打包。
 *
 * 为什么需要（2026-11-07 真机事故）：单个 210MB 的本地插件一次 npm pack 实测 44.7s，而结果每次都被
 * 体积上限丢弃（core/local-plugin-pack.ts 的 maxTarballBytes）。自动同步 60s 一轮 ⇒ 每分钟白烧 45s CPU/磁盘，
 * 且整段时间持有 GLOBAL mutation 锁（用户删除档案/导入等操作恒 423「另一个任务正在运行」）。
 * 取 30 分钟而不是永久：源改动可能只落在 lib/ 上、package.json 指纹不变，重打包的代价能承受，
 * 「长期静默不备份」承受不了。 */
const OVERSIZE_NEGATIVE_TTL_MS = 30 * 60 * 1000;

/** 源指纹（缺省实现）：归档看自身 size/mtime；目录看「目录 mtime + package.json size/mtime」。
 *
 * 刻意不做整树遍历：真机实测 eac-design-world 包 8810 文件走一遍 3.6s、本仓库 51502 文件 14.9s，
 * 比它要省的 45s 只是小一个量级，且每轮都要付 —— 负缓存的意义就没了。 */
async function defaultSourceFingerprint(absPath: string): Promise<string | null> {
  try {
    const st = await fsp.stat(absPath);
    if (st.isFile()) return 'file:' + st.size + ':' + Math.trunc(st.mtimeMs);
    if (!st.isDirectory()) return null;
    const pkg = await fsp.stat(path.join(absPath, 'package.json')).catch(() => null);
    const pkgKey = pkg === null ? '-' : pkg.size + ':' + Math.trunc(pkg.mtimeMs);
    return 'dir:' + Math.trunc(st.mtimeMs) + ':' + pkgKey;
  } catch {
    return null;
  }
}
/** 内容缓存上限（缺省 128 MiB）：只缓存真的打过的 tarball 字节。 */
const PACKED_CACHE_MAX_BYTES = 128 * 1024 * 1024;

/** 内容缓存条目上限（防「一堆小插件」把 Map 撑大）。 */
const PACKED_CACHE_MAX_ENTRIES = 64;

/** 内容指纹的遍历上限：超过就不缓存（宁可不省，也不拿可能过期的字节去备份）。 */
const CONTENT_FP_MAX_ENTRIES = 20_000;

/**
 * 内容指纹（**正缓存**用）：递归列出目录内每个文件的相对路径 + 字节数 + mtime。
 *
 * 为什么不用上面的 defaultSourceFingerprint：它只取「目录 mtime + package.json」，
 * 在 lib/ 里改一行**不会**改目录 mtime —— 拿它做正缓存，会把旧 tarball 当成当前内容上传进备份。
 * 负缓存能容忍这种粗糙（最坏是少备份一次、30 分钟内重试），正缓存不能容忍（最坏是备份里是旧代码）。
 *
 * 成本实测（2026-11-07，真机）：8810 文件 3.6 s、51502 文件 14.9 s —— 仍比一次 210 MB 插件的
 * 44.7 s npm pack 便宜一个量级；超过 CONTENT_FP_MAX_ENTRIES 或遇到链接/特殊文件一律返回 null
 * （调用方据此**不缓存**，直接照常打包）。
 */
async function deepSourceFingerprint(absPath: string): Promise<string | null> {
  let st;
  try {
    st = await fsp.stat(absPath);
  } catch {
    return null;
  }
  if (st.isFile()) return 'file:' + st.size + ':' + Math.trunc(st.mtimeMs);
  if (!st.isDirectory()) return null;

  const hash = createHash('sha256');
  let entries = 0;
  const walk = async (dir: string, rel: string): Promise<boolean> => {
    let list;
    try {
      list = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of list) {
      // 与 npm pack 同口径：node_modules 不进产物；.git 不参与内容身份
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel === '' ? entry.name : rel + '/' + entry.name;
      if (entry.isDirectory()) {
        if (!(await walk(abs, relPath))) return false;
        continue;
      }
      if (!entry.isFile()) return false; // 链接 / 设备文件：不猜它指向什么，放弃缓存
      const s = await fsp.stat(abs).catch(() => null);
      if (s === null) return false;
      entries += 1;
      if (entries > CONTENT_FP_MAX_ENTRIES) return false;
      hash.update(relPath + '\u0000' + s.size + '\u0000' + Math.trunc(s.mtimeMs) + '\n');
    }
    return true;
  };
  if (!(await walk(absPath, ''))) return null;
  hash.update('entries:' + entries);
  return 'deep:' + hash.digest('hex');
}

export function createLocalPluginPackHook(opts: LocalPluginPackHookOptions): LocalPluginPackHook {
  const exec = opts.exec ?? defaultExec;
  const oversizeTtlMs = opts.oversizeTtlMs ?? OVERSIZE_NEGATIVE_TTL_MS;
  const fingerprintOf = opts.sourceFingerprint ?? defaultSourceFingerprint;
  /**
   * 超限负缓存：解析后的源路径 → 上次实测超限的结论。
   *
   * 存**结论**而不是 tarball：超限的 tarball 本来就不会进备份，缓存它没有意义；
   * 要省的只是那几十秒的 npm pack。键用绝对源路径（同一插件在 link:/file: 两种写法下同键）。
   */
  const oversizeCache = new Map<string, { fingerprint: string; at: number; oversize: OversizeLocalPlugin }>();

  /**
   * 内容缓存（正缓存）：解析后的源路径 → 上次打出的 tarball 字节 + 当时的内容指纹。
   *
   * 与超限负缓存的区别：负缓存存「结论」，这里存**产物本身**，命中即跳过 npm pack。
   * 命中判据是 deepSourceFingerprint（文件级 rel/size/mtime），不是目录 mtime —— 见该函数注释。
   * 上限双保险：总字节数 + 条目数，超出按「最久未用」淘汰；单条超过上限则根本不入缓存。
   */
  const packedMaxBytes = opts.packedCacheMaxBytes ?? PACKED_CACHE_MAX_BYTES;
  const packedMaxEntries = opts.packedCacheMaxEntries ?? PACKED_CACHE_MAX_ENTRIES;
  const contentFp = opts.contentFingerprint ?? deepSourceFingerprint;
  const packedCache = new Map<string, { fingerprint: string; entry: PackedLocalPlugin; bytes: number; usedAt: number }>();
  let packedCacheBytes = 0;
  const evictPacked = (): void => {
    while (packedCache.size > packedMaxEntries || packedCacheBytes > packedMaxBytes) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, value] of packedCache) {
        if (value.usedAt < oldestAt) {
          oldestAt = value.usedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      const removed = packedCache.get(oldestKey);
      if (removed !== undefined) packedCacheBytes -= removed.bytes;
      packedCache.delete(oldestKey);
    }
  };
  /** 按入参顺序输出打包结果（缓存命中与本轮打包混在一起时，保持确定性顺序）。 */
  const orderPacked = (input: readonly { name: string }[], packed: readonly PackedLocalPlugin[]): PackedLocalPlugin[] => {
    const byName = new Map(packed.map((p) => [p.packageName, p] as const));
    return input.map((p) => byName.get(p.name)).filter((p): p is PackedLocalPlugin => p !== undefined);
  };
  const rewrittenOf = (packed: readonly PackedLocalPlugin[]): Record<string, string> =>
    Object.fromEntries(packed.map((p) => [p.packageName, p.rewrittenSpec]));

  const hasLocalSpec = (p: { spec?: string }): boolean =>
    p.spec !== undefined && /^\s*(link|file):/i.test(p.spec);

  return async (plugins, ctx) => {
    // 无本地源插件时零开销返回（不建目录、不 spawn）。
    if (!plugins.some(hasLocalSpec)) {
      return { packed: [], rewritten: {}, warnings: [], oversize: [] };
    }

    // profile 目录：**优先用 HostContext.profileDir**（DSH 的档案目录不保证是
    // `<home>/profiles/<name>` 的默认布局，拼接出来的路径可能根本不存在）；
    // 宿主没给时回退到按 profile 名拼接，再回退到 web —— 与仓库既有约定一致。
    // 提到建临时目录之前：负缓存要按解析后的源路径判定，不为判定先建目录。
    const profile = ctx.profile !== undefined && ctx.profile !== '' ? ctx.profile : 'web';
    const profileDir = ctx.profileDir !== undefined && ctx.profileDir !== ''
      ? ctx.profileDir
      : path.join(opts.homeDir, 'profiles', profile);

    // —— 超限负缓存：源没变就别再白跑一遍 npm pack ——
    const kept: { name: string; version: string; spec?: string }[] = [];
    const cacheWarnings: string[] = [];
    // 缓存命中的超限项也要原样回给调用方：与首次发现同形，界面不必区分「这轮刚发现」还是「上轮已记」
    const cacheOversize: OversizeLocalPlugin[] = [];
    if (oversizeTtlMs > 0 && oversizeCache.size > 0) {
      const now = Date.now();
      for (const p of plugins) {
        const spec = p.spec;
        if (spec === undefined || !hasLocalSpec(p)) {
          kept.push(p);
          continue;
        }
        const abs = resolveLocalPluginPath(spec, { homeDir: opts.homeDir, profileDir });
        const hit = oversizeCache.get(abs);
        if (hit === undefined || now - hit.at >= oversizeTtlMs) {
          if (hit !== undefined) oversizeCache.delete(abs);
          kept.push(p);
          continue;
        }
        const fp = await fingerprintOf(abs).catch(() => null);
        if (fp === null || fp !== hit.fingerprint) {
          oversizeCache.delete(abs);
          kept.push(p);
          continue;
        }
        // 命中：与「打包后发现超限」用同一条文案，用户与调用方都看不出区别
        cacheWarnings.push(
          engineMsg('core.localPluginPack.tarballTooLarge', { name: p.name, size: hit.oversize.size, max: hit.oversize.maxBytes }),
        );
        cacheOversize.push(hit.oversize);
      }
    } else {
      kept.push(...plugins);
    }
    if (!kept.some(hasLocalSpec)) {
      return { packed: [], rewritten: {}, warnings: cacheWarnings, oversize: cacheOversize };
    }

    // —— 内容缓存命中分流：源内容没变的那几个直接复用上次的 tarball，其余才真的打包 ——
    const hitPacked: PackedLocalPlugin[] = [];
    const toPack: { name: string; version: string; spec?: string }[] = [];
    if (packedMaxBytes > 0) {
      for (const p of kept) {
        const spec = p.spec;
        if (spec === undefined || !hasLocalSpec(p)) {
          toPack.push(p);
          continue;
        }
        const abs = resolveLocalPluginPath(spec, { homeDir: opts.homeDir, profileDir });
        const hit = packedCache.get(abs);
        if (hit === undefined) {
          toPack.push(p);
          continue;
        }
        const fp = await contentFp(abs).catch(() => null);
        if (fp === null || fp !== hit.fingerprint) {
          packedCacheBytes -= hit.bytes;
          packedCache.delete(abs);
          toPack.push(p);
          continue;
        }
        hit.usedAt = Date.now();
        hitPacked.push(hit.entry);
      }
    } else {
      toPack.push(...kept);
    }

    if (!toPack.some(hasLocalSpec)) {
      // 全部命中：不建临时目录、不 spawn 一次 npm。
      return {
        packed: orderPacked(plugins, hitPacked),
        rewritten: rewrittenOf(hitPacked),
        warnings: cacheWarnings,
        oversize: cacheOversize,
      };
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
        warnings: [
          ...cacheWarnings,
          engineMsg('core.localPluginHost.tmpDirCreateFailed', { reason: err instanceof Error ? err.message : String(err) }),
        ],
        oversize: cacheOversize,
      };
    }

    try {
      const specOfName = new Map<string, string>();
      for (const p of toPack) {
        if (p.spec !== undefined && hasLocalSpec(p)) specOfName.set(p.name, p.spec);
      }
      const result = await packLocalPlugins({
        plugins: toPack.map((p) => ({ name: p.name, version: p.version, spec: p.spec })),
        homeDir: opts.homeDir,
        profileDir,
        packDir,
        exec,
        readFile: (abs) => fsp.readFile(abs),
        mkdir: async (abs) => { await fsp.mkdir(abs, { recursive: true }); },
        // issue #57：`file:` 指向 .tgz 时直读收编（跳过 npm pack）；判不出形态一律 unknown
        statKind: async (abs) => {
          try {
            const st = await fsp.stat(abs);
            return st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'unknown';
          } catch {
            return 'unknown';
          }
        },
        timeoutMs: PACK_TIMEOUT_MS,
        ...(opts.maxTarballBytes === undefined ? {} : { maxTarballBytes: opts.maxTarballBytes }),
      });

      // 本轮新发现的超限项记账：下一轮同源同指纹就直接走缓存，不再 npm pack。
      if (oversizeTtlMs > 0) {
        for (const o of result.oversize) {
          const fp = await fingerprintOf(o.sourcePath).catch(() => null);
          if (fp !== null) {
            oversizeCache.set(o.sourcePath, { fingerprint: fp, at: Date.now(), oversize: o });
          }
        }
      }
      // 内容缓存记账：本轮真打出来的 tarball 按「源内容指纹」入缓存；超限/算不出指纹的跳过（不猜）。
      if (packedMaxBytes > 0) {
        for (const entry of result.packed) {
          const spec = specOfName.get(entry.packageName);
          if (spec === undefined) continue;
          const bytes = entry.data.byteLength;
          if (bytes > packedMaxBytes) continue;
          const abs = resolveLocalPluginPath(spec, { homeDir: opts.homeDir, profileDir });
          const fp = await contentFp(abs).catch(() => null);
          if (fp === null) continue;
          const prev = packedCache.get(abs);
          if (prev !== undefined) packedCacheBytes -= prev.bytes;
          packedCache.set(abs, { fingerprint: fp, entry, bytes, usedAt: Date.now() });
          packedCacheBytes += bytes;
        }
        evictPacked();
      }
      const allPacked = [...hitPacked, ...result.packed];
      return {
        ...result,
        packed: orderPacked(plugins, allPacked),
        rewritten: { ...result.rewritten, ...rewrittenOf(hitPacked) },
        oversize: [...cacheOversize, ...result.oversize],
        warnings: [...cacheWarnings, ...result.warnings],
      };
    } finally {
      // 无论成败都清掉临时目录：tarball 字节已读进内存并随备份走，无需留盘
      await fsp.rm(packDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
/** 供其他模块复用（避免重复实现 npm 输出解析） */
export { parsePackOutput };
