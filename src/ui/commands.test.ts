/**
 * commands 单测（纯函数，node:test）。
 *
 * 重点：匹配分档与稳定性、不可用命令「仍然列出但标记 disabled」、目的地命令**不因上下文灰显**、
 * 以及 `titleOf` 注入让本模块与语言无关（测试里用假标题即可）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMMANDS, COMMAND_GROUP_ORDER, COMMAND_RESULT_LIMIT, filterCommands,
  type CommandContext, type CommandItem,
} from './commands.ts'

const TITLES: Record<string, string> = {
  'nav.home': '首页',
  'library.title': '产物库',
  'nav.sync': '同步',
  'nav.market': '市场',
  'environment.title': '环境',
  'nav.export': '导出',
  'nav.import': '导入',
  'foreign.source.title': '从其它 agent 导入',
  'environment.tab.maintenance': '维护与诊断',
  'task.title.runs': '活动记录',
  'task.title.history': '迁移历史',
  'task.title.about': '关于',
  'task.title.publish': '发布到市场',
  'palette.rescue.recovery': '事故恢复',
  'palette.rescue.mode': '救援模式',
  'palette.rescue.rollback': '回滚点（工作区 + 会话回退）',
  'library.source.all': '全部',
  'library.kind.snapshot': '快照',
  'library.kind.backupFile': '备份文件',
  'library.kind.remote': '同步快照',
  'library.kind.market': '市场配置',
}
const titleOf = (key: string): string => TITLES[key] ?? key
const ctx = (patch: Partial<CommandContext> = {}): CommandContext =>
  ({ recoveryRequired: false, runningCount: 0, ...patch })

const ids = (ms: ReturnType<typeof filterCommands>): string[] => ms.map((m) => m.item.id)

test('空查询返回全部，且保持声明顺序（分组交给调用方）', () => {
  const all = filterCommands(COMMANDS, '', titleOf, ctx())
  assert.equal(all.length, COMMANDS.length)
  assert.deepEqual(ids(all), COMMANDS.map((c) => c.id))
})

test('纯空白查询等同空查询', () => {
  assert.equal(filterCommands(COMMANDS, '   ', titleOf, ctx()).length, COMMANDS.length)
})

test('中文标题前缀命中排最前', () => {
  assert.equal(ids(filterCommands(COMMANDS, '导出', titleOf, ctx()))[0], 'export.open')
})

test('英文 id 命中（分隔符不影响段匹配）', () => {
  const found = ids(filterCommands(COMMANDS, 'export', titleOf, ctx()))
  assert.ok(found.includes('export.open'), 'export.open 应命中')
})

test('大小写不敏感', () => {
  assert.deepEqual(
    ids(filterCommands(COMMANDS, 'EXPORT', titleOf, ctx())),
    ids(filterCommands(COMMANDS, 'export', titleOf, ctx())),
  )
})

test('关键词命中（同义说法）', () => {
  assert.ok(ids(filterCommands(COMMANDS, 'webdav', titleOf, ctx())).includes('go.sync'))
})

test('关键词命中：口语「磁盘」直达维护与诊断、「恢复」直达事故恢复', () => {
  assert.ok(ids(filterCommands(COMMANDS, '磁盘', titleOf, ctx())).includes('maintenance.open'))
  assert.ok(ids(filterCommands(COMMANDS, '恢复', titleOf, ctx())).includes('recovery.open'))
})

test('标题前缀优先于 id 前缀', () => {
  // 用英文标题构造：A 命中标题前缀（第 0 档），B 只命中 id 段前缀（第 1 档）。
  const titleOfEn = (key: string): string =>
    ({ 'nav.export': 'Export', 'nav.market': 'Market' } as Record<string, string>)[key] ?? key
  const items: CommandItem[] = [
    { id: 'zzz', group: 'navigate', titleKey: 'nav.export', keywords: [] },
    { id: 'ex.thing', group: 'navigate', titleKey: 'nav.market', keywords: [] },
  ]
  assert.deepEqual(ids(filterCommands(items, 'ex', titleOfEn, ctx())), ['zzz', 'ex.thing'])
})

test('同档保持声明顺序（稳定排序）', () => {
  const a: CommandItem = { id: 'a', group: 'navigate', titleKey: 'nav.export', keywords: [] }
  const b: CommandItem = { id: 'b', group: 'navigate', titleKey: 'nav.export', keywords: [] }
  assert.deepEqual(ids(filterCommands([a, b], '导出', titleOf, ctx())), ['a', 'b'])
})

test('不可用的命令仍然列出，但标记 disabled（机制本身）', () => {
  const items: CommandItem[] = [
    { id: 'needs.ctx', group: 'action', titleKey: 'nav.export', keywords: [], enabled: (c) => c.runningCount > 0 },
  ]
  assert.equal(filterCommands(items, '', titleOf, ctx())[0]?.disabled, true)
  assert.equal(filterCommands(items, '', titleOf, ctx({ runningCount: 1 }))[0]?.disabled, false)
})

test('目的地命令不因上下文灰显：活动记录 / 事故恢复在任何上下文都可点', () => {
  // 回归护栏：这两条曾被 runningCount / recoveryRequired 挡成灰条 —— 用户看到的是一条点不动的选项。
  // 它们是**去处**（面板自己渲染空状态），不是需要前置条件的动作。
  for (const context of [ctx(), ctx({ runningCount: 2, recoveryRequired: true })]) {
    const activity = filterCommands(COMMANDS, '活动', titleOf, context)[0]
    assert.equal(activity?.item.id, 'activity.open')
    assert.equal(activity?.disabled, false)
    const recovery = filterCommands(COMMANDS, '事故', titleOf, context)[0]
    assert.equal(recovery?.item.id, 'recovery.open')
    assert.equal(recovery?.disabled, false)
  }
})

test('每个分组都有命令（空分组 = 渲染出无内容的标题）', () => {
  for (const group of COMMAND_GROUP_ORDER) {
    assert.ok(COMMANDS.some((c) => c.group === group), '空分组: ' + group)
  }
})

test('无匹配返回空数组', () => {
  assert.deepEqual(filterCommands(COMMANDS, 'zzzz', titleOf, ctx()), [])
})

test('limit 生效，且默认值有上限', () => {
  assert.equal(filterCommands(COMMANDS, '', titleOf, ctx(), 3).length, 3)
  assert.ok(COMMAND_RESULT_LIMIT > 0)
})

test('分组顺序常量覆盖全部用到的分组', () => {
  for (const item of COMMANDS) assert.ok(COMMAND_GROUP_ORDER.includes(item.group), item.id)
})

test('命令 id 唯一', () => {
  const seen = new Set<string>()
  for (const item of COMMANDS) {
    assert.ok(!seen.has(item.id), '重复 id: ' + item.id)
    seen.add(item.id)
  }
})

test('每条命令都有标题文案键（缺键的 t() 只在运行期变成原样键名）', () => {
  for (const item of COMMANDS) assert.ok(titleOf(item.titleKey) !== item.titleKey, '缺标题: ' + item.id)
})

test('命令表与壳层分发一一对应（认不出的 id = 点了什么都不做的死选项）', async () => {
  // 双向源码守卫：① 表里有、壳层没有 case → 用户点了一条静默无反应的选项；
  // ② 壳层有 case、表里没有 → 该功能在面板里根本搜不到（maintenance.open 就这样漏过一次）。
  const fs = await import('node:fs')
  const shellUrl = new URL('../client/ConfigManagerSection.tsx', import.meta.url)
  const shell = fs.readFileSync(shellUrl, 'utf8')
  const start = shell.indexOf('const runCommand = (id: string): void => {')
  assert.ok(start > 0, '壳层里找不到 runCommand（改名/搬走了就要同步改这条守卫）')
  const end = shell.indexOf('\n  }', start)
  const body = shell.slice(start, end)
  const declared = [...body.matchAll(/case '([^']+)':/g)].map((m) => m[1] ?? '')
  assert.deepEqual(
    declared.slice().sort(),
    COMMANDS.map((c) => c.id).slice().sort(),
    '命令表与 runCommand 的 case 必须逐条对应',
  )
})
