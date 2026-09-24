/**
 * import-log 模型测试（node:test，零依赖）。
 *
 * 字形一律用码点转义书写（与实现同款）：日志里的 ▶ ✓ ⚠ ✗ – ⏭ 在编辑链路上极易被
 * 替换 / 插入零宽字符，直接抄字形会让测试在「字形看起来一样」的情况下假绿或假红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildImportLogModel,
  filterImportLogEntries,
  importLogLevelIcon,
  parseImportLogLine,
} from './import-log.ts'

const RUN = '\u25b6'
const OK = '\u2713'
const WARN = '\u26a0'
const FAIL = '\u2717'
const SKIP = '\u2013'
const USER_SKIP = '\u23ed'

test('import-log: 单行解析 —— 五种项状态行 + 命令 + 普通说明', () => {
  assert.deepEqual(parseImportLogLine(RUN + ' plugin:a'), { kind: 'item', level: 'running', id: 'plugin:a' })
  assert.deepEqual(parseImportLogLine(OK + ' plugin:a'), { kind: 'item', level: 'ok', id: 'plugin:a' })
  assert.deepEqual(parseImportLogLine(WARN + ' plugin:a'), { kind: 'item', level: 'warn', id: 'plugin:a' })
  assert.deepEqual(parseImportLogLine(FAIL + ' mcp:x'), { kind: 'item', level: 'fail', id: 'mcp:x' })
  assert.deepEqual(parseImportLogLine(SKIP + ' settings:a'), { kind: 'item', level: 'skip', id: 'settings:a' })
  assert.deepEqual(parseImportLogLine(USER_SKIP + ' plugin:b'), { kind: 'item', level: 'skip', id: 'plugin:b' })
  assert.deepEqual(parseImportLogLine('$ dsh plugin add pkg'), {
    kind: 'detail', detail: { kind: 'command', text: '$ dsh plugin add pkg' },
  })
  assert.deepEqual(parseImportLogLine('本地插件 x 的 tarball 解包失败'), {
    kind: 'detail', detail: { kind: 'text', text: '本地插件 x 的 tarball 解包失败' },
  })
})

test('import-log: 只有字形没有项 id 的行不算项（退化为说明行，不吞信息）', () => {
  const parsed = parseImportLogLine(WARN + ' ')
  assert.equal(parsed.kind, 'detail')
})

test('import-log: 同一项的开始行 + 命令行 + 收尾行合并成一条记录', () => {
  const model = buildImportLogModel([
    RUN + ' plugin:@scope/a',
    '$ dsh plugin --profile web add @scope/a',
    'npm warn deprecated',
    OK + ' plugin:@scope/a',
    RUN + ' plugin:b',
    '$ dsh plugin --profile web add b',
    FAIL + ' plugin:b',
  ])
  assert.equal(model.entries.length, 2, '两个 itemId → 两条记录（不再是一屏流水）')
  const [a, b] = model.entries
  assert.equal(a?.id, 'plugin:@scope/a')
  assert.equal(a?.level, 'ok', '收尾行覆盖开始行的 running')
  assert.deepEqual(a?.details.map((d) => d.kind), ['command', 'text'], '命令与说明都挂在该项下')
  assert.equal(b?.level, 'fail')
  assert.deepEqual(model.counts, { ok: 1, warn: 0, fail: 1, skip: 0, running: 0 })
  assert.equal(model.problems, 1)
  assert.equal(model.finished, 2)
})

test('import-log: 项之外的行进 loose（不挂到别的项上）', () => {
  const model = buildImportLogModel(['引擎在项之外发出的说明', RUN + ' settings:a', OK + ' settings:a'])
  assert.deepEqual(model.loose, [{ kind: 'text', text: '引擎在项之外发出的说明' }])
  assert.equal(model.entries[0]?.details.length, 0)
})

test('import-log: 计数 —— 跳过分两类（– 与 ⏭）但同计 skip；problems = warn + fail', () => {
  const model = buildImportLogModel([
    OK + ' a', WARN + ' b', FAIL + ' c', SKIP + ' d', USER_SKIP + ' e', RUN + ' f',
  ])
  assert.deepEqual(model.counts, { ok: 1, warn: 1, fail: 1, skip: 2, running: 1 })
  assert.equal(model.problems, 2, '跳过不算「需要注意」')
  assert.equal(model.finished, 5)
  for (const level of ['running', 'ok', 'warn', 'fail', 'skip'] as const) {
    assert.equal(typeof importLogLevelIcon(level), 'string')
    assert.notEqual(importLogLevelIcon(level), '')
  }
})

test('import-log: 只看问题 —— 保留警告/失败/进行中，隐藏成功与跳过', () => {
  const model = buildImportLogModel([OK + ' a', RUN + ' b', WARN + ' c', SKIP + ' d', FAIL + ' e'])
  assert.deepEqual(filterImportLogEntries(model, false).map((e) => e.id), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(filterImportLogEntries(model, true).map((e) => e.id), ['b', 'c', 'e'])
})

test('import-log: 现场样本（截图同型 —— 逐插件 ▶/$/✓ 三连 + 一个未收尾的 ▶）', () => {
  const model = buildImportLogModel([
    RUN + ' plugin:@linx/dsh-a',
    '$ dsh plugin --profile cmtest add @linx/dsh-a',
    OK + ' plugin:@linx/dsh-a',
    RUN + ' plugin:@linx/dsh-b',
    '$ dsh plugin --profile cmtest add @linx/dsh-b',
    OK + ' plugin:@linx/dsh-b',
    RUN + ' plugin:dsh-better-sidebar',
    '$ dsh plugin --profile cmtest add dsh-better-sidebar',
  ])
  assert.equal(model.entries.length, 3, '6 行流水 → 3 条可读记录')
  assert.equal(model.counts.ok, 2)
  assert.equal(model.counts.running, 1, '最后一项尚未收尾 → 进行中')
  assert.equal(model.problems, 0)
  assert.deepEqual(filterImportLogEntries(model, true).map((e) => e.id), ['plugin:dsh-better-sidebar'])
})
