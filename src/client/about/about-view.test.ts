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

import { ABOUT_LINKS, ABOUT_META, aboutStatusRows, deriveAboutLinks } from './about-view.ts'

/* ---------------------------------------------------------------- 链接派生 */

test('about-view: deriveAboutLinks 派生 star/docs/issues 正确后缀', () => {
  const links = deriveAboutLinks('https://github.com/xiajiajun516/dsh-config-manager')
  assert.equal(links.starUrl, 'https://github.com/xiajiajun516/dsh-config-manager')
  assert.equal(links.repoUrl, 'https://github.com/xiajiajun516/dsh-config-manager')
  assert.equal(links.docsUrl, 'https://github.com/xiajiajun516/dsh-config-manager#readme')
  assert.equal(links.issuesUrl, 'https://github.com/xiajiajun516/dsh-config-manager/issues')
})

test('about-view: deriveAboutLinks 归一化尾斜杠（单个 / 多个）', () => {
  const single = deriveAboutLinks('https://github.com/xiajiajun516/dsh-config-manager/')
  assert.equal(single.repoUrl, 'https://github.com/xiajiajun516/dsh-config-manager')
  assert.equal(single.starUrl, 'https://github.com/xiajiajun516/dsh-config-manager')
  assert.equal(single.docsUrl, 'https://github.com/xiajiajun516/dsh-config-manager#readme')
  assert.equal(single.issuesUrl, 'https://github.com/xiajiajun516/dsh-config-manager/issues')

  const many = deriveAboutLinks('https://github.com/xiajiajun516/dsh-config-manager///')
  assert.equal(many.repoUrl, 'https://github.com/xiajiajun516/dsh-config-manager')
  assert.equal(many.docsUrl, 'https://github.com/xiajiajun516/dsh-config-manager#readme')
  assert.equal(many.issuesUrl, 'https://github.com/xiajiajun516/dsh-config-manager/issues')
})

test('about-view: deriveAboutLinks 首尾空白裁剪且不破坏路径型仓库', () => {
  const links = deriveAboutLinks('  https://example.com/org/repo/  ')
  assert.equal(links.repoUrl, 'https://example.com/org/repo')
  assert.equal(links.docsUrl, 'https://example.com/org/repo#readme')
  assert.equal(links.issuesUrl, 'https://example.com/org/repo/issues')
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
  assert.equal(ABOUT_LINKS.issuesUrl, `${ABOUT_META.repoUrl}/issues`)
  assert.equal(ABOUT_LINKS.releasesUrl, `${ABOUT_META.repoUrl}/releases`)
})