/**
 * SyncPanel.tsx 的**分层/拆分结构守卫**（t42；v2 第 5 步由 SyncSettingsView.tsx 改名而来）。
 *
 * 为什么是源码级：本仓库 React 无组件测试框架（AGENTS.md：逻辑提炼到 src/ui/ 保证可测），
 * 「组件已退化成装配层 + 渲染段各成文件 + 纯逻辑只在 src/ui」这件事只能按**源码结构**钉住。
 * 断言只锚真实代码结构（import / 函数定义 / JSX 用法 / 逻辑片段 / 行数棘轮），不锚注释文本
 * —— 注释里出现同名字符串不会让守卫假绿；每条断言独立，单独回退会单独变红。
 *
 * 与 src/ui/sync-settings-view.test.ts 的分工：那边测**行为**（22 条），这边测**分层与拆分边界**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/* ------------------------------- 结构守卫：SyncPanel.tsx 的分层边界（t42） */

/**
 * 为什么守卫放在这里而不是 src/client/sync/SyncSettingsView.test.tsx：
 * 本仓库 Node（v24）的内置 TS 支持**不加载 .tsx 扩展名**（实测 ERR_UNKNOWN_FILE_EXTENSION），
 * 且 npm test 的 glob 是 src/**\/*.test.ts —— .tsx 守卫文件既不被 glob 匹配、也无法被 node 加载。
 * 因此按可运行优先把它放在逻辑模块的测试文件里（与 src/client/common/plan-text-redaction.test.ts
 * 的源码守卫同源思路）：断言只锚**真实代码结构**（函数定义 / JSX 用法 / import / 逻辑片段），
 * 不锚注释文本，注释里出现同名字符串不会让守卫假绿。
 */
const VIEW_PATH = fileURLToPath(new URL('./SyncPanel.tsx', import.meta.url))
const LOGIC_PATH = fileURLToPath(new URL('../../ui/sync-settings-view.ts', import.meta.url))
/** 统一换行（守卫要按 `\n` 跨行匹配，避免 CRLF 让断言静默失真）。 */
const readSource = (file: string): string => fs.readFileSync(file, 'utf8').split('\r\n').join('\n')
const viewSource = readSource(VIEW_PATH)
const logicSource = readSource(LOGIC_PATH)

/**
 * 主组件（SyncSettingsView 函数体）的源码文本：从它的定义到文件里下一个顶层 `function `（子组件都在其后）。
 * 「某段渲染/逻辑已搬出主组件」这类断言必须只针对**主组件**，否则同文件的子组件会让断言失真。
 */

test('t42: 纯逻辑在 ui 模块，且 ui 模块保持框架无关（不反向依赖 client / React）', () => {
  assert.match(viewSource, /from '\.\.\/\.\.\/ui\/sync-settings-view\.ts'/, '组件必须从 ui/sync-settings-view.ts 引入纯逻辑')
  assert.doesNotMatch(logicSource, /from 'react'/, 'ui 逻辑模块不得 import React')
  assert.doesNotMatch(logicSource, /from '\.\.\/client\//, 'ui 逻辑模块不得反向 import client')
})

test('t42: 已下沉的逻辑不得在组件里重新实现（每条独立 → 单独回退单独变红）', () => {
  assert.doesNotMatch(viewSource, /syncSections\.includes\('sessions'\)/, 'sessions 显式放行规则必须只在 ui 里')
  assert.doesNotMatch(viewSource, /encrypt: true, encryptPassword:/, '加密载荷组装必须只在 ui 里')
  assert.doesNotMatch(viewSource, /pollDelayMs \?\?/, 'GitHub 轮询延迟兜底必须只在 ui 里')
  assert.doesNotMatch(viewSource, /Math\.max\(state\.github\.interval/, '轮询兜底计算必须只在 ui 里')
  assert.doesNotMatch(viewSource, /toLocaleString\(/, '时间格式化必须只在 ui 里')
  assert.doesNotMatch(viewSource, /if \(savingRef\.current\)/, '保存防重入判断必须只在 ui 里')
  assert.doesNotMatch(viewSource, /pendingSave\.current =/, '待发改动队列必须走 ui 状态机')
  assert.doesNotMatch(viewSource, /mode: 'advanced',\n\s*sections:/, '分区选择请求体组装必须只在 ui 里')
})

test('t42: 组件按职责物理拆分成独立文件（各自导出 + 主文件只装配）', () => {
  const units: [string, string][] = [
    ['SyncChannelEntryCard', 'SyncChannelEntryCard.tsx'],
    ['ChannelConfigDialog', 'ChannelConfigDialog.tsx'],
    ['SyncSectionPickerDialog', 'SyncSectionPickerDialog.tsx'],
    ['SecurityOptionsCard', 'SecurityOptionsCard.tsx'],
    ['DecryptPasswordCard', 'DecryptPasswordCard.tsx'],
    ['AutosyncCard', 'AutosyncCard.tsx'],
    // issue #79：工作副本卡（含确认弹窗 + 宿主调用 + 回执）自成文件，主文件只装配 —— 行数棘轮因此不必上调
    ['WorkDirCard', 'WorkDirCard.tsx'],
    // issue #91：推送预览卡（五条并列提示带：只读 / 首次基线 / 加密 / 含凭据 / 引擎告警）自成文件，
    // 主文件只装配 —— 同样以「抽出去」而不是「抬上限」满足棘轮
    ['PushPreviewCard', 'PushPreviewCard.tsx'],
    // 一键同步的加载反馈：在途活动条是纯展示（无状态无调用），同样以「抽出去」守住棘轮
    ['SyncActivityBar', 'SyncActivityBar.tsx'],
  ]
  for (const [name, file] of units) {
    // 主文件：必须 import 并渲染该单元
    assert.match(viewSource, new RegExp("from '\\./" + file.replace('.', '\\.') + "'"), name + ' 必须从独立文件导入')
    assert.match(viewSource, new RegExp('<' + name + '[\\s/>]'), name + ' 必须被主组件渲染')
    // 单元文件：必须存在、导出该组件、且不反向 import 主文件（避免环）
    const unitSource = readSource(fileURLToPath(new URL('./' + file, import.meta.url)))
    assert.match(unitSource, new RegExp('export function ' + name + '\\('), name + ' 必须在自己的文件里导出')
    assert.doesNotMatch(unitSource, /from '\.\/SyncPanel\.tsx'/, name + ' 不得反向 import 主文件')
  }
  // 已迁出的渲染不再出现在主文件（整文件级断言：搬出后必然为真，回退即变红）
  assert.doesNotMatch(viewSource, /WEBDAV_PRESETS\.map/, 'WebDAV 预设渲染必须只在 ChannelConfigDialog.tsx 里')
  assert.doesNotMatch(viewSource, /syncSectionGroups\(/, '分组勾选渲染必须只在 SyncSectionPickerDialog.tsx 里')
  assert.doesNotMatch(viewSource, /settings\.encryptPasswordConfirm/, '加密密码输入必须只在 SecurityOptionsCard.tsx 里')
  // 行数棘轮：主文件显著低于拆分前（1792 行 → 拆分后约 1300 行），回退合并会立刻变大
  const viewLines = viewSource.split('\n').length
  // v2 第 5 步把「当前通道」参数化并抽出 ChannelCard：行数仍须保持拆分后的量级。
  // 上限随「确实不得不落在装配层」的改动上调，且每次上调都要有理由（否则棘轮会被慢慢磨平）：
  // 1450 → 1480（issue #59/#60）：commit() 必须在 runStore.patch 之后把**在途密码**写回内存
  // （否则任何无关 patch 都会清空用户正在输入的 webdav 密码），加上列表回传的读失败提示接线。
  // 展示段本身已拆到 UnreadableSnapshotsBanner.tsx，所以主文件只多了装配与状态同步的几行。
  // 1480 → 1500（用户要求：同步通道配置必须能删掉）：断开流程自身已外置到
  // ChannelClearConfirmDialog.tsx（确认弹窗 + 宿主调用 + 回执），主文件只多了
  // 「待确认通道」一个状态、一次收尾（清表单/撤在途自动保存/重拉 status）与渲染接线。
  // 1500 → 1520（用户要求：点 GitHub 登录自动复制一次性授权代码 + 断开 git 通道必须同步复位
  // 「已登录」内存态）。两条都属于「弹窗/卡片之外的跨切片状态接线」，没有可下沉的纯逻辑：
  // 复制是浏览器副作用（实现在 common/clipboard.ts），登录态复位是 SyncPanel 自己的内存状态。
  // 1520 → 1580（t12：客户端接线云端点通道 s3 / gist）。增量逐项都是**装配**，没有可下沉的逻辑：
  //   · 通道状态由 { git, webdav } 字面量改为 Record<SyncChannel, …>（枚举派生、四通道构造）；
  //   · 云端点表单 12 个字段进出 state（校验 / 组装 / 就绪判定都已下沉 ui 层，这里是 state 通道）；
  //   · 多两张通道卡；对话框改为收单个 form 快照后，调用点反而少了几行；
  //   · /sync/status → 四通道回填 + 云端点非密字段回填。
  // 1580 → 1585（t3：英文界面零中文）。增量是**装配接线**：分区选择弹窗新增 uiT 注入
  //   （分区描述 / 分组说明改为字典键后，弹窗内需要 ui 字典翻译器才能解析；判定逻辑在 ui 层）。
  //   同一轮把 11 处 toast 的「全角冒号 + 详情」拼接改为 t('common.labelSeparator')，行数不变。
  // 1585 → 1595（cloud-sync 借鉴项 ②⑥ + 远程合并裁决入口）：新增的组件各自成文件
  //   （SyncProbeRow / MergePreviewEntry + 产物库那侧的 deviceLabel），
  //   主文件只多出 import、挂载点与一处「快照标签追加设备名」的拼接 —— 没有可再下沉的纯逻辑
  //   （测试连接/设备名的判定与渲染规则在 ui 层，见 probe-view.ts / remote-device-view.ts）。
  // 1595 → 1620（方案 A：同步页按钮瘦身）。增量逐项都是**装配**，且已按「先抽出去」外移：
  //   · 一键同步分派：决策与编排分别下沉 merge-view.decideSyncEntry / sync-entry.resolveSmartSync
  //     （两者都有 node 单测），主文件只留 switchChannel + 一次 resolveSmartSync + 三个分支；
  //   · 受控展开：合并视图改由 mergeSeed（preview + signal）驱动（MergePreviewEntry 增加
  //     openSignal / hideEntryButton / initialPreview），主文件只多一个 state 与一次挂载；
  //   · 按钮瘦身本身是**净减**（主行 3 → 2 个、拉取降级到快照行、测试连接下移到卡片底部）。
  //   剩下的全是 React 状态与 JSX 位置，没有可再下沉的纯逻辑，故按仓库惯例抬上限并记录理由。
  // 1620 → **1560**（三项 UI 收口：测试连接并入动作行、移除拉取差异预览、一键同步改弹窗）。
  //   这一轮是**净减**，因此按棘轮本意把上限**压回去**（而不是继续抬）：
  //   · 测试连接：结果走 toast，页面不再有它的一整块内联横幅（组件内 presentation='action' 只出按钮）；
  //   · 拉取差异预览：按钮、runPull、pullView、报告弹窗、pullReportView import 全部删除；
  //   · 一键同步：裁决视图从页面内联改为**弹窗**装配（Modal + 一次 MergePreviewView），
  //     页面侧只多一个 mergeSeed 状态、一个 mergeApplying 状态与一个弹窗块。
  // 1560 不变（加载动画 + 合并弹窗重设计）：新增的在途活动条抽成 SyncActivityBar.tsx，
  //   裁决弹窗壳/状态/请求抽成 MergeModal.tsx（主文件只留一次挂载），主文件因此仍然回落。
  // 1560 → 1600（真·自动同步：三项策略开关）。增量逐项都是**装配**，三个控件本身在 AutosyncCard.tsx：
  //   · updateAutosyncOptions：一次 api.autosyncUpdate + 两处 patchChannelOf（就地回填 autosync/interval/realtime）；
  //   · 卡片新增 onUpdateOptions 接线与 import 两个类型（realtime / 分档 / 冲突策略都是通道级状态）。
  //   没有可再下沉的纯逻辑：判定与文案都在 ui 层（sync-settings-view.ts）与字典里，这里只是 state 通道。
  assert.ok(viewLines <= 1600, '主文件行数必须保持在拆分后的量级（实际 ' + viewLines + ' 行）')
})

test('t42: 通道卡必须是渲染函数（内联组件 = 每次渲染新类型 → 子树重挂、Select 展开态清零）', () => {
  // 真机 bug：打开同步页「选择历史快照」下拉时 onOpen 会触发一次 loadSnapshots → 父组件重渲染；
  // 若通道卡是组件体内定义的组件，React 按类型不同整棵子树重挂，Select 的 open 状态当场归零 ——
  // 下拉刚展开就被关掉，根本选不中。渲染函数返回 JSX 直接调用即可保持元素标识稳定。
  assert.doesNotMatch(viewSource, /<ChannelCard[\s/>]/, '通道卡不得渲染成 JSX 组件（内联组件会让子树在每次渲染重挂）')
  assert.doesNotMatch(viewSource, /const ChannelCard = \(/, '不得在组件体内定义 ChannelCard 组件')
  assert.match(viewSource, /const renderChannelCard = \(channel: SyncChannel\): ReactNode =>/, '通道卡必须是返回 JSX 的渲染函数')
  assert.match(viewSource, /\{renderChannelCard\('git'\)\}/, 'git 通道卡必须经渲染函数调用')
  assert.match(viewSource, /\{renderChannelCard\('webdav'\)\}/, 'webdav 通道卡必须经渲染函数调用')
})

test('工作副本「重建」按钮必须在请求在途时转加载态（用户报告：点了没有任何反馈）', () => {
  // 真机用户报告：点「重新克隆工作副本」后整卡没有任何变化，只有结束时才跳出 toast —— reclone 要删目录 +
  // 重新 clone（可达数十秒），期间用户无从判断是否在执行。守卫钉住三条：在途态由本卡自持、两个出口都转
  // 加载态并互相禁用、失败也必须收掉加载态；任一条回退即变红。
  const src = readSource(fileURLToPath(new URL('./WorkDirCard.tsx', import.meta.url)))
  assert.match(src, /const \[pending, setPending\] = useState<'relink' \| 'adopt' \| 'reclone' \| null>\(null\)/, '在途态必须是本卡自持的 relink/reclone 判别式状态')
  assert.match(src, /loading=\{pending === 'reclone'\}/, '重新克隆按钮必须在自身请求在途时显示加载态')
  assert.match(src, /loading=\{pending === 'relink'\}/, '重指向按钮同理')
  assert.match(src, /disabled=\{busy \|\| pending !== null\}/, '在途时必须同时禁用两个出口（防重复点击）')
  const start = src.indexOf('const reset = async')
  const body = src.slice(start, start + 900)
  assert.match(body, /finally \{[\s\S]*setPending\(null\)/, '失败也必须收掉加载态（否则按钮会永远转圈）')
})

test('t42: 断开 git 通道必须同步复位内存登录态（令牌槽位被删 = 已登出，否则登录入口恒隐藏）', () => {
  // 真机用户报告：点「断开配置」删掉的是 SYNC_CREDENTIAL_REF —— 与 GitHub 登录**同一个槽位**，
  // 但 githubSignedIn 当时不复位，登录块恒隐藏，用户以为要重启 profile 才能重新登录。
  const start = viewSource.indexOf('const onChannelCleared')
  assert.ok(start > 0, 'onChannelCleared 必须存在')
  const body = viewSource.slice(start, start + 900)
  assert.match(body, /channel === 'git' \? \{ githubSignedIn: false, github: initialGithub \}/, '断开 git 必须复位 githubSignedIn + 清 github 流程态')
})

test('t42: 发起 GitHub 登录即自动复制一次性授权代码（用户要求）', () => {
  assert.match(viewSource, /copyTextToClipboard\(info\.userCode\)/, '一次性代码必须在登录发起后自动复制（走 common/clipboard.ts）')
})

test('t42: 未新增硬编码颜色（DESIGN.md：颜色/阴影走 --dsw-* token）', () => {
  assert.doesNotMatch(viewSource, /#[0-9a-fA-F]{3,8}\b/, '不得出现硬编码颜色值')
  assert.doesNotMatch(viewSource, /rgba?\(/, '不得出现硬编码 rgb/rgba 颜色')
})
