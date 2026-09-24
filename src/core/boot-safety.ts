/**
 * 启动自洽审计（Launch Safety Audit）——「终止导入并保留已应用项」分支的安全闸门。
 *
 * 为什么必须有它：用户选择「保留」= 允许一笔**只应用了一部分计划项**的导入留在盘上。
 * 盘面不自洽时 DSH 下次启动可能直接失败，而用户看到的却是「已保留」的绿色结论。
 * 本模块复用仓库里已有的两套原语，不新造检查：
 *  - `computeSafeBundles`（./boot-rescue.ts）：救援模式剪 bundle 用的同一函数 ——
 *    profile `dsh.profile.bundles` 里解析不到的包会让 DSH 启动失败，这是「插件装一半」
 *    最典型的坏盘面，也是本审计里**唯一会自动修正**的一项；
 *  - `BOOT_CRITICAL_RELS` / `profileCriticalRels`（./config-lifecycle.ts）：启动关键文件清单。
 *
 * 纪律（与 boot-rescue 一致）：
 *  - **只做可证明安全的自动修正**（剔除解析不到的 bundle，与救援模式同一判据）；
 *    其余问题一律如实上报，绝不静默「修好」；
 *  - 审计结论三态：safe（未发现问题）/ repaired（发现问题且已定点修正）/ unsafe
 *    （存在未修正的 error 级问题）。**能力未注入的检查记入 unchecked，绝不当作通过**；
 *  - 审计自身**绝不抛错**（调用方处于「用户已选择保留」的正常返回路径上，抛错会把
 *    「已知结论」换成异常并触发 journal NEEDS_ATTENTION + SAFE MODE）。
 *  - core 与 DSH 解耦：读文件 / 写文件 / bundle 解析 / YAML 解析全部由宿主注入。
 */
import { RESCUE_KEEP_BUNDLE_PREFIXES, computeSafeBundles } from './boot-rescue.ts';
import type { BundleResolver } from './boot-rescue.ts';
import { BOOT_CRITICAL_RELS, profileCriticalRels } from './config-lifecycle.ts';
import type { MsgFunc } from './messages.ts';
import { zhMsg } from './messages.ts';

/** 审计问题 id（稳定；测试与 UI 判定用，展示文本一律走 msg）。 */
export type BootSafetyIssueId =
  | 'bundlesUnresolved'
  | 'bundlesUnresolvedUnfixed'
  | 'bundleListUnreadable'
  | 'criticalFileUnreadable'
  | 'criticalFileUnparsable'
  | 'patchFileMissing'
  | 'extraCheckFailed';

export interface BootSafetyIssue {
  id: BootSafetyIssueId
  /** error = 可能直接导致 DSH 启动失败；warn = 需要用户知道但不阻断启动。 */
  severity: 'warn' | 'error'
  /** 已本地化的细节文本（非敏感：只有相对路径 / 包名 / 解析错误摘要）。 */
  detail: string
  /** true = 本次已自动修正（盘面已改变，detail 里说明了改了什么）。 */
  fixed: boolean
}

export type BootSafetyVerdict = 'safe' | 'repaired' | 'unsafe'

export interface BootSafetyReport {
  verdict: BootSafetyVerdict
  issues: BootSafetyIssue[]
  /** 被剔除的 bundle（与救援模式同语义；空数组 = 未改动插件清单）。 */
  prunedBundles: { name: string; reason: string }[]
  /**
   * 未能执行的检查（能力未注入）——如实告知。
   * **不得**把 unchecked 当作通过：verdict=safe 只代表「已执行的检查」全过。
   */
  unchecked: string[]
}

export interface BootSafetyDeps {
  /** 配置档案名（如 'web'）。 */
  profile: string
  /** 读 home-relative（posix）文件文本；不存在返回 null。 */
  readText: (relPosix: string) => Promise<string | null>
  /** 写 home-relative（posix）文件文本（仅在修正插件清单时需要）。 */
  writeText: (relPosix: string, text: string) => Promise<void>
  /** bundle 可解析探测（宿主注入；与救援模式同一实现：只有严格 true 视为可解析）。 */
  resolveBundle: BundleResolver
  /**
   * YAML 解析器（宿主注入 js-yaml 的 load）。不注入 → 跳过 YAML 可解析性检查并记入
   * unchecked（core 不 import js-yaml：保持引擎层零第三方依赖）。
   */
  parseYaml?: (text: string) => unknown
  /** 附加检查（宿主可挂会话位置 / 工作区登记等专项检查）；抛错只记 unchecked。 */
  extraChecks?: () => Promise<BootSafetyIssue[]>
  msg?: MsgFunc
}

/** 可解析性检查的目标（.json → JSON.parse；.yaml/.yml → 注入的 parseYaml）。 */
function parseKind(rel: string): 'json' | 'yaml' | 'none' {
  if (rel.endsWith('.json')) return 'json'
  if (rel.endsWith('.yaml') || rel.endsWith('.yml')) return 'yaml'
  return 'none'
}

/** 从 pnpm-workspace.yaml 解析出的 patchedDependencies 值（patch 文件相对路径）。 */
function patchedDependencyRefs(parsed: unknown): string[] {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const raw = (parsed as Record<string, unknown>)['patchedDependencies']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  const out: string[] = []
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value !== '') out.push(value)
  }
  return out
}

/** 解析 profile package.json 的 dsh.profile.bundles；非普通对象返回 undefined。 */
function readBundles(pkg: unknown): unknown {
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return undefined
  const dsh = (pkg as Record<string, unknown>)['dsh']
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) return undefined
  const profile = (dsh as Record<string, unknown>)['profile']
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return undefined
  return (profile as Record<string, unknown>)['bundles']
}

/** 写回 dsh.profile.bundles（仅当 dsh / dsh.profile 均为普通对象）；返回是否写入。 */
function writeBundles(pkg: Record<string, unknown>, bundles: string[]): boolean {
  const dsh = pkg['dsh']
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) return false
  const profile = (dsh as Record<string, unknown>)['profile']
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return false
  ;(profile as Record<string, unknown>)['bundles'] = bundles
  return true
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 执行启动自洽审计。**绝不抛错**：任何单项失败转成 issue / unchecked。
 */
export async function auditBootSafety(deps: BootSafetyDeps): Promise<BootSafetyReport> {
  const msg = deps.msg ?? zhMsg
  const issues: BootSafetyIssue[] = []
  const unchecked: string[] = []
  let prunedBundles: { name: string; reason: string }[] = []

  const profileRels = profileCriticalRels(deps.profile)
  const allRels = [...BOOT_CRITICAL_RELS, ...profileRels]

  // ---------- ① 插件清单：解析不到的 bundle 必须剔除（唯一自动修正项） ----------
  const pkgRel = `profiles/${deps.profile}/package.json`
  let pkgText: string | null = null
  try {
    pkgText = await deps.readText(pkgRel)
  } catch (err) {
    issues.push({ id: 'bundleListUnreadable', severity: 'warn', detail: msg('bootSafety.bundleListUnreadable', { rel: pkgRel, reason: errorText(err) }), fixed: false })
  }
  if (pkgText !== null) {
    let pkg: Record<string, unknown> | null = null
    try {
      const parsed: unknown = JSON.parse(pkgText)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) pkg = parsed as Record<string, unknown>
    } catch (err) {
      issues.push({ id: 'criticalFileUnparsable', severity: 'error', detail: msg('bootSafety.criticalFileUnparsable', { rel: pkgRel, reason: errorText(err) }), fixed: false })
    }
    if (pkg !== null) {
      const bundles = readBundles(pkg)
      const safe = await computeSafeBundles(bundles, deps.resolveBundle)
      // 防御性收窄（与救援模式同一不变量）：`@deepseek-ai/*` 是 DSH 自身核心 bundle，
      // **绝不**因为「本机解析探测失败」就把它从清单里剪掉 —— 那等于我们亲手让 DSH 起不来。
      // 探测本身也可能只是「没从正确的根解析」，故核心项一律只告警、不修、不升级为 unsafe。
      // 核心项**静默保留**：`@deepseek-ai/*` 由 DSH 从它自己的安装位置解析，本机探测不到属预期
      // （profile 的 node_modules 里通常就没有它们）。既不能剪，也不该每次保留都刷一条告警。
      const isCore = (name: string): boolean => RESCUE_KEEP_BUNDLE_PREFIXES.some((prefix) => name.startsWith(prefix))
      const prunable = safe.pruned.filter((p) => !isCore(p.name))
      prunedBundles = prunable
      if (safe.inputWasArray && prunable.length > 0) {
        const names = prunable.map((p) => p.name).join(', ')
        let written = false
        let failReason = ''
        try {
          // 只剔除「不可解析且非核心」的条目：其余条目（含解析不出的核心项）原样保留
          const drop = new Set(prunable.map((p) => p.name))
          const next = (Array.isArray(bundles) ? bundles : []).filter((b) => !(typeof b === 'string' && drop.has(b))) as string[]
          if (!writeBundles(pkg, next)) throw new Error('dsh.profile.bundles 不是数组或结构异常')
          await deps.writeText(pkgRel, JSON.stringify(pkg, null, 2) + '\n')
          written = true
        } catch (err) {
          failReason = errorText(err)
        }
        if (written) {
          issues.push({ id: 'bundlesUnresolved', severity: 'error', detail: msg('bootSafety.bundlesPruned', { count: String(prunable.length), names }), fixed: true })
        } else {
          issues.push({ id: 'bundlesUnresolvedUnfixed', severity: 'error', detail: msg('bootSafety.bundlesPrunedFailed', { count: String(prunable.length), names, reason: failReason }), fixed: false })
        }
      }
    }
  }

  // ---------- ② 启动关键文件：存在性 + 可解析性（只上报，不自动改写） ----------
  for (const rel of allRels) {
    let text: string | null
    try {
      text = await deps.readText(rel)
    } catch (err) {
      issues.push({ id: 'criticalFileUnreadable', severity: 'warn', detail: msg('bootSafety.criticalFileUnreadable', { rel, reason: errorText(err) }), fixed: false })
      continue
    }
    if (text === null) continue // 不存在不是问题（多数机器没有 settings.json / .env）
    const kind = parseKind(rel)
    if (kind === 'json') {
      try {
        JSON.parse(text)
      } catch (err) {
        issues.push({ id: 'criticalFileUnparsable', severity: 'error', detail: msg('bootSafety.criticalFileUnparsable', { rel, reason: errorText(err) }), fixed: false })
      }
      continue
    }
    if (kind === 'yaml') {
      if (deps.parseYaml === undefined) {
        if (!unchecked.includes('yaml')) unchecked.push('yaml')
        continue
      }
      try {
        const parsed = deps.parseYaml(text)
        // patchedDependencies 指向的 patch 文件必须真实存在（issue #35：缺失会让 pnpm 拒绝一切 add）
        if (rel.endsWith('pnpm-workspace.yaml')) {
          for (const ref of patchedDependencyRefs(parsed)) {
            const patchRel = ref.startsWith('/') ? ref.slice(1) : ref
            let present: string | null = null
            try { present = await deps.readText(patchRel) } catch { present = null }
            if (present === null) {
              issues.push({ id: 'patchFileMissing', severity: 'error', detail: msg('bootSafety.patchFileMissing', { ref }), fixed: false })
            }
          }
        }
      } catch (err) {
        issues.push({ id: 'criticalFileUnparsable', severity: 'error', detail: msg('bootSafety.criticalFileUnparsable', { rel, reason: errorText(err) }), fixed: false })
      }
    }
  }

  // ---------- ③ 宿主附加检查（会话位置 / 工作区登记等） ----------
  if (deps.extraChecks === undefined) {
    unchecked.push('extra')
  } else {
    try {
      issues.push(...await deps.extraChecks())
    } catch (err) {
      unchecked.push('extra')
      issues.push({ id: 'extraCheckFailed', severity: 'warn', detail: msg('bootSafety.extraCheckFailed', { reason: errorText(err) }), fixed: false })
    }
  }

  const hasUnfixedError = issues.some((i) => i.severity === 'error' && !i.fixed)
  const hasFixed = issues.some((i) => i.fixed)
  return {
    verdict: hasUnfixedError ? 'unsafe' : hasFixed ? 'repaired' : 'safe',
    issues,
    prunedBundles,
    unchecked,
  }
}
