/**
 * rollback 展示模型的护栏（纯函数；对应 src/ui/rollback-view.ts）。
 *
 * 钉住七件事：
 *  ① 未知码 / 未知态 / 未知来源**回落 unknown 键**（绝不裸渲染机器码）；
 *  ② 用户自由文本（note）与宿主技术细节（detail / guidance.detail / 路径清单）**渲染前必过 redact**；
 *  ③ 「可回退 / 可删除」的判定（受保护 / 两态不全 / 段可回退性 / 至少一段可用）；
 *  ④ mode 三选一映射（files+session / files / session）+ 未知回落；
 *  ⑤ 预览计数文案（overwrite / different / missing / createdAfter；清单按长度算）；
 *  ⑥ **只出现 workspace + session 两态**（源码级：第三态 config 已绝迹）；
 *  ⑦ 按会话分组的时间线（组内保序 / 组间按最新时间倒序 / 未知会话排最后）+ 时间线行事实
 *     （文件数 / 是否有会话游标）+ 预览的字节游标（t3 面板要用的三样）；
 *  ⑧ E1 逐文件行级统计的形状（`workspace.files`）：null 不当 0 外，**与引擎侧类型逐字对齐**
 *     （源码级钉住 path/status/added/removed/truncated 五字段与四种 status 枚举名）。
 *
 * 字段口径与 T1 宿主侧 src/core/rollback-point.ts 逐字段对齐（2026-10-10 双人确认）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  ROLLBACK_CODE_UNKNOWN_KEY,
  ROLLBACK_CODES,
  ROLLBACK_GUIDANCE_UNKNOWN_KEY,
  ROLLBACK_KIND_UNKNOWN_KEY,
  ROLLBACK_MAX_POINTS_GUARDS_PER_SESSION,
  ROLLBACK_MAX_POINTS_GUARDS_TOTAL,
  ROLLBACK_MAX_POINTS_PER_SESSION,
  ROLLBACK_MAX_POINTS_TOTAL,
  ROLLBACK_MODES,
  ROLLBACK_MODE_UNKNOWN_KEY,
  ROLLBACK_STATES,
  ROLLBACK_STATE_UNKNOWN_KEY,
  ROLLBACK_WARN_CODES,
  ROLLBACK_WARN_UNKNOWN_KEY,
  isRollbackMode,
  isRollbackState,
  rollbackChildSession,
  rollbackCodeKey,
  ROLLBACK_NOTICE_SKIPPED_KEY,
  ROLLBACK_NOTICE_TRUNCATED_KEY,
  ROLLBACK_PREVIEW_NOTICE_SKIPPED_KEY,
  ROLLBACK_PREVIEW_NOTICE_TRUNCATED_KEY,
  ROLLBACK_PREVIEW_REASON_GUARD_KEY,
  ROLLBACK_PREVIEW_REASON_HOST_REFUSED_KEY,
  ROLLBACK_PREVIEW_REASON_INCOMPLETE_KEY,
  rollbackGuidanceRows,
  rollbackModeFromSegments,
  rollbackPointGroups,
  rollbackRowFileCount,
  rollbackRowHasSessionCursor,
  rollbackModeKey,
  rollbackModeSegments,
  rollbackEntryVisible,
  rollbackOutcome,
  rollbackPointRows,
  rollbackPreviewGuidance,
  rollbackPreviewFileLabel,
  rollbackPreviewNote,
  rollbackPreviewScope,
  splitRollbackPath,
  rollbackPreviewRows,
  rollbackPreviewVerdict,
  rollbackPreviewWarnings,
  rollbackRewindCounts,
  rollbackRewindRows,
  rollbackSkippedSegments,
  rollbackStateKey,
  type RollbackListResult,
  type RollbackPointSummary,
  type RollbackPreviewFile,
  type RollbackPreviewResult,
  type RollbackRewindResult,
  type RollbackSegmentSummary,
} from './rollback-view.ts'

const SOURCE_PATH = fileURLToPath(new URL('./rollback-view.ts', import.meta.url))

function segment(over: Partial<RollbackSegmentSummary> = {}): RollbackSegmentSummary {
  return { state: 'workspace', ok: true, degraded: false, reasonCode: null, entries: 3, bytes: 12, cursorBytes: null, restorable: true, ...over }
}

function point(over: Partial<RollbackPointSummary> = {}): RollbackPointSummary {
  return {
    id: 'rp-1', createdAt: 1_700_000_000_000, sessionId: 'sess-1', turn: 7, kind: 'auto',
    protected: false, incomplete: false, note: null, spreadMs: 12,
    segments: [segment({ state: 'workspace' }), segment({ state: 'session', entries: 1, cursorBytes: 4096 })],
    ...over,
  }
}

function list(points: RollbackPointSummary[]): RollbackListResult {
  return {
    ok: true, points,
    storage: { available: true, root: 'C:/home/.dsh/dsh-config-manager/rollback-points', guidance: [], requirements: [] },
    maxRecords: 50, maxRecordsPerSession: 20,
  }
}

test('两态：只有 workspace + session，第三态 config 一律回落 unknown', () => {
  assert.deepEqual([...ROLLBACK_STATES], ['workspace', 'session'])
  assert.equal(rollbackStateKey('workspace'), 'rollback.state.workspace')
  assert.equal(rollbackStateKey('session'), 'rollback.state.session')
  assert.equal(rollbackStateKey('config'), ROLLBACK_STATE_UNKNOWN_KEY, '已删除的第三态必须回落 unknown')
  assert.equal(rollbackStateKey('something-new'), ROLLBACK_STATE_UNKNOWN_KEY)
  assert.equal(rollbackStateKey(null), ROLLBACK_STATE_UNKNOWN_KEY)
  assert.equal(isRollbackState('config'), false)
  assert.equal(isRollbackState('session'), true)
  for (const mode of ROLLBACK_MODES) {
    for (const state of rollbackModeSegments(mode)) assert.ok(ROLLBACK_STATES.includes(state), mode + ' 产出了非两态的段：' + state)
  }
  // 源码级：去掉注释后，代码里不得再出现第三态字面量
  const code = fs.readFileSync(SOURCE_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.equal(code.includes("'config'"), false, 'rollback-view.ts 代码里不得再出现第三态 config')
  assert.equal(code.includes('rollback.state.config'), false)
  // 列表行也只渲染两态标签
  const rows = rollbackPointRows(list([point()]))
  assert.deepEqual(rows[0]?.segments.map((s) => s.labelKey), ['rollback.state.workspace', 'rollback.state.session'])
})

test('未知 code 回落 unknown（白名单外的机器码绝不裸渲染）', () => {
  assert.equal(rollbackCodeKey('confirmation-required'), 'rollback.code.confirmation-required')
  assert.equal(rollbackCodeKey('no-boundary'), 'rollback.code.no-boundary')
  assert.equal(rollbackCodeKey('mutation-locked'), 'rollback.code.mutation-locked')
  assert.equal(rollbackCodeKey('deleted'), 'rollback.code.deleted')
  assert.equal(rollbackCodeKey('ok'), 'rollback.code.ok')
  assert.equal(rollbackCodeKey('record-incomplete'), 'rollback.code.record-incomplete')
  assert.equal(rollbackCodeKey('torn-frame'), ROLLBACK_CODE_UNKNOWN_KEY, '宿主内部分级码不在白名单 → unknown')
  assert.equal(rollbackCodeKey('session-log-missing'), ROLLBACK_CODE_UNKNOWN_KEY)
  assert.equal(rollbackCodeKey(''), ROLLBACK_CODE_UNKNOWN_KEY)
  assert.equal(rollbackCodeKey(null), ROLLBACK_CODE_UNKNOWN_KEY)
  assert.equal(rollbackCodeKey(undefined), ROLLBACK_CODE_UNKNOWN_KEY)
  for (const code of ROLLBACK_CODES) assert.equal(rollbackCodeKey(code), 'rollback.code.' + code)
  // 指引码两种形态都认：裸后缀（旧检查点引擎）与完整字典键（T1 引擎）
  const [known] = rollbackGuidanceRows([{ code: 'workspaceRolledBack', detail: 'C:/ws' }])
  assert.equal(known?.key, 'rollback.guidance.workspaceRolledBack')
  const [qualified] = rollbackGuidanceRows([{ code: 'rollback.guidance.forkUnavailable', detail: 'sess-1' }])
  assert.equal(qualified?.key, 'rollback.guidance.forkUnavailable', 'T1 回传完整字典键时必须原样认，不得回落 unknown')
  const [unknown] = rollbackGuidanceRows([{ code: 'some-new-code' }])
  assert.equal(unknown?.key, ROLLBACK_GUIDANCE_UNKNOWN_KEY)
  const [unknownQualified] = rollbackGuidanceRows([{ code: 'rollback.guidance.some-new-code' }])
  assert.equal(unknownQualified?.key, ROLLBACK_GUIDANCE_UNKNOWN_KEY, '完整键里的未知后缀同样回落 unknown')
  // 告警一族（T1 的 warnings 回传 rollback.warn.* 完整键）：不认这族会让真实告警显示成「未识别的指引」
  const [warn] = rollbackGuidanceRows([{ code: 'rollback.warn.trackMissing' }])
  assert.equal(warn?.key, 'rollback.warn.trackMissing')
  for (const code of ROLLBACK_WARN_CODES) {
    const [row] = rollbackGuidanceRows([{ code: 'rollback.warn.' + code }])
    assert.equal(row?.key, 'rollback.warn.' + code)
  }
  const [warnUnknown] = rollbackGuidanceRows([{ code: 'rollback.warn.some-new-code' }])
  assert.equal(warnUnknown?.key, ROLLBACK_WARN_UNKNOWN_KEY, '未知告警回落 rollback.warn.unknown（不是指引 unknown）')
  assert.deepEqual(rollbackGuidanceRows(undefined), [])
})

/* ------------------------------------------------------------ T15：预览态四态分派（一处实现） */

const previewNoteKeys = {
  unavailable: 'rollback.preview.files.unavailable',
  unavailableSession: 'rollback.preview.files.unavailableSession',
  noFiles: 'rollback.preview.result.noFiles',
  noFilesSession: 'rollback.preview.files.noFilesSession',
  consistentSession: 'rollback.preview.files.consistentSession',
  consistentNoop: 'rollback.preview.files.empty',
}

test('T15 预览态四态分派：(a) 工作区不可用 / (b) 没记录任何文件 / (c) 一致但会话仍回退 / (d) 一致且无事可做', () => {
  const a = rollbackPreviewNote({ workspace: { available: false, reasonCode: 'chunk-not-found' }, session: { restorable: false } })
  assert.equal(a.kind, 'workspace-unavailable')
  assert.equal(a.key, previewNoteKeys.unavailable)
  assert.equal(a.reasonKey, 'rollback.code.chunk-not-found')
  assert.equal(a.changesSomething, false, '工作区不可用 + 会话不可回退 ⇒ 真的无事可做')
  const b = rollbackPreviewNote({ workspace: { available: true, overwrite: 0, different: 0 }, session: { restorable: false } })
  assert.equal(b.kind, 'no-recorded-files')
  assert.equal(b.key, previewNoteKeys.noFiles, '与结果态共用同一句「没有记录任何文件」')
  assert.equal(b.reasonKey, null)
  const c = rollbackPreviewNote({ workspace: { available: true, overwrite: 5, different: 0, missing: 0 }, session: { restorable: true } })
  assert.equal(c.kind, 'workspace-consistent-session')
  assert.equal(c.key, previewNoteKeys.consistentSession)
  assert.equal(c.changesSomething, true, '会话会 fork ⇒ 点下去真会改动什么')
  const d = rollbackPreviewNote({ workspace: { available: true, overwrite: 5, different: 0 }, session: { restorable: false } })
  assert.equal(d.kind, 'workspace-consistent-noop')
  assert.equal(d.key, previewNoteKeys.consistentNoop)
  assert.equal(d.changesSomething, false)
})

test('T15 优先级：① 不可用 > ② 没记录文件 > ③a 一致但会话回退 > ③b 无事可做', () => {
  const oneOverTwo = rollbackPreviewNote({ workspace: { available: false, overwrite: 0, reasonCode: 'no-chunks' }, session: { restorable: true } })
  assert.equal(oneOverTwo.kind, 'workspace-unavailable')
  assert.equal(oneOverTwo.key, previewNoteKeys.unavailableSession, '① 且会话会 fork ⇒ 用不含「无需恢复」的变体')
  assert.equal(oneOverTwo.changesSomething, true)
  const twoOverThree = rollbackPreviewNote({ workspace: { available: true, overwrite: 0, different: 0 }, session: { restorable: true } })
  assert.equal(twoOverThree.kind, 'no-recorded-files')
  assert.equal(twoOverThree.key, previewNoteKeys.noFilesSession)
  assert.notEqual(twoOverThree.key, previewNoteKeys.consistentSession)
  const threeA = rollbackPreviewNote({ workspace: { available: true, overwrite: 3, different: 0 }, session: { restorable: true } })
  assert.equal(threeA.kind, 'workspace-consistent-session')
})

test('T15 工作区真会写文件 ⇒ 不上屏任何「一致」句（key=null，由文件列表说话）', () => {
  const changes = rollbackPreviewNote({ workspace: { available: true, overwrite: 9, different: 3 }, session: { restorable: false } })
  assert.equal(changes.kind, 'workspace-changes')
  assert.equal(changes.key, null, '有变更时不得上一句「一致/无需恢复」')
  assert.equal(changes.changesSomething, true)
  const missing = rollbackPreviewNote({ workspace: { available: true, overwrite: 9, different: 0, missing: 2 }, session: { restorable: false } })
  assert.equal(missing.kind, 'workspace-changes', 'missing>0 同样会写文件（重新创建）')
})

test('T15 假尾句禁令（键层面）：changesSomething=true 时 key 必为 null 或**非**「无需恢复」键', () => {
  const noopKeys = new Set([previewNoteKeys.consistentNoop, previewNoteKeys.noFiles, previewNoteKeys.unavailable])
  const shapes = [
    { workspace: { available: false, reasonCode: 'chunk-not-found' }, session: { restorable: true } },
    { workspace: { available: false }, session: { restorable: false } },
    { workspace: { available: true, overwrite: 0 }, session: { restorable: true } },
    { workspace: { available: true, overwrite: 0 }, session: { restorable: false } },
    { workspace: { available: true, overwrite: 5, different: 0 }, session: { restorable: true } },
    { workspace: { available: true, overwrite: 5, different: 0 }, session: { restorable: false } },
    { workspace: { available: true, overwrite: 5, different: 2 }, session: { restorable: true } },
    { workspace: null, session: { restorable: true } },
  ]
  for (const shape of shapes) {
    const note = rollbackPreviewNote(shape as never)
    if (!note.changesSomething) continue
    assert.ok(note.key === null || !noopKeys.has(note.key), '会改动什么时不得用「无需恢复」类键：' + JSON.stringify(shape) + ' → ' + String(note.key))
  }
  const blocked = rollbackPreviewNote({ workspace: { available: true, overwrite: 3, different: 0 }, session: { restorable: true }, canRestore: false })
  assert.equal(blocked.sessionForks, false)
  assert.equal(blocked.key, previewNoteKeys.consistentNoop)
})

test('⓪ 会删掉「该点未记录且可证」的路径 ⇒ 不得上屏「一致 / 无需恢复」（2026-10-12 第 6 条 + 删除集收敛）', () => {
  // 真值：宿主 rewind 的 removeCreated **缺省为真**（src/routes/recovery.ts:459 —— body['removeCreated'] !== false），
  // 所以这一类点上「工作区与该回退点一致，无需恢复」同样是假尾句：点下去真会删文件。
  const byCount = rollbackPreviewNote({ workspace: { available: true, overwrite: 5, different: 0, missing: 0, removalsCount: 3 }, session: { restorable: false } })
  assert.equal(byCount.kind, 'workspace-changes', 'removalsCount>0 ⇒ 工作区真会变')
  assert.equal(byCount.key, null, '不得说「一致」（key=null：让文件清单逐条说出来）')
  assert.equal(byCount.changesSomething, true)

  const byList = rollbackPreviewNote({ workspace: { available: true, overwrite: 2, different: 0, removals: ['a', 'b'] }, session: { restorable: true } })
  assert.equal(byList.kind, 'workspace-changes', '只有清单（没有总数）同样要认出来')
  assert.equal(byList.key, null)
  assert.equal(byList.changesSomething, true)
  assert.equal(byList.sessionForks, true, '会话段的事实不受影响（该字段是给「会话仍会回退」用的）')

  // ⓪ 优先于 ②：一条记录都没有、但有会被删掉的路径 ⇒ 更不能说「无需恢复」
  const noFilesButRemovals = rollbackPreviewNote({ workspace: { available: true, overwrite: 0, different: 0, removalsCount: 1 }, session: { restorable: false } })
  assert.equal(noFilesButRemovals.kind, 'workspace-changes')
  assert.equal(noFilesButRemovals.key, null)

  // 反自检①：两边都是 0 时**不得**误判成「会变」（否则 ③b 永远说不上话）
  const clean = rollbackPreviewNote({ workspace: { available: true, overwrite: 5, different: 0, missing: 0, removalsCount: 0, removals: [] }, session: { restorable: false } })
  assert.equal(clean.kind, 'workspace-consistent-noop')
  assert.equal(clean.key, previewNoteKeys.consistentNoop)

  // 反自检②：**「未记录」不等于「会删」**（用户 2026-10-12 的假尾句正是这一类）——
  // 拒删项一堆（.git / 越界 / 过大）而 removalsCount=0 时，不得说「工作区会变」。
  const onlyRefused = rollbackPreviewNote({
    workspace: { available: true, overwrite: 5, different: 0, missing: 0, createdAfter: 40, leftovers: ['a'], createdSkippedCount: 40, removalsCount: 0, removals: [] },
    session: { restorable: false },
  })
  assert.equal(onlyRefused.kind, 'workspace-consistent-noop', '一条都不会删 ⇒ 不得拿「未记录总数」当删除数')
  assert.equal(onlyRefused.changesSomething, false)
})

test('T15 ① 的原因键来源：workspace.reasonCode 优先 → 段摘要回落 → unknown（绝不编原因）', () => {
  assert.equal(rollbackPreviewNote({ workspace: { available: false, reasonCode: 'no-chunks' } }).reasonKey, 'rollback.code.no-chunks')
  assert.equal(rollbackPreviewNote({ workspace: { available: false }, segments: [{ state: 'workspace', reasonCode: 'chunk-not-found' }] }).reasonKey, 'rollback.code.chunk-not-found')
  assert.equal(rollbackPreviewNote({ workspace: { available: false }, segments: [{ state: 'session', reasonCode: 'no-boundary' }] }).reasonKey, ROLLBACK_CODE_UNKNOWN_KEY, '只认 workspace 段')
  assert.equal(rollbackPreviewNote({ workspace: { available: false } }).reasonKey, ROLLBACK_CODE_UNKNOWN_KEY)
  assert.equal(rollbackPreviewNote({ workspace: { available: false, reasonCode: 'brand-new-code' } }).reasonKey, ROLLBACK_CODE_UNKNOWN_KEY, '白名单外回落 unknown（不裸渲染机器码）')
  assert.equal(rollbackPreviewNote({ workspace: null }).kind, 'workspace-unavailable', '没有工作区信息 ⇒ 不能说「一致」')
})

/* ------------------------------------------------------------ T11 防漂移：镜像 != 引擎码表即红 */

/**
 * 从引擎源码里读出 `RollbackCode` union 的全部成员（行扫描：成员行形如 `  | 'code'`）。
 * 遇到空行即认为 union 结束（后面是下一个声明）；union 内部允许 JSDoc/行注释（本次 t10 就插了一段）。
 */
function engineCodeUnion(source: string): string[] {
  const start = source.indexOf('export type RollbackCode =')
  assert.notEqual(start, -1, '引擎里找不到 RollbackCode union（改名即红 —— 镜像对照会失去单一来源）')
  const codes: string[] = []
  for (const line of source.slice(start).split('\n').slice(1)) {
    const trimmed = line.trim()
    if (trimmed === '') break
    if (trimmed.startsWith('|')) {
      const found = /'([a-z0-9-]+)'/.exec(trimmed)
      if (found !== null) codes.push(found[1] as string)
      continue
    }
    if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')) continue
    break
  }
  return codes
}

/** 从本文件的 `ROLLBACK_CODES` 镜像块里读出全部条目（先去掉注释，避免注释里的引号被当成码）。 */
function mirrorCodeList(source: string): string[] {
  const block = /export const ROLLBACK_CODES: readonly string\[\] = \[([\s\S]*?)\n\]/.exec(source)
  assert.notEqual(block, null, '找不到 ROLLBACK_CODES 镜像块（改名即红）')
  const body = ((block as RegExpExecArray)[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  return [...body.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1] as string)
}

test('T11 防漂移：客户端码表镜像与引擎 RollbackCode union **双向集合相等**', () => {
  const engine = fs.readFileSync(fileURLToPath(new URL('../../src/core/rollback-point.ts', import.meta.url)), 'utf8')
  const ui = fs.readFileSync(SOURCE_PATH, 'utf8')
  const engineCodes = engineCodeUnion(engine)
  const mirror = mirrorCodeList(ui)
  // 解析器自检：两侧都必须真的解析出内容，否则「相等」是空集对空集的假绿
  assert.ok(engineCodes.length >= 30, '引擎码表解析结果太少（解析器失效？）：' + engineCodes.length)
  assert.ok(mirror.length >= 30, '镜像解析结果太少（解析器失效？）：' + mirror.length)
  assert.ok(engineCodes.includes('ok') && mirror.includes('ok'), '解析器自检：至少要有 ok')
  // 双向断言：引擎新增码忘了补镜像（本次 t10 no-recorded-files 静默漂移的根因）/ 镜像多写了引擎没有的码，都立刻红
  assert.deepEqual(mirror.filter((code) => !engineCodes.includes(code)), [], '客户端镜像里有引擎码表没有的码')
  assert.deepEqual(engineCodes.filter((code) => !mirror.includes(code)), [], '引擎码表里有码没进客户端镜像（补码时请同步 src/ui/rollback-view.ts）')
  // 两侧都不得有重复项（重复项会让集合相等断言失去意义）
  assert.equal(new Set(engineCodes).size, engineCodes.length, '引擎码表有重复成员')
  assert.equal(new Set(mirror).size, mirror.length, '客户端镜像有重复成员')
  // t11 的分派硬依赖这个字面量 ⇒ 逐字钉住（改名即红，两处都要改）
  assert.ok(engineCodes.includes('no-recorded-files'), '引擎码表必须有 no-recorded-files（t10）')
  assert.ok(mirror.includes('no-recorded-files'), '客户端镜像必须有 no-recorded-files（t11）')
  assert.equal(rollbackCodeKey('no-recorded-files'), 'rollback.code.no-recorded-files', '新码必须映射到自己的字典键（否则界面显示 unknown）')
  assert.notEqual(rollbackCodeKey('no-recorded-files'), ROLLBACK_CODE_UNKNOWN_KEY)
})

/** 反自检：注入式漂移必须被抓到（否则守卫可能因解析失效而永远绿灯 —— 本仓 scale-06 同款纪律）。 */
test('T11 防漂移反自检：注入「引擎有、镜像没有」的码必须被抓到；注释里的假码不得被当成真码', () => {
  const fakeEngine = "export type RollbackCode =\n  | 'ok'\n  | 'brand-new-code'\n\n"
  const fakeMirror = "export const ROLLBACK_CODES: readonly string[] = [\n  'ok',\n  // 注释里的 'fake-code' 不算码\n  /* 'another-fake' */\n]"
  const engineCodes = engineCodeUnion(fakeEngine)
  const mirrorCodes = mirrorCodeList(fakeMirror)
  assert.deepEqual(engineCodes, ['ok', 'brand-new-code'], 'union 解析必须逐字取到成员')
  assert.deepEqual(mirrorCodes, ['ok'], '镜像解析必须去掉注释（注释里的引号不得被当成码）')
  assert.deepEqual(engineCodes.filter((code) => !mirrorCodes.includes(code)), ['brand-new-code'], '注入的漂移必须被这条断言抓到')
  // 反向：镜像多写的码同样被抓到
  assert.deepEqual(['ok', 'stale-code'].filter((code) => !mirrorCodes.includes(code)), ['stale-code'])
})


test('note / detail / guidance.detail / 路径清单 渲染前必过 redact', () => {
  const rows = rollbackPointRows(list([point({ note: 'before refactor password=Hunter2Secret' })]))
  assert.ok(rows[0]?.note !== null)
  assert.equal(rows[0]!.note!.includes('Hunter2Secret'), false, 'note 里的敏感值必须被掩码')

  const rewind: RollbackRewindResult = {
    ok: true, outcome: 'partial', code: 'ok',
    segments: [
      { state: 'workspace', status: 'restored', restored: 2, failed: 1, detail: ['write failed token=ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345'], leftovers: ['C:/ws/token-ghp_ZzYyXxWwVvUuTtSsRrQqPpOo.txt'] },
      { state: 'session', status: 'failed', detail: ['fork failed apiKey: sk-live-abcdefghijklmnop'], guidance: [{ code: 'rollback.guidance.forkUnavailable', detail: 'secret=SuperSecret12345' }] },
    ],
  }
  const view = rollbackRewindRows(rewind)
  assert.equal(view.length, 2)
  for (const line of view[0]!.detail) assert.equal(line.includes('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345'), false, 'detail 行必须脱敏')
  for (const line of view[1]!.detail) assert.equal(line.includes('sk-live-abcdefghijklmnop'), false, 'detail 行必须脱敏')
  for (const line of view[0]!.leftovers) assert.equal(line.includes('ghp_ZzYyXxWwVvUuTtSsRrQqPpOo'), false, '路径清单也要脱敏')
  const guidance = view[1]!.guidance[0]
  assert.equal(guidance?.key, 'rollback.guidance.forkUnavailable')
  assert.ok(guidance?.detail !== null)
  assert.equal(guidance!.detail!.includes('SuperSecret12345'), false, 'guidance.detail 必须脱敏')

  const preview = rollbackPreviewRows({
    ok: true, id: 'rp-1', storage: { available: true },
    workspace: { leftovers: ['C:/ws/new-secret=PlainSecret99.txt'] },
  })
  assert.equal(preview[0]?.leftovers[0]?.includes('PlainSecret99'), false, '预览的 leftovers 清单必须脱敏')
})

test('rollbackPointRows：来源徽章 + 可回退 / 可删除判定 + 回合与留存', () => {
  const rows = rollbackPointRows(list([
    point({ id: 'ok' }),
    point({ id: 'degraded', segments: [segment({ degraded: true }), segment({ state: 'session', restorable: false, ok: false, reasonCode: 'no-boundary' })] }),
    point({ id: 'protected', protected: true }),
    point({ id: 'incomplete', incomplete: true }),
    point({ id: 'guard', kind: 'guard', turn: null }),
    point({ id: 'nothing', segments: [segment({ restorable: false })] }),
    point({ id: 'weird-kind', kind: 'legacy' }),
  ]))
  assert.equal(rows.length, 7)
  assert.equal(rows[0]?.rewindable, true)
  assert.equal(rows[0]?.removable, true)
  assert.equal(rows[0]?.kindKey, 'rollback.kind.auto')
  assert.equal(rows[0]?.turn, 7)
  assert.equal(rows[0]?.sessionId, 'sess-1')
  assert.equal(rows[0]?.segments[0]?.badgeKind, 'ok')
  assert.equal(rows[1]?.segments[0]?.badgeKind, 'warn', '捕获不完整 = warn')
  assert.equal(rows[1]?.segments[1]?.badgeKind, 'error', '没捕到 = error')
  assert.equal(rows[1]?.segments[1]?.reasonKey, 'rollback.code.no-boundary')
  assert.equal(rows[2]?.rewindable, false, '保护点不可回退')
  assert.equal(rows[2]?.removable, false, '保护点不可删除')
  assert.equal(rows[3]?.rewindable, false, '两态不全缺省不可回退')
  assert.equal(rows[3]?.removable, true)
  assert.equal(rows[3]?.badgeKind, 'warn')
  assert.equal(rows[4]?.kindKey, 'rollback.kind.guard', 'guard = 回退前救援点')
  assert.equal(rows[4]?.turn, null, '回合未知 → null（界面渲染 turnUnknown，不编造）')
  assert.equal(rows[5]?.rewindable, false, '没有可回退段 → 不可回退')
  assert.equal(rows[6]?.kindKey, ROLLBACK_KIND_UNKNOWN_KEY, '未知来源回落 unknown')
  assert.deepEqual(rollbackPointRows(null), [], 'null 列表 → 空数组（不抛）')
  assert.equal(rollbackPointRows({ ok: true, points: [], storage: { available: true } }).length, 0)
})

test('mode 三选一映射（files+session / files / session）+ 未知回落', () => {
  assert.deepEqual([...ROLLBACK_MODES], ['files+session', 'files', 'session'])
  assert.equal(rollbackModeKey('files+session'), 'rollback.mode.filesAndSession')
  assert.equal(rollbackModeKey('files'), 'rollback.mode.filesOnly')
  assert.equal(rollbackModeKey('session'), 'rollback.mode.sessionOnly')
  assert.equal(rollbackModeKey('config'), ROLLBACK_MODE_UNKNOWN_KEY)
  assert.equal(rollbackModeKey(null), ROLLBACK_MODE_UNKNOWN_KEY)
  assert.equal(isRollbackMode('files'), true)
  assert.equal(isRollbackMode('files+config'), false)
  assert.deepEqual(rollbackModeSegments('files+session'), ['workspace', 'session'])
  assert.deepEqual(rollbackModeSegments('files'), ['workspace'])
  assert.deepEqual(rollbackModeSegments('session'), ['session'])
  assert.deepEqual(rollbackModeSegments('nope'), [], '未知 mode 不猜段')
  assert.equal(rollbackModeFromSegments(['workspace']), 'files')
  assert.equal(rollbackModeFromSegments(['session']), 'session')
  assert.equal(rollbackModeFromSegments(['workspace', 'session']), 'files+session')
  assert.equal(rollbackModeFromSegments([]), 'files+session')
})

test('预览计数文案：工作区四类计数 + 会话边界/回合号', () => {
  const preview: RollbackPreviewResult = {
    ok: true, id: 'rp-1', storage: { available: true }, canRestore: true, canRemove: true,
    workspace: {
      overwrite: 5, different: 2, missing: 1, createdAfter: 3, leftovers: ['a', 'b', 'c'], leftoversTruncated: false,
      removals: ['del-1', 'del-2'], removalsCount: 25, removalsTruncated: true,
      createdSkipped: ['C:/ws/.git/index'], createdSkippedCount: 3, createdSkippedTruncated: false,
      createdRefusedReason: null,
    },
    session: { from: 9000, to: 4096, turns: 3, restorable: true, active: false },
  }
  const rows = rollbackPreviewRows(preview)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.state, 'workspace')
  assert.equal(rows[0]?.labelKey, 'rollback.state.workspace')
  assert.deepEqual(rows[0]?.counts, [
    { key: 'rollback.preview.overwrite', n: 5 },
    { key: 'rollback.preview.different', n: 2 },
    { key: 'rollback.preview.missing', n: 1 },
    { key: 'rollback.preview.createdAfter', n: 3 },
  ])
  assert.deepEqual(rows[0]?.leftovers, ['a', 'b', 'c'])
  // 删除清单与「未记录清单」**分开**：removals = 会删的（与执行阶段同一份规划），拒删项另算
  assert.deepEqual(rows[0]?.removals, ['del-1', 'del-2'])
  assert.equal(rows[0]?.removalsCount, 25)
  assert.equal(rows[0]?.removalsTruncated, true)
  assert.deepEqual(rows[0]?.createdSkipped, ['C:/ws/.git/index'])
  assert.equal(rows[0]?.createdSkippedCount, 3)
  assert.equal(rows[0]?.createdRefusedReason, null)
  assert.equal(rows[1]?.state, 'session')
  assert.deepEqual(rows[1]?.cursor, { from: 9000, to: 4096 })
  assert.equal(rows[1]?.turns, 3)
  assert.equal(rows[1]?.active, false)
  assert.deepEqual(rows[1]?.counts, [], '会话段没有覆盖计数（它不是文件覆盖）')
  // 只给清单不给计数时，计数按清单长度算
  const listed = rollbackPreviewRows({ ok: true, id: 'rp-3', storage: { available: true }, workspace: { leftovers: ['x', 'y'] } })
  assert.equal(listed[0]?.counts.find((c) => c.key === 'rollback.preview.createdAfter')?.n, 2)
  // 缺字段一律回落安全值（0 / null），不抛
  const sparse = rollbackPreviewRows({ ok: true, id: 'rp-2', storage: { available: true }, workspace: {}, session: {} })
  assert.deepEqual(sparse[0]?.counts.map((c) => c.n), [0, 0, 0, 0])
  assert.deepEqual(sparse[1]?.cursor, { from: null, to: null })
  assert.equal(sparse[1]?.turns, null)
  assert.deepEqual(rollbackPreviewRows(null), [])
})

test('预览判定：可回退 / 可删除 + 不可回退时的原因键 + mode 默认值', () => {
  const base: RollbackPreviewResult = {
    ok: true, id: 'rp-1', storage: { available: true }, canRestore: true, canRemove: true,
    workspace: {}, session: { restorable: true },
  }
  const verdict = rollbackPreviewVerdict(base)
  assert.equal(verdict.canRestore, true)
  assert.equal(verdict.canRemove, true)
  assert.equal(verdict.reasonKey, null)
  assert.equal(verdict.mode, 'files+session')
  assert.deepEqual(verdict.segments, ['workspace', 'session'])

  const protectedPoint = rollbackPreviewVerdict({ ...base, canRestore: false, canRemove: false, code: 'protected-point' })
  assert.equal(protectedPoint.canRestore, false)
  assert.equal(protectedPoint.canRemove, false)
  assert.equal(protectedPoint.reasonKey, 'rollback.code.protected-point')

  const noSegments = rollbackPreviewVerdict({ ...base, canRestore: false, workspace: null, session: null })
  assert.equal(noSegments.canRestore, false)
  assert.equal(noSegments.reasonKey, 'rollback.preview.none')

  // 会话无稳定边界（restorable:false + no-boundary）→ 只剩工作区段
  const filesOnly = rollbackPreviewVerdict({ ...base, session: { restorable: false, reasonCode: 'no-boundary' } })
  assert.equal(filesOnly.mode, 'files')
  assert.deepEqual(filesOnly.segments, ['workspace'])

  // 工作区段显式不可用 → 只剩会话段（session 模式）
  const sessionOnly = rollbackPreviewVerdict({ ...base, workspace: { available: false, reasonCode: 'no-boundary' } })
  assert.equal(sessionOnly.mode, 'session')
  assert.deepEqual(sessionOnly.segments, ['session'])

  // 一段都不可回退时，原因取段的 reasonCode（不裸渲染机器码）
  const nothing = rollbackPreviewVerdict({ ...base, canRestore: false, workspace: { available: false }, session: { restorable: false, reasonCode: 'no-boundary' } })
  assert.equal(nothing.reasonKey, 'rollback.code.no-boundary')

  assert.equal(rollbackPreviewVerdict(null).canRestore, false, '没有预览 → 不可回退（不猜）')
  assert.equal(rollbackPreviewVerdict(null).reasonKey, ROLLBACK_CODE_UNKNOWN_KEY)
})

test('回退结果：结论徽章 / 段状态 / 计数 / 未执行段 / fork 子会话（S3）', () => {
  const restored: RollbackRewindResult = {
    ok: true, outcome: 'restored', code: 'ok', childSessionId: 'child-9', guardPointId: 'guard-2',
    segments: [
      { state: 'workspace', status: 'restored', restored: 3, failed: 0, leftovers: ['a.txt', 'b.txt'] },
      { state: 'session', status: 'restored', restored: 1, failed: 0, leftovers: [], childSessionId: 'child-9' },
    ],
    skippedSegments: [],
  }
  assert.deepEqual(rollbackOutcome(restored.outcome), { key: 'rollback.outcome.restored', badgeKind: 'ok' })
  assert.deepEqual(rollbackOutcome('partial'), { key: 'rollback.outcome.partial', badgeKind: 'warn' })
  assert.deepEqual(rollbackOutcome('failed'), { key: 'rollback.outcome.failed', badgeKind: 'error' })
  assert.deepEqual(rollbackOutcome('denied'), { key: 'rollback.outcome.denied', badgeKind: 'error' })
  assert.deepEqual(rollbackOutcome('weird'), { key: 'rollback.outcome.unknown', badgeKind: 'error' })
  const rows = rollbackRewindRows(restored)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.statusKey, 'rollback.segment.restored')
  assert.equal(rows[0]?.badgeKind, 'ok')
  assert.equal(rows[0]?.leftoversCount, 2, '该点未记录的路径计数（引擎 planCreatedRemovals 的 all 语义）')
  assert.equal(rows[0]?.removedCount, 0, '没开 removeCreated / 宿主没回 removed 时一律 0（不无中生有）')
  assert.deepEqual(rows[0]?.leftovers, ['a.txt', 'b.txt'])
  assert.equal(rows[1]?.childSessionId, 'child-9')
  assert.deepEqual(rollbackRewindCounts(restored), { restored: 4, failed: 0, leftovers: 2, removed: 0 })
  assert.deepEqual(rollbackChildSession(restored), { key: 'rollback.rewind.result.child', id: 'child-9' })
  assert.deepEqual(rollbackSkippedSegments(restored), [])

  const partial: RollbackRewindResult = { ok: false, outcome: 'partial', code: 'restore-failed', segments: [
    { state: 'workspace', status: 'restored', restored: 1 },
    { state: 'session', status: 'skipped', leftovers: ['x'] },
    { state: 'workspace', status: 'something-new' },
  ], skippedSegments: ['session', 'nope'] }
  const view = rollbackRewindRows(partial)
  assert.equal(view[1]?.statusKey, 'rollback.segment.skipped')
  assert.equal(view[1]?.badgeKind, 'warn')
  assert.equal(view[2]?.statusKey, 'rollback.segment.unknown', '未知段状态回落 unknown（绝不裸渲染）')
  assert.equal(view[2]?.badgeKind, 'error')
  assert.deepEqual(rollbackSkippedSegments(partial), [
    { state: 'session', key: 'rollback.state.session' },
    { state: 'nope', key: ROLLBACK_STATE_UNKNOWN_KEY },
  ])
  assert.deepEqual(rollbackRewindRows(null), [])
  assert.equal(rollbackChildSession({ ok: true, outcome: 'restored', code: 'ok' }), null, '没有会话回退就不编造子会话 id')
  assert.equal(rollbackChildSession(null), null)
})

test('按会话分组的时间线：组内保序、组间按最新时间倒序、未知会话排最后', () => {
  const groups = rollbackPointGroups(list([
    point({ id: 'a1', sessionId: 'sess-A', createdAt: 300, turn: 3 }),
    point({ id: 'b1', sessionId: 'sess-B', createdAt: 500, turn: 1 }),
    point({ id: 'a2', sessionId: 'sess-A', createdAt: 100, turn: 1 }),
    point({ id: 'u1', sessionId: null, createdAt: 900, turn: null }),
  ]))
  assert.equal(groups.length, 3)
  assert.equal(groups[0]?.sessionId, 'sess-B', '组间按各组最新时间倒序（B=500 最新）')
  assert.equal(groups[1]?.sessionId, 'sess-A')
  assert.deepEqual(groups[1]?.rows.map((row) => row.id), ['a1', 'a2'], '组内保持台账顺序（时间倒序），不重排')
  assert.equal(groups[1]?.latestAtMs, 300)
  assert.equal(groups[2]?.sessionId, null, '缺 sessionId 的记录归入未知会话组并排在最后（绝不猜归属）')
  assert.deepEqual(rollbackPointGroups(null), [])
  assert.deepEqual(rollbackPointGroups({ ok: true, points: [], storage: { available: true } }), [])
})

test('对话标题：宿主补的 title 透传（渲染前脱敏；没有标题回落 null，绝不编造）', () => {
  const rows = rollbackPointRows(list([
    point({ id: 'a1', sessionId: 'sess-A', title: '配置管理：回滚点' }),
    point({ id: 'a2', sessionId: 'sess-A' }),
    point({ id: 'b1', sessionId: 'sess-B', title: 'before refactor password=Hunter2Secret' }),
  ]))
  assert.equal(rows[0]?.title, '配置管理：回滚点', '宿主给的标题原样透传（界面优先显示它）')
  assert.equal(rows[1]?.title, null, '缓存里没有标题 → null（界面回落显示 sessionId）')
  assert.ok(rows[2]?.title !== null && rows[2]!.title!.includes('Hunter2Secret') === false, '标题进界面前必须过 redact')

  const groups = rollbackPointGroups(list([
    point({ id: 'a1', sessionId: 'sess-A', title: '配置管理：回滚点', createdAt: 100 }),
    point({ id: 'a2', sessionId: 'sess-A', createdAt: 300 }),
    point({ id: 'b1', sessionId: 'sess-B', createdAt: 500 }),
  ]))
  assert.equal(groups[0]?.sessionId, 'sess-B', '组序仍按各组最新时间倒序（新 → 旧）')
  assert.equal(groups[0]?.title, null, '该会话没有标题 → null')
  assert.equal(groups[1]?.title, '配置管理：回滚点', '组标题取组内任一记录的标题')
})

test('时间线行事实：文件数（工作区段条目数）与是否有会话游标', () => {
  const withCursor = rollbackPointRows(list([point()]))[0]
  assert.ok(withCursor !== undefined)
  assert.equal(rollbackRowFileCount(withCursor), 3, '文件数 = 工作区段 entries')
  assert.equal(rollbackRowHasSessionCursor(withCursor), true)

  const withoutCursor = rollbackPointRows(list([point({
    id: 'no-cursor',
    segments: [segment({ state: 'workspace', entries: 7 }), segment({ state: 'session', entries: 1, cursorBytes: null, restorable: false })],
  })]))[0]
  assert.ok(withoutCursor !== undefined)
  assert.equal(rollbackRowFileCount(withoutCursor), 7)
  assert.equal(rollbackRowHasSessionCursor(withoutCursor), false, '没有会话游标 = 只能回退工作区（界面必须如实说）')
})

test('预览的会话段：字节游标 now→target（宿主给得出才有）', () => {
  const rows = rollbackPreviewRows({
    ok: true, id: 'rp-1', storage: { available: true },
    session: { from: 9000, to: 4096, turns: 3, cursorSeq: 4096, cursorNowBytes: 9000, cursorTargetBytes: 4096, restorable: true, active: false },
  })
  assert.deepEqual(rows[0]?.cursor, { from: 9000, to: 4096 })
  assert.deepEqual(rows[0]?.cursorBytes, { now: 9000, target: 4096 })
  const sparse = rollbackPreviewRows({ ok: true, id: 'rp-2', storage: { available: true }, session: {} })
  assert.deepEqual(sparse[0]?.cursorBytes, { now: null, target: null })
})

test('T18-F2：可删判定与宿主一致 —— auto 可删 / guard 与 protected 不可删', () => {
  // 宿主真值（src/core/rollback-point.ts:1512 canRemove = !protected && kind!=='guard'；
  // :1839-1840 remove() 对 protected 与 guard 一律回 protected-point）
  const rows = rollbackPointRows(list([
    point({ id: 'auto-1', kind: 'auto' }),
    point({ id: 'guard-1', kind: 'guard' }),
    point({ id: 'prot-1', protected: true }),
  ]))
  assert.equal(rows[0]?.removable, true, 'auto 点可删（宿主允许）')
  assert.equal(rows[1]?.removable, false, 'guard 点不可删（宿主 remove 必回 protected-point）')
  assert.equal(rows[2]?.removable, false, 'protected 点不可删')
  // 两门互相独立（t22）：guard 可回退（rewindable=true）但不可删（removable=false）
  assert.equal(rows[1]?.rewindable, true, 'guard 行可回退（t22：回退门不排除 guard）')
  assert.equal(rows[1]?.removable, false, '同一行不可删 —— 两门独立，界面不得把「不可删」当「不可回退」')
})

test('T18-F3：不可回退的原因按宿主真实形状分派（code:ok + canRestore:false），绝不回落 unknown', () => {
  // 宿主真实形状：引擎 preview 恒回 code:'ok'，拒绝只体现在 canRestore/canRemove
  //（t22 定稿：rollback-point.ts:1530-1531 —— canRemove = !protected && kind!=='guard' 与
  //  canRestore = !protected && !incomplete && (ws||session 可恢复) 两门**互相独立**）
  const real = (over: Partial<RollbackPreviewResult>): RollbackPreviewResult => ({
    ok: true, code: 'ok', id: 'rp-1', storage: { available: true },
    canRestore: false, canRemove: false,
    workspace: {}, session: { restorable: true },
    ...over,
  })
  const prot = rollbackPreviewVerdict(real({ point: point({ protected: true }) }))
  assert.equal(prot.canRestore, false)
  assert.equal(prot.reasonKey, 'rollback.code.protected-point', '受保护点（真实形状）必须给 protected-point')
  // t22 新真值（本轮 t23 翻正）：救援点**可以**回退 —— canRestore=true 且 canRemove=false；
  // 引擎依据 rollback-point.ts:1531（canRestore 不含 kind!=='guard'）与 :1582（rewind 门 2 只拒 protected）
  const guard = rollbackPreviewVerdict(real({ canRestore: true, point: point({ kind: 'guard' }) }))
  assert.equal(guard.canRestore, true, '救援点必须可回退（t22：回退门不排除 guard）')
  assert.equal(guard.reasonKey, null, '可回退就不给原因键')
  assert.equal(guard.canRemove, false, '同一时刻救援点仍不可删（两门独立）')
  // 救援点专属原因键只在**宿主真的拒绝了一个看起来可恢复的救援点**时使用（不是「救援点一律不可回退」）
  const guardRefused = rollbackPreviewVerdict(real({ point: point({ kind: 'guard' }) }))
  assert.equal(guardRefused.canRestore, false)
  assert.equal(guardRefused.reasonKey, ROLLBACK_PREVIEW_REASON_GUARD_KEY, '宿主拒绝救援点时给救援点专属原因键')
  const incomplete = rollbackPreviewVerdict(real({ point: point({ incomplete: true }) }))
  assert.equal(incomplete.reasonKey, ROLLBACK_PREVIEW_REASON_INCOMPLETE_KEY, '两态不全（真实形状）必须给 incomplete 原因键')
  const hostRefused = rollbackPreviewVerdict(real({}))
  assert.equal(hostRefused.reasonKey, ROLLBACK_PREVIEW_REASON_HOST_REFUSED_KEY, '兜底必须是可证明的「宿主拒绝」键')
  const noSegment = rollbackPreviewVerdict(real({ workspace: { available: false }, session: { restorable: false, reasonCode: 'no-boundary' } }))
  assert.equal(noSegment.reasonKey, 'rollback.code.no-boundary', '一段都不可回退时取段自己的 reasonCode')
  for (const verdict of [prot, guardRefused, incomplete, hostRefused, noSegment]) {
    assert.notEqual(verdict.reasonKey, ROLLBACK_CODE_UNKNOWN_KEY, '真实形状下绝不回落 rollback.code.unknown')
  }
  // 补充（不是唯一覆盖）：伪造 code:'protected-point' 的老形状仍要能给出 protected-point（上面 :264 那条）
  assert.equal(rollbackPreviewVerdict({ ok: true, code: 'protected-point', id: 'x', storage: { available: true }, canRestore: false, canRemove: false, workspace: {}, session: {} }).reasonKey, 'rollback.code.protected-point')
})

test('T18-F1：跳过 / 截断事实在行级与预览级都可见（宿主已如实回传，界面不得静默）', () => {
  const degradedPoint = point({
    id: 'truncated',
    segments: [
      segment({ state: 'workspace', degraded: true, reasonCode: 'capture-truncated', entries: 2, skippedCount: 3, truncated: true }),
      segment({ state: 'session', entries: 1, cursorBytes: 4096 }),
    ],
  })
  const row = rollbackPointRows(list([degradedPoint]))[0]!
  const ws = row.segments[0]!
  assert.equal(ws.skippedCount, 3, '行级必须带跳过计数（S4 可见性）')
  assert.equal(ws.truncated, true, '行级必须带截断事实')
  assert.deepEqual(ws.noticeKeys, [ROLLBACK_NOTICE_SKIPPED_KEY, ROLLBACK_NOTICE_TRUNCATED_KEY], '截断点的行必须给可见告警键')
  assert.equal(row.segments[1]?.noticeKeys.length, 0, '没有跳过/截断的段不产生噪声告警')
  assert.equal(ws.badgeKind, 'warn', 'degraded 段仍是 warn 徽章（与告警键并存）')

  const preview: RollbackPreviewResult = {
    ok: true, code: 'ok', id: 'rp-1', storage: { available: true }, canRestore: true, canRemove: true,
    workspace: { overwrite: 2, different: 1, missing: 0, createdAfter: 3, skippedCount: 3, truncated: true },
    session: { restorable: true },
    warnings: [
      { code: 'rollback.warn.trackDegraded', detail: 'workspace capture-truncated' },
      { code: 'rollback.warn.some-new-code', detail: 'x' },
    ],
    guidance: [{ code: 'rollback.guidance.workspaceRolledBack' }],
  }
  const previewRows = rollbackPreviewRows(preview)
  assert.equal(previewRows[0]?.skippedCount, 3, '预览行必须带跳过计数')
  assert.equal(previewRows[0]?.truncated, true)
  assert.deepEqual(previewRows[0]?.noticeKeys, [ROLLBACK_PREVIEW_NOTICE_SKIPPED_KEY, ROLLBACK_PREVIEW_NOTICE_TRUNCATED_KEY])
  assert.equal(previewRows[0]?.counts.find((c) => c.key === 'rollback.preview.createdAfter')?.n, 3)
  // 点级告警：走 rollback.warn.* 映射，未知码回落 unknown；两行都带同一份（引擎不给段键，绝不猜归属）
  assert.deepEqual(rollbackPreviewWarnings(preview).map((w) => w.key), ['rollback.warn.trackDegraded', ROLLBACK_WARN_UNKNOWN_KEY])
  assert.deepEqual(previewRows[0]?.warnings.map((w) => w.key), ['rollback.warn.trackDegraded', ROLLBACK_WARN_UNKNOWN_KEY])
  assert.deepEqual(previewRows[1]?.warnings.map((w) => w.key), ['rollback.warn.trackDegraded', ROLLBACK_WARN_UNKNOWN_KEY])
  assert.deepEqual(rollbackPreviewGuidance(preview).map((g) => g.key), ['rollback.guidance.workspaceRolledBack'])
  // 告警不改变「可回退」：规格允许部分覆盖，S4 只要求看得见
  assert.equal(rollbackPreviewVerdict(preview).canRestore, true, '有告警不等于禁止回退（绝不因告警禁用恢复）')
  assert.deepEqual(rollbackPreviewWarnings(null), [])
  assert.deepEqual(rollbackPreviewGuidance(null), [])
})

test('文件行主标签 = 文件名（完整路径由 title 承载，信息不丢）', () => {
  assert.equal(rollbackPreviewFileLabel('D:\\Projects\\personal\\dsh-settings-tidy\\hello-world.md'), 'hello-world.md')
  assert.equal(rollbackPreviewFileLabel('/home/u/项目/说明 文档.md'), '说明 文档.md')
  assert.equal(rollbackPreviewFileLabel('plain.md'), 'plain.md')
  assert.equal(rollbackPreviewFileLabel('D:\\a\\b\\'), 'b')
  assert.equal(rollbackPreviewFileLabel(''), '')
})

/**
 * 2026-10-12 第二轮（用户「弹窗太丑」的根因之一）：只画基名时 `.git/index` / `.git/HEAD` 读不出「在哪」。
 * 切分必须与 `rollbackPreviewFileLabel` **同一口径**（尾分隔符剥掉、只切最后一个分隔符）。
 */
test('文件行路径切分 = 目录前缀 + 基名（与主标签同口径）', () => {
  assert.deepEqual(splitRollbackPath('D:\\Projects\\x\\.git\\COMMIT_EDITMSG'), { dir: 'D:\\Projects\\x\\.git\\', base: 'COMMIT_EDITMSG' })
  assert.deepEqual(splitRollbackPath('/home/u/项目/src/a.md'), { dir: '/home/u/项目/src/', base: 'a.md' })
  // 尾分隔符先剥掉 ⇒ 'src/' 归到「根目录下的 src」（与 rollbackPreviewFileLabel('src/') === 'src' 同一口径，
  // 该用例就在下一条测试里；界面因此永远不会画出一条没有基名的行）
  assert.deepEqual(splitRollbackPath('src/'), { dir: '', base: 'src' })
  // 根目录文件：dir 空串 ⇒ 界面不画目录那一段（绝不出现孤零零的 '/'）
  assert.deepEqual(splitRollbackPath('AGENTS.md'), { dir: '', base: 'AGENTS.md' })
  assert.deepEqual(splitRollbackPath(''), { dir: '', base: '' })
  // 与 rollbackPreviewFileLabel 的一致性（同一段基名）
  for (const p of ['D:\\a\\b\\c.md', '/x/y/z.md', 'plain.md']) {
    assert.equal(splitRollbackPath(p).base, rollbackPreviewFileLabel(p), '基名必须与主标签逐字相同：' + p)
  }
})

/**
 * 汇总条口径（第二轮新增）：这一屏的第一决策信息 —— 用户先判规模再逐行核文件。
 * 三条不可放宽：① 文件数 = 列表长度；② ±行数**只累加两侧都可信的行**（null 不得计成 0）；
 * ③ 删除集是另一条清单，单独计数。
 */
test('预览汇总：文件数 = 清单长度、null 行数不计入合计、删除集单独计数', () => {
  const scope = rollbackPreviewScope(
    [
      { added: 3, removed: 1 },
      { added: null, removed: null },   // 「行数未统计」——绝不能被当成 0
      { added: 0, removed: 4 },         // 确信的 0 是**可信**数据，照常计入
    ],
    ['a.txt', 'b/c.txt'],
  )
  assert.deepEqual(scope, { files: 3, added: 3, removed: 5, removals: 2 })
  // 空清单：三个数字都是 0（不是 null —— 这是「确知为空」，与「读不出」是两件事）
  assert.deepEqual(rollbackPreviewScope([], []), { files: 0, added: 0, removed: 0, removals: 0 })
})

test('留存口径（S6）：自动点每会话 20 / 全局 50、救援点每会话 20 / 全局 50 由本模块单点声明', () => {
  assert.equal(ROLLBACK_MAX_POINTS_PER_SESSION, 20)
  assert.equal(ROLLBACK_MAX_POINTS_TOTAL, 50)
  assert.equal(ROLLBACK_MAX_POINTS_GUARDS_PER_SESSION, 20)
  assert.equal(ROLLBACK_MAX_POINTS_GUARDS_TOTAL, 50)
})
/* ------------------------------------------------------------ ⑧ E1：逐文件行级统计（workspace.files） */

test('E1 预览文件行级统计：workspace.files 原样映射，added/removed 为 null 时**不谎报 0**', () => {
  // 三条真实形状：有可信行数的覆盖 / 本次没统计出来的覆盖 / 重新创建
  const overwrite: RollbackPreviewFile = { path: 'C:/ws/a.ts', status: 'overwrite', added: 12, removed: 3, truncated: false }
  const unmeasured: RollbackPreviewFile = { path: 'C:/ws/big.bin', status: 'overwrite', added: null, removed: null, truncated: true }
  const created: RollbackPreviewFile = { path: 'C:/ws/new.ts', status: 'create', added: 7, removed: 0, truncated: false }
  const preview: RollbackPreviewResult = {
    ok: true, id: 'rp-files', storage: { available: true }, canRestore: true,
    workspace: { overwrite: 3, different: 2, missing: 1, createdAfter: 0, files: [overwrite, unmeasured, created] },
    session: { restorable: true },
  }
  const files = preview.workspace?.files ?? []
  assert.equal(files.length, 3)
  assert.deepEqual(files[0], overwrite)
  // 「不知道」不是 0：两侧 null 原样保留 + truncated=true（界面据此说「行数未统计」）
  assert.equal(files[1]?.added, null)
  assert.equal(files[1]?.removed, null)
  assert.equal(files[1]?.truncated, true)
  assert.notEqual(files[1]?.added, 0, '未统计绝不能被当成 0 行新增')
  // create 的语义：新增 = 快照行数、删除 = 0（0 在这里是**可信**的具体数字，与 null 是两回事）
  assert.deepEqual(files[2], { path: 'C:/ws/new.ts', status: 'create', added: 7, removed: 0, truncated: false })
  // delete 只在取值集合里（引擎当前永不产出 —— 回退只覆盖、绝不删除文件）
  const statuses: RollbackPreviewFile['status'][] = ['overwrite', 'create', 'delete']
  assert.deepEqual(statuses, ['overwrite', 'create', 'delete'])
  // 空数组 = 工作区与该回退点一致（E1：只列会被改动的文件）
  const consistent: RollbackPreviewResult = { ok: true, id: 'rp-same', storage: { available: true }, workspace: { files: [] }, session: {} }
  assert.deepEqual(consistent.workspace?.files, [])
  // 字段缺省（老响应 / 老宿主）必须**不抛、不凭空造值**，且既有判定行为一字不变
  const legacy: RollbackPreviewResult = { ok: true, id: 'rp-legacy', storage: { available: true }, workspace: { overwrite: 2 }, session: {} }
  assert.equal(legacy.workspace?.files, undefined, '缺字段就是「没有这条信息」，不得谎报成空数组')
  assert.equal(rollbackPreviewVerdict(legacy).canRestore, false, '判定只看 available/restorable/code，与 files 无关')
  assert.equal(rollbackPreviewRows(legacy)[0]?.counts.find((c) => c.key === 'rollback.preview.overwrite')?.n, 2, '既有计数不受影响')
})

test('E1 类型与引擎逐字同形（源码级）：五字段 + 三种 status + files 必须可选', () => {
  const ui = fs.readFileSync(SOURCE_PATH, 'utf8')
  const engine = fs.readFileSync(fileURLToPath(new URL('../../src/core/rollback-point.ts', import.meta.url)), 'utf8')
  // ① UI 侧类型确实带上了这五个字段（缺一个即红 —— 聊天侧就又要退回结构化读取）
  const uiFile = /export interface RollbackPreviewFile \{([\s\S]*?)\n\}/.exec(ui)?.[1] ?? ''
  for (const field of ['path', 'status', 'added', 'removed', 'truncated']) {
    assert.ok(new RegExp('\\b' + field + '\\s*[:?]').test(uiFile), 'UI 侧 RollbackPreviewFile 缺字段：' + field)
  }
  // ② 引擎侧同名类型形状一致（两侧永远同形；引擎改字段即红，提示同步）
  const engineFile = /export interface RollbackPreviewFile \{([\s\S]*?)\n\}/.exec(engine)?.[1] ?? ''
  for (const field of ['path', 'status', 'added', 'removed', 'truncated']) {
    assert.ok(new RegExp('\\b' + field + '\\s*[:?]').test(engineFile), '引擎侧 RollbackPreviewFile 缺字段：' + field)
  }
  // ③ status 三种取值两侧同名（delete 保留在取值集合里、当前引擎永不产出）
  assert.match(ui, /RollbackPreviewFileStatus = 'overwrite' \| 'create' \| 'delete'/, 'UI 侧 status 枚举形状必须逐字')
  assert.match(engine, /RollbackPreviewFileStatus = 'overwrite' \| 'create' \| 'delete'/, '引擎侧 status 枚举形状必须逐字')
  // ④ workspace.files 必须是**可选**字段（向后兼容老响应）
  assert.match(ui, /files\?: RollbackPreviewFile\[\]/, 'files 必须是可选字段，缺省回落「没有这条信息」')
  // ⑤ 聊天侧不再自带一份重复形状（收敛成同一份类型）
  const chat = fs.readFileSync(fileURLToPath(new URL('../client/chat/rollback-entry-view.ts', import.meta.url)), 'utf8')
  assert.match(chat, /Omit<RollbackPreviewFile, 'status'>/, '聊天侧的预览文件行类型必须复用 UI 的唯一形状（只补运行时兜底态）')
  assert.match(chat, /type RollbackPreviewFile\b/, '复用必须来自 src/ui 的类型导入（不是又抄一份字段表）')
})

/**
 * issue #88：聊天内「↺ 回退」入口的可见性判据。三条口径缺一不可：
 *  ① **明确 false = 收起**（用户把这个功能关了，入口本身就不该存在）；
 *  ② **明确 true = 显示**；
 *  ③ **字段缺失 = 按「默认开」** —— 老宿主的语义就是默认启用，此时藏掉入口会让用户
 *     「有点但没有入口」（那比多画一颗按钮更糟）。
 */
test('issue #88：rollbackEntryVisible —— false 收起 / true 显示 / 缺字段按默认开', () => {
  assert.equal(rollbackEntryVisible({ available: true, rollbackEnabled: false }), false, '明确关闭必须收起')
  assert.equal(rollbackEntryVisible({ available: true, rollbackEnabled: true }), true)
  assert.equal(rollbackEntryVisible({ available: true }), true, '老宿主没有该字段 = 那一版默认开')
  assert.equal(rollbackEntryVisible(null), false, '还没读到状态时不画入口（缺省关闭）')
  assert.equal(rollbackEntryVisible(undefined), false)
})



/* ------------------------------------------------------------------ A+B：逐文件选择的界面模型 */

test('A/B 选择模型：默认排除别的对话改过的文件；全选时不传 onlyPaths', async () => {
  const { rollbackSelectionRows, rollbackDefaultSelection, rollbackOnlyPaths, rollbackSelectionBlocksSubmit } = await import('./rollback-view.ts')
  const preview = {
    ok: true, id: 'rp-1', storage: { available: true },
    workspace: {
      files: [
        { path: 'C:/ws/a.txt', status: 'overwrite', added: 1, removed: 1, truncated: false },
        { path: 'C:/ws/b.txt', status: 'overwrite', added: null, removed: null, truncated: true, foreign: true, foreignSessionId: 'session-x' },
      ],
    },
  } as unknown as import('./rollback-view.ts').RollbackPreviewResult
  const rows = rollbackSelectionRows(preview)
  assert.equal(rows.length, 2)
  assert.equal(rows[1]?.foreign, true)
  assert.equal(rows[1]?.foreignSessionId, 'session-x')
  const fallback = rollbackDefaultSelection(rows)
  assert.deepEqual(fallback, ['C:/ws/a.txt'], '默认只勾非 foreign 的文件')
  assert.deepEqual(rollbackOnlyPaths(rows, fallback), ['C:/ws/a.txt'])
  assert.equal(rollbackOnlyPaths(rows, rows.map((row) => row.path)), null, '全选 ⇒ null（不传字段，走既有全量口径）')
  assert.equal(rollbackSelectionBlocksSubmit(rows, []), true, '一个都没勾必须拦住（宿主侧空数组是 400）')
  assert.equal(rollbackSelectionBlocksSubmit(rows, fallback), false)
  assert.deepEqual(rollbackSelectionRows(null), [])
  assert.deepEqual(rollbackSelectionRows({ workspace: { files: 'nope' } } as unknown as import('./rollback-view.ts').RollbackPreviewResult), [])
})
