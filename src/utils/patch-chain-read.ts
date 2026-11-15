/**
 * 生效 patch 链的读取与写前判据（issue #144）—— 宿主合并序：bundle 层 → profile 层 → home 层。
 *
 * 为什么判据要看 bundle 层：DSH 启动时把每层 patch 依次 overlay 到同一份 plugin 树上，
 * 「这个 id 已存在吗」是全链事实 —— 只看两个 patch 文件会把 bundle 已提供的 id 当成
 * 「本机没有」，于是导入写出第二条 insert（issue #144 报错的成因）。
 *
 * 本模块是宿主侧 IO 壳：纯判据在 `core/patch-chain.ts`，这里只负责把三层读成文档，
 * 并给写入路径提供「已存在则降级成覆盖行」的兜底。读不出来的层一律 fail-open（进 `failures`），
 * 绝不因为一个装坏的 bundle 拒绝写入 —— 但**必须登记**，否则判据缺口会静默变成「确知没有」。
 */
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  patchChainIndex,
  providedByOtherLayers,
  type PatchChainRead,
  type PatchChainSource,
} from '../core/patch-chain.ts'
import { USER_PATCH_FILE, profilePatchRel } from '../core/patch-layers.ts'
import { isENOENT } from './guards.ts'
import { isSameOrChild } from './paths.ts'
import { describePatchYamlError, loadPatchDocument } from './patch-yaml.ts'

/**
 * patch 行改动的最小形状（`PatchFileFacade.applyPatchChanges` 的入参元素）。
 *
 * `forceTopLevel` = 「这一行必须落在**顶层**」：本层若还留着同名 insert 成员（0.9.0 写坏的存量），
 * 光把 action 改成 update 不够 —— planPatchDocument 按**原文档归属**决定身份，insert 成员会
 * 原地留着，于是同 id 仍是两条新增。置位后强制搬到顶层覆盖行。
 */
export type PatchChangeLike = {
  lineId: string
  raw: unknown
  action: 'insert' | 'update' | 'remove'
  forceTopLevel?: boolean
}

/**
 * 生效链读取结果的短时缓存：一次导入会逐行写 patch，逐行重读 30+ 个 bundle patch 没有意义。
 *
 * 只按 TTL 命中还不够 —— 写盘之后必须 `invalidate()`，否则同一批次里「我刚写下的行」对后续
 * 判定不可见（本层最终会同时出现在 insert 与顶层两种身份里）。
 */
export class PatchChainCache {
  private at = 0
  private read: PatchChainRead | null = null
  private pending: Promise<PatchChainRead> | null = null
  private readonly ttlMs: number

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  /** 丢弃缓存（写盘成功后调用）。 */
  invalidate(): void {
    this.at = 0
    this.read = null
  }

  async get(load: () => Promise<PatchChainRead>, now: number = Date.now()): Promise<PatchChainRead> {
    if (this.read !== null && now - this.at < this.ttlMs) return this.read
    // 并发首读只读一遍：同一次导入里多个分区同时问「这个 id 在吗」很常见
    if (this.pending === null) {
      this.pending = load().then((read) => {
        this.at = now
        this.read = read
        this.pending = null
        return read
      }, (err: unknown) => {
        this.pending = null
        throw err
      })
    }
    return this.pending
  }
}

/**
 * 把「已被**别的层**提供」的 insert 改动降级成覆盖行。
 *
 * 顶层 `- id: X` 行只做覆盖：宿主 `entryMap` 查得到 X 就覆盖它的 config，查不到就整行丢弃；
 * 只有 `- insert:` 块成员才新增条目。所以「X 已在链上」时必须写覆盖行，再写一份 insert 就
 * 变成两条「新增」抢同一个 id —— 宿主 compose 后该条目取到没有 config 的那份，插件保存配置
 * 时必然报 `Configuration for "X" is overridden by a home patch or command-line overlay`。
 */
export function downgradeProvidedInserts<T extends PatchChangeLike>(
  chain: PatchChainRead | null,
  file: string,
  changes: readonly T[],
): { effective: T[]; downgraded: string[] } {
  const effective = [...changes]
  const downgraded: string[] = []
  if (chain === null) return { effective, downgraded }
  const byOther = providedByOtherLayers(patchChainIndex(chain), file)
  if (byOther.size === 0) return { effective, downgraded }
  const out = effective.map((change) => {
    if (change.action === 'remove') return change
    const other = byOther.get(change.lineId)
    // 只有「别的层以 insert（新增）提供」才会撞车：别的层若只是覆盖行，新增来源仍只有我们这一份
    if (other === undefined || other.insertLayers.length === 0) return change
    // 本层可能已经是 insert 成员（0.9.0 写坏的存量）：只改 action 留不住位置，必须强制搬到顶层
    if (change.action === 'insert') downgraded.push(change.lineId)
    return { ...change, action: 'update' as const, forceTopLevel: true } as T
  })
  return { effective: out, downgraded }
}

/** 读整条生效链：bundle 层按声明顺序在前，其后 profile 层、home 层（与宿主合并序一致）。 */
export async function readPatchChainFromProfile(homeDir: string, profile: string): Promise<PatchChainRead> {
  const sources: PatchChainSource[] = []
  const failures: { file: string; reason: string }[] = []
  sources.push(...await readBundleLayerSources(homeDir, profile, failures))
  for (const file of [profilePatchRel(profile), USER_PATCH_FILE]) {
    try {
      sources.push({ file, doc: loadPatchDocument(await fs.readFile(resolve(homeDir, file), 'utf8')) })
    } catch (err) {
      // 真不存在 = 该层本来就没有（空文档）；其余一律登记失败，绝不静默当空层
      if (isENOENT(err)) {
        sources.push({ file, doc: [] })
        continue
      }
      failures.push({ file, reason: describePatchYamlError(err) })
    }
  }
  return { sources, failures }
}

/**
 * 读 bundle 层的 patch 文档：`profiles/<p>/package.json` 的 `dsh.profile.bundles` →
 * 每个包的 `dsh.bundle.patch`（字符串或有序字符串数组）→ 已解析文档。
 *
 * 声明顺序即合并顺序（宿主 bundlePatchFiles / bundlePatchPaths 同口径）。
 */
async function readBundleLayerSources(
  homeDir: string,
  profile: string,
  failures: { file: string; reason: string }[],
): Promise<PatchChainSource[]> {
  const sources: PatchChainSource[] = []
  const manifestRel = `profiles/${profile}/package.json`
  let manifest: unknown
  try {
    manifest = JSON.parse(await fs.readFile(resolve(homeDir, manifestRel), 'utf8')) as unknown
  } catch (err) {
    if (!isENOENT(err)) failures.push({ file: manifestRel, reason: describePatchYamlError(err) })
    return sources
  }
  const declared = (manifest as { dsh?: { profile?: { bundles?: unknown } } } | null)?.dsh?.profile?.bundles
  if (!Array.isArray(declared)) return sources
  for (const name of declared) {
    if (typeof name !== 'string' || name === '') continue
    // 清单来自远端快照：名字必须是合法的 npm 包名，否则 `resolve(node_modules, '../../..')` 会
    // 把读取面带出 $DSH_HOME（链判据读的是文件内容，不该成为任意路径的探针）。
    if (!isBundleName(name)) {
      failures.push({ file: `bundles:${name}`, reason: 'illegal bundle name in profile manifest' })
      continue
    }
    const patches = await readBundlePatches(homeDir, profile, name, failures)
    if (patches === null) {
      failures.push({ file: `bundles:${name}`, reason: 'package not installed in this profile' })
      continue
    }
    sources.push(...patches)
  }
  return sources
}

/** 合法 bundle 名：`name` 或 `@scope/name`，分段不得为空、`.`、`..`，不得含分隔符/盘符/NUL。 */
function isBundleName(name: string): boolean {
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false
  const parts = name.split('/')
  if (parts.length === 0 || parts.length > 2) return false
  if (parts.length === 2 && parts[0]?.startsWith('@') !== true) return false
  return parts.every((part) => part !== '' && part !== '.' && part !== '..' && /^@?[A-Za-z0-9._-]+$/.test(part))
}

/**
 * 一个 bundle 声明的全部 patch 文档；包不在本机任何已知 node_modules → `null`。
 *
 * 三个候选位置都是**真实布局**（漏掉就不会命中，而漏掉在 fail-open 下等于「这个 bundle 不存在」）：
 *   1. `profiles/<p>/node_modules` —— profile 私有安装；
 *   2. `profiles/node_modules` —— pnpm hoisted 树（`nodeLinker: hoisted`，`@deepseek-ai/*` 在这）；
 *   3. `$DSH_HOME/node_modules` —— 早期 / 手工安装。
 *
 * 桌面端的 inbox bundle 只有 `app.asar` 内一份（磁盘上不存在），解析不到时如实进 `failures`。
 */
async function readBundlePatches(
  homeDir: string,
  profile: string,
  name: string,
  failures: { file: string; reason: string }[],
): Promise<PatchChainSource[] | null> {
  const candidates = [
    resolve(homeDir, 'profiles', profile, 'node_modules', name),
    resolve(homeDir, 'profiles', 'node_modules', name),
    resolve(homeDir, 'node_modules', name),
  ]
  let pkgDir: string | null = null
  let manifest: unknown = null
  for (const dir of candidates) {
    if (!isSameOrChild(dir, homeDir)) continue
    try {
      manifest = JSON.parse(await fs.readFile(resolve(dir, 'package.json'), 'utf8')) as unknown
      pkgDir = dir
      break
    } catch (err) {
      // 不存在 → 试下一个候选；存在但读不出/解析不了 → 登记后**不再 fallback**
      // （换用另一个副本会拿错版本的 patch 清单，判据悄悄变味）
      if (isENOENT(err)) continue
      failures.push({ file: `bundles:${name}/package.json`, reason: describePatchYamlError(err) })
      return null
    }
  }
  if (pkgDir === null) return null
  const patch = (manifest as { dsh?: { bundle?: { patch?: unknown } } } | null)?.dsh?.bundle?.patch
  const files = typeof patch === 'string' ? [patch] : patch
  if (patch !== undefined && (typeof patch !== 'string' && !Array.isArray(patch) || Array.isArray(patch) && !patch.every((file) => typeof file === 'string'))) {
    failures.push({ file: `bundles:${name}`, reason: 'dsh.bundle.patch must be a string or string[]' })
    return []
  }
  if (!Array.isArray(files)) return []
  const sources: PatchChainSource[] = []
  for (const rel of files as string[]) {
    const file = 'bundles:' + name + '/' + rel.replace(/\\/g, '/')
    const abs = resolve(pkgDir, rel)
    // 声明里的路径越界（../..）→ 直接忽略该文件：链判据不该读包外的东西
    if (!isSameOrChild(abs, pkgDir)) {
      failures.push({ file, reason: 'patch path escapes the bundle directory' })
      continue
    }
    try {
      sources.push({ file, doc: loadPatchDocument(await fs.readFile(abs, 'utf8')) })
    } catch (err) {
      // 单个 patch 文件读不出来 = 该 bundle 在这条链上不提供 id，但判据缺口必须可见
      failures.push({ file, reason: describePatchYamlError(err) })
    }
  }
  return sources
}

/**
 * 读既有 patch 文件并解析：真不存在（ENOENT）或内容为空 → `undefined`。
 *
 * 读不出来 / 解析不了**必须抛错**（issue #75 的数据丢失点）：调用方把失败当成空文档重建，
 * 就等于删掉用户手写的其余行。
 */
export async function readExistingPatchDocument(path: string): Promise<unknown> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (err) {
    if (isENOENT(err)) return undefined
    throw err
  }
  if (text.trim() === '') return undefined
  return loadPatchDocument(text)
}

