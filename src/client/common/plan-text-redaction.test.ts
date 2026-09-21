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
    id: 'import-log-line',
    file: 'src/client/import/ImportWizardView.tsx',
    redacted: R('className={css.logLine}>{redact(line)}</div>'),
    bare: R('className={css.logLine}>{line}</div>'),
    why: '导入执行日志行（宿主 /progress 回传的命令输出）',
  },
  /* ---------------- 档案（DSH profile）原文 ---------------- */
  {
    id: 'profile-manifest-text',
    file: 'src/client/profiles/ProfilesPanel.tsx',
    redacted: R("{redact(detail.manifest ?? '')}"),
    bare: R("{detail.manifest ?? ''}"),
    why: 'package.json 原文（依赖 spec 可能内联私有源地址/令牌）',
  },
  {
    id: 'profile-patch-text',
    file: 'src/client/profiles/ProfilesPanel.tsx',
    redacted: R("{detail.patch !== null ? redact(detail.patch) :"),
    bare: R("{detail.patch !== null ? detail.patch :"),
    why: 'cordis.patch.yml 原文（!!js 表达式旁可能内联字面量密钥）',
  },
  /* ---------------- 恢复计划 / 差异查看 ---------------- */
  /* git 风格恢复预览（RestorePlanView）：描述/路径/明细/文件正文/错误文本逐个登记 */
  {
    id: 'restore-plan-description',
    file: 'src/client/snapshots/RestorePlanView.tsx',
    redacted: R('const safeDescription = redact(row.description)'),
    bare: R('const safeDescription = row.description'),
    why: '恢复计划行描述（宿主拼装，可能含本地明文配置值）',
  },
  {
    id: 'restore-plan-target',
    file: 'src/client/snapshots/RestorePlanView.tsx',
    redacted: R('const safeTarget = row.target === undefined ? null : redact(row.target)'),
    bare: R('const safeTarget = row.target === undefined ? null : row.target'),
    why: '恢复计划行目标路径（宿主拼装的 home 相对路径，同时进可见文本与 title）',
  },
  {
    id: 'restore-plan-detail',
    file: 'src/client/snapshots/RestorePlanView.tsx',
    redacted: R('（{redact(row.detail)}）'),
    bare: R('（{row.detail}）'),
    why: '恢复计划行明细（宿主拼装）',
  },
  {
    id: 'restore-plan-diff-cell',
    file: 'src/client/snapshots/RestorePlanView.tsx',
    redacted: R("return text === undefined ? '' : redact(text)"),
    bare: R("return text === undefined ? '' : text"),
    why: '逐行对照单元格正文（磁盘/快照文件原文，可能含明文凭据）',
  },
  {
    id: 'restore-plan-diff-error',
    file: 'src/client/snapshots/RestorePlanView.tsx',
    redacted: R('<Banner kind="error">{redact(state.message)}</Banner>'),
    bare: R('<Banner kind="error">{state.message}</Banner>'),
    why: '读取单文件差异失败的错误文本（宿主返回，可能含路径）',
  },
  {
    id: 'snapshot-inspect-description',
    file: 'src/client/snapshots/SnapshotsPanel.tsx',
    redacted: R("{' '}{item.adapter}: {redact(item.description)}"),
    bare: R("{' '}{item.adapter}: {item.description}"),
    why: '备份差异查看的计划项描述',
  },
  /* ---------------- 同步差异确认 ---------------- */
  {
    id: 'sync-confirm-description',
    file: 'src/client/sync/SyncConfirmView.tsx',
    redacted: R('<span>{redact(it.description)}</span>'),
    bare: R('<span>{it.description}</span>'),
    why: '同步差异项描述（引擎/宿主拼装）',
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
    redacted: R('title={safeLabel}>{middleEllipsis(safeLabel, UNIT_NAME_MAX)}</span>'),
    bare: R('title={u.label}>{middleEllipsis(u.label, UNIT_NAME_MAX)}</span>'),
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
  /* ---------------- 关于：更新内容弹窗（G-04） ---------------- */
  {
    id: 'release-notes-error',
    file: 'src/client/about/ReleaseNotesDialog.tsx',
    redacted: R('<Banner kind="error">{redact(error)}</Banner>'),
    bare: R('<Banner kind="error">{error}</Banner>'),
    why: 'release notes 拉取错误文本（GitHub 状态/网络响应）',
  },
]

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
    assert.doesNotMatch(src, p.bare, `[${p.id}] ${p.file}：存在裸渲染 ${p.bare}（${p.why}）`)
  }
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
