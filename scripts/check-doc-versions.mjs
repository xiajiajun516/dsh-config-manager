#!/usr/bin/env node
/**
 * 文档版本守卫（P1，2026-10-22 审计后新增）
 *
 * 为什么存在：审计实证「文档写死的版本号会腐烂」——docs/spec/known-gaps.md 曾写
 * 「npm 最新 v0.1.58、将以 v0.1.59 发布」，实查已是 0.1.79；compat-matrix 写「适用 0.1.67」。
 * 写死的数字没有任何机制保证它跟着发版走，读的人无法判断真假。
 *
 * 检查两类事实（其余历史性版本引用**故意不查**，避免假红）：
 *   1. 三处版本必须一致：package.json.version、src/index.ts 的 PLUGIN_VERSION、
 *      package-lock.json 的根 version 与 packages[""].version。
 *   2. 活文档里**声明当前适用版本**的句子（含「适用插件版本」）必须等于当前版本；
 *      含「最新/当前」字样的 dsh-config-manager@X.Y.Z 同样必须等于当前版本。
 *
 * 不查：CHANGELOG、docs/maintenance/known-gaps.md（历史台账）、docs/handoff、docs/lessons、
 *       docs/design（历史设计稿），以及标注「取证/写作时」的历史证据行。
 *
 * 用法：node scripts/check-doc-versions.mjs [--report]
 * 退出码：0 = 一致；1 = 有漂移。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const SEMVER = /([0-9]+[.][0-9]+[.][0-9]+)/
const ROOT_FILES = ['AGENTS.md', 'DESIGN.md', 'DEVELOPERS.md', 'README.md', 'README.zh-CN.md', 'SECURITY.md']
const DOC_FILES = ['docs/index.md', 'docs/modules/architecture.md']
const DOC_DIRS = ['docs/spec', 'docs/modules', 'docs/maintenance', 'docs/decisions']
const SKIP_FILES = ['docs/maintenance/known-gaps.md'] // 历史缺陷台账：写的是写作时的基线

const errors = []
const lines = (rel) => {
  const raw = readFileSync(join(ROOT, rel), 'utf8')
  return raw.split(LF).map((l) => (l.endsWith(CR) ? l.slice(0, -1) : l))
}
const semverOf = (text) => {
  const m = SEMVER.exec(text)
  return m ? m[1] : ''
}

// ---- 1. 三处版本 ----
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
const srcLines = lines('src/index.ts')
const versionLine = srcLines.find((l) => l.includes('export const PLUGIN_VERSION')) || ''
const pluginVersion = semverOf(versionLine)
const current = String(pkg.version || '')
if (!current) errors.push('package.json：读不到 version')
if (!pluginVersion) errors.push('src/index.ts：读不到 export const PLUGIN_VERSION')
if (pluginVersion && pluginVersion !== current) {
  errors.push('src/index.ts PLUGIN_VERSION=' + pluginVersion + ' 与 package.json.version=' + current + ' 不一致')
}
const lockRoot = String(lock.version || '')
const lockPkg = String((lock.packages && lock.packages[''] && lock.packages[''].version) || '')
if (lockRoot !== current) errors.push('package-lock.json 根对象 version=' + lockRoot + ' 与 package.json=' + current + ' 不一致')
if (lockPkg !== current) errors.push('package-lock.json packages[""].version=' + lockPkg + ' 与 package.json=' + current + ' 不一致')

// ---- 2. 活文档里的「当前版本」声明 ----
const targets = []
for (const f of ROOT_FILES) if (existsSync(join(ROOT, f))) targets.push(f)
for (const f of DOC_FILES) if (existsSync(join(ROOT, f))) targets.push(f)
const walk = (rel) => {
  const full = join(ROOT, rel)
  if (!existsSync(full)) return
  for (const name of readdirSync(full)) {
    const child = rel + '/' + name
    if (name.endsWith('.md')) targets.push(child)
    else if (!name.includes('.')) walk(child)
  }
}
for (const d of DOC_DIRS) walk(d)

let checked = 0
for (const rel of targets) {
  if (SKIP_FILES.includes(rel)) continue
  const ls = lines(rel)
  for (let i = 0; i < ls.length; i += 1) {
    const line = ls[i]
    const claimsApplicable = line.includes('适用插件版本')
    const claimsCurrent = line.includes('dsh-config-manager@') && (line.includes('最新') || line.includes('当前'))
    if (!claimsApplicable && !claimsCurrent) continue
    checked += 1
    const got = semverOf(line)
    if (!got) {
      errors.push(rel + ':' + (i + 1) + ' 声明了适用/当前版本，但读不出 X.Y.Z')
    } else if (got !== current) {
      errors.push(rel + ':' + (i + 1) + ' 声明版本 ' + got + '，实际 ' + current)
    }
  }
}

const reportOnly = process.argv.includes('--report')
console.log('[doc-versions] current=' + current + ' 声明句=' + checked + ' 不一致=' + errors.length)
for (const e of errors) console.log('  x ' + e)
if (errors.length > 0 && !reportOnly) {
  console.error('[doc-versions] FAIL: 版本声明必须与 package.json 一致（写死的历史版本不要用「适用/当前」措辞）。')
  process.exit(1)
}
