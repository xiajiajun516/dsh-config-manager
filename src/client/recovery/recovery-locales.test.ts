/**
 * A1c 文案级守卫：`sessions.desc`（面板「会话体检」卡片的说明）必须与面板真实能力同口径。
 *
 * 钉住三件事（口径来自 captain 的逐句核证）：
 *  ① 四档严重级都要点到 —— 旧文案漏了最严重的一档「会让 DSH 起不来」；
 *  ② 应用内可修是**两类**且要写清边界：零损失（重放重复行 / 可证明的合成收尾块）与
 *     有损（序列空洞 / 不可解析行，需逐条显式确认、不批量）—— 旧文案只提了「重放重复行」；
 *  ③ 「其余类别」的真实出路必须分类：布局归位 / 重复 id 隔离 → 离线 `dcm sessions repair --fix` 真会执行；
 *     容器或首帧读不出来 / 格式超前 / 未登记工作区 / 子代理缺父 → **本工具不修**（离线 CLI 也修不了）。
 *     旧的「其余损坏类别仍只能走离线 CLI」把「修不了」说成「有命令可修」，必须绝迹。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { en, zh } from './recovery-locales.ts'
import {
  ROLLBACK_CODES,
  ROLLBACK_GUIDANCE_CODES,
  ROLLBACK_WARN_CODES,
  ROLLBACK_WARN_UNKNOWN_KEY,
  ROLLBACK_STATES,
  ROLLBACK_MODES,
  ROLLBACK_CODE_UNKNOWN_KEY,
  ROLLBACK_GUIDANCE_UNKNOWN_KEY,
  ROLLBACK_KIND_UNKNOWN_KEY,
  ROLLBACK_MODE_UNKNOWN_KEY,
  ROLLBACK_STATE_UNKNOWN_KEY,
  rollbackGuardPolicyKey,
  rollbackModeKey,
  rollbackStateKey,
} from '../../ui/rollback-view.ts'

/** 旧句特征（zh / en）：出现即红 —— 同一不实表述的两种语言形态。 */
const LEGACY_CLAIMS: ReadonlyArray<RegExp> = [
  /仍只能走离线 CLI/,
  /只能走离线 CLI/,
  /still need the offline CLI/i,
  /only (?:via|through) the offline CLI/i,
  /the offline CLI is the only (?:way|option)/i,
]

test('A1c：sessions.desc 不再把「修不了」说成「只能走离线 CLI」', () => {
  const zhText: string = zh['sessions.desc']
  const enText: string = en['sessions.desc']
  assert.ok(zhText.length > 0, 'zh 键必须存在且非空')
  assert.ok(enText.length > 0, 'en 键必须存在且非空')
  for (const re of LEGACY_CLAIMS) {
    assert.doesNotMatch(zhText, re, 'zh 不得再出现旧说法：' + String(re))
    assert.doesNotMatch(enText, re, 'en 不得再出现旧说法：' + String(re))
  }
})

test('A1c：sessions.desc 补齐四档严重级 + 两类应用内修复能力（含预览/备份/回滚承诺）', () => {
  const zhText: string = zh['sessions.desc']
  const enText: string = en['sessions.desc']
  // ① 四档严重级（含最严重的一档 —— 旧文案漏的就是它）
  for (const token of ['会让 DSH 起不来', '读不出来', '下次请求会失败', '看不见']) {
    assert.ok(zhText.includes(token), 'zh 说明必须点到严重级：' + token)
  }
  for (const token of ['block DSH startup', 'cannot load', 'next request fails', 'invisible']) {
    assert.ok(enText.toLowerCase().includes(token.toLowerCase()), 'en 说明必须点到严重级：' + token)
  }
  // ② 两类应用内能力边界
  for (const token of ['零损失', '重放重复行', '合成收尾块', '有损', '序列空洞', '不可解析行', '逐条', '不批量']) {
    assert.ok(zhText.includes(token), 'zh 必须写清能力边界：' + token)
  }
  for (const token of ['lossless', 'replayed duplicate rows', 'synthetic closer', 'lossy', 'seq gaps', 'unparsable', 'explicitly']) {
    assert.ok(enText.toLowerCase().includes(token.toLowerCase()), 'en 必须写清能力边界：' + token)
  }
  // 仍然保留「先预览 / 自动备份 / 可回滚」的承诺（旧文案里成立的那一半不能丢）
  assert.ok(zhText.includes('预览') && zhText.includes('备份') && zhText.includes('可回滚'), 'zh 必须保留预览/备份/可回滚承诺')
  assert.ok(enText.includes('preview') && enText.includes('backup') && enText.includes('rollback'), 'en 必须保留预览/备份/可回滚承诺')
})

test('A1c：sessions.desc 把「其余类别」的两条真实出路分类写清', () => {
  const zhText: string = zh['sessions.desc']
  const enText: string = en['sessions.desc']
  // (i) 离线 CLI **真会改**的那两类（点名到命令）
  for (const token of ['布局归位', '重复 id 隔离', 'dcm sessions repair --fix']) {
    assert.ok(zhText.includes(token), 'zh 必须点出离线可执行的类别与命令：' + token)
  }
  for (const token of ['layout relocation', 'duplicate-id quarantine', 'dcm sessions repair --fix']) {
    assert.ok(enText.toLowerCase().includes(token.toLowerCase()), 'en 必须点出离线可执行的类别与命令：' + token)
  }
  // (ii) 本工具**不修**的那几类（如实说「修不了」，不得再暗示有命令可修）
  for (const token of ['本工具不修', '容器', '首帧读不出来', '格式超前', '未登记工作区', '子代理缺父']) {
    assert.ok(zhText.includes(token), 'zh 必须如实写清修不了的类别：' + token)
  }
  for (const token of ['does not repair', 'container', 'future formats', 'unregistered workspaces', 'without a parent']) {
    assert.ok(enText.toLowerCase().includes(token.toLowerCase()), 'en 必须如实写清修不了的类别：' + token)
  }
})


/**
 * 类级守卫（M2 收尾）：**面板是纯文本渲染**（`RecoveryPanel` 只做 `{t('…')}`，recovery 目录没有 markdown/HTML 辅助），
 * 所以任何 `**` 都会原样显示成星号。这条把人机"看着像加粗"的错觉变回红灯 —— zh/en 一视同仁。
 */
/**
 * S7：rollback.*（工作区 + 会话回滚）字典守卫。
 *
 * 钉四件事：
 *  ① 本任务新增的 rollback.* 键 zh/en **成对且非空**（en 由 `Record<keyof typeof zh, string>` 编译期兜底，
 *     这里再兜一层运行期：值不许是空串）；
 *  ② **两态纪律**：不得出现第三态（rollback.state.config）与「同点判定」（rollback.samePoint.*）；
 *  ③ 判定层（src/ui/rollback-view.ts）会发出的**全部键**都在字典里 —— 缺一个就是界面裸渲键名；
 *  ④ 说明文案必须与代码逐条对得上（自动留点 / 只覆盖记录路径 / 不删新建文件 / fork 子会话 / 原会话只读）。
 */
/** 判定层会发出的固定键（按码拼接的那些由下面的枚举断言覆盖）。 */
const ROLLBACK_FIXED_KEYS: readonly string[] = [
  ROLLBACK_STATE_UNKNOWN_KEY, ROLLBACK_MODE_UNKNOWN_KEY, ROLLBACK_CODE_UNKNOWN_KEY,
  ROLLBACK_GUIDANCE_UNKNOWN_KEY, ROLLBACK_KIND_UNKNOWN_KEY,
  'rollback.title', 'rollback.desc', 'rollback.list.empty', 'rollback.apiMissing',
  'rollback.col.time', 'rollback.col.session', 'rollback.col.turn', 'rollback.col.states',
  'rollback.turn', 'rollback.turnUnknown', 'rollback.badge.incomplete', 'rollback.badge.protected',
  'rollback.retention.hint', 'rollback.autopoint.hint', 'rollback.mode.label',
  'rollback.preview', 'rollback.preview.title', 'rollback.preview.hint', 'rollback.preview.loading',
  'rollback.preview.empty', 'rollback.preview.none', 'rollback.preview.segments',
  'rollback.preview.overwrite', 'rollback.preview.different', 'rollback.preview.missing',
  'rollback.preview.createdAfter', 'rollback.preview.createdAfterTruncated', 'rollback.preview.leftoversTitle',
  'rollback.preview.cursor', 'rollback.preview.cursorBytes', 'rollback.preview.turns', 'rollback.preview.active',
  'rollback.preview.warningsTitle',
  'rollback.preview.reason.guard', 'rollback.preview.reason.incomplete', 'rollback.preview.reason.hostRefused',
  'rollback.preview.notice.skipped', 'rollback.preview.notice.truncated',
  'rollback.group.label', 'rollback.group.unknownSession',
  'rollback.row.files', 'rollback.row.sessionCursor', 'rollback.row.noSessionCursor',
  'rollback.row.notice.skipped', 'rollback.row.notice.truncated',
  'rollback.rewind', 'rollback.rewind.confirm', 'rollback.rewind.allowPartial',
  'rollback.rewind.result.title', 'rollback.rewind.result.counts', 'rollback.rewind.result.child',
  'rollback.rewind.result.guard', 'rollback.rewind.result.skipped',
  'rollback.segment.restored', 'rollback.segment.skipped', 'rollback.segment.failed', 'rollback.segment.unknown',
  'rollback.outcome.restored', 'rollback.outcome.partial', 'rollback.outcome.failed',
  'rollback.outcome.denied', 'rollback.outcome.unknown',
  'rollback.delete', 'rollback.delete.done', 'rollback.delete.confirmTitle',
  'rollback.delete.confirmMessage', 'rollback.delete.protected',
  'rollback.storage.unavailable',
]

test('S7：rollback.* 键 zh/en 成对且非空（判定层会发出的键一个都不缺）', () => {
  const dicts: ReadonlyArray<[string, Record<string, string>]> = [['zh', zh], ['en', en]]
  const offenders: string[] = []
  for (const [lang, dict] of dicts) {
    for (const key of ROLLBACK_FIXED_KEYS) {
      const value = dict[key]
      if (typeof value !== 'string' || value === '') offenders.push(lang + ':' + key)
    }
  }
  assert.deepEqual(offenders, [], '这些 rollback.* 键缺失或为空（界面会裸渲键名）：' + offenders.join(', '))
})

test('S7 收口：旧 checkpoint.* 键必须绝迹（删除旧检查点代码后不得留下死文案）', () => {
  const offenders: string[] = []
  for (const key of [...Object.keys(zh), ...Object.keys(en)]) {
    if (key.startsWith('checkpoint.')) offenders.push(key)
  }
  assert.deepEqual(offenders, [], '旧检查点的文案键必须随旧代码一起删除：' + offenders.slice(0, 10).join(', '))
})

test('S7：两态纪律 —— 无第三态键、无同点判定键、无手动拍点键', () => {
  const banned: RegExp[] = [/^rollback\.state\.config$/, /^rollback\.samePoint\./, /^rollback\.capture/]
  const offenders: string[] = []
  for (const key of [...Object.keys(zh), ...Object.keys(en)]) {
    for (const re of banned) if (re.test(key)) offenders.push(key)
  }
  assert.deepEqual([...new Set(offenders)], [], '第三态 config / 同点判定 / 手动拍点已删除，不得再有对应文案键')
  const expected: string[] = []
  for (const state of ROLLBACK_STATES) expected.push(rollbackStateKey(state))
  for (const mode of ROLLBACK_MODES) expected.push(rollbackModeKey(mode))
  for (const code of ROLLBACK_CODES) expected.push('rollback.code.' + code)
  for (const guidance of ROLLBACK_GUIDANCE_CODES) expected.push('rollback.guidance.' + guidance)
  for (const warn of ROLLBACK_WARN_CODES) expected.push('rollback.warn.' + warn)
  expected.push(ROLLBACK_WARN_UNKNOWN_KEY)
  for (const policy of ['require', 'warn', 'off']) expected.push(rollbackGuardPolicyKey(policy))
  expected.push('rollback.kind.auto', 'rollback.kind.guard')
  const zhDict: Record<string, string> = zh
  const enDict: Record<string, string> = en
  const missing = expected.filter((key) => typeof zhDict[key] !== 'string' || typeof enDict[key] !== 'string')
  assert.deepEqual(missing, [], '枚举对应文案键缺失：' + missing.join(', '))
})

test('S7：rollback.desc 与代码逐条对得上（自动留点 / 只覆盖记录路径 / 不删新建 / fork 子会话 / 原会话只读）', () => {
  const zhText: string = zh['rollback.desc']
  const enText: string = en['rollback.desc']
  for (const token of ['回合', '自动', '工作区', '会话游标', '只覆盖', '绝不删除', '新建', 'fork', '只读', '改写']) {
    assert.ok(zhText.includes(token), 'zh 说明必须写清：' + token)
  }
  for (const token of ['turn', 'automatic', 'workspace', 'session cursor', 'only overwrites', 'never deleted', 'fork', 'read-only', 'rewritten']) {
    assert.ok(enText.toLowerCase().includes(token.toLowerCase()), 'en 说明必须写清：' + token)
  }
})

/**
 * T17：留存 / 保护 / 救援点文案必须能被**引擎代码逐句证明**（两侧诚实）。
 *
 * 引擎真值（src/core/rollback-point.ts，t14 冻结）：
 *  - ROLLBACK_MAX_RECORDS = 50（全局自动点）/ ROLLBACK_MAX_RECORDS_PER_SESSION = 20（每会话自动点）；
 *  - ROLLBACK_MAX_GUARDS_PER_SESSION = 20：guard 救援点**不占**自动点预算、**不受** 20/50 淘汰，
 *    但用户删不掉（remove 一律 protected-point），所以**有自己的**每会话上限，超出淘汰最旧的 guard；
 *  - selectPrune：protected 点只进不出（生产路径造不出来）；guard 可作为回退目标（rewind 只拒 protected）。
 *
 * 为什么用源码级读常量而不是 import core：client 侧测试不把宿主运行时（node:fs 链）拖进来；
 * 这条同时把「文案里的数字 = 引擎常量」钉死 —— 常量改了而文案没跟，本用例即红。
 */
const ENGINE_PATH = fileURLToPath(new URL('../../../src/core/rollback-point.ts', import.meta.url))

/** 从引擎源码里读一个数值常量（改名 / 删除即红）。 */
function engineNumberConstant(name: string): number {
  const src = fs.readFileSync(ENGINE_PATH, 'utf8')
  const found = new RegExp('export const ' + name + '\\s*=\\s*(\\d+)').exec(src)
  assert.notEqual(found, null, '引擎里找不到常量 ' + name + '（改名即红）')
  return Number((found as RegExpExecArray)[1])
}

test('T17：留存/救援点文案与引擎三常量逐句对齐，旧的不实表述绝迹', () => {
  const maxRecords = engineNumberConstant('ROLLBACK_MAX_RECORDS')
  const perSession = engineNumberConstant('ROLLBACK_MAX_RECORDS_PER_SESSION')
  const guards = engineNumberConstant('ROLLBACK_MAX_GUARDS_PER_SESSION')
  assert.equal(maxRecords, 50, '引擎全局自动点上限应为 50')
  assert.equal(perSession, 20, '引擎每会话自动点上限应为 20')
  assert.equal(guards, 20, '引擎每会话救援点上限应为 20')

  const zhHint: string = zh['rollback.retention.hint']
  const enHint: string = en['rollback.retention.hint']
  // ① 救援点三条事实：不占 20/50 预算 / 用户删不掉 / 有自己的每会话上限（数字 = 引擎常量）
  for (const token of ['救援点', '不占', '删不掉', String(guards), '淘汰最旧的救援点']) {
    assert.ok(zhHint.includes(token), 'zh 留存说明必须写清：' + token)
  }
  for (const token of ['rescue point', 'do not count against', 'cannot delete', String(guards), 'oldest rescue point']) {
    assert.ok(enHint.toLowerCase().includes(token.toLowerCase()), 'en 留存说明必须写清：' + token)
  }
  // ② 占位符必须恰好是组件真正传入的两个（多一个会被原样渲染成 {xxx}）
  const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => String(m[1])).sort()
  assert.deepEqual(placeholders(zhHint), ['perSession', 'total'], 'zh 留存说明的占位符必须恰好是 perSession/total')
  assert.deepEqual(placeholders(enHint), ['perSession', 'total'], 'en 留存说明的占位符必须恰好是 perSession/total')

  // ③ 旧的不实表述绝迹（任何键、任何语言）
  const legacy: RegExp[] = [
    /只淘汰最旧的非保护点/, /永不淘汰/, /无上限保留/, /救援点受保护/, /救援点永不淘汰/,
    /only drops the oldest unprotected points/i, /never evicted/i, /no upper limit/i, /rescue point is protected/i,
  ]
  const offenders: string[] = []
  for (const [key, value] of [...Object.entries(zh), ...Object.entries(en)]) {
    for (const re of legacy) if (re.test(value)) offenders.push(key + ' :: ' + String(re))
  }
  assert.deepEqual(offenders, [], '不实表述必须绝迹（受保护点与救援点的淘汰口径只有一份真值）：' + offenders.join(', '))

  // ④ 删除确认 / 删除拒绝文案与引擎「protected 与 guard 一律拒绝删除」一致
  for (const token of ['救援点', '一律拒绝删除', '自动淘汰']) {
    assert.ok(zh['rollback.delete.confirmMessage'].includes(token), 'zh 删除确认必须写清：' + token)
  }
  for (const token of ['rescue point', 'refused by the engine', 'evicted automatically']) {
    assert.ok(en['rollback.delete.confirmMessage'].toLowerCase().includes(token.toLowerCase()), 'en 删除确认必须写清：' + token)
  }
  assert.ok(zh['rollback.delete.protected'].includes('救援点'), 'zh 删除拒绝文案必须覆盖救援点（引擎 remove(guard) 同样 protected-point）')
  assert.ok(en['rollback.delete.protected'].toLowerCase().includes('rescue point'))

  // ⑤ 救援点（t22 冻结口径）：**可以作为回退目标**，但用户不可删除 —— 两门互相独立。
  //    引擎依据：src/core/rollback-point.ts:1531 canRestore = !protected && !incomplete && (ws||session 可恢复)
  //    （**不含** kind!=='guard'）；:1530 canRemove = !protected && kind!=='guard'；:1582 rewind 门 2 只拒 protected。
  //    t17 曾按注释写对、t18 按当时 preview 的真值改错，本轮（t23）按 t22 新真值翻回。
  assert.ok(zh['rollback.code.protected-point'].includes('救援点可作为回退目标'), 'zh protected-point 文案必须写清救援点可作为回退目标')
  assert.ok(en['rollback.code.protected-point'].includes('can be a rewind target'), 'en protected-point 文案必须写清救援点可作为回退目标')
  assert.ok(zh['rollback.code.protected-point'].includes('用户不可删除'), 'zh 同一句必须同时写清救援点不可删除（两门独立）')
  assert.ok(zh['rollback.preview.reason.guard'].includes('通常可作为回退目标'), 'zh 救援点原因键必须说清「救援点通常可回退，这次是宿主拒绝」')
  assert.ok(zh['rollback.kind.guard'].includes('不可删'), 'zh 救援点徽章必须带上「用户不可删」这条真值')
  assert.ok(zh['rollback.kind.guard'].includes('可回退'), 'zh 救援点徽章必须带上「可回退」这条真值（t22）')
  // 反向：不得再出现「救援点不可回退 / 不能作为回退目标」这类旧口径（任何键、任何语言）
  const stale: RegExp[] = [/救援点不可回退/, /不能作为回退目标/, /救援点.*不可回退/, /rescue point cannot be rewound/i, /nor used as a rewind target/i, /rescue point is not rewindable/i]
  const staleHits: string[] = []
  for (const [key, value] of [...Object.entries(zh), ...Object.entries(en)]) {
    for (const re of stale) if (re.test(value)) staleHits.push(key + ' :: ' + String(re))
  }
  assert.deepEqual(staleHits, [], '旧口径（救援点不可回退）必须绝迹：' + staleHits.join(', '))
})
test('T18-F1④：createdAfter / leftovers 文案不得声称「之后新建」（引擎语义 = 该点未记录）', () => {
  // 引擎依据：src/core/rollback-point.ts 的 scanLeftovers 只统计「不在记录里」的文件（`if (captured.has(...)) continue`），
  // 因此留点时**被跳过的既有文件**同样落进 createdAfter / leftovers —— 「之后新建」是不实表述。
  // 只钉「描述那个计数」的三个键：rollback.desc / rollback.rewind.confirm 里的「不删除该点之后新建的文件」
  // 是**删除保证**（S4：绝不删除未记录文件），成立且可证，故不在此列。
  const countKeys = ['rollback.preview.createdAfter', 'rollback.preview.leftoversTitle', 'rollback.rewind.result.counts'] as const
  const legacy: RegExp[] = [/之后新建/, /created after (this|the) point/i, /new entries/i, /未删除的新建内容/]
  const offenders: string[] = []
  for (const key of countKeys) {
    for (const re of legacy) {
      if (re.test(zh[key])) offenders.push('zh:' + key + ' :: ' + String(re))
      if (re.test(en[key])) offenders.push('en:' + key + ' :: ' + String(re))
    }
  }
  assert.deepEqual(offenders, [], '计数类文案不得声称「之后新建」（被跳过的既有文件也会进这个计数）：' + offenders.join(', '))
  assert.ok(zh['rollback.preview.createdAfter'].includes('未记录'), 'zh createdAfter 必须说「该点未记录」')
  assert.ok(zh['rollback.preview.leftoversTitle'].includes('未记录'), 'zh leftoversTitle 必须说「该点未记录」')
  assert.ok(en['rollback.preview.createdAfter'].toLowerCase().includes('not recorded'), 'en createdAfter 必须说 not recorded')
  assert.ok(en['rollback.preview.leftoversTitle'].toLowerCase().includes('does not record'), 'en leftoversTitle 必须说 does not record')
})

test('T18-F1：跳过 / 截断 / 点级告警的文案键齐备且 zh/en 成对', () => {
  const keys = [
    'rollback.row.notice.skipped', 'rollback.row.notice.truncated',
    'rollback.preview.notice.skipped', 'rollback.preview.notice.truncated',
    'rollback.preview.warningsTitle',
  ]
  const missing: string[] = []
  for (const key of keys) {
    if (typeof (zh as Record<string, string>)[key] !== 'string') missing.push('zh:' + key)
    if (typeof (en as Record<string, string>)[key] !== 'string') missing.push('en:' + key)
  }
  assert.deepEqual(missing, [], 'S4 可见性所需的文案键缺失：' + missing.join(', '))
  assert.ok(zh['rollback.row.notice.skipped'].includes('{n}'), 'zh 行级跳过告警必须带计数插值')
  assert.ok(en['rollback.row.notice.skipped'].includes('{n}'), 'en 行级跳过告警必须带计数插值')
  assert.ok(zh['rollback.preview.notice.skipped'].includes('{n}'), 'zh 预览跳过计数必须带插值')
})
test('渲染文案不得含字面 markdown 标记 **（面板纯文本渲染）', () => {
  const offenders: string[] = []
  for (const [key, value] of Object.entries(zh)) if (value.includes('**')) offenders.push('zh:' + key)
  for (const [key, value] of Object.entries(en)) if (value.includes('**')) offenders.push('en:' + key)
  assert.deepEqual(offenders, [], '这些键的文案含字面 **，面板纯文本渲染会原样显示星号：' + offenders.join(', '))
})
