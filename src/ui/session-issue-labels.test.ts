/**
 * 会话问题码 → 文案键映射的护栏（known-gaps G-24 剩余未做项 ③）。
 *
 * 钉两件事：① 每条已知码都有映射、且映射结果**不是机器码本身**（绝不裸渲染）；
 * ② 未知码回落 sessions.issue.unknown，不抛错、不漏码。
 * 「词典里真有这些键」由 npm run typecheck 兜底：映射结果作为 t() 的实参使用，
 * 键不在 config-manager-recovery 字典里就编译不过（src/ui 不 import client 侧字典，保持分层）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SESSION_ISSUE_CODES,
  SESSION_ISSUE_KEYS,
  SESSION_ISSUE_UNKNOWN_KEY,
  sessionIssueKey,
  sessionIssuesText,
} from './session-issue-labels.ts'

test('每条已知问题码都有词典键（不裸渲染机器码）', () => {
  const keys = Object.values(SESSION_ISSUE_KEYS)
  for (const [code, key] of Object.entries(SESSION_ISSUE_KEYS)) {
    assert.ok(key.startsWith('sessions.issue.'), `${code} 的键必须在 sessions.issue. 命名空间：${key}`)
    assert.notEqual(key, code, `${code} 不得以机器码自身当文案`)
  }
  assert.equal(new Set(keys).size, keys.length, '键必须唯一（两条码共用一个键会让诊断失真）')
  assert.equal(SESSION_ISSUE_CODES.length, keys.length, '运行时码清单必须与映射表同集合')
  assert.ok(!SESSION_ISSUE_CODES.includes(SESSION_ISSUE_UNKNOWN_KEY.replace('sessions.issue.', '')), '未知码回落键不得与任何真实码撞名')
})

test('代表码映射到位（与 core 联合类型逐字对齐）', () => {
  assert.equal(sessionIssueKey('location-mismatch'), 'sessions.issue.locationMismatch')
  assert.equal(sessionIssueKey('duplicate-id'), 'sessions.issue.duplicateId')
  assert.equal(sessionIssueKey('format-newer'), 'sessions.issue.formatNewer')
  assert.equal(sessionIssueKey('missing-message-id'), 'sessions.issue.missingMessageId')
  assert.equal(sessionIssueKey('subagent-without-parent'), 'sessions.issue.subagentWithoutParent')
})

test('未知码回落 unknown（绝不裸渲染、绝不抛错）', () => {
  for (const code of ['', 'not-a-code', 'location_mismatch', 'LOCATION-MISMATCH', '__proto__']) {
    assert.equal(sessionIssueKey(code), SESSION_ISSUE_UNKNOWN_KEY, `未知码必须回落：${code}`)
  }
})

test('sessionIssuesText：按传入顺序拼接、空列表为空串、未知码也上屏（不静默丢失）', () => {
  const t = (key: string): string => key
  assert.equal(sessionIssuesText(['location-mismatch', 'duplicate-id'], t), 'sessions.issue.locationMismatch · sessions.issue.duplicateId')
  assert.equal(sessionIssuesText(['duplicate-id', 'location-mismatch'], t), 'sessions.issue.duplicateId · sessions.issue.locationMismatch', '顺序按传入，不重排')
  assert.equal(sessionIssuesText([], t), '')
  assert.equal(sessionIssuesText(['mystery-code'], t), SESSION_ISSUE_UNKNOWN_KEY, '未知码必须回落成可读标签而不是消失')
})
