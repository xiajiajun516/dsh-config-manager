/**
 * T13 守卫：会话体检弹窗必须**条件挂载**。
 *
 * 背景（真机反馈）：弹窗常驻时，卡片每次重渲染都会带着它一起走；它内部持有整屏内容
 * （真机 1024 条会话的预览数据），一旦渲染成本失控，整个设置页会变成空白。
 * 关闭即卸载是这条缺陷的最小结构性防线 —— 用源码级断言钉住，避免被后续重构改回常驻。
 * 为什么源码级：本仓库 React 无组件测试框架（AGENTS.md：逻辑提炼到 src/ui/ 保证可测）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PANEL = path.join(ROOT, 'src/client/recovery/RecoveryPanel.tsx');

test('T13：会话体检弹窗只在 open 时挂载（关闭即卸载）', () => {
  const source = fs.readFileSync(PANEL, 'utf8');
  const at = source.indexOf('<SessionHealthDialog');
  assert.ok(at > 0, '找不到 SessionHealthDialog 的挂载点');
  // 挂载点上方 400 字符内必须出现条件渲染（{open && …）
  const before = source.slice(Math.max(0, at - 400), at);
  assert.match(before, /\{open && \(/, '弹窗必须条件挂载（真机：常驻会让设置页变空白）');
  assert.equal(/<SessionHealthDialog[^>]*\/>/.test(source), false, '不得再出现无条件自闭合挂载');
});

test('T13：长列表必须限高内滚（DESIGN §8 硬性规则）', () => {
  const source = fs.readFileSync(PANEL, 'utf8');
  assert.match(source, /snapshotList\} \$\{css\.reportScroll\}/, '会诊列表必须带限高内滚类');
});

test('T14：SessionHealthDialog 的 state 声明必须在被使用之前（TDZ 会把整个面板打白）', () => {
  const source = fs.readFileSync(PANEL, 'utf8');
  const start = source.indexOf('function SessionHealthDialog(');
  const end = source.indexOf('function RecoveryPanel(', start);
  assert.ok(start > 0 && end > start, '找不到 SessionHealthDialog 源码窗口');
  const body = source.slice(start, end);
  // 声明位置必须早于首个使用位置（真机：后置声明 → ReferenceError → slot entry crashed → 面板空白）
  const declAt = body.indexOf("const [repairedUnits, setRepairedUnits] = useState");
  const useAt = body.indexOf('!repairedUnits.has(');
  assert.ok(declAt > 0, '找不到 repairedUnits 的声明');
  assert.ok(useAt > declAt, 'repairedUnits 必须在使用之前声明（否则 TDZ 直接把插件面板打崩）');
  assert.equal(body.split('const [repairedUnits, setRepairedUnits] = useState').length - 1, 1, '不得重复声明');
});

test('T15：会话体检的卡片与容器必须留白（真机反馈「挤在一起」）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/client/config-manager.module.css'), 'utf8');
  // 卡片自身内边距：不再是 9px 12px
  const row = /\.snapshotRow \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(row, /padding: 12px 14px/, '卡片内边距必须加大');
  // 限高容器里的列表必须自带上下左右留白
  const scrolled = /\.snapshotList\.reportScroll \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(scrolled, /padding: 10px 12px 10px 10px/, '内滚列表必须留白');
  // 行间距
  const list = /\.snapshotList \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(list, /gap: 10px/, '行间距必须加大');
  // 2026-10-12 UI 重构：新的行卡与摘要卡同样不许贴边（旧类只覆盖了 .snapshotRow）
  const shRow = /\.shRow \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(shRow, /padding: 8px 10px/, '会话行卡（.shRow）必须自带内边距');
  const shSummary = /\.shSummary \{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(shSummary, /padding: 12px 14px/, '摘要卡（.shSummary）必须自带内边距');
});

/**
 * T16：会话体检弹窗的**结构**（2026-10-12 用户反馈「会话体检的 UI 太丑」后新增）。
 *
 * 旧形态的三处根因：① 摘要是四颗同款徽章，看不出哪个数重点；② 每行是「徽章 + 会话 id + 问题 +
 * 版本/体积 + 两颗文字按钮」同排的横向 flex，564px 画布下换行位置随机；③ 机制说明（布局归位 3 段、
 * 离线修复 1 段）常驻成 4~6 行散文。类型检查 / 纯函数单测 / bundle 护栏都抓不到「渲染结构」，
 * 故与 T13 同规格用源码守卫钉住（改回字墙即红灯）。
 */
test('T16：会话体检弹窗 = 数字摘要 + 区块头 + 两行式行卡（禁止退回字墙）', () => {
  const src = fs.readFileSync(PANEL, 'utf8');
  for (const cls of [
    'shSummary', 'shMetric', 'shSeverity', 'shSectionHead',
    'shRow', 'shRowTop', 'shRowMeta', 'shRowActions', 'shPanel', 'shCommands',
  ]) {
    assert.ok(src.includes('css.' + cls), '弹窗必须用 .' + cls + '（摘要 / 区块头 / 两行式行卡 / 面板容器）');
  }
  // ① 主操作进标题行（旧实现是正文左上角孤零零一颗按钮，要先滚过摘要才找得到）
  assert.ok(src.includes('<Modal.Header'), '弹窗标题行必须显式装配（主操作与 ⓘ 都挂在它上面）');
  assert.ok(src.includes('css.shHeaderTrailing'), '标题行 trailing 必须有自己的容器类');
  // ② 数据口径（未验证 / 被隐藏的正常会话 / 超上限 / 读不出条目）必须有专属容器，不散落成正文 .hint
  assert.ok(src.includes('css.shNotes'), '数据口径必须有专属容器（.shNotes）');
  // ③ ZIP 入口不再是文字按钮：图标按钮 + 已翻译的 aria-label，禁用原因走 title（不静默消失）
  assert.equal(
    /t\('sessions\.zip\.action'\)\}\s*<\/Button>/.test(src),
    false,
    '下载 ZIP 不得再是文字按钮（图标按钮 + aria-label + title）',
  );
  assert.ok(src.includes("label={t('sessions.zip.action')}"), 'ZIP 图标按钮必须带已翻译的无障碍名');
  // ④ 长句只进 title：完整严重级句不得再进屏当徽章文案（短标签走 severityShortKey）
  assert.ok(src.includes('row.severityShortKey'), '行徽章必须用短标签键（完整句进 title）');
  assert.ok(src.includes('title={t(row.severityKey)}'), '完整严重级句必须仍在 title 里（事实一个字不少）');
});

/**
 * T17：会话体检的行首必须显示**对话标题**（2026-10-12 用户反馈：列表只有 `session-20d2722c-…`，
 * 同屏十几条里认不出哪条是自己的对话）。宿主没给标题时回落目录名，绝不编造。
 */
test('T17：会话行首 = 对话标题（缺省回落目录名），目录名退到 meta 行仍可见', () => {
  const src = fs.readFileSync(PANEL, 'utf8');
  assert.ok(
    src.includes("row.title ?? (row.blank ? t('sessions.blank') : row.sessionId)"),
    '行首主文本必须是标题（缺省：空白会话显示「新会话」，其余回落 sessionId）',
  );
  assert.ok(src.includes('title={row.title ?? row.unitId}'), '全文进 title（标题已是脱敏后的文本）');
  assert.ok(src.includes('title={row.unitId}>{row.sessionId}'), '目录名仍需常驻（修复 / 下载要核对的主键）');
  // 空白会话（从未提问）：DSH 自己显示「新会话」—— 不得拿 uuid 当标题
  assert.ok(src.includes("row.blank ? t('sessions.blank')"), '空白会话必须显示本地化的「新会话」占位名');
});
