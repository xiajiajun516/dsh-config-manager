/**
 * `src/ui/mid-ellipsis.ts` 单测（t6：midEllipsis 三份实现去重）。
 *
 * 收敛前的三份定义点（算法逐字相同，仅默认参数/语句风格不同）：
 *  1. `src/ui/snapshots-view.ts`（`max = 26`）
 *  2. `src/client/sync/history-model.ts`（`max = 26`）
 *  3. `src/client/overview/OverviewPanel.tsx`（私有，`max` 必填，调用点传 52）
 *
 * 本文件钉住四件事：
 *  - 边界：上限附近（max-1 / max / max+1）、单字符、多字节中文、默认上限 26；
 *  - 三处行为一致：快照页与同步历史两处**再导出的是同一个函数对象**，且输入矩阵下输出逐字相同；
 *  - 收敛守卫：全 `src` 只有 `src/ui/mid-ellipsis.ts` 一处定义（源码断言先剥注释，避免
 *    注释里的同名串假绿——本仓库踩过这个坑）；
 *  - 行为等价：`max <= 2` 的退化区沿用历史行为（逐字保留，未顺手改语义）。
 *
 * OverviewPanel.tsx 无法在本测试里 import（`.tsx` 的 JSX 不能被 node 类型剥离加载），
 * 故该调用点用「剥注释后的源码形状 + 下方 `npm run typecheck` 解析 import」双重覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { midEllipsis } from './mid-ellipsis.ts'
import { midEllipsis as fromSnapshotsView } from './snapshots-view.ts'
import { midEllipsis as fromHistoryModel } from '../client/sync/history-model.ts'

/** 定义点形状（函数声明 / 函数表达式赋值）；使用前必须剥注释，勿直接 indexOf 锚字符串。 */
const DEFINITION_RE = /\b(?:export\s+)?(?:function|const|let|var)\s+midEllipsis\b/

/** 与 tests/architecture-boundaries.test.ts 同款注释剥离（`http://` 里的 `//` 不误剥）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/* ------------------------------------------------------------ 边界（统一实现） */

test('midEllipsis：未超上限原样返回（空串 / 单字符 / 恰好等长）', () => {
  assert.equal(midEllipsis(''), '')
  assert.equal(midEllipsis('x'), 'x')
  assert.equal(midEllipsis('a'.repeat(26)), 'a'.repeat(26))
  assert.equal(midEllipsis('a'.repeat(26), 26), 'a'.repeat(26))
})

test('midEllipsis：默认上限 26，且上限附近（max-1 / max / max+1）行为明确', () => {
  const long = '0123456789'.repeat(5) // 50 码元
  assert.equal(midEllipsis(long), midEllipsis(long, 26), '省略 max 必须等价于显式 26')
  assert.equal(midEllipsis(long).length, 26)
  assert.equal(midEllipsis(long, 25).length, 25)
  assert.equal(midEllipsis(long, 27).length, 27)
  assert.equal(midEllipsis(long, 40).length, 40)
  assert.equal(midEllipsis(long, 10).length, 10)
  // 恰好等长（26）与长一位（27）的分界
  assert.equal(midEllipsis('a'.repeat(26)), 'a'.repeat(26))
  assert.equal(midEllipsis('a'.repeat(27)).length, 26)
  // 头尾切分的精确形状（与收敛前逐字相同）
  assert.equal(midEllipsis('0123456789ABCDEFGHIJK', 20), '0123456789…CDEFGHIJK')
  assert.equal(midEllipsis('0123456789ABCDEFGHIJ', 11), '01234…FGHIJ')
})

test('midEllipsis：多字节中文按码元计数，截断不产生半个字符（BMP）', () => {
  const zh = '中文'.repeat(15) // 30 码元
  assert.equal(zh.length, 30)
  const out = midEllipsis(zh) // 默认 26 → head 13 / tail 12
  assert.equal(out, '中文中文中文中文中文中文中…中文中文中文中文中文中文')
  assert.equal(out.length, 26)
  assert.equal([...out].filter((c) => c !== '…').length, 25, '除 … 外恰好保留 25 个中文码元')
  assert.ok(!out.includes('\uFFFD'))
  assert.equal(midEllipsis('中文'.repeat(13)), '中文'.repeat(13), '恰好 26 的中文串不截断')
  assert.equal(midEllipsis('中', 1), '中', '单字符（多字节）不截断')
})

test('midEllipsis：max <= 2 的退化区沿用历史行为（本次收敛逐字保留，未改语义）', () => {
  const s = 'abcdef'
  assert.equal(midEllipsis(s, 2), 'a…abcdef')
  assert.equal(midEllipsis(s, 1), '…abcdef')
  assert.equal(midEllipsis(s, 0), '…bcdef')
})

/* ------------------------------------------------------------ 三处一致 / 收敛守卫 */

test('三处收敛为一份：快照页与同步历史再导出的是同一个函数对象', () => {
  assert.equal(fromSnapshotsView, midEllipsis, 'snapshots-view.ts 应再导出 src/ui/mid-ellipsis.ts 的实现')
  assert.equal(fromHistoryModel, midEllipsis, 'history-model.ts 应再导出 src/ui/mid-ellipsis.ts 的实现')
})

test('三处行为一致：输入矩阵下输出逐字相同，且统一实现满足不变量', () => {
  const samples = [
    '',
    'x',
    '中',
    'a'.repeat(25),
    'a'.repeat(26),
    'a'.repeat(27),
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    '中文'.repeat(15),
    '快照-2026-08-23T12-00-00-000Z.zip',
    '--projectKey--/sessions/2026/08/23/session-abcdef.jsonl.zstd',
  ]
  const maxes: (number | undefined)[] = [undefined, 0, 1, 2, 3, 4, 11, 20, 26, 40, 52]

  for (const s of samples) {
    for (const max of maxes) {
      const expected = midEllipsis(s, max)
      assert.equal(fromSnapshotsView(s, max), expected, `snapshots-view 与统一实现不一致：len=${s.length} max=${max}`)
      assert.equal(fromHistoryModel(s, max), expected, `history-model 与统一实现不一致：len=${s.length} max=${max}`)

      const limit = max ?? 26
      if (limit >= 3) {
        if (s.length <= limit) {
          assert.equal(expected, s, `未超上限必须原样返回：len=${s.length} max=${limit}`)
        } else {
          assert.equal(expected.length, limit, `超上限结果长度必须恰为 max：len=${s.length} max=${limit}`)
          assert.ok(expected.includes('…'))
          assert.equal(expected[0], s[0], '头部保留')
          assert.equal(expected[expected.length - 1], s[s.length - 1], '尾部（唯一区分信息）保留')
        }
      }
    }
  }
})

test('收敛守卫：全 src 只有 src/ui/mid-ellipsis.ts 一处 midEllipsis 定义', () => {
  const SRC = path.resolve(import.meta.dirname, '..')
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) return walk(p)
      return /\.(?:ts|tsx)$/.test(entry.name) ? [p] : []
    })

  const definitions = walk(SRC)
    .filter((file) => DEFINITION_RE.test(stripComments(fs.readFileSync(file, 'utf8'))))
    .map((file) => path.relative(SRC, file).split(path.sep).join('/'))

  assert.deepEqual(definitions, ['ui/mid-ellipsis.ts'], 'midEllipsis 只允许一处定义（其余必须是引用）')
})

test('收敛守卫：三处原定义点改为引用（前两处再导出、第三处直接 import 且调用点未丢失）', () => {
  const SRC = path.resolve(import.meta.dirname, '..')
  const read = (rel: string) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'))

  assert.match(
    read('ui/snapshots-view.ts'),
    /export\s*\{\s*midEllipsis\s*\}\s*from\s*'\.\/mid-ellipsis\.ts'/,
    'snapshots-view.ts 应以再导出引用唯一实现',
  )
  assert.match(
    read('client/sync/history-model.ts'),
    /export\s*\{\s*midEllipsis\s*\}\s*from\s*'\.\.\/\.\.\/ui\/mid-ellipsis\.ts'/,
    'history-model.ts 应以再导出引用唯一实现',
  )
  const overview = read('client/overview/OverviewPanel.tsx')
  assert.match(
    overview,
    /import\s*\{\s*midEllipsis\s*\}\s*from\s*'\.\.\/\.\.\/ui\/mid-ellipsis\.ts'/,
    'OverviewPanel.tsx 应 import 唯一实现',
  )
  assert.match(overview, /midEllipsis\(backupDir,\s*52\)/, 'OverviewPanel.tsx 的调用点应保留（显式 52，行为不变）')
})
