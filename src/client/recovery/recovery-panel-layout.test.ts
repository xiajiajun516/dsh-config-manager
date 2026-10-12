/**
 * 源码级布局守卫（M2 收尾，2026-10-07 用户实测）：面板小节的**容器类**必须用对。
 *
 * 实测缺陷（用户截图「都挤在一块了」）：`SessionLayoutSection` 外层用了 `.snapshotRow`
 * （横向 flex 行）当卡片容器，标题又用了 `.snapshotRowMain`（`flex:1` + `nowrap`），
 * 于是标题/说明/按钮/计划被排成一行、文字被挤成竖排。
 *
 * 为什么需要这条：类型检查、模型单测、bundle 自包含护栏**都抓不到**这类缺陷 —— 它只在真实渲染里可见。
 * 这条守卫把「容器类选错」变回红灯（口径：小节外层 = `.card`；小节标题 = `.groupLabel`；
 * 行列表 = `.snapshotList` + `.reportScroll`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE_PATH = 'src/client/recovery/RecoveryPanel.tsx';

/** 截出某个顶层函数的函数体（到下一个顶层 `function ` 为止）。 */
function functionBody(name: string): string {
  const src = readFileSync(SOURCE_PATH, 'utf8');
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at >= 0, SOURCE_PATH + ' 里找不到函数 ' + name);
  const end = src.indexOf('\nfunction ', at + 1);
  return src.slice(at, end < 0 ? undefined : end);
}

test('布局守卫：小节用卡片容器 + groupLabel 标题 + snapshotList/reportScroll 列表', () => {
  const body = functionBody('SessionLayoutSection');

  assert.match(
    body,
    /return \(\s*<div className=\{css\.card\}>/,
    '小节外层必须是 .card（纵向卡片）—— 用 .snapshotRow（横向行）会把标题/说明/按钮挤成一行',
  );
  assert.equal(
    /<div className=\{css\.snapshotRowMain\}>\{t\(/.test(body),
    false,
    '小节标题不得用 .snapshotRowMain（flex:1 + nowrap ⇒ 标题被拉成一行、文字竖排）',
  );
  // 2026-10-12 UI 重构：计划 / 结果从「卡内小节」变成**面板**（.shPanel + .shPanelTitle），
  // 入口标题与 keep 仍在卡内走 .groupLabel。口径不变：标题必须用**专属标题类**，
  // 绝不退回 .snapshotRowMain（flex:1 + nowrap ⇒ 标题被拉成一行、文字竖排）。
  assert.ok(
    (body.match(/css\.groupLabel/g) ?? []).length >= 2,
    '入口标题与 keep 选择必须走 .groupLabel（至少 2 处）',
  );
  assert.ok(
    (body.match(/css\.shPanelTitle/g) ?? []).length >= 2,
    '计划与结果的面板标题必须走 .shPanelTitle（至少 2 处）',
  );
  assert.ok(
    (body.match(/css\.snapshotList/g) ?? []).length >= 3,
    '行列表必须包在 .snapshotList 里（纵向 flex + 行间呼吸感）',
  );
  assert.ok(
    (body.match(/css\.reportScroll/g) ?? []).length >= 3,
    '长列表必须限高内滚（.snapshotList + .reportScroll）',
  );
});

const ROLLBACK_CARD_PATH = 'src/client/recovery/RollbackCard.tsx';

/* ---------------------------------------------- 回滚点时间线（2026-10-11 布局重构） */

/**
 * 源码级守卫：回滚点台账必须用**会话分组卡 + 两行式行卡**，不得退回通用 `.actionRow` 字墙。
 *
 * 为什么（用户 2026-10-11 反馈「工作区 + 对话回滚面板的 UI 太丑」）：旧实现每行都是
 * `.actionRow[data-inline]`（通用横向操作行）—— 时间 / 回合 / 来源徽章 / 文件数 / 会话游标 / note /
 * 两颗实体按钮**同权重**横排，564px 画布下换行位置随机，元信息与按钮混成一片 11px 灰字；
 * 长句（「回退前救援点（可回退、不可删）」「无会话游标（只能回退工作区）」）逐行重复整句。
 * 这类缺陷**类型检查、纯函数单测、bundle 护栏全都抓不到**（与本文件头上那条同源），只能靠源码守卫。
 *
 * 四条判据：
 *  ① 结构类必须在位：分组卡 / 分组头 / 组标题 / 行列表 / 行卡 / 主行 / meta 行；
 *  ② 行内不得再出现 `.actionRow[data-inline]`（旧字墙形态必须绝迹）；
 *  ③ 长句必须有**短标签键**进屏（完整句仍进 title，事实一个字都不少）；
 *  ④ 台账与预览两个长列表仍限高内滚。
 */
test('布局守卫：回滚点时间线 = 分组卡 + 两行式行卡（禁止退回 actionRow 字墙）', () => {
  const src = readFileSync(ROLLBACK_CARD_PATH, 'utf8');
  for (const cls of [
    'rollbackGroup', 'rollbackGroupHead', 'rollbackGroupTitle',
    'rollbackPoints', 'rollbackPoint', 'rollbackPointTop', 'rollbackPointMeta',
  ]) {
    assert.ok(src.includes('css.' + cls), '回滚卡必须用 .' + cls + '（会话分组卡 + 两行式行卡）');
  }
  assert.equal(
    /css\.actionRow[^\n]*data-inline/.test(src),
    false,
    '行渲染不得退回 .actionRow[data-inline]（旧字墙形态：元信息与按钮同权重横排）',
  );
  for (const key of ['rollback.kind.guardShort', 'rollback.row.sessionShort', 'rollback.row.workspaceShort']) {
    assert.ok(src.includes(key), '短标签键必须进屏（完整句进 title）：' + key);
  }
  assert.ok(
    src.includes('css.planScroll') && src.includes('css.reportScroll'),
    '台账与预览列表必须限高内滚（.planScroll / .reportScroll）',
  );
});

/* ------------------- 2026-10-12：两块诊断卡退出折叠 + 台账整块进弹窗 */

/**
 * 用户 2026-10-12 的两条要求（类型检查 / 纯函数单测 / bundle 护栏都抓不到渲染结构，故仍是源码守卫）：
 *  ①「会话体检」与「工作区 + 会话回滚」**不再可展开/收回** —— 卡头不得再出现折叠开关或折叠容器，
 *     摘要与主操作（体检入口 / 台账入口）常驻可见；
 *  ② 回滚台账整块搬进**本页弹窗**（按会话分组），且与体检弹窗同一条挂载纪律：只在打开时挂载。
 * 谁把折叠加回来、或把台账塞回卡内正文，这里直接红灯。
 */
test('两块诊断卡退出折叠：卡头无 FoldToggle/Collapse，回滚台账在条件挂载的弹窗内', () => {
  const rollback = readFileSync(ROLLBACK_CARD_PATH, 'utf8');
  const sessions = functionBody('SessionHealthCard');

  for (const [name, src] of [['RollbackCard', rollback], ['SessionHealthCard', sessions]] as const) {
    assert.equal(src.includes('<FoldToggle'), false, name + ' 不得再渲染折叠开关（用户要求退出折叠）');
    assert.equal(src.includes('<Collapse'), false, name + ' 不得再用折叠容器（内容常驻可见）');
    assert.equal(src.includes('aria-expanded'), false, name + ' 卡内不得再有展开/收回语义');
  }

  // 卡上只留「打开台账」这一颗入口按钮；台账本体在 {open && …} 条件挂载的弹窗里
  assert.ok(rollback.includes("t('rollback.dialog.open')"), '卡上必须留一颗打开台账的按钮');
  assert.match(
    rollback,
    /\{open && \(\s*<Modal open[\s\S]{0,400}title=\{t\('rollback\.dialog\.title'\)\}/,
    '台账必须进弹窗，且只在打开时挂载（关闭即卸载）',
  );
  assert.ok(rollback.includes('<Modal.Body scroll>'), '台账列表必须在弹窗正文内（限高内滚，不撑长页面）');
  // 体检入口同样常驻卡上（不再是「收起后要展开才看得到」）
  assert.ok(sessions.includes("t('sessions.dialog.open')"), '体检入口必须常驻卡上');
});

/* ------------------- 2026-10-12：台账弹窗左右分栏 + 刷新不抖 + 预览弹窗留白 */

/**
 * 用户 2026-10-12 的三条要求（同样只有源码守卫能钉住渲染结构）：
 *  ① 台账弹窗 = **左栏选对话 / 右栏看该对话的回滚点**（左栏默认新 → 旧，顺序由 rollbackPointGroups 定死）；
 *  ② 「刷新」**不得**把已有内容换成 loading 空态（旧实现让弹窗高度骤变 ⇒ 用户反馈「整页抖动」）；
 *  ③ 预览弹窗正文必须包在 `Modal.Body` 里（否则文字与按钮贴边 —— 用户截图实证）。
 */
test('台账弹窗分栏 / 刷新不抖 / 预览留白（2026-10-12 用户要求）', () => {
  const src = readFileSync(ROLLBACK_CARD_PATH, 'utf8');
  for (const cls of ['rollbackLedger', 'rollbackSessions', 'rollbackSessionItem', 'rollbackSessionId', 'rollbackSessionMeta', 'rollbackLedgerMain']) {
    assert.ok(src.includes('css.' + cls), '分栏必须用 .' + cls + '（左栏会话列表 + 右栏回滚点）');
  }
  assert.ok(src.includes("aria-label={t('rollback.sessions.title')}"), '左栏必须带**已翻译**的无障碍名');
  assert.ok(src.includes('activeGroup.rows.map('), '右栏渲染的必须是**当前选中对话**的回滚点（不是全部会话平铺）');
  assert.match(src, /const activeGroup = groups\.find\(/, '选中的键失效时必须回落到第一条（绝不显示空右栏）');
  // ② 刷新：保留内容，只把按钮置为在途
  assert.ok(src.includes('load({ keep: true })'), '刷新按钮必须走 keep 语义（保留旧内容）');
  assert.match(src, /const keep = options\?\.keep === true && list !== null/, 'keep 只在已有内容时成立（首屏仍走 loading）');
  assert.ok(src.includes('loading={refreshing}'), '刷新在途只体现在按钮上，不动正文');
  // ③ 预览弹窗正文留白（两个弹窗的正文都必须包在 Modal.Body 里）
  assert.ok((src.match(/<Modal.Body scroll>/g) ?? []).length >= 2, '台账与预览两个弹窗的正文都必须包在 Modal.Body 里');
  // ④ 弹窗高度**锁死**（2026-10-12 用户第二条反馈：切换对话 / 选到点数很少的会话时不得变高变矮）
  const cssSheet = readFileSync('src/client/config-manager.module.css', 'utf8');
  const ledgerRule = /\.rollbackLedger \{[^}]*\}/.exec(cssSheet)?.[0] ?? '';
  assert.match(ledgerRule, /height: 340px/, '分栏容器必须锁死高度（否则弹窗重排 = 整页抖动）');
  const sessionsRule = /\.rollbackSessions \{[^}]*\}/.exec(cssSheet)?.[0] ?? '';
  assert.match(sessionsRule, /height: 100%/, '左栏必须填满分栏高度（不得再用 max-height 随内容变化）');
  assert.ok(src.includes('css.rollbackPointsScroll'), '右栏列表必须用 .rollbackPointsScroll 吃掉剩余高度并内滚');
  // ⑤ 会话显示**标题**（拿不到标题才回落 id —— 绝不编造）
  assert.ok(src.includes('group.title ?? group.sessionId'), '左栏必须优先显示对话标题，拿不到才回落会话 id');
  assert.ok(src.includes('activeGroup.title ?? activeGroup.sessionId'), '右栏组头同样优先显示标题');
});

/* ------------------- 2026-10-12：会话体检卡删掉「预扫描说明」文案 */

/**
 * 用户 2026-10-12 要求删掉卡上那行描述（「打开后扫描本机存量会话：哪些读不出来……（扫描只读）。」）——
 * 卡上只留真正的信息：扫描摘要与主操作。类型检查/模型单测都抓不到「文案又被加回来」，
 * 故仍用源码守卫钉住：卡内不得再渲染该键，字典（zh/en）里也不得再有它。
 */
test('会话体检卡不再渲染预扫描说明文案（用户 2026-10-12 要求）', () => {
  const sessions = functionBody('SessionHealthCard');
  assert.equal(sessions.includes('sessions.dialog.hint'), false, '预扫描说明文案不得再回到卡上');
  // 摘要行必须保留，且只在真有扫描结果时渲染（首屏不得留空行）
  assert.ok(sessions.includes("t('sessions.dialog.lastScan'"), '扫描摘要必须保留');
  assert.match(sessions, /summary !== null && response !== null &&/, '摘要只在有结果时渲染');
  const locales = readFileSync('src/client/recovery/recovery-locales.ts', 'utf8');
  assert.equal(locales.includes("'sessions.dialog.hint'"), false, '字典里不得留下已删文案（zh 与 en 都要删）');
});
