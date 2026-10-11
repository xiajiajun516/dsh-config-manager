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

/* ---------------------------------------------- T2：聊天内回退入口形态开关（回滚卡内） */

const ROLLBACK_CARD_PATH = 'src/client/recovery/RollbackCard.tsx';

/**
 * T2 源码级守卫：「工作区 + 会话回滚」卡上的**聊天内回退入口形态**开关。
 *
 * 为什么要有这条：开关是 captain 承诺给用户的「一键退回回合尾」保险，坏在三种地方**类型检查
 * 与纯函数单测都看不见**：
 *  ① 位置 —— 若挂在台账加载分支里，回滚点列表读不出来时这个保险正好不可用；
 *  ② 外观 —— 自造开关/内联样式 = 第二套视觉体系（DESIGN.md 硬约束）；
 *  ③ 通道 —— 直接写 localStorage 会**绕过 T1 的热切换**（切换变成「下次加载生效」，与界面
 *     文案「立即生效」矛盾），也造出第二套持久化通道。
 * 本用例把这三条都钉成红灯（对照 T1 的偏好模块 chat-entry-pref.ts）。
 */
test('T2：回滚卡的聊天入口开关位置/原语/通道（panel 小节三件套 + 只走偏好模块）', () => {
  const src = readFileSync(ROLLBACK_CARD_PATH, 'utf8');

  // ① 必须在回滚卡**内**，且排在台账状态分支**之前**（列表读不出来时它仍要可用）
  const cardAt = src.indexOf('<Card>');
  const labelAt = src.indexOf("t('rollback.chatEntry.label')");
  const cardEndAt = src.indexOf('</Card>');
  const readyAt = src.indexOf("status === 'ready'");
  assert.ok(cardAt >= 0 && cardEndAt > cardAt, '找不到回滚卡的 <Card> 容器');
  assert.ok(labelAt > cardAt && labelAt < cardEndAt, '开关必须渲染在回滚卡内（小节外层 = .card）');
  assert.ok(readyAt > 0 && labelAt < readyAt, '开关必须排在台账状态分支之前 —— 否则列表读不出来时这颗保险正好不可用');

  // ② 复用既有原语（标题走 .groupLabel / 说明走 .hint / 切换走 common/ui.tsx 的 Segmented）
  assert.match(
    src,
    /<div className=\{css\.groupLabel\}>\{t\('rollback\.chatEntry\.label'\)\}<\/div>/,
    '开关标题必须走 .groupLabel（与面板其它小节同一把尺子）',
  );
  assert.match(
    src,
    /<div className=\{css\.hint\}>\{t\('rollback\.chatEntry\.hint'\)\}<\/div>/,
    '开关说明必须走 .hint',
  );
  assert.match(
    src,
    /<Segmented[\s\S]{0,400}onChange=\{applyChatEntryMode\}/,
    '切换必须复用 common/ui.tsx 的 Segmented（禁止自造开关组件/内联样式）',
  );
  assert.ok(
    src.includes("ariaLabel={t('rollback.chatEntry.label')}"),
    '分段控件必须带**已翻译**的无障碍名（不得硬编码字符串）',
  );
  assert.ok(
    src.includes('CHAT_ENTRY_MODES.map('),
    '两档选项必须由偏好模块的档位列表派生（手写死两档 ⇒ 加档就漏）',
  );

  // ③ 通道：只走 T1 的偏好模块（不得直碰 localStorage / 不得自造第二套通道）
  //    判据只看**代码**：注释里说明「绝不直接读写 localStorage」是文档，不是缺陷
  //    （整行 // 与 /* */ 一律剥掉；真实调用点不会只活在注释里）。
  const stripComments = (text: string): string => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.equal(stripComments(src).includes('localStorage'), false, '组件不得直接读写 localStorage：偏好唯一入口是 chat-entry-pref');
  // 反向对照：同一条判据对「注释提到 + 代码真的调用」必须命中（证明剥离不是把整份源码抹空）
  assert.equal(
    stripComments('/* 注释里提到 localStorage */\nconst raw = localStorage.getItem("dcm.k")\n').includes('localStorage'),
    true,
    '剥离注释的判据必须保留真实代码：真实调用点仍要被抓到',
  );
  assert.ok(src.includes("from '../chat/chat-entry-pref.ts'"), '偏好必须来自 T1 的 chat-entry-pref（唯一来源）');
  assert.ok(src.includes('readChatEntryMode('), '当前值必须从偏好读取（缺省 = 每条用户消息）');
  assert.ok(
    src.includes('useState<ChatEntryMode>(() => readChatEntryMode())'),
    '开关初值必须是偏好读出来的值（缺省 = 每条用户消息；不得另存一份状态/不得硬编码缺省）',
  );
  assert.ok(src.includes('active={chatEntryMode}'), '分段控件的选中值必须绑到该状态（界面与偏好不脱钩）');
  assert.ok(
    src.includes('writeChatEntryMode('),
    '写入必须走 writeChatEntryMode —— 只有它通知订阅者，T1 才会 dispose → register（否则要刷新才生效）',
  );
});

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
