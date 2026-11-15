/**
 * 生效 patch 链的读取与写前判据（issue #144）—— 宿主合并序：bundle 层 → profile 层 → home 层。
 *
 * 为什么判据要看 bundle 层：DSH 启动时把每层 patch 依次 overlay 到同一份 plugin 树上，
 * 「这个 id 已存在吗」是全链事实 —— 只看两个 patch 文件会把 bundle 已提供的 id 当成
 * 「本机没有」，于是导入写出第二条 insert（issue #144 报错的成因）。
 *
 * 本模块是宿主侧 IO 壳：纯判据在 `core/patch-chain.ts`，这里只负责把三层读成文档，
 * 并给写入路径提供「已存在则降级成覆盖行」的兜底。读不出来的层一律 fail-open（进 `failures`），
 * 绝不因为一个装坏的 bundle 拒绝写入。
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

/** patch 行改动的最小形状（`PatchFileFacade.applyPatchChanges` 的入参元素）。 */
export type PatchChangeLike = { lineId: string; raw: unknown; action: 'insert' | 'update' | 'remove' }

/** 生效链读取结果的短时缓存：一次导入会逐行写 patch，逐行重读 30+ 个 bundle patch 没有意义。 */
export class PatchChainCache {
  private at = 0
  private read: PatchChainRead | null = null
  private readonly ttlMs: number

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  async get(load: () => Promise<PatchChainRead>): Promise<PatchChainRead> {
    const now = Date.now()
    if (this.read !== null && now - this.at < this.ttlMs) return this.read
    const read = await load()
    this.at = now
    this.read = read
    return read
  }
}

/**
 * 把「已被**别的层**提供」的 insert 改动降级成覆盖行（update）。
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
    if (change.action !== 'insert' || !byOther.has(change.lineId)) return change
    downgraded.push(change.lineId)
    return { ...change, action: 'update' as const } as T
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
 * 声明顺序即合并顺序（宿主 bundlePatchFiles / bundlePatchPaths 同口径）。包目录只在本 profile
 * 与 home 的 node_modules 里找 —— inbox bundle 可能装在 DSH 自带安装位（不在 $DSH_HOME 内），
 * 读不到就登记失败，让判据退回两层（fail-open）。
 */
export async function readBundleLayerSources(
  homeDir: string,
  profile: string,
  failures: { file: string; reason: string }[],
): Promise<PatchChainSource[]> {
  const sources: PatchChainSource[] = []
  const bundlePatchArgs = { homeDir, profile }
  let manifest: unknown
  try {
    manifest = JSON.parse(await fs.readFile(resolve(homeDir, 'profiles', profile, 'package.json'), 'utf8')) as unknown
  } catch (err) {
    if (!isENOENT(err)) failures.push({ file: `profiles/${profile}/package.json`, reason: describePatchYamlError(err) })
    return sources
  }
  const declared = (manifest as { dsh?: { profile?: { bundles?: unknown } } } | null)?.dsh?.profile?.bundles
  if (!Array.isArray(declared)) return sources
  for (const name of declared) {
    if (typeof name !== 'string' || name === '') continue
    const patches = await readBundlePatches(bundlePatchArgs.homeDir, bundlePatchArgs.profile, name)
    if (patches === null) {
      failures.push({ file: `bundles:${name}`, reason: 'package not installed in this profile' })
      continue
    }
    sources.push(...patches)
  }
  return sources
}

/** 一个 bundle 声明的全部 patch 文档；包不在本 profile / home 的 node_modules → `null`。 */
export async function readBundlePatches(
  homeDir: string,
  profile: string,
  name: string,
): Promise<PatchChainSource[] | null> {
  const candidates = [
    resolve(homeDir, 'profiles', profile, 'node_modules', name),
    resolve(homeDir, 'node_modules', name),
  ]
  let pkgDir: string | null = null
  let manifest: unknown = null
  for (const dir of candidates) {
    try {
      manifest = JSON.parse(await fs.readFile(resolve(dir, 'package.json'), 'utf8')) as unknown
      pkgDir = dir
      break
    } catch {
      continue
    }
  }
  if (pkgDir === null) return null
  const patch = (manifest as { dsh?: { bundle?: { patch?: unknown } } } | null)?.dsh?.bundle?.patch
  const files = typeof patch === 'string' ? [patch] : patch
  if (!Array.isArray(files) || !files.every((file) => typeof file === 'string')) return []
  const sources: PatchChainSource[] = []
  for (const rel of files as string[]) {
    const abs = resolve(pkgDir, rel)
    // 声明里的路径越界（../..）→ 直接忽略该文件：链判据不该读包外的东西
    if (!isSameOrChild(abs, pkgDir)) continue
    try {
      sources.push({
        file: 'bundles:' + name + '/' + rel.replace(/\\/g, '/'),
        doc: loadPatchDocument(await fs.readFile(abs, 'utf8')),
      })
    } catch {
      // 单个 patch 文件读不出来 = 该 bundle 在这条链上不提供 id（fail-open）
      continue
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

/** 读另一层并解析；读不到/解析不了 → undefined（跨层守卫 fail-open）。 */
export async function readPatchDocQuietly(homeDir: string, file: string): Promise<unknown> {
  try {
    return loadPatchDocument(await fs.readFile(resolve(homeDir, file), 'utf8'))
  } catch {
    return undefined
  }
}
