# 🎨 DESIGN.md — DSH Config Manager 视觉设计规范（Design System 唯一权威）

> **本文件是项目 UI / UX / Visual Style 的 Single Source of Truth。**
> 任何开发者或 AI Agent 在创建、修改、重构前端界面时，都必须先阅读并遵守本文件（约束入口见 [AGENTS.md](AGENTS.md) §「UI AND DESIGN SYSTEM RULES」）。
>
> 本规范**全部从当前项目实际代码提取**（`src/client/config-manager.module.css`、`src/client/common/ui.tsx` 及全部 React 组件），不脱离现状另造 Design System。若本文件与代码冲突，以代码为准并更新本文件。

---

## 0. 定位：这是「DSH 插件设置页」，不是独立 Web 应用

本项目 UI 是挂在 DSH（DeepSeek Harness）GUI 内部的 **`settings.section` 设置页**（「备份与迁移」）。因此：

- **不拥有**全局页面框架：App Shell / 侧边栏 / 顶部导航 / 路由 / 全局页面背景全部由 DSH 宿主提供，本插件只渲染 `settings.section` 的**内容体**（`css.section` 容器内部）。
- **不拥有**主题：亮/暗/皮肤由 DSH 活动主题决定，通过 `--dsw-*` CSS 变量注入。插件**永远不定义自己的颜色**，只消费 token。
- **不拥有**字体栈：正文 font-family 取 `var(--dsw-font-family)`；等宽场景用系统等宽栈（见 §3）。
- 所有视觉必须能同时在亮/暗主题与任意 DSH 皮肤下成立——这是本项目的最高视觉约束。

---

## 1. Design Principles

| 原则 | 含义 | 代码依据 |
|---|---|---|
| **Token 驱动，零硬编码** | 颜色 / 字体 / 边框 / 交互底色全部用 `--dsw-*` CSS 变量，CSS 文件中搜索不到任何 `#hex` / `rgb()` 常量 | `config-manager.module.css` 头部注释明确声明「全部颜色/字体/阴影走 DSH Design System 的 --dsw-* token（跟随活动主题：亮/暗与皮肤），不另造视觉体系」 |
| **薄壳渲染，逻辑下沉** | React 组件只做装配；渲染模型 / 状态判定 / 文案来自 `src/ui/` 纯函数 | 每个组件头部注释写明「全部渲染模型来自 ./xxx.ts 纯函数（node 单测覆盖），组件只做装配」 |
| **设置页密度，克制堆叠** | 信息密度中等偏低：垂直卡片流 + 分组勾选 + 步骤化向导；不用宽屏多栏布局、不用 data-grid | 五视图全部是单列 `viewBody` 卡片流 |
| **状态即语义** | 状态表达走固定语义集（ok / info / warn / error），Badge 与 Banner 四态一一对应 | `BadgeKind = 'info' | 'ok' | 'warn' | 'error'`、`BannerKind = 'ok' | 'error' | 'info' | 'warn'` |
| **安全优先于美观** | 错误/报告文本展示前强制 `redact()`；敏感字段不进 sessionStorage；危险操作用 danger 按钮 + confirm | `ErrorBanner.tsx` / `ReportView.tsx` / `run-store.ts` 白名单 |
| **长内容限高内滚** | 大列表 / 报告 / diff 一律「标题固定 + 容器限高内滚」，绝不让数百条内容把设置页撑长 | `planScroll` / `reportScroll` / `confirmScroll` / `pullScroll` / `diffScroll` |

**设计倾向**：桌面设置页优先（DSH GUI 宿主），无独立 Mobile 视图；响应式只靠 flex-wrap / auto-fit 网格自然收缩。

---

## 2. Colors（唯一来源：DSH Design System Token）

**禁止硬编码颜色值。** 所有颜色必须引用以下 `--dsw-*` 变量（或经 `color-mix()` 调制已有 token，见 §2.2）。

### 2.1 已在项目中使用的 Token 及语义映射

| 语义角色 | Token（变量引用） | 典型用途 |
|---|---|---|
| 主要文字 | `var(--dsw-alias-label-primary)` | 正文 / 标题 / 激活 tab |
| 次级文字 | `var(--dsw-alias-label-secondary)` | 副标题 / 未激活 tab / 说明 / 状态文字 |
| 弱化文字 | `var(--dsw-alias-label-tertiary)` | hint / 占位符 / 表头 / 空态 / 计数详情 |
| 反色前景（主按钮文字） | `var(--dsw-alias-label-primary-foreground)` | primary 按钮文字 / danger hover 文字 |
| 主按钮填充 | `var(--dsw-alias-button-info-fill)` | primary 按钮背景 |
| 主按钮 hover | `var(--dsw-alias-button-info-hover)` | primary 按钮 hover 背景 |
| 交互 hover 底色 | `var(--dsw-alias-interactive-bg-hover)` | tab hover / ghost 按钮 hover / 可点击行 hover / kindTag 背景 |
| 页面底色（最底层） | `var(--dsw-alias-bg-base)` | 限高滚动容器 / 冲突详情 / diff 容器背景 |
| 卡片表面 | `var(--dsw-alias-bg-layer-2)` | Card / 报告块 / 错误块背景 |
| 边框 L1 | `var(--dsw-alias-border-l1)` | Card 边框 / tab 下划线 / 表头分隔线 |
| 边框 L2 | `var(--dsw-alias-border-l2)` | 输入框 / ghost 按钮 / badge / 内嵌块边框 |
| 输入框背景 | `var(--dsw-specific-input-major)` | input / select 背景 |
| 业务主色（蓝系） | `var(--dsw-alias-state-business-primary)` | 激活 tab 下划线 / focus 边框 / 进度条 / info 徽章 / 链接色 |
| 成功 | `var(--dsw-alias-state-success-primary)` | ok 徽章 / 完成进度条 / 成功横幅 |
| 警告 | `var(--dsw-alias-state-warn-primary)` | warn 徽章 / 警告横幅 / 危险提示框 |
| 错误 | `var(--dsw-alias-state-error-primary)` | error 徽章 / 错误横幅 / danger 按钮 / formError |
| 中性信息 | `var(--dsw-alias-state-info-primary)` | 内部计数徽章（progressBadgeCount） |
| 正文字体 | `var(--dsw-font-family)` | section 容器 font-family |

### 2.2 Token 调制规则

需要「淡色底 / 高亮底」时，**只能**用 `color-mix()` 混合已有 token，禁止自造透明度色：

```css
/* 已有用法（照抄） */
background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);  /* 分区徽章淡底 */
background: color-mix(in srgb, var(--dsw-alias-state-info-primary) 14%, transparent);      /* 计数徽章淡底 */
background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);  /* 选中行淡底 */
```

### 2.3 语义映射速查（做状态先对号入座）

| 语义 | Badge kind | Banner data-kind | 边框/文字 |
|---|---|---|---|
| 成功 | `ok` | `ok` | `state-success-primary` |
| 业务信息 | `info` | `info` | `state-business-primary` |
| 警告 | `warn` | `warn` | `state-warn-primary` |
| 错误 / 危险 | `error` | `error` | `state-error-primary` |

Badge 的 `info` 特例：仅表达「中性状态计数 / 分类标签」（如 `3 sections`、插件版本）时用 `info` 但视觉上是中性描边徽章（§8.5）。

---

## 3. Typography

### 3.1 字体族

```css
/* 正文（继承自 .section） */
font-family: var(--dsw-font-family);

/* 等宽（代码 / 报告 / 错误 / 路径 / diff）——项目统一栈 */
font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
```

### 3.2 字号与字重表（唯一允许的 scale，禁止自造字号）

| 用途（样式类） | 字号 | 字重 | 备注 |
|---|---|---|---|
| 页面区块标题 `.sectionTitle` | 15px | 700 | 每个视图顶部主标题（`SectionTitle`） |
| 分组标签 `.groupLabel` / 冲突条目 `.conflictId` | 12.5px | 700 / 600 | 卡片内小标题 |
| 副标题 `.sectionSubtitle` / 模式提示 `.modeHint` | 12px | 400 | line-height 1.5 |
| 字段标签 `.fieldLabel` / 选项头 `.optionsHeader` | 12px | 600 | |
| 正文 / 按钮 primary / 输入 `.section .viewTab .input .groupLabel 等` | 13px | 400（按钮 600） | 页面默认字号 13px |
| 次级按钮 `.ghostButton` / `.modeTab` | 12px | 400（激活 600） | |
| 说明文字 `.hint` / 报告内 `.progressMeta` | 11.5px / 12px | 400 | line-height 1.5 |
| 徽章 `.badge` | 11px | 400 | line-height 1.6，`font-variant-numeric: tabular-nums`（计数徽章） |
| 极小编码 `.errorLine .severityError .pathIssueKind .kindTag` | 10.5–11px | 400 | 等宽或标签类 |
| 等宽报告 `.reportText .errorReason .errorLine .conflictDetail .diffScroll .pathValue` | 11–11.5px | 400 | line-height 1.6，`white-space: pre-wrap; word-break: break-all` |

**规则**：`mono` 只用于「代码/路径/diff/错误原文/报告正文」；正文文本不用等宽。标题层级：页面主标题 = `SectionTitle`（h3，15px/700）→ 卡片内分组标签（12.5px/700）→ 字段标签（12px/600）。**不再引入更粗/更大的标题层级**（页面标题本就由 DSH 设置 shell 提供）。

---

## 4. Spacing

### 4.1 间距速查（全部来自现有 CSS，禁止随意新值）

| 场景 | 值 | 类 |
|---|---|---|
| 页面视图内垂直间距（卡片之间） | **12px** | `.viewBody { gap: 12px }` |
| 页面视图内边距 | 4px 2px 16px | `.viewBody { padding }` |
| section 容器 gap（tab 栏与内容） | 10px | `.section { gap: 10px }` |
| 卡片内间距 | **10px**（gap）/ 12px（padding） | `.card { gap: 10px; padding: 12px }` |
| 向导卡片内间距（上传/更新表单，元素密集） | **14px**（gap） | `.wizardCard { gap: 14px }` |
| 向导卡片内字段（label↔控件↔hint） | **8px** | `.wizardCard .field { gap: 8px }` |
| 操作行按钮间距 | **10px** | `.actionRow { gap: 10px }` |
| 表单字段内（label↔控件↔hint） | **5px** | `.field { gap: 5px }` |
| 分组勾选项间距 | 6px | `.groupItems { gap: 6px }` |
| 按钮内图标/文字间距 | 6px | `.primaryButton/.ghostButton { gap: 6px }` |
| 状态行徽章间距 | 6px | `.statRow { gap: 6px }` |
| checkbox 标签间距 | 8px | `.checkboxRow { gap: 8px }` |
| tab 之间 | 2px | `.viewTabs/.modeTabs { gap: 2px }` |
| 输入框内边距 | 7px 10px | `.input` |
| 主按钮内边距 | 6px 14px | `.primaryButton` |
| 次按钮内边距 | 5px 12px | `.ghostButton/.dangerButton` |
| 徽章内边距 | 1px 8px | `.badge` |
| 双列密码输入 | `grid auto-fit minmax(180px, 1fr)` gap 10px/12px | `.secretFields` |

### 4.2 可归纳的 spacing scale（本项目实际使用的值集合）

`2 / 4 / 5 / 6 / 8 / 10 / 12 / 14 / 16 / 18`（px）。**新间距优先从该集合取**；需要更大间距时用现有的容器（Card / Banner 自带 padding），不要创造 20px+ 的裸间距。

---

## 5. Border & Radius

### 5.1 Border

- 宽度恒为 **1px**（全站无其他 border-width）。
- 颜色只允许两个 token：
  - `var(--dsw-alias-border-l1)` — 容器级：Card / tab 下划线 / 列表表头分隔线 / 冲突项
  - `var(--dsw-alias-border-l2)` — 控件与内嵌级：输入框 / select / ghost 按钮 / badge / banner / 报告块 / 错误行 / diff 容器
- 状态边框：`badge*` / `banner[data-kind]` / errorBanner / rollbackBox 用对应 `state-*-primary` 颜色描边替代 L1/L2。

### 5.2 Radius 速查（唯一允许的圆角值）

| 组件 | 圆角 |
|---|---|
| Button / Input / Select / Banner / 错误块 / 报告块 / 限高滚动容器 | **8px** |
| Card | **10px** |
| tab 顶部 | `6px 6px 0 0` |
| 内嵌小块（错误行 / 冲突详情 / kindTag） | **6px**（kindTag 为 4px） |
| Badge / 进度条轨道与填充 / severity 胶囊 | **999px**（全圆） |

---

## 6. Shadows

**本项目不使用任何 box-shadow。** 层级关系完全靠 `--dsw-alias-bg-layer-2`（卡片表面）、`--dsw-alias-bg-base`（更深的滚动容器）与边框 L1/L2 表达。

> 禁止引入阴影表达层级（含 hover 浮起）；层级一律用背景色 + 边框对比。

---

## 7. Layout

### 7.1 页面骨架（五视图共用）

```
css.section                    高 100%，纵向 flex，gap 10px
├── .sectionHeader             横向 flex（含 .viewTabs 角色=tablist）
│   └── .viewTabs / .viewTab   五 tab（导出/导入/快照/同步/市场），下划线激活态
└── .sectionBody               flex:1 + overflow-y:auto（滚动发生在 section 内部）
    └── .viewBody              纵向 flex，gap 12px，padding 4px 2px 16px（各视图内容）
```

- **Tab 激活态**：`data-active` + `border-bottom: 2px solid var(--dsw-alias-state-business-primary)` + 字重 600。
- **视图外滚动**：`sectionBody` 是唯一滚动容器；页面无需（也不应）设置 `height` 之外的滚动。

### 7.2 布局原语（组合一切视图的积木）

| 原语 | 类 | 说明 |
|---|---|---|
| 视图容器 | `.viewBody` | 所有视图的根 |
| 区块标题 | `.sectionTitleBlock`（`SectionTitle` 组件） | `title(15px/700) + subtitle(12px)` |
| 卡片 | `.card`（`Card` 组件） | 分组 / 选项 / 结果容器，bg-layer-2 + 10px 圆角 |
| 横向状态行 | `.statRow` | Badge 排布，gap 6px，flex-wrap |
| 操作行 | `.actionRow` | 按钮排布，gap 10px，flex-wrap |
| 链接行 | `.aboutLinkRow` | 外链排布，gap 10px，flex-wrap（贴近 `.actionRow`） |
| 作者行 | `.aboutAuthor` | 可点外链行：13px label-primary，hover 转 `interactive-bg-hover`，6px 圆角微底（图标/文字 gap 6px） |
| 分组勾选列表 | `.groupList > .groupCard > .groupItems` | 导出 Custom / 同步高级模式共用 |
| 动作标题 + 说明 | `.groupLabel` + `.hint` | 卡片内「小标题 + 说明」模式 |
| 限高滚动容器 | `.planScroll`(280px 固定) `.reportScroll`(220px) `.confirmScroll`(280px) `.pullScroll`(280px 固定) `.diffScroll`(240px) | 长列表/报告/diff，`overscroll-behavior: contain` |

### 7.3 表格类布局

- 真实 `<table>` **只在 SyncHistoryView 存在**（历史遗留，类名 `sync-history-table` 是字符串 class，非新规范）。
- 新列表一律用 **CSS Grid 行**（见 `.snapshotRowHeader/.snapshotRow`：`grid-template-columns: minmax(120px,1.2fr) minmax(140px,1.6fr) 90px 56px 56px`）或 **flex 行 + 徽章**。
- 快照列表行 = `<button>` 整行可点，选中态 `data-active`（business 色边框 + 10% 淡底）。

### 7.4 表单布局

- 单列表单：`Field`（label + 控件 + hint）纵向叠放，字段间 12px（viewBody gap）。
- 双列（仅密码确认）: `.secretFields` `grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))`。
- 路径映射：`.pathRow` 两列 grid `minmax(0,1fr) minmax(0,1fr)`（旧路径等宽只读 → 新路径输入框）。

---

## 8. Components（公共组件目录）

**所有共享原语在 `src/client/common/ui.tsx`，复合组件在 `src/client/common/`。已有组件能解决的问题，禁止重新创建（见 AGENTS.md §Reuse Before Creating）。**

### 8.1 Button（`Button`）
- Variant：`primary`（主操作，主按钮填充 bg）/ 默认 `ghost`（次操作，透明底 + L2 边框）/ `danger`（危险操作，error 色描边，hover 反色为 error 填充）。
- 禁用：`opacity 0.5`（primary）/ `0.45`（ghost、danger）+ `cursor: default`，**保留 hover 抑制**（`:hover:not(:disabled)`）。
- 用法：`<Button variant="primary" disabled={...} onClick={...}>{children}</Button>`；进行中在 children 里放 `<Spinner label={...}/>`；`title` 用于危险操作确认提示。
- 禁止：无 icon 图标库；不用 `variant="danger"` 表达成功；不用 primary 做次要操作；不以样式属性（style）改按钮外观。

### 8.2 Badge（`Badge`）
- Kind：`info`（业务主色描边）/ `ok`（成功）/ `warn`（警告）/ `error`（错误）；默认 `info`。
- 用途：状态标记、统计计数（`3 sections`、`plugins: 6✓/18✗`）、分区标签、来源徽章（见 §14）。
- 计数场景用 `progressBadge`（淡色底 + tabular-nums）而不是普通 badge。

### 8.3 Banner（`Banner`）
- Kind：`ok / error / info / warn`，`data-kind` 驱动描边色；默认 `info`（中性 L2 描边 + label-secondary 文字）。
- 用途：流程说明、安全提示（私有仓库强制提示、供应链警示用 warn）、结果横幅、需要重启提示。
- 禁止：Banner 内放按钮做主要操作（快照错误态中 Button 在 Banner 内部是既有例外）。

### 8.4 Card（`Card`）
- 容器：`bg-layer-2` + `border-l1` + `10px` 圆角 + `gap 10`、`padding 12`。
- 用法：分组勾选、安全选项、状态区块、结果/报告、confirm 会话。`className` 可叠加（`groupCard` 仅调 gap 8px）。

### 8.5 Spinner（`Spinner`）
- 11px 旋转环（business 色 + 透明上边框，800ms linear）+ 可选文字（12px，label-secondary）。
- 用法：按钮内进行中态、页面加载态。**不用于空态 / 完成态**。

### 8.6 Field（`Field`）
- 表单字段原语：`label`（12px/600）+ `children`（控件）+ 可选 `hint`（11.5px tertiary）。
- 横排（如「选择历史快照」）不用 Field，直接 `label` + 控件 inline。

### 8.7 SectionTitle（`SectionTitle`）
- 视图主标题：`title`（15px/700）+ 可选 `subtitle`（12px label-secondary，line-height 1.5）。
- 每个视图**顶部且仅一次**；卡片内小标题用 `.groupLabel`（span），不要再套 SectionTitle。

### 8.8 Checkbox / Empty
- `Checkbox`：选区行（原生 checkbox + 13px 标签）；分组勾选（导出 / 同步高级模式）与 confirm 阶段的选项勾选。
- `Empty`：空态占位（12.5px tertiary 居中，padding 22px 12px）。

### 8.9 复合组件（`src/client/common/`）

| 组件 | 职责 | 必用场景 |
|---|---|---|
| `ErrorBanner` | 可操作错误（标题/原因 pre/建议动作/相关项/重试按钮），渲染前强制 `redact()` | 任何错误展示入口 |
| `ErrorList` | 多行错误列表（等宽各行，`redact()` 后） | Wizard.errors 数组 |
| `ProgressBar` | 进度条（阶段文字 + 分区/计数徽章 + 当前项 + 百分比 + 轨道），换算在 `progress-view.ts` | 导出 / 导入 / 同步进行中 |
| `ReportView` | 结果报告（统计 Badge + 等宽 `<pre>` 报告 + 建议动作 + 回滚块） | export / import 结果页 |

### 8.10 表单控件（原生元素 + 统一类，无封装组件）

| 控件 | 类 | 规格 |
|---|---|---|
| 文本/密码输入 | `.input` | 7px 10px、13px、L2 边框、8px 圆角、`resize: vertical`、focus 边框 business 色、placeholder tertiary、禁用 opacity 0.55 |
| 下拉 | `.select` | 去原生外观 + 纯 CSS 双三角 chevron（`:dsw-alias-label-secondary` 渐变绘制）、与 input 同高同圆角；hover 边框转 L1、focus business |
| Radio | `.radioLabel` | 冲突决策「保留当前 / 使用备份」两项单选 |
| File | `.hiddenFile` | 隐藏原生 input，触发按钮为外层 Button |
| 密码二次确认 | `.secretFields` 双列 + `.formError` | 加密/密钥场景（导出、同步、解密） |

### 8.11 ConfirmDialog（确认弹窗，`src/client/common/ConfirmDialog.tsx`）

项目**首个 fixed / z-index 浮动层**（§15 Anti-pattern #7 的登记豁免，z-index 100）。危险/重要操作（删除等不可恢复）的二次确认，替代一次性内联确认。

- **API**（受控）：`{ open, title, message?, confirmLabel?, cancelLabel?, danger?, busy?, onConfirm, onCancel, children? }`；
- **关闭三途径**：遮罩点击（组件判定 `e.target === currentTarget`，卡片内点击不关闭）/ Esc 键 / 取消按钮；`busy` 时全部禁用；
- **busy 自管**：`onConfirm` 返回 Promise 时组件内部置 busy（防重复提交），完成后复位；`busy` prop 可外部强控；
- **焦点**：打开后焦点落**取消**按钮（危险确认不默认落破坏性按钮）；关闭后还原到打开前的触发元素；不做完整 focus trap（两按钮场景风险可接受，本小节即登记）；
- **样式**：仅 `dialogMask`（fixed 全屏 + `color-mix(bg-base 55%)` 遮罩）/ `dialogCard`（bg-layer-2 + border-l1 + radius10 + max-width 420 + 80vh 限高）/ `dialogHeader`（groupLabel 层级）/ `dialogBody`（240px 限高内滚，`white-space: pre-wrap`）；确认按钮复用现有 `Button variant="danger"|"primary"`，零新按钮类；
- **文案**：confirmLabel / cancelLabel / title / message 由调用方从 i18n 字典传入，组件不硬编码。

### 8.12 操作弹窗 + 免责弹窗（2026-08-21，`market/` 三处：上传 / 下载 / 装回本地）

在 ConfirmDialog（§8.11）基础上扩展的弹窗体系，共享同一 z-index 100 浮动层登记（§15 Anti-pattern #7）。

**交互约定（用户需求 2026-08-21）**：
- 上传 / 下载 / 装回本地三处操作**改为弹窗驱动**：点操作按钮 → 弹窗；弹窗前置**免责声明**；
- **免责弹窗** = 复用 `ConfirmDialog` + `children` 里放「不再提示」勾选框（`css.checkboxRow`）：点「我已了解，继续」才进入操作弹窗；
- **「不再提示」三操作分开记**（`market/disclaimer.ts` 纯函数层，localStorage key `dsh-cm-market.disclaimer.<key>`，`upload | download | install` 各自独立；读/写都 try/catch 静默降级——存储不可用时下次仍提示）；
- **操作弹窗**：手写遮罩容器（`dialogMask` + `dialogCard dialogWide` + 标题行 `dialogHeaderRow` + 关闭按钮 `dialogClose` × + 正文 `dialogBodyScroll`），**不套 ConfirmDialog**（操作弹窗有自己的按钮区）；
- 关闭弹窗 = 放弃本次操作（上传向导重置为初始态 / 装回本地清会话 / 下载详情清 detail）；关闭途径：遮罩点击（`e.target === currentTarget`）+ 关闭按钮 ×，`busy/importing/running/validating` 时禁用；
- 弹窗开关（`uploadOpen` / `downloadOpen` / `installOpen`）是**瞬态 UI**（组件内 useState，不持久化）；内容状态（detail / approvals / wizard / install）仍走 runStore 持久化切片（切 tab/刷新不丢数据，但弹窗不自动重开）。

**复用扩展（2026-08-21，`sync/` 同步通道配置弹窗）**：远程同步页的「同步通道」入口卡点按钮弹出通道配置弹窗（Git/WebDAV 子 tab + 表单 + GitHub device flow 登录块），复用本节的**操作弹窗样式四件套**（`dialogWide`/`dialogHeaderRow`/`dialogClose`/`dialogBodyScroll`），零新增样式；弹窗开关 `channelOpen` 同为瞬态 useState；关闭弹窗 = 放弃本次操作（GitHub 登录流程进行中 → 一并取消：停轮询 + 通知宿主丢弃设备码）；`savingConfig` 时禁用全部关闭途径。

**样式**：新增 `dialogWide`（宽 560px）/ `dialogHeaderRow`（标题 + 关闭按钮行）/ `dialogClose`（× 按钮，ghost 语义）/ `dialogBodyScroll`（70vh 限高内滚，替代 240px 短版）四类，全部走 `--dsw-*` token；无新颜色、无新动效。

---

## 9. Interaction States

| 状态 | 规则 |
|---|---|
| hover | 可交互行/ghost/tab：`--dsw-alias-interactive-bg-hover`；primary：`--dsw-alias-button-info-hover`；danger：error 填充反色；卡片/报告**无 hover 效果** |
| active | tab 激活：business 2px 下划线 + 600 字重；列表选中：business 边框 + 10% 淡底（`data-active`） |
| focus | 输入类控件：`border-color: var(--dsw-alias-state-business-primary)`；按钮无自定义 focus ring（跟随宿主/浏览器默认） |
| disabled | 按钮 0.45–0.5 opacity + `cursor: default` + 抑制 hover；输入 0.55 opacity；**进行中任务同时禁用关联操作按钮**（防重复启动 / 并发写入） |
| loading | `Spinner`（按钮内联或独立行）；进行中任务其余操作按钮禁用 |
| error | `ErrorBanner`（可操作）+ `formError`（行内校验）+ `banner[data-kind=error]`（简要） |
| empty | `Empty` 占位（列表无数据、无冲突、无快照等），**不渲染空表头/空表格** |

`data-active` 是项目统一的「选中/激活」标记属性（tab、快照行、表单模式），CSS 一律用 `[data-active]` 选择器命中。

---

## 10. Responsive Design

- **Breakpoints：本插件不定义任何媒体查询**——DSH 设置 shell 决定可用宽度；本插件只在内容层响应。
- 响应机制：
  - 横向排布一律 `flex-wrap: wrap`（`.statRow` / `.actionRow` / `.groupHeader` / `.conflictHead` / `.conflictOptions`）；
  - 双列输入用 `repeat(auto-fit, minmax(180px, 1fr))`（窄到 180px 以下自动单列）；
  - 快照 Grid 行用 `minmax()` 分栏，超窄时各列可压缩，长文本 `ellipsis` 截断。
- **禁止**：手写固定像素宽度撑破容器、水平滚动（另有 `overflow-x` 需求必须走限高滚动容器规范）、在小屏隐藏核心功能（无 Mobile 专用分支）。

---

## 11. Icons

- **无图标库，禁止引入。** 现状表达方式：
  - 文本符号：`✓` / `✗` / `≈`（统计徽章）、`→`（错误建议动作前缀）、`·`（分隔）
  - Emoji：`🔒`（加密备份徽章）
  - 纯 CSS 图形：`select` 的 chevron（渐变两三角）
- 图标与文字间距：按钮内 6px（`gap`）；徽章内无需图标（用文字/符号即可）。
- 新图标需求：优先文本符号/emoji；确需图形时先在 `DESIGN.md` 记录方案（引入 SVG 内联或 CSS 图形），**不得直接安装 icon 包**。

---

## 12. Motion

只存在三类动效，**禁止新增无意义动画**：

| 动效 | 参数 | 用于 |
|---|---|---|
| Spinner 旋转 | `dshCmSpin` 800ms linear infinite（rotate 360°） | 加载 / 进行中 |
| 进度条不定态 | `dshCmIndeterminate` 1s ease-in-out infinite（40% 宽左右滑动） | 无百分比进度 |
| 进度条宽度 | `transition: width 120ms linear` | 有百分比进度推进 |

- 无 hover 过渡、无弹窗动画、无路由过渡（无路由）、无 skeleton 动画。
- 页面出现 / tab 切换**无动画**（瞬时切换）。

---

## 13. Forms

统一表单规范（导出安全选项、同步配置、导入各阶段共用）：

- **Label**：`fieldLabel`（12px/600，label-secondary）；用 `<label>` 包裹或关联。
- **Required**：文案层面表达（如「（必需）/（可选）」后缀），没有统一的 `*` 标记规范 —— 加密密码必填由 `formError`（`passwordRequired`）提示。
- **Placeholder**：tertiary 色；placeholder 即提示（路径映射的 `mappedTo`、仓库地址示例）。
- **Helper Text**：`hint`（11.5px，tertiary，line-height 1.5）——控件下方。
- **Error**：`formError`（12px，error 色）行内紧贴对应字段；跨字段整体错误用 `ErrorBanner`。
- **输入高度**：约 32px（7px 上下 padding + 13px 行高）——输入框 / select 一致。
- **Field Gap**：视图内 12px；字段内部（label/控件/hint）5px。
- **Validation**：提交前在组件内判定（`passwordInvalid`、`encryptInvalid`、`summary.adopted === 0` 禁用按钮）；服务端/控制器错误经 `ErrorBanner`。
- **Disabled**：输入 0.55 opacity；进行中（busy/running）时整组表单控件禁用。
- **Readonly**：只读路径显示为等宽 `<pre>`（`.pathValue`），不提供只读 input。
- **密码控件约定**：`type="password"` + `autoComplete="off"`（敏感）或 `"new-password"`（新密码）；密码值**仅内存**，成功后清空，绝不回显/持久化（见 AGENTS.md 安全不变量）。

---

## 14. Common UI Patterns（复用这些模式，不要另起炉灶）

| Pattern | 结构 | 现例 |
|---|---|---|
| **模式切换（Quick/Custom）** | `modeTabs` 双 tab + `modeHint` 说明 | 导出视图、同步模式、市场面板（浏览市场 / 我的配置） |
| **GitHub 登录卡（device flow）** | `Card` + `actionRow`（「使用 GitHub 登录」primary 按钮 + 取消）+ 一次性用户码 Badge + 「打开授权页」外链 + 轮询状态 Badge + 错误 Banner；token 只存宿主凭据槽，界面只展示用户码与登录名 | 远程同步视图（GitHub 登录）、「我的配置」登录卡 |
| **通道子 tab 面板（GitHub/WebDAV）** | `modeTabs` 双 tab + `modeHint` 说明；各 tab 内配置表单 / 自动同步 / 同步模式 / 加密 / 远端快照**按通道独立**，切换 tab 互不覆盖（busy 时禁用切换） | 远程同步视图（同步面板二级 tab） |
| **分组勾选目录** | `groupList > groupCard(groupHeader: groupLabel+groupNote) > groupItems(Checkbox 行: categoryName+categoryDesc+Badge)` | 导出 Custom、同步高级模式 |
| **安全选项卡** | Card + `optionsHeader` + Checkbox + hint + 条件渲染密码双列 + formError | 导出、同步加密 |
| **步骤化向导** | 顶部为阶段渲染（`SectionTitle` 标题 + 内容 + `actionRow` 内「上一步/下一步」），进度条独立 | 导入九步向导、发布向导（5 步） |
| **统计徽章行** | `statRow` 一组语义化 Badge + 条件 `warn` Banner | 兼容性页、预览页、报告页 |
| **来源徽章** | 条目卡片首徽章表达供应链来源：`sourceBadgeKind(item, builtinUrl)` 纯函数判定 —— 无 `repo`（与市场同仓）或 `repo` 为官方默认地址 → `Badge kind="ok"`「官方来源」；`repo` 为第三方仓库 → `kind="warn"`「第三方来源」；文案走 locale 字典（`list.sourceOfficial` / `list.sourceThirdParty`） | 市场面板条目行 |
| **复制文本块** | 等宽 `<pre class="reportText">` + `actionRow` 内复制按钮（`navigator.clipboard`，成功/失败 Badge 反馈），用于向用户交付「复制到外部执行」的文本产物（git 命令模板、JSON 片段）；文本渲染前过 `redact()` | 发布向导（推送命令 / index.json 收录片段） |
| **限高列表 + 批量操作** | `confirmScroll/reportScroll` + 底部 actionRow（批量决策按钮） | 冲突决策、差异确认、恢复计划、拉取预览 |
| **diff 展开** | `<details><summary>diff</summary><pre class="diffScroll">` | 同步冲突 diff |
| **结果页** | `ReportView`（统计 + 等宽报告）+ 条件 Banner（needsRestart）+ 动作按钮 | 导入结果、导出完成 |
| **错误恢复** | `ErrorBanner(error, onRetry)`（可重试）+ 禁用重复启动 | 全站 |
| **列表+详情** | 列表（可搜索/过滤）+ 点条目展开详情卡 | 市场面板（搜索框 + 类别 select + 条目行 + 详情） |
| **dry-run → confirm → 执行** | 零写入预览 → 危险按钮（title 确认）→ 诚实报告 | 快照恢复、市场导入、一键同步 |
| **关于页** | `viewBody` 卡片流：`SectionTitle` + 信息卡（`statRow` 动态版本/DSH/平台 Badge：官方→`ok`、版本→`info`）+ 链接卡（`actionRow` 内 Star 主按钮 + `aboutLinkRow` 外链行 + `aboutAuthor` 作者外链） | 关于 tab |
| **确认弹窗 ConfirmDialog（危险/重要操作）** | `common/ConfirmDialog.tsx` 受控弹窗：`{ open, title, message?, confirmLabel?, cancelLabel?, danger?, busy?, onConfirm, onCancel, children? }`；遮罩点击（target===currentTarget）/ Esc / 取消三途径关闭（busy 时全禁用）；onConfirm 返回 Promise 时组件自管 busy 防重复提交；初始焦点落取消按钮（危险确认不默认落破坏性按钮）、关闭还原触发按钮；样式仅 dialogMask/dialogCard/dialogHeader/dialogBody 四类（遮罩 color-mix 半透明、卡片 bg-layer-2+border-l1+radius10、正文限高 240px 内滚）；确认按钮复用现有 danger/primary Button | 「我的配置」列表删除条目（不可恢复 + 已收录自动提交下架 PR）；快照恢复确认（可升级） |

---

## 15. Anti-patterns（明令禁止）

1. **禁止 hardcode 颜色**（`#xxx` / `rgb()` / `rgba()`），含 inline style 里的颜色值（MarketPanel 中 `style={{color: 'var(...)'}}` 是引用 token 的例外写法——颜色值本身仍必须是 token）。
2. **禁止新增样式文件**：样式只能进 `src/client/config-manager.module.css`；禁止内联 `<style>`、禁止第三方 CSS 文件、禁止非 `.module.css` 样式资源（tsdown 构建链不处理）。
3. **禁止字符串 className**（`className="foo"`）；一律 `css.xxx`。字符串类（如 `sync-history-table`）是遗留，新代码不得效仿。
4. **禁止自造字号/间距/圆角/阴影**：必须落在 §3.2 / §4.2 / §5 的 scale 内。
5. **禁止绕过公共组件**：能复用 `ui.tsx` 原语时手写 `<button>`/`<span>` 样式等同违规；新需求先检查 `common/` 与 COMPONENTS、再 Extend、最后才 Create（并回写本文件）。
6. **禁止引入第二套视觉体系**：Tailwind / CSS-in-JS / Sass / styled-components / UI 组件库 / 图标库 / 动画库，一概不引入。
7. **禁止随意增加 z-index / fixed 定位**：本项目长期无 z-index / fixed 元素；**唯一登记豁免** = 弹窗体系（§8.11 ConfirmDialog + §8.12 操作弹窗/免责弹窗，z-index 100，共享同一浮动层登记）。任何新的浮动层需求（提示浮层等）必须先设计好再进 DESIGN.md 并登记 z-index，禁止私自增加。
8. **禁止给所有按钮加 primary、禁止用 danger 表达非危险操作**。
9. **禁止硬编码用户可见文案**（走 locale 字典 / `UiT`）；**禁止在 UI 展示未 `redact()` 的原始错误文本**。
10. **禁止把长列表/报告直接平铺撑长页面**——必须限高内滚（§7.2）。
11. **禁止在 React 组件中直接 `fetch`** 或实现可测试业务逻辑（走 `src/ui/` + api 类）。
12. **禁止为单个页面创建一次性视觉规则**而不回写 DESIGN.md（见 §17）。

---

## 16. 暗色模式

- 本项目**没有独立暗色样式**——暗/亮/皮肤完全由 DSH 主题决定，通过 `--dsw-*` token 自动生效。
- 保证暗色正确的唯一方法：**所有颜色引用 token**、tint 用 `color-mix()`；任何硬编码颜色都会在暗色下违和（这也是 Anti-pattern #1 的根本原因）。
- 修改样式后的自查：在 DSH GUI 切换暗色/亮色确认对比度与层级依然成立。

---

## 17. 新增 Style / Component / Pattern 的流程（写入本文件的强制规则）

> 新的 UI Pattern 一旦被引入项目，就必须被文档化。

1. 检查现有代码是否已有类似 Pattern（§8 / §14 + 代码搜索）。
2. 检查现有 Component 可否扩展（如给 `ui.tsx` 增加原语、给类加 modifier）。
3. 检查现有 Token 可否组合实现（§2.1 + `color-mix`）。
4. 确实不存在时：**基于本文件现有设计语言**设计新规范（沿用 token / 字号 / 间距 / 圆角 / 组件模式）。
5. **同步更新本文件**（新增条目到 Components / Common UI Patterns / Typography 等对应章节）。
6. 然后在代码中实现。

**Never introduce a new visual pattern without documenting it in DESIGN.md.**

---

## 18. 维护约定

- 本文件随项目一起演进：新 Design Pattern / 新 Shared Component / Token 修改都必须同步本文件（与 AGENTS.md §Documentation Maintenance 联动）。
- 文档与代码冲突时：**以实际代码为准修改本文件**（代码是 Ground Truth）。
- 本文件按「从代码提取、可对照代码验证」的原则编写——每个数值/规则都能在被引用的类/组件中直接找到出处。