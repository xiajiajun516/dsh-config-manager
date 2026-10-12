/**
 * 安全守卫（**按渲染点**）：宿主下发的文本在渲染前必须过 `redact()`。
 *
 * 背景（t6 的 high）：ConflictList 曾把 host 下发的 `detail.current` / `detail.imported` 直接渲染。
 * 这些值可能含**未脱敏的本地明文凭据**（实测：MCP 的 env / headers 原样回传，如 env.MCP_TOKEN、
 * headers.Authorization；detail 由 settings/providers/mcp/workspaces 适配器拼接，index.ts 把
 * analyzeImport 结果直接回传浏览器，**全仓没有 plan 级脱敏**）—— UI 是最后一道闸门。
 * 依据：AGENTS.md §UI 硬性规则 7 / DESIGN.md §7「错误/报告/历史摘要渲染前 redact()」。
 * 规则统一：**展示文本一律先过 redact()，不留例外**（哪怕当前数据源看起来无值泄漏）。
 *
 * 为什么是源码级：本仓库 React 无组件测试框架（AGENTS.md：逻辑提炼到 `src/ui/` 保证可测），
 * 组件渲染只能靠源码断言锁死（沿用 tests/client/import-wizard-redaction.test.ts 模式）。
 *
 * **G-09 升级**：原实现是「文件级 contains 断言」——同一文件里去掉**某一处** redact 仍会绿灯
 * （典型：SyncConfirmView 只断言了 description，`redact(item.detail)` / `redact(conflict.diff)`
 * 两处裸渲染照样通过；即「注释承诺 > 实际防线」）。现在每个渲染点**单独一条断言**：
 * 去掉任意一处 `redact()`（改成裸渲染）→ 该点红灯。已逐点做变异验证（24/24 全部按预期红灯，
 * 恢复后全绿），记录见队长报告。
 *
 * 维护约定：**新增「宿主文本 → JSX」的渲染点必须在此登记**（本表是这类渲染点的单一登记表）。
 * 表里的 `redacted` / `bare` 必须成对：前者是当前实现里的已脱敏写法，后者是它被改裸后的写法。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（本文件位于 src/client/common/） */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

interface RenderPoint {
  /** 渲染点唯一 id（变异实验与失败信息里用） */
  id: string
  /** 相对仓库根的源码路径 */
  file: string
  /** 必须出现的**已脱敏**渲染形态 */
  redacted: RegExp
  /** 不得出现的**裸渲染**形态（去掉 redact 后的写法） */
  bare: RegExp
  /** 为什么这段文本可能含敏感值 */
  why: string
}

const R = (s: string): RegExp => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

const RENDER_POINTS: RenderPoint[] = [
  /* ---------------- 导入：冲突决策（t6 的 high） ---------------- */
  {
    id: 'conflict-description',
    file: 'src/client/import/ConflictList.tsx',
    redacted: R('const safeDescription = redact(item.description)'),
    bare: R('const safeDescription = item.description'),
    why: '冲突项描述（宿主按计划项拼装的配置路径/键名）',
  },
  {
    id: 'conflict-detail',
    file: 'src/client/import/ConflictList.tsx',
    // 先整体脱敏再切分：切分只依赖 current= / imported= 字面标记，两者互不干扰
    redacted: R('splitConflictDetail(redact(item.detail))'),
    bare: R('splitConflictDetail(item.detail)'),
    why: '冲突明细（MCP env/headers 等本地明文配置值）',
  },
  {
    id: 'conflict-description-title',
    file: 'src/client/import/ConflictList.tsx',
    redacted: R('title={safeDescription}>{safeDescription}</span>'),
    bare: R('title={item.description}>{item.description}</span>'),
    why: '描述同时进 title 与可见文本（两条路径都要脱敏）',
  },
  /* ---------------- 导入：向导其它渲染点 ---------------- */
  {
    id: 'import-next-steps-description',
    file: 'src/client/import/ImportWizardView.tsx',
    redacted: R('{item.adapter}: {redact(item.description)}</li>'),
    bare: R('{item.adapter}: {item.description}</li>'),
    why: '收尾清单的重启项描述（宿主按计划项拼装）',
  },
  {
    id: 'import-analysis-warnings',
    file: 'src/client/import/ImportWizardView.tsx',
    redacted: R('{analysis.warnings.map((w, i) => <div key={i}>{redact(w)}</div>)}'),
    bare: R('{analysis.warnings.map((w, i) => <div key={i}>{w}</div>)}'),
    why: '分析告警（含 ZIP 条目名等攻击者可控字符串）',
  },
  {
    id: 'import-log-item-line',
    file: 'src/client/import/ImportLogPanel.tsx',
    redacted: R('className={css.logLine} data-level={entry.level}>{redact(logEntryTitle(entry))}</div>'),
    bare: R('className={css.logLine} data-level={entry.level}>{logEntryTitle(entry)}</div>'),
    why: '导入日志的项状态行（itemId 来自宿主 /progress；脱敏后渲染）',
  },
  {
    id: 'import-log-detail-line',
    file: 'src/client/import/ImportLogPanel.tsx',
    redacted: R('className={css.logDetail} data-kind={detail.kind}>{redact(detail.text)}</div>'),
    bare: R('className={css.logDetail} data-kind={detail.kind}>{detail.text}</div>'),
    why: '导入日志的明细行（子进程命令行 / 引擎说明文本）',
  },
  /* ---------------- 导入结果报告（2026-09 结构化结果页） ---------------- */
  {
    id: 'import-report-problem-item',
    file: 'src/client/common/ReportView.tsx',
    redacted: R('<span className={css.reportProblemText}>{redact(p.itemId)}</span>'),
    bare: R('<span className={css.reportProblemText}>{p.itemId}</span>'),
    why: '结果页「需要你关注」的失败/警告项 id（宿主 executed 回传）',
  },
  {
    id: 'import-report-problem-reason',
    file: 'src/client/common/ReportView.tsx',
    redacted: R('{redact(p.message ?? t(\'report.unknownReason\'))}'),
    bare: R('{p.message ?? t(\'report.unknownReason\')}'),
    why: '结果页失败/警告项的原因文本（适配器拼装，可能内联本地路径/配置片段）',
  },
  /* ---------------- 档案（DSH profile）原文 ---------------- */
  {
    id: 'profile-manifest-text',
    file: 'src/client/environment/EnvironmentPanel.tsx',
    redacted: R("{redact(detail.manifest ?? '')}"),
    bare: R("{detail.manifest ?? ''}"),
    why: 'package.json 原文（依赖 spec 可能内联私有源地址/令牌）',
  },
  {
    id: 'profile-patch-text',
    file: 'src/client/environment/EnvironmentPanel.tsx',
    redacted: R("{detail.patch !== null ? redact(detail.patch) :"),
    bare: R("{detail.patch !== null ? detail.patch :"),
    why: 'cordis.patch.yml 原文（!!js 表达式旁可能内联字面量密钥）',
  },
  /* ---------------- 恢复计划 / 差异查看 ---------------- */
  /* git 风格恢复预览（RestorePlanView）：描述/路径/明细/文件正文/错误文本逐个登记 */
  {
    id: 'restore-plan-description',
    file: 'src/client/library/RestorePlanView.tsx',
    redacted: R('const safeDescription = redact(row.description)'),
    bare: R('const safeDescription = row.description'),
    why: '恢复计划行描述（宿主拼装，可能含本地明文配置值）',
  },
  {
    id: 'restore-plan-target',
    file: 'src/client/library/RestorePlanView.tsx',
    redacted: R('const safeTarget = row.target === undefined ? null : redact(row.target)'),
    bare: R('const safeTarget = row.target === undefined ? null : row.target'),
    why: '恢复计划行目标路径（宿主拼装的 home 相对路径，同时进可见文本与 title）',
  },
  {
    id: 'restore-plan-detail',
    file: 'src/client/library/RestorePlanView.tsx',
    // client-F6：括号本身进字典（common.parens），宿主文本仍然先过 redact
    redacted: R("{t('common.parens', { text: redact(row.detail) })}"),
    bare: R("{t('common.parens', { text: row.detail })}"),
    why: '恢复计划行明细（宿主拼装）',
  },
  {
    // 2026-10-12：双栏差异表抽成共享原语（common/DiffTable.tsx，快照恢复计划与回滚点「查看」共用），
    // 脱敏从「调用方自己记得包」升级为**缺省即脱敏**（sanitize 缺省 = redact），登记点随之搬家。
    id: 'diff-table-cell',
    file: 'src/client/common/DiffTable.tsx',
    redacted: R('const cell = sanitize ?? ((text: string): string => redact(text))'),
    bare: R('const cell = sanitize ?? ((text: string): string => text)'),
    why: '逐行对照单元格正文（磁盘/快照文件原文，可能含明文凭据）',
  },
  {
    id: 'restore-plan-diff-error',
    file: 'src/client/library/RestorePlanView.tsx',
    redacted: R('<Banner kind="error">{redact(state.message)}</Banner>'),
    bare: R('<Banner kind="error">{state.message}</Banner>'),
    why: '读取单文件差异失败的错误文本（宿主返回，可能含路径）',
  },
  {
    id: 'snapshot-inspect-description',
    // UI v2：该视图搬到 library/ 供产物库与备份页共用（同一次提交里改登记表，绝不漏）
    file: 'src/client/library/BackupInspectView.tsx',
    redacted: R("{' '}{item.adapter}: {redact(item.description)}"),
    bare: R("{' '}{item.adapter}: {item.description}"),
    why: '备份差异查看的计划项描述',
  },
  /* ---------------- 同步差异确认 ---------------- */
  {
    id: 'sync-confirm-description',
    file: 'src/client/sync/SyncConfirmView.tsx',
    redacted: R('<span className={css.confirmItemDesc}>{redact(it.description)}</span>'),
    bare: R('<span className={css.confirmItemDesc}>{it.description}</span>'),
    why: '同步差异项描述（引擎/宿主拼装；2026-10-04 收紧为确认列表的 .confirmItemDesc 描述列）',
  },
  {
    id: 'sync-confirm-detail',
    file: 'src/client/sync/SyncConfirmView.tsx',
    redacted: R('<div className={css.conflictDetail}>{redact(item.detail)}</div>'),
    bare: R('<div className={css.conflictDetail}>{item.detail}</div>'),
    why: '同步差异项明细（含本地配置值）',
  },
  {
    id: 'sync-confirm-diff',
    file: 'src/client/sync/SyncConfirmView.tsx',
    redacted: R('<pre className={css.diffScroll}>{redact(conflict.diff)}</pre>'),
    bare: R('<pre className={css.diffScroll}>{conflict.diff}</pre>'),
    why: '同步冲突 diff（本地 vs 远端配置全文）—— G-09 指出的漏网渲染点',
  },
  /* ---------------- 内容选择器（G-01：label 与 detail 同待遇） ---------------- */
  {
    id: 'picker-unit-label-decl',
    file: 'src/client/common/ContentPicker.tsx',
    redacted: R('const safeLabel = redact(u.label)'),
    bare: R('const safeLabel = u.label'),
    why: '单元名（导入侧来自备份包内的单元名/会话名）',
  },
  {
    id: 'picker-unit-label-title',
    file: 'src/client/common/ContentPicker.tsx',
    redacted: R('title={safeLabel}>{tailWeightedEllipsis(safeLabel, UNIT_NAME_MAX)}</span>'),
    bare: R('title={u.label}>{tailWeightedEllipsis(u.label, UNIT_NAME_MAX)}</span>'),
    why: '单元名的 title 与可见文本（先脱敏、后省略）',
  },
  {
    id: 'picker-unit-detail',
    file: 'src/client/common/ContentPicker.tsx',
    redacted: R('{u.detail !== undefined && <span className={css.pickerUnitDetail}>{redact(u.detail)}</span>}'),
    bare: R('{u.detail !== undefined && <span className={css.pickerUnitDetail}>{u.detail}</span>}'),
    why: '单元副标题（宿主 listUnits 下发的版本/路径等）',
  },
  /* ---------------- 市场 / 我的配置（条目导入审阅面板，两处共用同一组件） ----------------
     逐项明细已回到级联树里渲染（ContentPicker 的三个已登记点覆盖宿主下发的单元名与副标题），
     这里只剩「条目名进回滚确认文案」一处。 */
  {
    id: 'market-rollback-item-name',
    file: 'src/client/market/MarketImportReview.tsx',
    redacted: R("{ item: redact(itemName), id: result?.snapshotId ?? '' }"),
    bare: R("{ item: itemName, id: result?.snapshotId ?? '' }"),
    why: '市场条目名来自条目 manifest（外部文本）',
  },
  /* ---------------- 进度条（G-03） ---------------- */
  {
    id: 'progress-label',
    file: 'src/client/common/ProgressBar.tsx',
    redacted: R('<span className={css.progressLabel}>{redact(view.label)}</span>'),
    bare: R('<span className={css.progressLabel}>{view.label}</span>'),
    why: '进度阶段文案（宿主 /progress 回传）',
  },
  {
    id: 'progress-section-badge',
    file: 'src/client/common/ProgressBar.tsx',
    redacted: R('{redact(view.sectionBadge.label)} · {view.sectionBadge.current}/{view.sectionBadge.total}'),
    bare: R('{view.sectionBadge.label} · {view.sectionBadge.current}/{view.sectionBadge.total}'),
    why: '分区徽章标签（宿主回传的分区名）',
  },
  {
    id: 'progress-count-badge',
    file: 'src/client/common/ProgressBar.tsx',
    redacted: R('{view.countBadge.label !== \'\' ? `${redact(view.countBadge.label)} · ` : \'\'}'),
    bare: R('{view.countBadge.label !== \'\' ? `${view.countBadge.label} · ` : \'\'}'),
    why: '计数徽章标签（宿主回传的当前项名）',
  },
  {
    id: 'progress-detail',
    file: 'src/client/common/ProgressBar.tsx',
    redacted: R('{view.detail !== null && <span className={css.progressDetail}>{redact(view.detail)}</span>}'),
    bare: R('{view.detail !== null && <span className={css.progressDetail}>{view.detail}</span>}'),
    why: '当前项名（宿主回传）',
  },
  /* ---------------- 同步：仓库选择器（选择已有仓库 / 新建仓库） ---------------- */
  {
    id: 'sync-repo-picker-load-error',
    file: 'src/client/sync/SyncRepositoryPicker.tsx',
    // t3：括号改走字典（common.parens，英文界面不得出现全角括号），脱敏点不变
    redacted: R("{t('repoPicker.loadFailed')}{t('common.parens', { text: redact(loadError) })}"),
    bare: R("{t('repoPicker.loadFailed')}{t('common.parens', { text: loadError })}"),
    why: '仓库列表拉取失败文本（GitHub 状态/网络响应）',
  },
  {
    id: 'sync-repo-picker-create-error',
    file: 'src/client/sync/SyncRepositoryPicker.tsx',
    redacted: R('{createError !== null && <span className={css.formError}>{redact(createError)}</span>}'),
    bare: R('{createError !== null && <span className={css.formError}>{createError}</span>}'),
    why: '新建仓库失败文本（GitHub 校验消息可能回显仓库名/URL）',
  },
  /* ---------------- 关于：更新内容弹窗（G-04） ---------------- */
  {
    id: 'release-notes-error',
    file: 'src/client/about/ReleaseNotesDialog.tsx',
    redacted: R('<Banner kind="error">{redact(error)}</Banner>'),
    bare: R('<Banner kind="error">{error}</Banner>'),
    why: 'release notes 拉取错误文本（GitHub 状态/网络响应）',
  },
  /* ---------------- toast 错误文本渲染点（client-F4：T11 修复登记） ---------------- */
  {
    id: 'toast-error-text-recovery',
    file: 'src/client/recovery/RecoveryPanel.tsx',
    redacted: /const redactErrorText = \(err: unknown\): string => redact\(err instanceof Error \? err\.message : String\(err\)\)/,
    bare: /const redactErrorText = \(err: unknown\): string => err instanceof Error \? err\.message : String\(err\)/,
    why: '恢复面板的宿主/网络错误文本（13 处 toast）此前裸渲染',
  },
  {
    id: 'toast-error-text-library',
    file: 'src/client/library/LibraryActions.tsx',
    redacted: /const redactErrorText = \(err: unknown\): string => redact\(err instanceof Error \? err\.message : String\(err\)\)/,
    bare: /const redactErrorText = \(err: unknown\): string => err instanceof Error \? err\.message : String\(err\)/,
    why: '产物库动作层错误文本（9 处）此前裸渲染',
  },
  {
    id: 'toast-error-text-backup-schedule',
    file: 'src/client/home/BackupScheduleCard.tsx',
    redacted: /const redactErrorText = \(err: unknown\): string => redact\(err instanceof Error \? err\.message : String\(err\)\)/,
    bare: /const redactErrorText = \(err: unknown\): string => err instanceof Error \? err\.message : String\(err\)/,
    why: '定时备份卡错误文本（2 处）此前裸渲染',
  },
  {
    id: 'toast-error-text-export',
    file: 'src/client/export/ExportView.tsx',
    redacted: /const redactErrorText = \(err: unknown\): string => redact\(err instanceof Error \? err\.message : String\(err\)\)/,
    bare: /const redactErrorText = \(err: unknown\): string => err instanceof Error \? err\.message : String\(err\)/,
    why: '导出下载失败文本此前裸渲染',
  },
  {
    id: 'toast-error-text-runs',
    file: 'src/client/common/RunsCenter.tsx',
    redacted: /const redactErrorText = \(err: unknown\): string => redact\(err instanceof Error \? err\.message : String\(err\)\)/,
    bare: /const redactErrorText = \(err: unknown\): string => err instanceof Error \? err\.message : String\(err\)/,
    why: '运行中心错误文本（2 处，同文件其它 3 处已脱敏）',
  },
  /* ---------------- 「工作区 + 会话回滚」卡（t12：新组件登记） ---------------- */
  {
    id: 'rollback-card-error-text',
    file: 'src/client/recovery/RollbackCard.tsx',
    redacted: /const redactErrorText = \(err: unknown\): string => redact\(err instanceof Error \? err\.message : String\(err\)\)/,
    bare: /const redactErrorText = \(err: unknown\): string => err instanceof Error \? err\.message : String\(err\)/,
    why: '回滚卡（src/client/recovery/RollbackCard.tsx）的宿主/网络错误文本：预览 / 回退 / 删除三条失败路径统一经 fail() → redactErrorText → Banner（列表加载失败经 setError(redactErrorText(err))）。登记前该文件既不参与逐点断言、也不参与「裸 toast 错误文本」全文件扫描（countNakedToast）',
  },
]

/**
 * VA-2 修复 + t56 边界修正：裸 toast 错误文本的**全文件**判据。
 *
 * 判据：`toast.error(` / `toast.warn(`（**含可选链** `toast?.error(`）的参数里出现
 *  ① `.message`（未被 `redact…` 包装）—— 把 Error 原文交给 toast；或
 *  ② `String(<标识符>)`（**未被 `redact…` 包装、且不在 `t(...)` 里**）—— 把非 Error 的原始值交给 toast，
 *就记 1 处裸渲染。该判据不依赖登记表里的某个具体写法，所以「往已登记文件追加一个新的裸渲染点」也会被扫到（VA-2 的原始绕过手法）。
 *
 * t56 的两处修正（t46 反向攻击登记的 R1/R2）：
 *  - **R1（逃逸，已修）**：`String(...)` 分支原先是变量名白名单（`err|e|error`），于是 `toast.error(String(problem))`
 *    这种同样裸的写法逃逸 → 现在匹配**任意标识符**。**但不能一刀切**：`String(...)` 在 `t(...)` 里极常见且合法
 *    （`t('import.failed', { count: String(failedCount) })` 是数值格式化，不是错误原文），所以 `String(...)` 只在
 *    **不在 `t(...)` 内**时才判裸 —— 这是为「不把合法写法误伤」而做的窄化，不是放水。
 *  - **R2（误报，已修）**：判定前先把**被 `redact(...)` / `redactErrorText(...)` 包住的片段**整段抹空（`blankRanges`），
 *    于是 `toast.error(t('k', { detail: redact(err.message) }))` 不再被误报。抹空按位置进行（长度不变），
 *    未被包装的 `.message` / `String(x)` 原样保留 ⇒ R1/R2 的修改不会互相抵消。
 *
 * R3（观察，部分处理）：可选链 `toast?.error(` 已纳入；**别名**形态（`const x = toast; x.error(...)`）仍不在扫描范围
 * —— 覆盖它需要跨语句数据流分析（纯字符串扫描做不到），而当前仓库 0 处别名写法，宁可不做也不引入
 * 「任何 `x.error` 都算违规」这种粗糙规则。
 *
 * 已知限制（如实登记）：`t('k', { message: String(problem) })`（把原始值经 `String` 塞进字典参数）不被判裸 ——
 * 该形态与 `String(count)` 在源码上不可区分（需类型/数据流），当前仓库 0 处；`.message` 形态与 t 外的 `String(...)` 均已覆盖。
 */
const TOAST_CALL = /toast\??\.(?:error|warn)\s*\(/
const NAKED_MESSAGE = /\.message\b/
const NAKED_STRING = /String\s*\(\s*[A-Za-z_$][\w$]*\s*\)/

/** 从 `argStart` 起做括号配平（跳过字符串字面量里的括号），返回配对右括号之后的下标（找不到则 src.length） */
function closeParenAfter(src: string, argStart: number): number {
  let depth = 1
  let j = argStart
  while (j < src.length && depth > 0) {
    const ch = src[j]
    if (ch === '"' || ch === "'" || ch === '`') {
      j += 1
      while (j < src.length && src[j] !== ch) { if (src[j] === '\\') j += 1; j += 1 }
    } else if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    j += 1
  }
  return j
}

/** 源码里与 `namePattern`（形如 `foo(`）匹配的全部调用区间 */
function callRanges(src: string, namePattern: RegExp): { start: number; end: number; argStart: number }[] {
  const re = new RegExp(namePattern.source, namePattern.flags.includes('g') ? namePattern.flags : namePattern.flags + 'g')
  const out: { start: number; end: number; argStart: number }[] = []
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const argStart = m.index + m[0].length
    out.push({ start: m.index, end: closeParenAfter(src, argStart), argStart })
  }
  return out
}

/** 把区间整段抹成空格（**长度不变**，保证其余字符的下标与相对位置不变） */
function blankRanges(src: string, ranges: readonly { start: number; end: number }[]): string {
  const chars = [...src]
  for (const r of ranges) {
    for (let i = r.start; i < r.end; i += 1) { if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ' }
  }
  return chars.join('')
}

/** 统计源码里「把宿主/网络错误原文直接交给 toast」的调用数（0 = 合规） */
function countNakedToast(src: string): number {
  const redactMasked = blankRanges(src, callRanges(src, /\b(?:redactErrorText|redact)\s*\(/))
  const tMasked = blankRanges(redactMasked, callRanges(src, /\bt\s*\(/))
  let count = 0
  for (const call of callRanges(src, TOAST_CALL)) {
    const argsRedactMasked = redactMasked.slice(call.argStart, call.end)
    const argsMasked = tMasked.slice(call.argStart, call.end)
    if (NAKED_MESSAGE.test(argsRedactMasked) || NAKED_STRING.test(argsMasked)) count += 1
  }
  return count
}

/**
 * 把匹配文本里最外层的 `redact(...)` 调用剥掉（支持一层嵌套），得到「被改裸后」的文本。
 * 用于反死正则自检：凡是「剥掉 redact 包装即得裸形态」的登记点，bare 都必须能命中剥出来的文本。
 */
function unwrapRedact(text: string): string {
  return text.replace(/redact\(((?:[^()]|\([^()]*\))*)\)/, '$1')
}

/** 读源码（每个点各自读一次，避免缓存掩盖变异） */
function read(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8')
}

function countMatches(src: string, re: RegExp): number {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  return [...src.matchAll(global)].length
}

test('安全守卫（按渲染点）：每个已登记的渲染点都必须过 redact()，且不得存在裸渲染', () => {
  for (const p of RENDER_POINTS) {
    const src = read(p.file)
    const hits = countMatches(src, p.redacted)
    assert.equal(
      hits,
      1,
      `[${p.id}] ${p.file}：期望恰好 1 处已脱敏渲染（${p.redacted}），实际 ${hits} 处 —— 少了 = 被改裸/被删，多了 = 请更新本登记表`,
    )
    // VA-2 修复：必须用「命中数 == 0」判定 —— doesNotMatch 在 bare 被写歪成死正则时**恒真**（漏报）。
    const bareHits = countMatches(src, p.bare)
    assert.equal(bareHits, 0, `[${p.id}] ${p.file}：存在 ${bareHits} 处裸渲染（${p.bare}）—— ${p.why}`)
  }
  // VA-2 修复：全文件子句，不依赖登记表里的某个具体写法 —— 往已登记文件**追加**一个新的裸渲染点也会被扫到。
  for (const file of [...new Set(RENDER_POINTS.map((p) => p.file))]) {
    const naked = countNakedToast(read(file))
    assert.equal(naked, 0, `${file}：存在 ${naked} 处裸 toast 错误文本渲染（必须过 redact() / redactErrorText()）`)
  }
})

test('安全守卫（按渲染点）：bare 正则不得是死代码（剥掉 redact(...) 包装后必须命中）', () => {
  // VA-2 的机制：bare 曾被写成「比合法裸形态多一个右括号」的死正则 —— doesNotMatch 恒真 ⇒ 永远拦不住。
  // 这里把每个点的 redacted 命中文本剥掉最外层 redact(...) 包装，再要求 bare 能命中它：
  // 正则写歪即红灯（等价于对 30+ 个登记点做一次「变异 → 必须红」的自证）。
  let checked = 0
  for (const p of RENDER_POINTS) {
    const src = read(p.file)
    const m = new RegExp(p.redacted.source, p.redacted.flags.replace('g', '')).exec(src)
    assert.notEqual(m, null, `[${p.id}] ${p.file}：redacted 未命中，无法做死正则自检`)
    const matched = (m as RegExpExecArray)[0]
    const naked = unwrapRedact(matched)
    // 变量换名式登记点（bare 与 redacted 不是「同一段文本的去包装形态」）不适用本自检
    if (naked === matched) continue
    assert.match(
      naked,
      p.bare,
      `[${p.id}] ${p.file}：bare 是死代码 —— 把「${matched}」剥成裸形态「${naked}」后 bare（${p.bare}）匹配不到`,
    )
    checked++
  }
  assert.ok(checked >= 20, `应有 >= 20 个「去包装」型登记点参与死正则自检（实际 ${checked}）`)
})

test('安全守卫（按渲染点）：登记表本身可用（file 存在、id 唯一、file/bare 成对）', () => {
  const ids = RENDER_POINTS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length, '渲染点 id 必须唯一')
  assert.ok(RENDER_POINTS.length >= 20, `登记表应有 >= 20 个渲染点（实际 ${RENDER_POINTS.length}）`)
  for (const p of RENDER_POINTS) {
    const src = read(p.file) // 文件不存在会直接抛错
    assert.ok(src.length > 0, `${p.file} 为空`)
    assert.notEqual(p.redacted.source, p.bare.source, `[${p.id}] redacted 与 bare 不得相同`)
    // 每个登记点所在文件都必须真的 import 了 redact（接线被删即红灯）
    assert.match(
      src,
      /import \{ redact \} from '\.\.\/\.\.\/security\/redaction\.ts'/,
      `${p.file}：必须从 security/redaction.ts 导入 redact`,
    )
  }
})

test('安全守卫（按渲染点）：NAKED_TOAST_CALL 的两处边界（t56：R1 String 逃逸 / R2 嵌套 redact 误报）', () => {
  const naked = (snippet: string): boolean => countNakedToast(snippet) > 0
  // R1：任意变量名的 String(...) 都算裸（修复前只认 err|e|error → 逃逸）
  assert.ok(naked('toast.error(String(problem))'), 'R1：String(problem) 必须判裸')
  assert.ok(naked('toast.warn(String(cause))'), 'R1：toast.warn 同理')
  assert.ok(naked('toast.error(err.message)'), '`.message` 形态仍判裸')
  // R2：参数里**已经过** redact 包装的不算裸（修复前会误报）
  assert.equal(naked("toast.error(t('k', { detail: redact(err.message) }))"), false, 'R2：嵌套 redact 不得误报')
  assert.equal(naked('toast.error(redactErrorText(err))'), false, 'redactErrorText 包装合法')
  assert.equal(naked('toast.error(redact(String(err)))'), false, 'redact 包裹 String(err) 合法')
  // 合法形态与变量形态仍绿（与 t45 建立的判据一致；防「一律算违规」的粗糙规则）
  assert.equal(naked("toast.error(t('recovery.sessions.repairFailed') + ': ' + redactErrorText(err))"), false, '合法：t(...) + redactErrorText')
  assert.equal(naked("toast.error(t('k', { message }))"), false, '合法：变量（调用前已 redact）')
  assert.equal(naked("toast.error(t('k'))"), false, '合法：纯字典文案')
  // R3：可选链已纳入扫描
  assert.ok(naked('toast?.error(String(problem))'), 'R3：toast?.error 已纳入')
})
