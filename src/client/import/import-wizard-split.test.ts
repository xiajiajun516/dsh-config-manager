/**
 * ImportWizardView 拆分护栏（t45）。
 *
 * 为什么是源码级：本仓库 React 无组件测试框架（AGENTS.md：逻辑提炼到 src/ui/ 保证可测），
 * 「纯逻辑只在 src/ui + 步骤视图与控制器各成文件 + 主文件只装配」只能按**源码结构**钉住。
 * 断言只锚真实代码结构（import / 函数定义 / JSX 用法 / 派生片段 / 行数棘轮），不锚注释文本；
 * 每条独立 —— 单独回退某一处会单独变红。
 *
 * 与 src/ui/import-wizard.test.ts 的分工：那边测**行为**，这边测**分层与拆分边界**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 统一换行后读取（避免 CRLF 让跨行断言静默失真）。 */
const read = (rel: string): string =>
  fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').split('\r\n').join('\n')

const view = read('./ImportWizardView.tsx')
/** t50：日志面板（含两条脱敏登记点）拆到独立模块，主文件只 import + 渲染 */
const logPanel = read('./ImportLogPanel.tsx')
const steps = read('./import-wizard-steps.tsx')
const controller = read('./use-import-wizard-controller.ts')
const logic = read('../../ui/import-wizard.ts')
/** client 侧三文件合并文本（判断「某规则是否在 client 侧重新实现」）。 */
const clientSide = [view, steps, controller].join('\n')

test('t45: 纯逻辑在 src/ui/import-wizard.ts，client 侧不得重新实现', () => {
  const moved = [
    'importFlowFlags', 'nextImportPhase', 'pendingSecretRequests', 'importApplicablePhases',
    'compatibilityLevel', 'compatibilityBadgeKind', 'importPreviewStageAfter', 'isSkippablePluginInstall',
  ]
  for (const name of moved) {
    assert.match(logic, new RegExp('export function ' + name + '\\('), name + ' 必须在 src/ui/import-wizard.ts 导出')
    assert.doesNotMatch(clientSide, new RegExp('function ' + name + '\\('), name + ' 不得在 client 侧重定义')
  }
  assert.match(logic, /export interface ImportFlowInputs\b/, '阶段判定输入类型必须在 ui 模块')
  assert.match(logic, /export type CompatibilityLevel\b/, '兼容性等级类型必须在 ui 模块')

  // 已迁出的派生不得在组件/hook 里内联回来（各条独立）
  assert.doesNotMatch(controller, /\.kind === 'Conflict'/, '冲突标志派生必须只在 ui 模块')
  assert.doesNotMatch(view, /compatibility === 'unsupported'/, '兼容性等级映射必须只在 ui 模块')
  assert.doesNotMatch(view, /push\('decrypt-archive'\)/, '适用阶段列表必须只在 ui 模块')
})

test('t45: 物理拆分 —— 步骤视图与控制器各成文件，主文件只装配（无循环 import）', () => {
  assert.match(view, /from '\.\/import-wizard-steps\.tsx'/, '主文件必须从步骤文件导入')
  assert.match(view, /from '\.\/use-import-wizard-controller\.ts'/, '主文件必须从控制器 hook 导入')
  assert.doesNotMatch(steps, /from '\.\/ImportWizardView\.tsx'/, '步骤文件不得反向 import 主文件（避免环）')
  assert.doesNotMatch(controller, /from '\.\/ImportWizardView\.tsx'/, '控制器 hook 不得反向 import 主文件（避免环）')
  assert.match(controller, /export function useImportWizardController\b/, '控制器必须以 hook 形式导出')

  for (const name of [
    'SecretsForm', 'SelectStep', 'AnalyzingStep', 'ConsultStage', 'DecryptArchiveStep',
    'ConflictsStage', 'PathMappingStage', 'SecretsStage', 'ConfirmStage',
  ]) {
    assert.match(steps, new RegExp('export function ' + name + '\\('), name + ' 必须在步骤文件导出')
  }
  // 步骤组件必须被主组件真正渲染（不是只 import 不用）
  for (const name of [
    'SelectStep', 'AnalyzingStep', 'ConsultStage', 'DecryptArchiveStep', 'ConflictsStage',
    'PathMappingStage', 'SecretsStage', 'ConfirmStage',
  ]) {
    assert.match(view, new RegExp('<' + name + '\\b'), name + ' 必须被主组件渲染')
  }
  // 主文件自持的渲染段（受 out-of-scope 源码守卫约束，见下一条测试）
  for (const name of ['ContentSelectStage', 'CompatibilityStep', 'ImportingStep', 'ResultStep', 'NextStepsCard']) {
    assert.match(view, new RegExp('function ' + name + '\\b'), name + ' 必须定义在主文件（受登记点/调用点守卫约束）')
  }
  // t50：日志面板自成模块（import-log-view 拆分）—— 两条脱敏登记点在那边，主文件只装配
  assert.match(logPanel, /export const ImportLogPanel = memo\(ImportLogPanelBase/, '日志面板必须以 memo 形式导出（其脱敏登记点被 plan-text-redaction 钉死）')
  for (const name of ['ContentSelectStage', 'CompatibilityStep', 'ImportingStep', 'ResultStep', 'NextStepsCard', 'ImportLogPanel']) {
    assert.match(view, new RegExp('<' + name + '\\b'), name + ' 必须被主组件渲染')
  }
  assert.match(steps, /<SecretsForm\b/, 'SecretsForm 必须被 SecretsStage 渲染')
})

test('t45/t50: 脱敏登记渲染点必须留在主文件（或日志面板模块），且不得裸渲染', () => {
  assert.match(
    view,
    /import \{ redact \} from '\.\.\/\.\.\/security\/redaction\.ts'/,
    'tests/client/import-wizard-redaction.test.ts 要求主文件 import redact',
  )
  assert.match(view, /\{item\.adapter\}: \{redact\(item\.description\)\}<\/li>/, '收尾清单登记点必须留在主文件')
  assert.match(view, /\{analysis\.warnings\.map\(\(w, i\) => <div key=\{i\}>\{redact\(w\)\}<\/div>\)\}/, '分析告警登记点必须留在主文件')
  // 2026-09：日志改为「合并后的项状态行 + 明细行」，两处脱敏渲染点在日志面板模块内
  // （同点登记见 src/client/common/plan-text-redaction.test.ts 的 import-log-* 两条）
  assert.match(logPanel, /className=\{css\.logLine\} data-level=\{entry\.level\}>\{redact\(logEntryTitle\(entry\)\)\}<\/div>/, '执行日志项状态行必须在日志面板模块过 redact')
  assert.match(logPanel, /className=\{css\.logDetail\} data-kind=\{detail\.kind\}>\{redact\(detail\.text\)\}<\/div>/, '执行日志明细行必须在日志面板模块过 redact')
  // section-labels.test.ts 的 UI-08 源码守卫按文件枚举 <ContentPicker> 调用点：
  // 该调用点搬走后 ImportWizardView.tsx 不再含 ContentPicker → out-of-scope 守卫会红。
  assert.match(view, /<ContentPicker\b/, 'ContentPicker 调用点必须留在主文件（section-labels 源码守卫前提）')
})

test('t45: 主文件行数棘轮（拆分后 ≈750 行 / 拆分前 1075 行）+ 无硬编码颜色', () => {
  const lines = view.split('\n').length
  assert.ok(lines <= 790, '主文件行数必须保持在拆分后的量级（实际 ' + lines + ' 行；拆分前 1075 行）')
  assert.doesNotMatch(view, /#[0-9a-fA-F]{3,8}\b/, '不得硬编码颜色（DESIGN.md：走 --dsw-* token）')
  assert.doesNotMatch(view, /rgba?\(/, '不得硬编码 rgb/rgba 颜色')
})
