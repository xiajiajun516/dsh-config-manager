/**
 * 「关于（About）」Tab 纯函数渲染模型单测（node:test + node:assert，无需 DOM）。
 *
 * 覆盖（docs/design/2026-08-19-about-tab-design.md §5）：
 *  - 链接派生：repoUrl → star / docs / issues 的正确后缀；
 *  - 尾斜杠输入归一化（含多个尾斜杠）；
 *  - 状态行格式化：pluginVersion / dshVersion / platform+arch 合并；
 *  - 常量完整性：repoUrl 与 package.json repository 一致（测试中硬编码断言）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ABOUT_LINKS, ABOUT_META, aboutStatusRows, aboutUpdateView, aboutUpgradeCommand, buildFeedbackSnippet, deriveAboutLinks } from './about-view.ts'
import { zh } from '../locales.ts'
import type { TranslateNS } from '../client-types.ts'

/** 测试用翻译器：zh 目录 + {param} 插值（与 ctx.locale.bind 同口径）。 */
const t = ((key: string, params?: Record<string, string | number>) => {
  const template: string = (zh as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] === undefined ? m : String(params[k])))
}) as TranslateNS<'config-manager'>

/* ---------------------------------------------------------------- 链接派生 */

test('about-view: deriveAboutLinks 派生 star/docs/issues 正确后缀', () => {
  const links = deriveAboutLinks('https://github.com/xiajiajun516/dsh-config-manager')
  assert.equal(links.starUrl, 'https://github.com/xiajiajun516/dsh-config-manager')
  assert.equal(links.repoUrl, 'https://github.com/xiajiajun516/dsh-config-manager')
  assert.equal(links.docsUrl, 'https://github.com/xiajiajun516/dsh-config-manager#readme')
  assert.equal(links.issuesUrl, 'https://github.com/xiajiajun516/dsh-config-manager/issues/new/choose')
})

test('about-view: deriveAboutLinks 归一化尾斜杠（单个 / 多个）', () => {
  const single = deriveAboutLinks('https://github.com/xiajiajun516/dsh-config-manager/')
  assert.equal(single.repoUrl, 'https://github.com/xiajiajun516/dsh-config-manager')
  assert.equal(single.starUrl, 'https://github.com/xiajiajun516/dsh-config-manager')
  assert.equal(single.docsUrl, 'https://github.com/xiajiajun516/dsh-config-manager#readme')
  assert.equal(single.issuesUrl, 'https://github.com/xiajiajun516/dsh-config-manager/issues/new/choose')

  const many = deriveAboutLinks('https://github.com/xiajiajun516/dsh-config-manager///')
  assert.equal(many.repoUrl, 'https://github.com/xiajiajun516/dsh-config-manager')
  assert.equal(many.docsUrl, 'https://github.com/xiajiajun516/dsh-config-manager#readme')
  assert.equal(many.issuesUrl, 'https://github.com/xiajiajun516/dsh-config-manager/issues/new/choose')
})

test('about-view: deriveAboutLinks 首尾空白裁剪且不破坏路径型仓库', () => {
  const links = deriveAboutLinks('  https://example.com/org/repo/  ')
  assert.equal(links.repoUrl, 'https://example.com/org/repo')
  assert.equal(links.docsUrl, 'https://example.com/org/repo#readme')
  assert.equal(links.issuesUrl, 'https://example.com/org/repo/issues/new/choose')
})

test('about-view: deriveAboutLinks 与 ABOUT_META.repoUrl 派生常量一致', () => {
  const derived = deriveAboutLinks(ABOUT_META.repoUrl)
  assert.deepEqual(ABOUT_LINKS, derived)
})

/* ---------------------------------------------------------------- 状态行格式化 */

test('about-view: aboutStatusRows 透传版本并合并 platform + arch', () => {
  const rows = aboutStatusRows({
    pluginVersion: '0.1.33',
    dshVersion: '1.2.3',
    platform: 'win32',
    arch: 'x64',
  })
  assert.equal(rows.version, '0.1.33')
  assert.equal(rows.dsh, '1.2.3')
  assert.equal(rows.platform, 'win32 · x64')
})

test('about-view: aboutStatusRows 空字符串安全透传', () => {
  const rows = aboutStatusRows({ pluginVersion: '', dshVersion: '', platform: '', arch: '' })
  assert.equal(rows.version, '')
  assert.equal(rows.dsh, '')
  assert.equal(rows.platform, ' · ')
})

/* ---------------------------------------------------------------- 常量完整性 */

test('about-view: ABOUT_META.repoUrl 与 package.json repository 一致（硬编码断言）', () => {
  // package.json "repository": { "type": "git", "url": "git+https://github.com/xiajiajun516/dsh-config-manager.git" }
  const pkgRepoUrl = 'git+https://github.com/xiajiajun516/dsh-config-manager.git'
  const normalized = pkgRepoUrl.replace(/^git\+/, '').replace(/\.git$/, '')
  assert.equal(normalized, ABOUT_META.repoUrl)
})

test('about-view: ABOUT_META 元数据字段正确', () => {
  assert.equal(ABOUT_META.name, 'DSH Config Manager')
  assert.equal(ABOUT_META.author, 'xiajiajun516')
  assert.equal(ABOUT_META.authorUrl, 'https://github.com/xiajiajun516')
})

test('about-view: ABOUT_LINKS 各字段与派生规则一致', () => {
  assert.equal(ABOUT_LINKS.starUrl, ABOUT_META.repoUrl)
  assert.equal(ABOUT_LINKS.repoUrl, ABOUT_META.repoUrl)
  assert.equal(ABOUT_LINKS.docsUrl, `${ABOUT_META.repoUrl}#readme`)
  assert.equal(ABOUT_LINKS.issuesUrl, `${ABOUT_META.repoUrl}/issues/new/choose`)
  assert.equal(ABOUT_LINKS.releasesUrl, `${ABOUT_META.repoUrl}/releases`)
})

/* ---------------------------------------------------------------- 反馈片段（提 issue 时一键复制） */

test('about-view: buildFeedbackSnippet 无诊断位时只输出环境三行', () => {
  const text = buildFeedbackSnippet(aboutStatusRows({
    pluginVersion: '0.1.64',
    dshVersion: '1.2.3',
    platform: 'win32',
    arch: 'x64',
  }), t)
  assert.equal(
    text,
    [
      '### 环境 / Environment',
      '- 插件版本 / Plugin: 0.1.64',
      '- DSH 版本 / DSH: 1.2.3',
      '- 平台 / Platform: win32 · x64',
    ].join('\n'),
  )
})

test('about-view: buildFeedbackSnippet 带诊断位时追加 profile 与插件清单目录', () => {
  const rows = aboutStatusRows({
    pluginVersion: '0.1.64',
    dshVersion: '1.2.3',
    platform: 'win32',
    arch: 'x64',
    homeDir: 'C:/Users/me/.dsh',
    profile: 'web',
    installedPluginCount: 7,
  })
  const text = buildFeedbackSnippet(rows, t)
  assert.ok(text.includes('- profile: web'))
  assert.ok(text.includes('- 插件清单目录 / Plugin dir: C:/Users/me/.dsh/profiles/web'))
  assert.equal(text.split('\n').length, 6)
})

test('about-view: buildFeedbackSnippet 版本号为空时回落 unknown（不产出半截标签）', () => {
  const text = buildFeedbackSnippet(aboutStatusRows({
    pluginVersion: '',
    dshVersion: '',
    platform: 'win32',
    arch: 'x64',
  }), t)
  assert.ok(text.includes('- 插件版本 / Plugin: unknown'))
  assert.ok(text.includes('- DSH 版本 / DSH: unknown'))
})
/* ---------------------------------------------------------------- 插件版本更新检查（2026-09） */

test('about-view: aboutUpdateView 已是最新 → upToDate（不提示升级）', () => {
  const view = aboutUpdateView({ ok: true, current: '1.2.0', latest: '1.2.0', updateAvailable: false, checkedAt: 1, cached: false })
  assert.deepEqual(view, { kind: 'upToDate', current: '1.2.0', latest: '1.2.0' })
})

test('about-view: aboutUpdateView 有新版本 → available + 精确版本升级命令', () => {
  const view = aboutUpdateView(
    { ok: true, current: '1.2.0', latest: '1.3.0', updateAvailable: true, checkedAt: 1, cached: false },
    { profile: 'web' },
  )
  assert.deepEqual(view, {
    kind: 'available',
    current: '1.2.0',
    latest: '1.3.0',
    command: 'dsh plugin --profile web add dsh-config-manager@1.3.0',
  })
})

test('about-view: aboutUpgradeCommand 对 desktop / 未知档案返回 null（不给注定失败的命令）', () => {
  assert.equal(aboutUpgradeCommand('1.3.0', { profile: 'desktop' }), null)
  assert.equal(aboutUpgradeCommand('1.3.0', {}), null)
  assert.equal(aboutUpgradeCommand('1.3.0', { profile: '   ' }), null)
  assert.equal(aboutUpgradeCommand('1.3.0', { profile: 'cmtest' }), 'dsh plugin --profile cmtest add dsh-config-manager@1.3.0')
})

test('about-view: aboutUpdateView 检查失败 → failed（带原因，绝不当作已是最新）', () => {
  const view = aboutUpdateView({ ok: false, current: '1.2.0', error: 'network error: ENOTFOUND' })
  assert.deepEqual(view, { kind: 'failed', current: '1.2.0', error: 'network error: ENOTFOUND' })
})

test('about-view: available 视图在 desktop 档案下 command 为 null（界面改给插件页提示）', () => {
  const view = aboutUpdateView(
    { ok: true, current: '1.2.0', latest: '1.4.0', updateAvailable: true, checkedAt: 1, cached: true },
    { profile: 'desktop' },
  )
  assert.equal(view.kind, 'available')
  assert.equal(view.kind === 'available' ? view.command : 'x', null)
})
