/**
 * SyncSettingsView.tsx 的**分层/拆分结构守卫**（t42）。
 *
 * 为什么是源码级：本仓库 React 无组件测试框架（AGENTS.md：逻辑提炼到 src/ui/ 保证可测），
 * 「组件已退化成装配层 + 渲染段各成文件 + 纯逻辑只在 src/ui」这件事只能按**源码结构**钉住。
 * 断言只锚真实代码结构（import / 函数定义 / JSX 用法 / 逻辑片段 / 行数棘轮），不锚注释文本
 * —— 注释里出现同名字符串不会让守卫假绿；每条断言独立，单独回退会单独变红。
 *
 * 与 src/ui/sync-settings-view.test.ts 的分工：那边测**行为**（22 条），这边测**分层与拆分边界**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/* ------------------------------- 结构守卫：SyncSettingsView.tsx 的分层边界（t42） */

/**
 * 为什么守卫放在这里而不是 src/client/sync/SyncSettingsView.test.tsx：
 * 本仓库 Node（v24）的内置 TS 支持**不加载 .tsx 扩展名**（实测 ERR_UNKNOWN_FILE_EXTENSION），
 * 且 npm test 的 glob 是 src/**\/*.test.ts —— .tsx 守卫文件既不被 glob 匹配、也无法被 node 加载。
 * 因此按可运行优先把它放在逻辑模块的测试文件里（与 src/client/common/plan-text-redaction.test.ts
 * 的源码守卫同源思路）：断言只锚**真实代码结构**（函数定义 / JSX 用法 / import / 逻辑片段），
 * 不锚注释文本，注释里出现同名字符串不会让守卫假绿。
 */
const VIEW_PATH = fileURLToPath(new URL('./SyncSettingsView.tsx', import.meta.url))
const LOGIC_PATH = fileURLToPath(new URL('../../ui/sync-settings-view.ts', import.meta.url))
/** 统一换行（守卫要按 `\n` 跨行匹配，避免 CRLF 让断言静默失真）。 */
const readSource = (file: string): string => fs.readFileSync(file, 'utf8').split('\r\n').join('\n')
const viewSource = readSource(VIEW_PATH)
const logicSource = readSource(LOGIC_PATH)

/**
 * 主组件（SyncSettingsView 函数体）的源码文本：从它的定义到文件里下一个顶层 `function `（子组件都在其后）。
 * 「某段渲染/逻辑已搬出主组件」这类断言必须只针对**主组件**，否则同文件的子组件会让断言失真。
 */

test('t42: 纯逻辑在 ui 模块，且 ui 模块保持框架无关（不反向依赖 client / React）', () => {
  assert.match(viewSource, /from '\.\.\/\.\.\/ui\/sync-settings-view\.ts'/, '组件必须从 ui/sync-settings-view.ts 引入纯逻辑')
  assert.doesNotMatch(logicSource, /from 'react'/, 'ui 逻辑模块不得 import React')
  assert.doesNotMatch(logicSource, /from '\.\.\/client\//, 'ui 逻辑模块不得反向 import client')
})

test('t42: 已下沉的逻辑不得在组件里重新实现（每条独立 → 单独回退单独变红）', () => {
  assert.doesNotMatch(viewSource, /syncSections\.includes\('sessions'\)/, 'sessions 显式放行规则必须只在 ui 里')
  assert.doesNotMatch(viewSource, /encrypt: true, encryptPassword:/, '加密载荷组装必须只在 ui 里')
  assert.doesNotMatch(viewSource, /pollDelayMs \?\?/, 'GitHub 轮询延迟兜底必须只在 ui 里')
  assert.doesNotMatch(viewSource, /Math\.max\(state\.github\.interval/, '轮询兜底计算必须只在 ui 里')
  assert.doesNotMatch(viewSource, /toLocaleString\(/, '时间格式化必须只在 ui 里')
  assert.doesNotMatch(viewSource, /if \(savingRef\.current\)/, '保存防重入判断必须只在 ui 里')
  assert.doesNotMatch(viewSource, /pendingSave\.current =/, '待发改动队列必须走 ui 状态机')
  assert.doesNotMatch(viewSource, /mode: 'advanced',\n\s*sections:/, '分区选择请求体组装必须只在 ui 里')
})

test('t42: 组件按职责物理拆分成独立文件（各自导出 + 主文件只装配）', () => {
  const units: [string, string][] = [
    ['SyncChannelEntryCard', 'SyncChannelEntryCard.tsx'],
    ['ChannelConfigDialog', 'ChannelConfigDialog.tsx'],
    ['SyncSectionPickerDialog', 'SyncSectionPickerDialog.tsx'],
    ['SecurityOptionsCard', 'SecurityOptionsCard.tsx'],
    ['DecryptPasswordCard', 'DecryptPasswordCard.tsx'],
    ['AutosyncCard', 'AutosyncCard.tsx'],
  ]
  for (const [name, file] of units) {
    // 主文件：必须 import 并渲染该单元
    assert.match(viewSource, new RegExp("from '\\./" + file.replace('.', '\\.') + "'"), name + ' 必须从独立文件导入')
    assert.match(viewSource, new RegExp('<' + name + '[\\s/>]'), name + ' 必须被主组件渲染')
    // 单元文件：必须存在、导出该组件、且不反向 import 主文件（避免环）
    const unitSource = readSource(fileURLToPath(new URL('./' + file, import.meta.url)))
    assert.match(unitSource, new RegExp('export function ' + name + '\\('), name + ' 必须在自己的文件里导出')
    assert.doesNotMatch(unitSource, /from '\.\/SyncSettingsView\.tsx'/, name + ' 不得反向 import 主文件')
  }
  // 已迁出的渲染不再出现在主文件（整文件级断言：搬出后必然为真，回退即变红）
  assert.doesNotMatch(viewSource, /WEBDAV_PRESETS\.map/, 'WebDAV 预设渲染必须只在 ChannelConfigDialog.tsx 里')
  assert.doesNotMatch(viewSource, /syncSectionGroups\(/, '分组勾选渲染必须只在 SyncSectionPickerDialog.tsx 里')
  assert.doesNotMatch(viewSource, /settings\.encryptPasswordConfirm/, '加密密码输入必须只在 SecurityOptionsCard.tsx 里')
  // 行数棘轮：主文件显著低于拆分前（1792 行 → 拆分后约 1300 行），回退合并会立刻变大
  const viewLines = viewSource.split('\n').length
  assert.ok(viewLines <= 1400, '主文件行数必须保持在拆分后的量级（实际 ' + viewLines + ' 行）')
})

test('t42: 未新增硬编码颜色（DESIGN.md：颜色/阴影走 --dsw-* token）', () => {
  assert.doesNotMatch(viewSource, /#[0-9a-fA-F]{3,8}\b/, '不得出现硬编码颜色值')
  assert.doesNotMatch(viewSource, /rgba?\(/, '不得出现硬编码 rgb/rgba 颜色')
})
