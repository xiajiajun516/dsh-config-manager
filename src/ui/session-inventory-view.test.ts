/**
 * 「会话体检」面板展示模型（T5）单测：严重级 → 徽章语义、摘要口径（**未验证必须可见**）、
 * 空态 / 截断 / 相位判定，以及「缺字段不填假值」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_ATTENTION_SEVERITIES,
  SESSION_REPAIR_REASON_KEYS,
  SESSION_REPAIR_VERIFY_KEYS,
  SESSION_SEVERITY_KEYS,
  SESSION_SEVERITY_SHORT_KEYS,
  sessionIssueChips,
  sessionIssueRepairable,
  sessionSeverityChips,
  sessionSeverityShortKey,
  formatSessionBytes,
  sessionHealthEmpty,
  sessionHealthPhase,
  sessionHealthRows,
  sessionHealthSummaryView,
  sessionHealthTruncated,
  sessionRepairBatchEntry,
  sessionRepairCommands,
  sessionRepairEntries,
  sessionRepairReasonKey,
  sessionRepairVerifyKey,
  sessionSeverityBadgeKind,
} from './session-inventory-view.ts';
import type { SessionHealthResponse, SessionHealthRowView, SessionVerifyView } from './session-inventory-view.ts';
import type { SessionHealthSeverity } from '../core/session-health.ts';
// 字典侧守卫用（反向依赖是刻意的：钉住「纯函数返回的键在 zh/en 里逐字存在」）。
import { en as recoveryEn, zh as recoveryZh } from '../client/recovery/recovery-locales.ts';

function row(overrides: Partial<SessionHealthRowView> = {}): SessionHealthRowView {
  return {
    unitId: '--p--/session-a',
    sessionId: 'session-a',
    projectKey: '--p--',
    severity: 'ok',
    issues: [],
    version: 3,
    cwd: 'D:\\proj',
    sizeBytes: 2048,
    mtimeMs: 1_700_000_000_000,
    ...overrides,
  };
}

function response(rows: SessionHealthRowView[], overrides: Partial<SessionHealthResponse> = {}): SessionHealthResponse {
  const by = { blocksStartup: 0, unloadable: 0, nextRequestFails: 0, invisible: 0, ok: 0 } as Record<string, number>;
  for (const r of rows) by[r.severity] = (by[r.severity] ?? 0) + 1;
  return {
    ok: true,
    readOnly: true,
    sessionsDir: 'D:\\home\\sessions',
    sessionsDirExists: true,
    targetFormatVersion: 3,
    summary: {
      total: rows.length,
      bySeverity: by as SessionHealthResponse['summary']['bySeverity'],
      structurallyChecked: rows.length,
      deepVerified: 0,
      deepUnverified: rows.length,
      untested: 0,
      unreadableEntries: 0,
    },
    rows,
    truncated: 0,
    nextSteps: { commands: [], notes: [] },
    ...overrides,
  };
}

test('T5：严重级 → 徽章语义（阻断启动/不可加载 = error；下次请求失败/不可见 = warn；ok = ok）', () => {
  assert.equal(sessionSeverityBadgeKind('blocksStartup'), 'error');
  assert.equal(sessionSeverityBadgeKind('unloadable'), 'error');
  assert.equal(sessionSeverityBadgeKind('nextRequestFails'), 'warn');
  assert.equal(sessionSeverityBadgeKind('invisible'), 'warn');
  assert.equal(sessionSeverityBadgeKind('ok'), 'ok');
  // 每个严重级都有文案键（缺一个就会渲染出裸枚举 —— DESIGN.md 禁止）
  for (const key of Object.values(SESSION_SEVERITY_KEYS)) assert.match(key, /^sessions\.severity\./);
});

test('T5：行 → 展示行（版本/归属/子代理/体积/时间），缺字段一律不填假值', () => {
  // T11 起列表只显示有问题的行 —— 本用例只验字段映射，故给一个需要处理的严重级
  const [full] = sessionHealthRows(response([row({ origin: 'subagent', severity: 'invisible', issues: [{ code: 'format-newer', severity: 'invisible' }] })]));
  assert.equal(full?.versionText, 'v3');
  assert.equal(full?.projectKeyText, '--p--');
  assert.equal(full?.subagent, true);
  assert.equal(full?.sizeText, '2.0 KiB');
  assert.equal(full?.mtimeMs, 1_700_000_000_000);
  assert.deepEqual(full?.issueCodes, ['format-newer']);

  const [bare] = sessionHealthRows(response([row({ severity: 'invisible', issues: [{ code: 'format-newer', severity: 'invisible' }], version: undefined, sizeBytes: undefined, mtimeMs: undefined, projectKey: '' })]));
  assert.equal(bare?.versionText, null);
  assert.equal(bare?.sizeText, null);
  assert.equal(bare?.mtimeMs, null);
  assert.equal(bare?.projectKeyText, null, '空 projectKey 不得渲染成空字符串列');

  assert.deepEqual(sessionHealthRows(null), [], 'null 响应 → 空列表（不是 0 行假数据）');
});

test('T5：摘要口径 —— needsAttention 只数非 ok，且「未验证」必须一直可见', () => {
  const view = sessionHealthSummaryView(response([
    row({ severity: 'unloadable' }),
    row({ severity: 'invisible', unitId: '--p--/b', sessionId: 'b' }),
    row({ severity: 'ok', unitId: '--p--/c', sessionId: 'c' }),
  ]));
  assert.equal(view?.total, 3);
  assert.equal(view?.needsAttention, 2);
  assert.equal(view?.allHealthy, false);
  assert.equal(view?.deepUnverified, 3, '未做深度校验的条数必须如实呈现');
  assert.equal(view?.repairable, 0, '没有问题码 → 0 条可修复');
  assert.equal(sessionHealthSummaryView(null), null);

  // T8：可修复条数只数「重放重复行」（界面据此给「修复」入口）
  // T9：可修复条数覆盖四类可修码（零损失两类 + 有损截断两类），不可修的码不计入
  const withRepairable = sessionHealthSummaryView(response([
    row({ severity: 'nextRequestFails', issues: [{ code: 'replay-duplicate-rows', severity: 'nextRequestFails' }] }),
    row({ severity: 'unloadable', unitId: '--p--/b', sessionId: 'b', issues: [{ code: 'seq-gap', severity: 'unloadable' }] }),
    row({ severity: 'invisible', unitId: '--p--/c', sessionId: 'c', issues: [{ code: 'format-newer', severity: 'invisible' }] }),
  ]));
  assert.equal(withRepairable?.repairable, 2, '重放重复行 + seq 空洞可修；格式超前不可修');
  assert.equal(withRepairable?.needsAttention, 3);
});

test('T5：全绿但**未做深检**时 allHealthy 仍为 true，deepUnverified 保留（界面据此措辞）', () => {
  const view = sessionHealthSummaryView(response([row(), row({ unitId: '--p--/b', sessionId: 'b' })]));
  assert.equal(view?.allHealthy, true);
  assert.equal(view?.needsAttention, 0);
  assert.equal(view?.deepUnverified, 2);
});

test('T5：空态 / 截断 / 相位判定', () => {
  assert.equal(sessionHealthEmpty(response([])), true);
  assert.equal(sessionHealthEmpty(response([row()])), false);
  assert.equal(sessionHealthEmpty(null), false);

  assert.equal(sessionHealthTruncated(response([row()], { truncated: 7 })), 7);
  assert.equal(sessionHealthTruncated(null), 0);

  assert.equal(sessionHealthPhase({ loading: false, error: null, response: null }), 'idle');
  assert.equal(sessionHealthPhase({ loading: true, error: null, response: null }), 'loading');
  assert.equal(sessionHealthPhase({ loading: false, error: null, response: response([]) }), 'ready');
  assert.equal(sessionHealthPhase({ loading: true, error: 'boom', response: null }), 'error', '错误优先于加载态');
});

test('T5：体积格式化（B/KiB/MiB/GiB）与非法值', () => {
  assert.equal(formatSessionBytes(0), '0 B');
  assert.equal(formatSessionBytes(2048), '2.0 KiB');
  assert.equal(formatSessionBytes(5 * 1024 * 1024), '5.0 MiB');
  assert.equal(formatSessionBytes(3 * 1024 * 1024 * 1024), '3.00 GiB');
  assert.equal(formatSessionBytes(-1), '', '非法值不显示（不填 0）');
  assert.equal(formatSessionBytes(Number.NaN), '');
});

test('T5：离线出路恒为三条（应用内修复只覆盖重放重复行，其余仍只有离线一条路）', () => {
  const commands = sessionRepairCommands();
  assert.deepEqual(commands.map((c) => c.command), [
    'dsh-config-manager sessions doctor --json',
    'dsh-config-manager sessions repair',
    'dsh-config-manager sessions repair --fix',
  ]);
  for (const c of commands) assert.match(c.command, /^dsh-config-manager sessions /, '不得给出猜出来的其它工具/命令');
});

test('T9：行 → repairable 覆盖应用内可修的四类（零损失两类 + 有损截断两类）', () => {
  for (const code of ['replay-duplicate-rows', 'synthetic-closer', 'seq-gap', 'unparsable-event']) {
    const [hit] = sessionHealthRows(response([row({ severity: 'nextRequestFails', issues: [{ code, severity: 'nextRequestFails' }] })]));
    assert.equal(hit?.repairable, true, '应当可修: ' + code);
  }
  // 应用内不动的类别：撕裂尾帧（DSH 自愈）、格式超前、缺工作区/缺父对话、header 不可读
  for (const code of [
    'torn-tail', 'format-newer', 'unregistered-workspace', 'subagent-without-parent', 'header-unreadable',
    // T4：工具生命周期码同样只报不修（修复要改写消息/工具行，超出只读体检范围）
    'missing-message-id', 'empty-tool-call-id', 'dangling-tool-call', 'tool-result-id-mismatch', 'duplicate-tool-call-id',
  ]) {
    const [miss] = sessionHealthRows(response([row({ severity: 'invisible', issues: [{ code, severity: 'invisible' }] })]));
    assert.equal(miss?.repairable, false, '不得出现「应用内修复」入口: ' + code);
  }
  // T11：**正常会话默认不进列表**（「只显示有问题的对话」）——全绿时列表为空
  assert.deepEqual(sessionHealthRows(response([row()])), [], '正常会话默认隐藏');
  // 但可修的行即使当前判为 ok 也必须留在列表里（判据分叉时宁可显示也不藏）
  const [keptOk] = sessionHealthRows(response([row({ issues: [{ code: 'replay-duplicate-rows', severity: 'ok' }] })]));
  assert.equal(keptOk?.repairable, true, '可修行不得被过滤掉');
});


test('T4：工具生命周期新码在展示模型里可被消费（裸 code 上屏、不可应用内修复、计入需处理）', () => {
  const cases: { code: string; severity: SessionHealthSeverity }[] = [
    { code: 'missing-message-id', severity: 'unloadable' },
    { code: 'empty-tool-call-id', severity: 'nextRequestFails' },
    { code: 'dangling-tool-call', severity: 'unloadable' },
    { code: 'tool-result-id-mismatch', severity: 'unloadable' },
    { code: 'duplicate-tool-call-id', severity: 'nextRequestFails' },
  ];
  for (const item of cases) {
    assert.equal(sessionIssueRepairable(item.code), false, '生命周期类没有应用内修复入口: ' + item.code);
    const [display] = sessionHealthRows(response([
      row({ severity: item.severity, unitId: '--p--/' + item.code, sessionId: item.code, issues: [{ code: item.code, severity: item.severity }] }),
    ]));
    assert.equal(display?.issueCodes.includes(item.code), true, '新码必须能上屏（沿用既有裸 code 渲染路径）: ' + item.code);
    assert.equal(display?.repairable, false, '不得给「应用内修复」入口: ' + item.code);
    assert.equal(
      display?.severityKey,
      item.severity === 'unloadable' ? SESSION_SEVERITY_KEYS.unloadable : SESSION_SEVERITY_KEYS.nextRequestFails,
      item.code,
    );
    assert.equal(display?.badgeKind, item.severity === 'unloadable' ? 'error' : 'warn', item.code);
  }
  const view = sessionHealthSummaryView(response([
    row({ severity: 'unloadable', unitId: '--p--/a', sessionId: 'a', issues: [{ code: 'tool-result-id-mismatch', severity: 'unloadable' }] }),
    row({ severity: 'nextRequestFails', unitId: '--p--/b', sessionId: 'b', issues: [{ code: 'duplicate-tool-call-id', severity: 'nextRequestFails' }] }),
  ]));
  assert.equal(view?.needsAttention, 2, '新码必须计入「需要处理」');
  assert.equal(view?.repairable, 0, '新码不进「应用内修复」入口');
  assert.equal(view?.hiddenHealthy, 0);
});

test('T11：列表只含有问题的会话（+ 可修行），并如实给出被隐藏的正常会话数', () => {
  const mixed = response([
    row({ severity: 'ok' }),
    row({ severity: 'nextRequestFails', unitId: '--p--/b', sessionId: 'b', issues: [{ code: 'synthetic-closer', severity: 'nextRequestFails' }] }),
    row({ severity: 'ok', unitId: '--p--/c', sessionId: 'c' }),
  ]);
  assert.deepEqual(sessionHealthRows(mixed).map((r) => r.sessionId), ['b'], '只有 b 需要处理');
  assert.equal(sessionHealthSummaryView(mixed)?.hiddenHealthy, 2, '被隐藏的正常会话数必须如实给出');
});

test('T8：修复原因 → 文案键（已知逐个映射；未知/缺省一律回退 unknown）', () => {
  for (const reason of ['unknown-unit', 'not-found', 'locked', 'busy', 'changed', 'repair-not-found', 'already-rolled-back', 'unavailable', 'unreadable', 'corrupt-container', 'torn-tail', 'invalid-header', 'nothing-to-fix', 'verification-refused', 'write-failed', 'postcheck-failed', 'backup-invalid']) {
    assert.match(sessionRepairReasonKey(reason), /^sessions\.repair\.reason\./, '缺映射会渲染出裸枚举: ' + reason);
  }
  assert.equal(sessionRepairReasonKey('locked'), 'sessions.repair.reason.locked');
  assert.equal(sessionRepairReasonKey('no-such-reason'), 'sessions.repair.reason.unknown');
  assert.equal(sessionRepairReasonKey(undefined), 'sessions.repair.reason.unknown');
  for (const key of Object.values(SESSION_REPAIR_REASON_KEYS)) assert.match(key, /^sessions\.repair\.reason\./);
});

test('T8：台账 → 展示行（跳过坏记录、最近在前、回滚态可见）', () => {
  const entries = sessionRepairEntries(response([], {
    repairs: [
      { repairId: 'a', unitId: '--p--/a', sessionId: 'a', at: 100, droppedRows: 2 },
      { repairId: '', unitId: '--p--/bad', sessionId: 'bad', at: 999 },
      { repairId: 'b', unitId: '--p--/b', sessionId: 'b', at: 300, droppedRows: 1, rolledBackAt: 400 },
    ],
  }));
  assert.deepEqual(entries.map((e) => e.repairId), ['b', 'a'], '最近在前，坏记录被跳过');
  assert.equal(entries[0]?.rolledBack, true);
  assert.equal(entries[1]?.rolledBack, false);
  assert.equal(entries[1]?.droppedRows, 2);
  assert.equal(entries[1]?.backupName, null, '缺字段不填假值');
  assert.deepEqual(sessionRepairEntries(null), []);
  assert.deepEqual(sessionRepairEntries(response([])), [], '没有 repairs 字段 → 空列表（不是假数据）');
});

test('M2-⑥：verify-failed / target-changed 有专属文案键，未知原因仍回落 unknown（绝不渲染裸枚举）', () => {
  assert.equal(sessionRepairReasonKey('verify-failed'), 'sessions.repair.reason.verifyFailed');
  assert.equal(sessionRepairReasonKey('target-changed'), 'sessions.repair.reason.targetChanged');
  assert.match(sessionRepairReasonKey('verify-failed'), /^sessions\.repair\.reason\./);
  assert.match(sessionRepairReasonKey('target-changed'), /^sessions\.repair\.reason\./);
  // 新增两个键**不得**放宽兜底：未来原因 / 空串 / undefined 一律 unknown
  assert.equal(sessionRepairReasonKey('some-future-reason'), 'sessions.repair.reason.unknown');
  assert.equal(sessionRepairReasonKey(''), 'sessions.repair.reason.unknown');
  assert.equal(sessionRepairReasonKey(undefined), 'sessions.repair.reason.unknown');
});

test('M2-⑥：复验三态 + 危险态 → 文案键（五个分支逐个钉住）', () => {
  const current: SessionVerifyView = { verified: true, events: 42, strong: true, equivalentToReadPath: true };
  const migrated: SessionVerifyView = { verified: true, events: 7, strong: false, strongDetail: 'installed-build', equivalentToReadPath: false };
  const unverified: SessionVerifyView = { verified: false, reason: 'unavailable', detail: 'profiles-tree:generation-mismatch', equivalentToReadPath: false };

  // ① 现役读盘可读
  assert.equal(sessionRepairVerifyKey(current), 'sessions.repair.verify.current');
  // ② 迁移链可还原（**不等于**现役读盘可读）
  assert.equal(sessionRepairVerifyKey(migrated), 'sessions.repair.verify.migrated');
  // ③ 未验证（**不等于**已验证）
  assert.equal(sessionRepairVerifyKey(unverified), 'sessions.repair.verify.unverified');
  // ④ 没有复验结论（预览路径）→ null：绝不臆造「已验证」
  assert.equal(sessionRepairVerifyKey(undefined), null);
  assert.equal(sessionRepairVerifyKey(undefined, undefined), null);
  // ⑤ rolledBack === false（复验确定性失败且自动回滚没成功）→ 危险态，**优先于其它一切态**
  assert.equal(sessionRepairVerifyKey(unverified, false), 'sessions.repair.verify.rollbackFailed');
  assert.equal(sessionRepairVerifyKey(current, false), 'sessions.repair.verify.rollbackFailed');
  assert.equal(sessionRepairVerifyKey(undefined, false), 'sessions.repair.verify.rollbackFailed');
  // rolledBack === true（已自动回滚）/ 缺省（服务层没回传）都不得抢占三态
  assert.equal(sessionRepairVerifyKey(unverified, true), 'sessions.repair.verify.unverified');
  assert.equal(sessionRepairVerifyKey(undefined, true), null);
  for (const key of Object.values(SESSION_REPAIR_VERIFY_KEYS)) assert.match(key, /^sessions\.repair\.verify\./);
});

test('M2-⑥：两个新原因 + 复验四键在 recovery 字典 zh / en 中逐字存在（键名漂移即红）', () => {
  const keys: string[] = [
    'sessions.repair.reason.verifyFailed',
    'sessions.repair.reason.targetChanged',
    ...Object.values(SESSION_REPAIR_VERIFY_KEYS),
  ];
  assert.equal(new Set(keys).size, 6, '应当是 2 个原因键 + 4 个复验键');
  // 与 SESSION_REPAIR_REASON_KEYS 里登记的两个新原因逐字对应（不是手抄的另一份字符串）
  assert.equal(SESSION_REPAIR_REASON_KEYS['verify-failed'], 'sessions.repair.reason.verifyFailed');
  assert.equal(SESSION_REPAIR_REASON_KEYS['target-changed'], 'sessions.repair.reason.targetChanged');
  for (const key of keys) {
    const zhValue: string = recoveryZh[key as keyof typeof recoveryZh];
    const enValue: string = recoveryEn[key as keyof typeof recoveryEn];
    assert.equal(typeof zhValue, 'string', 'zh 缺键：' + key);
    assert.equal(typeof enValue, 'string', 'en 缺键：' + key);
    assert.ok(zhValue !== '' && enValue !== '', '文案不得为空：' + key);
    assert.notEqual(zhValue, enValue, 'en 必须是镜像而不是复制：' + key);
  }
});

/* ---------------------------------------------- 2026-10-12 弹窗 UI 重构：摘要 chips / 问题 chip */

test('UI-1：需要处理的四档派生于 core 且不含 ok（顺序 = 由重到轻，绝不另抄一份）', () => {
  assert.deepEqual(
    [...SESSION_ATTENTION_SEVERITIES],
    ['blocksStartup', 'unloadable', 'nextRequestFails', 'invisible'],
    '四档顺序必须与 SESSION_HEALTH_SEVERITIES 一致（摘要 chips 与列表排序共用）',
  );
  assert.equal(SESSION_ATTENTION_SEVERITIES.includes('ok' as never), false, 'ok 不是「需要处理」的一档');
});

test('UI-1：摘要 chips 只留 count>0 的档，短标签 + 完整句键同源（0 值不渲染）', () => {
  assert.deepEqual(sessionSeverityChips(null), []);
  const summary = sessionHealthSummaryView(response([
    row({ severity: 'blocksStartup', unitId: '--p--/a', sessionId: 'a', issues: [{ code: 'corrupt-frame', severity: 'blocksStartup' }] }),
    row({ severity: 'invisible', unitId: '--p--/b', sessionId: 'b', issues: [{ code: 'unregistered-workspace', severity: 'invisible' }] }),
    row({ severity: 'invisible', unitId: '--p--/c', sessionId: 'c', issues: [{ code: 'format-newer', severity: 'invisible' }] }),
  ]));
  const chips = sessionSeverityChips(summary);
  assert.deepEqual(chips.map((c) => [c.severity, c.count]), [['blocksStartup', 1], ['invisible', 2]], '只留 >0 的档，且按由重到轻排列');
  assert.equal(chips[0]?.badgeKind, 'error', '阻断启动 = error 语义');
  assert.equal(chips[1]?.badgeKind, 'warn', '看不见 = warn 语义');
  // 短标签与完整句必须是同一份映射（不是手抄的第二组字符串）
  assert.equal(chips[0]?.shortKey, 'sessions.severityShort.blocksStartup');
  assert.equal(chips[0]?.fullKey, SESSION_SEVERITY_KEYS.blocksStartup);
  assert.equal(chips[1]?.fullKey, SESSION_SEVERITY_KEYS.invisible);
  assert.equal(Object.keys(SESSION_SEVERITY_SHORT_KEYS).length, 4, '四档各有短标签（漏一档 typecheck 就该红）');
});

test('UI-1：列表行与摘要 chips 走同一个短标签出口（ok 档回落完整键，绝不渲染空徽章）', () => {
  assert.equal(sessionSeverityShortKey('blocksStartup'), 'sessions.severityShort.blocksStartup');
  assert.equal(sessionSeverityShortKey('ok'), SESSION_SEVERITY_KEYS.ok, 'ok 档没有短标签 → 回落完整键');
  const [keep] = sessionHealthRows(response([row({ severity: 'ok', issues: [{ code: 'replay-duplicate-rows', severity: 'ok' }] })]));
  assert.equal(keep?.severityShortKey, SESSION_SEVERITY_KEYS.ok, '「可修但被判 ok」的分叉行也必须拿得到徽章文案');
  const [bad] = sessionHealthRows(response([row({ severity: 'unloadable', issues: [{ code: 'corrupt-frame', severity: 'unloadable' }] })]));
  assert.equal(bad?.severityShortKey, 'sessions.severityShort.unloadable');
  assert.equal(bad?.severityKey, 'sessions.severity.unloadable', '完整句仍在（进屏短、title 全）');
});

test('UI-2：问题 chip 截断 + 如实计数（被折叠的条数绝不静默丢掉）', () => {
  assert.deepEqual(sessionIssueChips([]), { codes: [], hidden: 0 });
  assert.deepEqual(sessionIssueChips(['a', 'b']), { codes: ['a', 'b'], hidden: 0 }, '不超上限时全都进屏');
  const many = sessionIssueChips(['a', 'b', 'c', 'd']);
  assert.deepEqual(many.codes, ['a', 'b'], '缺省最多 2 条（564px 画布下更多就折行）');
  assert.equal(many.hidden, 2, '折叠条数必须如实回传（界面渲染「还有 N 条」）');
  // 上限是显式参数，便于按行宽调整；非法值回落到缺省（不静默变成「全不显示」）
  assert.deepEqual(sessionIssueChips(['a', 'b', 'c'], 3).codes, ['a', 'b', 'c']);
  assert.deepEqual(sessionIssueChips(['a', 'b', 'c'], 0), { codes: [], hidden: 3 });
  assert.equal(sessionIssueChips(['a', 'b', 'c'], -1).codes.length, 2, '非法上限回落缺省，不得渲染成空行');
  assert.equal(sessionIssueChips(['a', 'b', 'c'], 1.5).codes.length, 2, '非整数上限同样回落缺省');
});

test('UI-3：本次重构新增的全部字典键在 recovery zh / en 中逐字存在（含短标签与指标标签）', () => {
  const keys: string[] = [
    ...Object.values(SESSION_SEVERITY_SHORT_KEYS),
    'sessions.metric.total',
    'sessions.metric.attention',
    'sessions.metric.format',
    'sessions.section.attention',
    'sessions.section.attentionNone',
    'sessions.issues.more',
    'sessions.rescan',
    'sessions.hidden.healthyShort',
    'sessions.repair.availableShort',
    'sessions.repair.noneShort',
  ];
  for (const key of keys) {
    const zhValue: string = recoveryZh[key as keyof typeof recoveryZh];
    const enValue: string = recoveryEn[key as keyof typeof recoveryEn];
    assert.equal(typeof zhValue, 'string', 'zh 缺键：' + key);
    assert.equal(typeof enValue, 'string', 'en 缺键：' + key);
    assert.ok(zhValue !== '' && enValue !== '', '文案不得为空：' + key);
    assert.notEqual(zhValue, enValue, 'en 必须是镜像而不是复制：' + key);
  }
});

test('A2-F1：批量条目构建 —— 成功/失败两条分支同源搬运 verify/rolledBack（危险态在批量视图可见）', () => {
  const unavailable: SessionVerifyView = { verified: false, reason: 'unavailable', detail: 'profiles-tree:generation-mismatch', equivalentToReadPath: false };

  // 成功但「未验证」（如 unavailable）→ 不得呈现成「已验证」
  const okEntry = sessionRepairBatchEntry({ unitId: '--p--/a', sessionId: 'a', ok: true, droppedRows: 3, verify: unavailable });
  assert.equal(sessionRepairVerifyKey(okEntry.verify, okEntry.rolledBack), 'sessions.repair.verify.unverified');
  assert.equal(okEntry.rolledBack, undefined, '成功分支没有回滚事实就不填假值');

  // verify-failed 且自动回滚**没成功** → 危险态必须搬到批量条目（A2-F1 回归点）
  const danger = sessionRepairBatchEntry({
    unitId: '--p--/b', sessionId: 'b', ok: false, reason: 'verify-failed', verify: unavailable, rolledBack: false,
  });
  assert.equal(danger.ok, false);
  assert.equal(danger.rolledBack, false, 'rolledBack===false 必须搬到批量条目（否则危险态在批量视图不可见）');
  assert.equal(sessionRepairVerifyKey(danger.verify, danger.rolledBack), 'sessions.repair.verify.rollbackFailed');
  assert.notEqual(sessionRepairVerifyKey(danger.verify, danger.rolledBack), null, '失败文案引用的「复验结论」必须由同一行给出');
  assert.equal(sessionRepairReasonKey(danger.reason), 'sessions.repair.reason.verifyFailed');

  // 已自动回滚（rolledBack:true）→ 未验证；不得误报成危险态
  const rolled = sessionRepairBatchEntry({ unitId: '--p--/c', sessionId: 'c', ok: false, reason: 'verify-failed', verify: unavailable, rolledBack: true });
  assert.equal(sessionRepairVerifyKey(rolled.verify, rolled.rolledBack), 'sessions.repair.verify.unverified');

  // 与单条路径同一个纯函数：迁移链可还原 / 现役读盘可读
  const migrated = sessionRepairBatchEntry({ unitId: '--p--/d', sessionId: 'd', ok: true, droppedRows: 1, verify: { verified: true, events: 2, strong: false, equivalentToReadPath: false } });
  assert.equal(sessionRepairVerifyKey(migrated.verify, migrated.rolledBack), 'sessions.repair.verify.migrated');
  const current = sessionRepairBatchEntry({ unitId: '--p--/e', sessionId: 'e', ok: true, droppedRows: 1, verify: { verified: true, events: 2, strong: true, equivalentToReadPath: true } });
  assert.equal(sessionRepairVerifyKey(current.verify, current.rolledBack), 'sessions.repair.verify.current');

  // 预览被拒 / 有损跳过 / 传输层失败：没有复验结论就不臆造（那一行不渲染）
  const refused = sessionRepairBatchEntry({ unitId: '--p--/f', sessionId: 'f', ok: false, reason: 'changed' });
  assert.equal(sessionRepairVerifyKey(refused.verify, refused.rolledBack), null);
  assert.equal('verify' in refused, false, '缺字段不填假值');
  assert.equal('rolledBack' in refused, false, '缺字段不填假值');
  assert.equal('lossy' in refused, false, '缺字段不填假值');
  const lossy = sessionRepairBatchEntry({ unitId: '--p--/g', sessionId: 'g', ok: false, reason: 'lossy-required', lossy: true });
  assert.equal(lossy.lossy, true);
  assert.equal(sessionRepairVerifyKey(lossy.verify, lossy.rolledBack), null);
  const boom = sessionRepairBatchEntry({ unitId: '--p--/h', sessionId: 'h', ok: false, transportError: 'boom' });
  assert.equal(boom.transportError, 'boom');
  assert.equal(sessionRepairReasonKey(boom.reason), 'sessions.repair.reason.unknown', '传输层失败不渲染裸枚举（组件走 transportError 文案分支）');
});

/**
 * 对话标题（2026-10-12 用户反馈）：行首渲染的必须是标题；宿主没给标题时为 null（渲染层回落目录名）。
 */
test('行 → 展示行：标题已脱敏；缺 / 空白标题一律 null（不得拿目录名冒充）', () => {
  const [titled] = sessionHealthRows(response([row({ severity: 'invisible', issues: [{ code: 'format-newer', severity: 'invisible' }], title: '推送更新到 GitHub 并发布新版本' })]));
  assert.equal(titled?.title, '推送更新到 GitHub 并发布新版本');

  const [untitled] = sessionHealthRows(response([row({ severity: 'invisible', issues: [{ code: 'format-newer', severity: 'invisible' }] })]));
  assert.equal(untitled?.title, null, '宿主没给标题 → null（组件回落显示 sessionId）');

  const [blank] = sessionHealthRows(response([row({ severity: 'invisible', issues: [{ code: 'format-newer', severity: 'invisible' }], title: '   ' })]));
  assert.equal(blank?.title, null, '纯空白标题不算标题');

  // 标题 = 用户自由文本（可能把密钥粘进第一句话）→ 渲染前必须脱敏
  const secret = 'sk-A1b2C3d4E5f6G7h8I9j0K1l2';
  const [redactedRow] = sessionHealthRows(response([row({ severity: 'invisible', issues: [{ code: 'format-newer', severity: 'invisible' }], title: '排查 ' + secret + ' 报错' })]));
  const safeTitle = redactedRow?.title ?? null;
  assert.ok(safeTitle !== null && !safeTitle.includes(secret), '标题里的密钥形状必须在渲染前被脱敏');
});
test('体检展示模型：blank 事实必须进展示行（界面据此显示「新会话」而不是 uuid）', () => {
  const [blankRow] = sessionHealthRows(response([row({ severity: 'invisible', issues: [{ code: 'format-newer', severity: 'invisible' }], blank: true })]));
  assert.equal(blankRow?.blank, true);
  assert.equal(blankRow?.title, null, '空白会话没有标题');
  const [normalRow] = sessionHealthRows(response([row({ severity: 'invisible', issues: [{ code: 'format-newer', severity: 'invisible' }] })]));
  assert.equal(normalRow?.blank, false, '缺字段一律不填假值');
});

