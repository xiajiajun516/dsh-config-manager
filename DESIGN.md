# 🎨 DESIGN.md — DSH Config Manager 视觉设计规范（Workbench Design System）

> **本文件是项目 UI / UX / Visual Style 的 Single Source of Truth。**
> 2026-09 Full UI Rebuild 重写。任何开发者或 AI Agent 在创建、修改前端界面前必读；
> 若本文件与代码冲突，以代码为准并更新本文件。

---

## 0. 定位：DSH 设置弹窗内的「内嵌工作台」

本项目 UI 挂在 DSH GUI 的 **`settings.section`**（「备份与迁移」）内。宿主约束（不可更改）：

- **画布固定 ≈ 564 × 720px**：设置弹窗 800×800（`width:800px; max-width:calc(100vw-48px)`），
  减去宿主导航 188px 与页边距后，插件内容区约 564px 宽、720px 高。
- 不拥有全局外壳/主题/字体栈：颜色字体全部消费 `--dsw-*` token（亮/暗主题与皮肤自适应）。
- 设计语言：**高密度开发者工具**（参考 Linear / Raycast / VS Code settings 的信息密度）。
  禁止：营销文案腔、大卡片堆砌、大留白、装饰性图标、纯填充用的零值 KPI 卡。

**Canvas 纪律**：任何页面都必须消灭「底部空洞」——内容不足时用真实数据块
（备份位置 / 分区构成 / 活动视口）填充，或让最后一个数据块成为内部滚动视口
（`.fillCard` / `.fillViewport`），禁止出现无意义的纯背景色区域。

---

## 1. IA（信息架构）

Shell（`ConfigManagerSection`）：导航条 + 页面内容 + 状态栏 + 活动抽屉。

- **一级导航（7 页签）**：总览 / 备份 / 导出 / 导入 / 同步 / 市场 / 档案。
  export/import 为一级页面；旧「更多」面板由「活动与关于」抽屉取代
  （run-store `parsePersistedState` 迁移旧值，`moreSub` 保留）。
- **活动抽屉**：右侧 400px 滑出，含 活动记录 / 关于 两个子视图（Segmented 切换）。
- **状态栏（28px 圆角条）**：状态点 + 就绪/进行中/恢复待处理 + 插件与 DSH 版本；
  与顶部页签条同款「圆角分段条」外观（四周留白 8px，不再通栏贴底）。
- 页内子视图切换一律用 `Segmented`（如备份页：安全快照 / 备份文件 / 定时备份 / 事故恢复）。

---

## 2. Design Principles

| 原则 | 含义 |
|---|---|
| **Token 驱动，零硬编码** | 颜色/字体/阴影全部 `--dsw-*`；tint 用 `color-mix(in srgb, <token> <pct>, transparent)` |
| **薄壳渲染，逻辑下沉** | React 只装配；渲染模型/状态判定在 `src/ui/` 纯函数（node 单测） |
| **密度优先** | 基准字号 12.5px；行高 1.5；卡片 padding 12px；页面 padding 16px；区块间距 10px |
| **状态即语义** | ok/info/warn/error 四态贯穿 Badge/Banner/StatusDot/choiceCard |
| **危险操作隔离** | 删除/恢复恒 `danger` 变体或 `data-danger` 图标 + ConfirmDialog 二次确认；行内用 `.rowDivider` 与安全操作分隔 |
| **开发者排版** | 路径/文件名/时间戳/命令一律等宽栈（`.mono`）；长文件名**中段省略**（保留尾部时间戳）+ `title` 全文 |
| **无障碍** | 所有交互元素 `:focus-visible` 双环；图标按钮必须 `aria-label`；表格行选择支持 Enter/Space |

---

## 3. Colors（DSH Design System Token）

| 语义角色 | Token |
|---|---|
| 主要/次级/弱化文字 | `--dsw-alias-label-primary / secondary / tertiary` |
| 主按钮填充 / hover | `--dsw-alias-button-info-fill / -hover` |
| 交互 hover 底色 | `--dsw-alias-interactive-bg-hover` |
| 页面底色 / 卡片表面 | `--dsw-alias-bg-base / bg-layer-2` |
| 边框 L1 / L2 | `--dsw-alias-border-l1 / -l2` |
| 输入框背景 | `--dsw-specific-input-major` |
| 业务主色 / 成功 / 警告 / 错误 / 中性 | `--dsw-alias-state-business-primary / success / warn / error / info` |
| 正文字体 | `--dsw-font-family`；等宽栈 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |

语义映射：成功=ok、业务信息=info、警告=warn、错误/危险=error（Badge/Banner/kindTag 一一对应）。

---

## 4. Typography（唯一允许的 scale）

| 用途 | 字号 | 字重 |
|---|---|---|
| 页面区块标题 `.sectionTitle` | 13px | 700 |
| 卡片头分组标签 `.groupLabel` | 11px | 700 |
| 正文/按钮/输入 | 12.5px | 400（按钮 600） |
| 表格正文 `.dataTable` | 12px | 400 |
| 元数据/说明 `.hint/.cellMeta` | 11–11.5px | 400 |
| 状态栏/徽章 | 11px / 10.5px | 400 / 600 |
| 等宽值 `.mono` | 11–11.5px | 400 |

- 数字一律 `font-variant-numeric: tabular-nums`（`.section` 全局启用）。
- 中文文案统一全角标点；插入语遵循 `line-break: strict`（`.quickActionHint` 等）。
- 禁止营销语气（「更省心」类）；状态描述使用名词在前（「定时备份 已开启」）。

---

## 5. Spacing & Shape

- 间距网格：4 / 8 / 10 / 12 / 16；区块间距统一 10px。
- 圆角：卡片 8px、控件（按钮/输入/选择）6px、分段容器 7px、徽章 9px、小标签 4px；
  顶部页签条 / 底部状态栏为 8px 圆角分段条（条内 .navTab 6px 药丸），
  激活态 = 主色 16% 淡底 + 45% 主色内描边（`.navStrip` / `.statusBar` 同款语言）。
- 控件高度：按钮 28px（sm 24）、输入/选择 28px、表格行 ~32px、活动行 28px、
  顶部页签条 32px（条内页签 24px）、状态条 32px、状态栏 28px、图标按钮 26px。
- 动效：仅颜色过渡 120ms ease、进度条 300ms、抽屉滑入 180ms、状态点脉冲 1.2s。

---

## 6. Components（config-manager.module.css 类）

### Primitives（common/ui.tsx）
- `Button`（primary/ghost/danger × sm/md；`href` 外链同款外观）
- `IconButton`（`.iconBtn`；`active`/`danger` 修饰；必须 `aria-label`）
- `StatusDot`（idle/ok/info/warn/error + `pulse`）
- `Badge`（info=中性描边 / ok / warn / error）
- `Banner`（四态；操作按钮一律**内嵌右侧**）
- `Segmented`（页内子视图切换；受控）
- `Card` / `Spinner` / `Field` / `SectionTitle` / `Empty` / `Checkbox` / `Stepper`

### 第三方原语（2026-09 Visual Polish 引入，按 `DEVELOPERS.md` 「第三方 UI 库准入」评估落地）
仅引入**无样式/行为级**原语，视觉仍 100% 走 `--dsw-*` token + 本文件规范，不引入第二套视觉体系：
- **图标 = lucide-react**（`common/Icon.tsx`）：取代散落文本符号图标（跨平台字形/基线漂移）。
  统一尺寸（默认 14px）/ 描边（1.75）/ `currentColor` 继承父级语义色。
  **体积纪律**：从各图标独立模块路径 `lucide-react/dist/esm/icons/<name>.mjs` 导入
  （非桶导出），保证 rolldown 在 cjs 单文件打包下精确 tree-shake（~18 图标仅 +12KB raw）；
  深路径无类型，由 `src/client/lucide-icons.d.ts` 全局 ambient 声明兜底
  （该文件刻意不含顶层 import，保持全局脚本态，否则 `declare module` 退化为 augmentation 而部分失效）。
  新增图标须同步登记 `Icon.tsx` 映射表 + `lucide-icons.d.ts`。
- **弹窗 = @radix-ui/react-dialog**（`common/Modal.tsx`）：统一原先两套弹窗
  （ConfirmDialog 手写 focus trap + 各页内联 `dialogMask` 无 trap）为一套，获得成熟
  focus trap / Esc / 初始焦点与关闭后焦点还原 / body 滚动锁 / Portal 渲染。
  `Modal`（容器，`open/onClose/title/wide/busy/cardStyle/onOpenAutoFocus`）+
  `Modal.Header`（标题行 + 可选关闭按钮 + trailing）/ `Modal.Body`（`scroll/innerRef/onScroll/style`）/
  `Modal.Footer`。Radix Content 用 `.dialogContentCenter` 自居中（Portal 下与 Overlay 平级）；
  旧 `.dialogMask/.dialogCard` 类保留供未迁移弹窗兼容。busy 时守卫 `onOpenChange` +
  `onEscapeKeyDown/onPointerDownOutside/onInteractOutside` 双保险禁闭。
  **已迁移（全部弹窗）**：ConfirmDialog、Profiles 切换预览、Market 条目详情、MyConfigs 上传向导 + 装回本地、
  Snapshots 恢复计划预览 + 备份查看、ReleaseNotes、**SyncSettingsView 全部 5 个弹窗**（通道配置 / 推送预览 /
  推送结果 / 拉取差异 / 一键同步确认 —— 实测为同级独立弹窗而非嵌套，逐个迁为 `<Modal>`，自定义宽度走
  `cardStyle`、限高走 `Modal.Body style`；通道配置弹窗的刷新快照按钮 `🔄` 亦改 Lucide `RefreshIcon`）。
  迁移后全仓再无手写 `dialogMask+dialogCard` 弹窗（`grep css.dialogMask` 仅余注释）。
- **构建接线**：`tsdown.config.ts` 的 `deps.alwaysBundle: [/^lucide-react(\/.*)?$/, /^@radix-ui\//]`
  强制把二者打进单文件 cjs（否则被当 dependencies 外部化 → 运行时 `require` 命中 DSH loader
  「module table miss」崩溃）。注意 tsdown 0.22 读 `deps.alwaysBundle`，旧的顶层 `noExternal`
  从 config 根读取、放在 `deps` 内会被静默忽略。bundle 增量约 +136KB raw / +30KB gzip。
- **依赖归类**：二者已被内联进 `lib/client.js`，因此是**构建期依赖** → 放 `devDependencies`
  （放 `dependencies` 会迫使只想复用引擎的 headless 消费者安装整套 React UI 栈）。
  这条不变量由 `src/client/bundle-selfcontained.test.ts` 钉死（build 后跑）；消费方式见
  `docs/spec/headless-consumption.md`。

### 数据展示
- **数据表**：`.tableWrap > .tableScroll > .dataTable`；变体 `.tableFixed`（固定布局 +
  th 显式宽度 + 内容 ellipsis）、`.tableCompact`（padding 8px）。行 hover 高亮、
  `data-selected` 选中淡底、数字列 `.num` 右对齐等宽、次级列 `.dim`。
  - **操作列**（`.cellActions`）：`overflow: visible; text-overflow: clip` 覆盖 `.tableFixed`
    给所有单元格加的省略号 —— 该列是按钮组，列宽略紧时浏览器会在按钮后补一个「…」
    （备份页两张表都出现过）。宁可略微溢出也不截断；并给 `.tableFixed` 单元格左右各留 12px。
- **状态条**（Overview）：`.statStrip`（健康点 + 可点指标段，名词在前值加粗）。
- **事实网格**：`.factGrid/.factCell/.factLabel/.factValue`（四列 label/value）。
- **键值行** `.kvRow`、**分区构成** `.sectionGrid/.sectionRow`（共享组件
  `common/SectionComposition.tsx`，总览卡的「分区构成」与**导出页的「本次将导出」数据块**共用；
  列用 `repeat(auto-fit, minmax(210px, 1fr))` 以便窄容器自动退化为单列）。
  组件带可选 `sectionLabel`（`SectionId → 文案`）：**用户可见场合一律传
  `sectionLabeler(t)`**（见 §7「分区显示名」），只有给开发者看的场合才允许省略。
  （旧文档里的「导出预览弹窗」已不存在，导出侧改由内容选择器 + 页内合计块承担。）
- **导出报告的分区清单**（2026-09 优化）：`.reportBody`（padding 8/12 + 纵向 flex，块间距
  由子块 `.groupLabel` 的 8px 下边距承担）+ 共享的 `.sectionGrid/.sectionRow`。
  **不再把 `renderExportReport` 的整块等宽文本直接铺在面板里** —— 那段文本的分区名是适配器 id、
  计数单位是英文键（namespaces/patchLines），与界面上别处的中文分区名自相矛盾。现在：
  分区名走 `sectionLabel`（`sectionLabeler(t)`），计数单位走 `report.unit.*` 字典
  （`exportCountsText`，未知键原样回退）。首行状态「备份已创建」用 `.reportHeadline` 保留
  （比区块标题高一级；结构化不能凭空丢掉这条状态）。`renderExportReport` 保留给非 UI 场合
  （文本报告 / `run-store` 记录），两者不是替代关系。
- **报告 / 错误文本块**（`ReportView`/`ErrorBanner`/`ErrorList`）：纯文本用 `<pre>` 呈现时
  **必须**同时给 `white-space: pre-wrap` + `overflow-wrap: anywhere`，并置于
  `.reportScroll`（限高 380px，与 `planScroll` 同规则）之内；报告卡内的该容器由
  `.reportView .reportScroll` 去掉自带描边/圆角/底色（否则与卡片边框贴合成双线）。`<pre>` 的 UA 默认
  `white-space: pre` 会让长行（导入失败原因 / 回滚项 / 警告文本）横向溢出，再被卡片
  `overflow: hidden` 直接裁掉 —— 用户既看不到内容也滚不过去；且 `.errorLine` 上只写
  `overflow-wrap` 落在 `<pre>` 上是**无效声明**（换行未获允许）。
  同类已修点：`.cliCommand`（导入日志里的命令行，F-05）与 `SyncConfirmView` 的变更明细
  （原 `<pre className={css.conflictDetail}>`，现为普通块元素）。`.diffScroll` 例外 ——
  它是 diff 视图、容器自带横向滚动（内容不会被裁），保留 `<pre>` 对齐语义。
- **内容选择器**（ContentPicker，2026-09 Phase 1 条目级导出选择）：共享组件
  `common/ContentPicker.tsx` + 纯逻辑 `src/ui/selection-model.ts`（**全部选择语义在后者**，
  React 侧只装配，node 可测）。
  - 结构：`.pickerRoot`（纵向 flex）→ `.pickerToolbar`（搜索 + 全选/全不选）→
    `.pickerList`（**限高内滚**，与 `planScroll/reportScroll` 同规则，禁止把弹窗撑长）→
    `.pickerFooter`（实时合计）。类清单（全部登记于此，勿在别处另起）：
    `.pickerRoot / .pickerToolbar / .pickerList / .pickerGroup / .pickerRow / .pickerTreeRow /
    .pickerUnit / .pickerUnitName / .pickerUnitDetail / .pickerCount / .pickerMore / .pickerFooter /
    .pickerOverlay / .pickerChevronSpacer / .pickerSubgroup / .pickerSubgroupName / .pickerUnitNested`。
    其中 `.pickerTreeRow` = 级联树行（左侧固定宽度 chevron + 可伸缩勾选框；与 `.pickerRow` 的唯一区别
    是首子节点不可伸缩），`.pickerChevronSpacer` = 无子节点行/子单元行用来对齐树左缘的等宽占位。
    其中 `.pickerOverlay` = 大分区清单读取中的半透明遮罩 + 加载动画（列表仍可见但不可点，
    避免「读 sessions 很久」被当成卡死）；`.pickerUnitDetail` = 单元副标题
    （`max-width: 220px` + 省略号，与 `.pickerUnitName` 的 280px 分工：副标题更弱、更短）；
    `.pickerCount` = 「已选 n/m」「N 个文件」这类计数（`font-variant-numeric: tabular-nums`）。
  - 两级树：`.pickerTreeRow`（分区行；三态用「部分」徽章 + `已选 n/m` 表达 ——
    `Checkbox` 只支持二态，**不为三态改造共享原语**）；`.pickerUnit`（单元行，左缩进 18px 表示从属）。
  - **捆绑（lockedWith）**：必须与同组条目同进同出的项显示 `捆绑` 徽章（warn）+ tooltip
    （如 pnpm-workspace ↔ patch 文件，见 issue #35 与 `src/adapters/units.ts`）。
  - **不可细分分区**（`units: []`）不渲染展开按钮，自然退化为整体开关 —— 不写第二套分支。
  - **分区行三态（UI-07）**：`读取中…`（在途）/ `读取失败 · 将整体导出`（该分区清单没拿到，
    引擎按整体导出处理）/ `已选 n/m`。**没读到清单时绝不显示 0/0** —— 那会被读成「这一项没有内容」。
    失败分区逐分区记账（`failedSections: SectionId[]`，不是一个数字），顶部复用
    `picker.unitsUnavailable` 提示；`failedSections` 缺省为空数组。判定**不写在 React 壳里**：宿主
    `/export-preview` 除既有 `sectionsFailed`（计数，必填）外还回精确 id 列表 `failedSections?: SectionId[]`
    （可选字段，旧宿主缺失即回退）；客户端由 API 层 `resolveFailedSections(requested, response)`
    （`src/client/api.ts`，node 可测）把「宿主点名」与「请求了但没回来」的推断取并集（推断复用
    `src/ui/export-flow.ts` 的 `failedSectionsFromResponse`），保持 `requested` 顺序并忽略本次请求之外的 id。
  - **设备相关 / 敏感徽章（UI-09）**：`SelectionSection.portability === 'deviceSpecific'` 渲染
    `设备相关` 徽章、`sensitive === true` 渲染 `敏感` 徽章（均 `Badge kind="warn"`）。
    勾选含设备相关分区时，调用方在页内与弹窗内就地渲染 `export.selectionWarnings` 提示
    （**非阻断**）：一键「全选」不得静默把 sessions / pluginFiles / credentialsStatus 勾上。
    portability 来自调用方的分类目录（导出侧 `ExportFlow.categories`）；来源未知时留空 = 不猜、不渲染徽章。
  - **大列表实测（2026-09，真实会话库）**：sessions 为 **631 个单元 / 369.6 MB**，
    整列表在 `.pickerList` 内滚动渲染正常（弹窗不撑长）。
  - **渐进披露（UI-15；2026-09 按用户反馈调整上限）**：`.pickerMore`（居中，「显示全部（共 N 条）」
    按钮，`picker.showAll`）仍在，但 `UNIT_RENDER_LIMIT` 由 **100 提到 1000** —— 真实会话库是
    660 个单元，100 的上限让用户展开后只看到前 100 条，被读成「只有这些 / 只选了这些」，
    必须再点一次才敢确认（用户实测反馈）。现在真实规模**展开即全量**，折叠只在异常大的分区上兜底。
    纯前端方案，**不引入第三方虚拟列表**（AGENTS.md 默认禁止新增第三方 UI 库）；判定下沉为纯函数
    `visibleUnits(units, showAll, limit)`（`src/ui/selection-model.ts`，node 可测）。
    单元数**上万**时再谈虚拟化（届时按 `DEVELOPERS.md` 的「第三方 UI 库准入」7 步流程评估）。
  - **二级分组 + 级联树（2026-09，两轮用户要求：先「按工作区分类」、再「级联展开 + 展开控件放左边」）**：
    `.pickerSubgroup` = 分组标题行（左缩进 18px；标题 `.pickerSubgroupName` 11.5px/600/secondary，
    同行带组内 `已选 n/m` 与「部分」徽章，整组可一键勾选/取消）+ `.pickerUnitNested` = 组内单元
    （勾选框与父分组勾选框同一左缘，标签与父标签对齐 —— 树形层级靠 chevron 与标签缩进表达）。
    **展开控件是左侧的 chevron 图标**（`.iconBtn[data-size="sm"]` 18px + `Icon` 的
    `chevronRight`/`chevronDown`，14px）：右对齐的文字按钮已全部取消（用户明确要求），
    `aria-expanded` / `aria-controls` / `aria-label` / `title` 一个不少（图标按钮必须有可访问名）。
    **级联语义（默认全部折叠）**：展开分区只列出工作区分组；点某个分组的 chevron **只展开这一棵子树**，
    不会一次铺开全部分组。折叠**只影响渲染**：收起的工作区里已勾选的会话保持勾选，
    分组行的勾选框在折叠状态下照常可整组选/取消（不必先展开）。
    约束与语义：① 分组名（工作区标题）与单元名同为**宿主直出字符串**，渲染前必须过 `redact()`；
    ② 分组**只影响展示**，勾选/导出契约仍只认单元 id，`ExportUnit.group` 缺省 = 平铺（skills /
    pluginFiles / self 等分区的渲染零变化）；③ 点一个分组 = **只勾这一组** —— 稀疏表示下
    `toggleUnitGroup` 必须在分区未勾选时把其余单元**显式排除**，否则「勾一个工作区」会静默变成
    「该分区全选」（`src/ui/selection-model.test.ts` 有专门回归）。
  - **单元行排版（UI-16）**：`.pickerUnitName` = 中段省略 + `title` 全文（`tailWeightedEllipsis(label, 44)`，
    保留尾部时间戳/版本等区分信息，见 §9 anti-pattern 5）+ `min-width:0 / max-width:280px /
    text-overflow: ellipsis` 兜底 —— 长路径/长会话标题不得撑宽列表产生横向滚动条。
    `.pickerUnitName` 的完整值进 `title`（值是脱敏后的）；`.pickerUnitDetail`（副标题）**只做 CSS 省略、不进 `title`**
    —— 两者分工不同，不要按「都进 title」理解。
  - **无障碍（UI-22）**：展开/收起是原生 `<button>`（复用 `.ghostButton[data-size="sm"]` 样式，
    共享 `Button` 原语不透传额外属性），带 `aria-expanded={open}` + `aria-controls`（指向单元列表容器
    `picker-units-<section>`）。
  - 与 **分区构成** 的分工：那个只读展示、这个可勾选，**禁止合并**。
  - **公告位恒定高度（2026-09，用户实测抖动后确立）**：提示类 Banner **不得**以「条件渲染」的方式直接插进内容流 —— 出现/消失会改变内容高度，垂直居中的弹窗与页面会跳。做法：把互斥的提示合并进同一个 `.noticeSlot`（`min-height` ≥ 单行 banner 盒高，并抵消 banner 自带 `margin`），提示文本用 `.noticeLine` 单行截断（完整文案放 `title`）。**底线：内容一旦会换行，不抖动的保证即失效。**
  - **三处复用同一个组件**（Phase 2 起导出/导入，2026-09 起含市场）：导出页（`mode="export"`，带体积）、
    导入向导 preview 步与**市场条目导入审阅**（均 `mode="import"`，**计划项没有体积，因此不渲染体积、
    也不要编一个数字**）。导入侧的单元由 `PlanItem.unitId`（适配器声明）归并 —— 与导出的 `listUnits()`
    同一套规则。**市场通道与导入页共用同一套选择语义**（默认全选、「全选」含高风险分区），
    差异只由调用方传入的 `highRisk` 回调表达（下一个要点）。
  - **高风险徽章（`highRisk?: (id: SectionId) => boolean`，2026-09 市场通道）**：命中时在分区行渲染
    `高风险` 徽章（`Badge kind="warn"`，`picker.highRisk`，tooltip 为 `picker.highRiskHint`）。
    **缺省不传 = 导出页/导入页零变化**（那两个调用点的分区风险由 portability/sensitive 表达，
    且没有「条目来自公共仓库」这层语义）。徽章**只是标记**：三态、全选、原子组联动仍全部由
    `selection-model.ts` 决定，**不得**在组件里为它写第二套勾选规则。
  - **单元级徽章（`unitBadge?: (section, unitId) => ReactNode`，2026-09 市场通道）**：渲染在单元行
    名称之后（市场传入「将改动 / 已一致 / 不导入」）。为什么开这个口子：市场审阅要在**树上**表达
    「这一项会不会写盘」；没有它，调用方只能在树旁边再铺一份逐项列表 —— 同一批条目渲染两遍正是
    「61 行挤爆弹窗」的根因。**缺省不传 = 导出页/导入页零变化**；文案与语义全部由调用方决定，
    组件不猜、也不为它推导任何勾选状态。
- **Stepper**：紧凑圆点 17px + 连接线，只读指示器。
- **进度条**：`.progressTrack` 5px + 确定宽度过渡 / `.progressIndeterminate`。

### Shell 与 Overlays
- Shell：`.shellNav/.navStrip/.navTab/.navActions/.shellMain/.pagePad/.statusBar`；
  `.shellMain` 与 `.pagePad` 构成纵向 flex 链，页面可伸展填充（`.fillCard/.fillViewport`）。
  - **页签条溢出可发现性（UI-19）**：`.navStrip` 是 `overflow-x: auto` 但滚动条被隐藏
    （`scrollbar-width: none`）——英文界面（7 个英文页签 + 2 个文字动作按钮）在 564px 画布下会溢出，
    而界面上原本没有任何「右边还有内容」的提示。壳层按 `scrollWidth/clientWidth/scrollLeft`
    算出溢出侧并写入 `data-overflow="none|start|end|both"`（判定 = 纯函数
    `navOverflowState`/`navOverflowAttr`，`src/ui/nav-overflow.ts`，node 可测），
    CSS 只在真正溢出的那一侧画渐隐遮罩（`mask-image`，作用在元素自身绘制盒上，
    不随内容滚动；`::after` 覆盖层在滚动容器里会跟着内容跑，不可用）。
    放得下时不画任何遮罩（避免给放得下的界面凭添渐隐）。
  - **`.shellNav` 不铺背景色**（与 `.statusBar` 一致）：宿主设置面板底色随主题变化，
    实测暗色下 `--dsw-alias-bg-base`=#151517 而面板底色=#2c2c2e，铺底色会在导航条两侧
    形成一条比面板更暗的通栏色块（亮色下两者同为 #fff 才看不出来）。页签分组感由
    `.navStrip` 自身的 `bg-layer-2` 底色 + 描边承担。
- Dialog：`.dialogMask/.dialogCard(.dialogWide)/.dialogHeaderRow/.dialogHeader/.dialogBody(.dialogBodyScroll)
  / .dialogFooter`，遮罩点击/Esc/取消三途径关闭，busy 禁闭，focus trap，焦点还原。
  - **标题行缩进（UI-10）**：`.dialogHeader` 原本是**独立块级标题行**（自带 `padding: 12px 16px 0`），
    在 `.dialogHeaderRow`（flex 行）里复用时内边距会与父级叠加 → 标题比正文多缩进 16px、下沉 12px。
    归零规则：`.dialogHeaderRow .dialogHeader { padding: 0 }`，缩进统一由行容器提供
    （只传 title 的弹窗走独立块分支，缩进本就正确）。
  - **关闭按钮文案（UI-17）**：`Modal.Header` 的 `closeLabel`（aria-label）**必填于传了 `onClose` 的调用点**
    （联合类型由编译器强制），值一律是各自字典的 `common.close` —— 原先硬编码中文，英文界面下
    屏幕阅读器仍读中文。**底部动作一律走 `Modal.Footer`**（`.dialogFooter` 固定底栏；UI-23），
    不要放进 `Modal.Body` 的正文流（会随内容滚动、条目多时被裁到折线以下）。
  - **尺寸**（2026-09 放大，长内容可读性）：`.dialogCard` = `min(640px, calc(100vw - 48px), 95%)`
    × `min(600px, calc(100vh - 64px), 92%)`；`.dialogWide` = `min(720px, …, 96%)` ×
    `min(620px, …, 92%)`；`.dialogBodyScroll` 限高 460px。旧值 380×480 在「配置更改明细 /
    分区构成」这类长内容下会被压成很窄一列且过早内滚。百分比上限用于兜底宿主导航占宽。
  **Portal 容器必须是插件根节点**（`ConfigManagerSection` 的 `#dsh-config-manager-root`，
  常量 `MODAL_ROOT_ID`）：宿主设置弹窗 overlay 为 `position: fixed; z-index: 1000`，
  弹窗若按 Radix 默认挂到 `document.body` 就成为它的兄弟节点、被 1000 层完全盖住而"隐形"，
  叠加 Radix modal 给 body 加的 `pointer-events: none` → 表现为"打开后整页点不动，
  必须先点一下屏幕"（那一下正是关掉隐形弹窗的外部点击）。挂回插件根节点即恢复
  与宿主同一层叠上下文（与迁移前内联 `dialogMask` 的层级语义一致）。
- Drawer：`.drawerMask/.drawerPanel`（右侧 400px；Esc 仅在面板内消费，`stopPropagation`
  避免关闭宿主弹窗）。
- **运行中心（2026-09，活动抽屉第三段「进行中」）**：`.runsCenter/.runsSummary/.runsCardHead/
  .runsCardTitle/.runsCounts/.runsLogTail/.runsLogLine/.runsCardActions/.runsOption(.runsOptionTitle
  / .runsOptionDesc/.runsOptionTag)` + 状态栏入口 `.statusAction`。
  - **入口双点、正文一处**：状态栏那句「N 个任务进行中」（`.statusText`）在有任务时**整句变成按钮**
    （`.statusAction`，无边框无底色，只加 hover 下划线 + 焦点环 —— 它是状态文本，不该看起来像按钮），
    点开抽屉并落到「进行中」段；正文只有抽屉里的运行中心一份。**不新增一级页签**：564×720 下
    7 个英文页签已溢出（见上「页签条溢出可发现性」），运行任务又是跨页面的，抽屉才是它的正确容器。
  - **三段式 Segmented**：进行中（瞬时态，`/runs?scope=recent`）→ 迁移历史（持久审计）→ 关于。
    两者**不得合并成一个视图**：前者终态 30 分钟后会被宿主 prune，混进历史页会出现
    「刷新后历史里少了一半」的认知撕裂。
  - **决策框不是普通确认框**：`Modal` + `.runsOption` 单选卡（两个语义不同的出口：回滚 / 保留），
    代价数字（已应用 / 未执行）写在正文顶部，默认项带 `.runsOptionTag`「推荐」标记（推荐项跟随用户
    既有的「失败不回滚」偏好），底部动作走 `Modal.Footer`（`.statusSpacer` 推靠右）。
    「保留」下方**必须**带 `Banner kind="warn"`：审计只能压低 DSH 启动失败的概率，不能保证。
  - 长内容纪律：日志尾部 `.runsLogTail` 限高 108px 内滚（同 §2 长列表规则），卡片列表靠在抽屉
    自身的 `.drawerBody` 滚动里，**不得**再嵌套一层滚动容器。
  - **进度轨道三态（真机 bug 修复，用户报告「定时备份 / 自动同步 一直在加载」）**：轨道形态由
    `progressBarMode(view, active)`（纯函数，`src/client/common/progress-view.ts`）决定 ——
    有百分比 → 定长；**无百分比且在跑** → `.progressIndeterminate` 不定态动画；
    **无百分比且已结束 → 静止满格条**（此前不看 `active`，只要没百分比就渲染无限动画，于是
    「已完成」的任务永远在滚动）。结束态默认 `.progressBarDone`（success 绿），失败时由
    ProgressBar 的 `failed` 换 `.progressBarFailed`（state-error）—— 失败的任务**不得**染成成功绿。
  - **阶段文案按 run 类型分开**（`src/client/run-store.ts` 的 `RUN_STAGE`）：备份 / 同步 / 快照恢复 /
    档案切换 / 事故恢复各有措辞（`progress.backingUp` / `syncing` / `restoring` / `switchingProfile` /
    `recovering`），**不得**再用导入的「正在应用配置…」兜住所有类型；已结束的 run 用
    `progress.done` / `progress.failed` 结论文案，不再显示进行时。
  - **终止等待必须可见（`.runsWarnNote`，2026-09）**：终止是**协作式**的（只在计划项边界生效），
    所以卡片必须写出「已请求终止：等当前计划项结束后暂停（已等待 N 分钟）」（`.hint` 灰底），
    超过 `CANCEL_STUCK_AFTER_MS`（2 分钟）升级为 `.runsWarnNote`（warn 描边 + warn tint）+
    `.runsWarnNoteDetail` 给出路：先「跳过当前插件」、否则重启 DSH。**绝不**留一个还能点、
    但点了没有任何新效果的「终止」按钮（已请求过就不再渲染该按钮）。
  - **环境锁卡片（同段，2026-09）**：残留锁此前只存在于「备份 → 事故恢复」，用户在运行中心里看不见它 ——
    而它正是「导入终止不了、写操作一直被 423」的当事者。三态语义必须分开：
    `FREE` **不渲染卡片**（空闲是常态）；`LOCKED` 渲染为 `Badge kind="info"`「使用中」**且不给回收按钮**
    （宿主按设计拒绝回收活锁，给按钮只会让人反复点）；其余（`STALE_LOCK_DETECTED` / `UNKNOWN_STATE` /
    IO/权限）渲染为 `Badge kind="warn"`「需要处理」+ 主按钮「回收残留锁」；失败/被拒必须如实提示
    （`runs.lock.recoverRefused` / `recoverFailed`），**不得**报成功。回收动作 `userConfirmed=true`
    只由用户点击表达。
  - **每张卡片带相对时间**（`.runsCardTime`，右贴）：没有它，「正在跑」与「几小时前就结束的僵尸卡片」
    在界面上完全一样。保留期说明 `.hint` **始终显示**（空列表时解释「为什么什么都没有」，
    有列表时解释「为什么只有这些」）。

### 布局行原语（2026-09 补：把「行」的语义与间距集中定义，禁止各处内联 margin）
- `.actionRow`：通用操作行（flex + nowrap→wrap，`margin: 0 0 10px`）。
- `.actionRowTop`：上方紧跟说明文案的操作行（同 `.actionRow` 但**上边距 10px**），
  用于「hint / 计数行之后才是按钮」的场景（同步页「配置同步通道」与「选择同步分区」）。
  **普通 `.actionRow` 没有上边距** —— 直接跟在文字后面会把按钮与文字贴在一起（实测过）。
- `.tabRow`：**独占一行**的分段/页签行（`.modeTabs` 是 inline-flex，直接跟在文案后
  会与文案同行）。**当前无调用点**：同步页的「默认 / 高级」模式分段已移除（分区恒由用户
  手动勾选），本类保留为原语，供后续需要独占一行的分段控件使用。
- `.headRow`：卡头单行（标题左、动作/徽章右）。与 `.groupHeader` 的区别：不做
  baseline 对齐（按钮组需居中），且 `.headRow .groupLabel { margin-bottom: 0 }`，
  否则标题的 8px 下边距会把整行撑高。右侧推靠用既有的 `.statusSpacer`。
- `.authorRow`：标签 + 值的居中行（关于页作者行），同样带 `.groupLabel{margin-bottom:0}`。
- `.sectionOptionRow`：同步分区弹窗里「分区勾选行 + 该分区专属参数」（历史会话的「最新 N 个」）
  的纵向容器。**必须包在 `Checkbox` 之外** —— `Checkbox` 内部是 `<label>` 元素，
  把输入控件放进去会让「点输入框」也切换勾选状态。
- **教训（本轮踩到）**：`.field` 自带 `margin-bottom:10px`，任何用 `align-items:flex-end`
  把「字段」与「按钮」并排的对齐都会因此差 10px（实测 select 底 1042 / 按钮底 1052）。
  在并排容器里必须把该字段的 margin 归零（见 `.snapshotPickerRow .field`）。

### 表单宽度纪律（本轮修正的回归）
`.input/.select` **不得**全局 `width:100%`：它们大量出现在行内 flex 容器里
（市场筛选、同步快照下拉），全局满宽会让每个控件各占一整行。
满宽只在**纵向**容器内按需生效：`.field > .input/.select { width:100% }`
（`.field` 是 column flex），路径映射则用 `.pathOld/.pathNew { display:flex;
flex-direction:column }` 让内部 input 拉满。市场筛选用 `.marketFilterGrid`
（2 列 grid）+ `.marketFilterSearch`（跨列）+ `.marketFilterMeta`（元信息行）。

### 页面级模式
- **Overview 控制中心**：状态条 → 动作工具栏（主操作 + 活动入口右对齐）→
  备份位置卡（路径+copy/体积/配额/间隔/下次）→ 分区构成卡 → 活动视口
  （fit-content 上限 8 行内滚；成功=绿点降噪，失败/跳过=徽章）。
  - 状态条指标段**精确跳转**：备份文件→备份页「备份文件」、安全快照→「安全快照」、
    定时备份→「定时备份」、远程同步→同步页（`METRIC_TARGET` 同时写 panel 与 snapshots.subTab，
    只写 panel 会全部停在子页默认值）。
  - 健康段仅在「存在未解决恢复事项」时渲染为按钮，直达备份页「事故恢复」；正常态是纯展示 span。
  - 活动行容器 `.activityRows` 取 `flex: 0 1 auto; min-height: 0`（**不可用 `flex: none`**）：
    页面被压缩时列表须随之收缩并自身内滚，否则内容溢出卡片边框（曾实测 274px 内容 vs 205px 卡片）。
- **Backups**：Segmented 四子视图；快照表（行点击→计划弹窗）、备份文件表
  （图标操作 + 删除红色隔离 + 分隔线）、定时备份独立子视图（单行头：标题+结果徽章+上次+动作）。
- **恢复计划预览（git 风格，2026-09 用户要求）**：计划弹窗从「一行条流水账」改为
  「摘要条 → 状态分组 → 点开逐行对照」三级：
  - 摘要条（`.statRow` + `Badge`）：将被还原 / 新增 / 将被删除 / 卸载插件 / 需人工处理 /
    无动作（各自计数）+ 行数合计（`.diffStatAdd` 绿 / `.diffStatDel` 红）。
  - 分组顺序固定：`changes`（修改+新增）→ `deletes` → `plugins` → `hints` → `skips`；
    **`skips` 默认折叠**（`.diffGroupToggle`）—— 几十条「跳过」不再淹没真实变更。
  - 文件行（`.restorePlanRow`）：状态标签（复用 `.kindTag` 四态）+ 等宽路径
    （`.restorePlanPath`，单行中段/尾部省略）+ 行数（`.restorePlanStat`）+ 展开箭头；
    不可展开的行（插件/提示/跳过）用 `.restorePlanRowStatic`（保留可读性，不置灰）。
  - 展开后为**左右双栏对照**（`.diffTable`：行号 + 内容 ×2，`table-layout: fixed`；表头两栏之间
    用 `.diffNoHead + .diffNoHead` 的左边框画竖线）：左=当前磁盘内容、右=快照内容；
    成对修改 = 左 `.diffCellDel` 红底 + 右 `.diffCellAdd` 绿底，单侧增/删只着色一侧；
    块头 `@@ -a,b +c,d @@` 用 `.diffHunkRow`。
    **上限**：单文件最多渲染 400 行对（超出显示「已截断」提示）；容器复用 `.diffScroll`（限高内滚）。
  - **行号列宽 = 实际最宽行号的位数**（`maxLineDigits` → `.diffNoColW3/4/5/6` 四档 ch，`<colgroup>` 固定）：
    fixed 布局下四列平分会让两条行号列吃掉一半宽度、代码列被挤到反复折行；行号列必须只占自身需要的宽度，
    剩余空间由两条代码列平分（`.diffPane` 左外边距归零，别在行号列左侧再留缩进）。
  - **行数统计一律分色**：`+N` 用 `.diffStatAdd`（绿）、`−M` 用 `.diffStatDel`（红）——单条
    `'+{added} −{removed}'` 字典文本无法分别着色，故该字典键已删除，改由 `RowStat` 两个 span 拼装。
  - **分组头严格一行**（`.restorePlanGroupHead`）：`.groupLabel` 是卡内小节头（`display:block` +
    `margin-bottom:8px`），直接塞进 `.statRow` 会被下外边距顶得与徽章/行数不在同一视觉行，
    故分组头用独立类并复位 `.groupLabel` 的 `display`/外边距。
  - **咨询与预览之间的分割线**（`.sectionDivider`，1px `--dsw-alias-border-l1`）：迁移前咨询卡排在
    「选择快照以预览恢复计划…」提示行之前，两部分之间画线；无咨询报告时不画（避免开头一条孤立横线）。
  - 无法逐行对照时按原因给一句话（二进制 / 过大 / 不可读 / 快照缺内容 / 路径越界），
    两侧一致时显示「无逐行差异」——三种状态都占位，不出现空白面板。
  - 数据来源：宿主 `POST /restore`（dryRun）附带 `changeSummary`（轻量统计，带读取上限），
    单文件 hunks 由 `POST /snapshots/file-diff` 在点开时懒加载 —— 会话类快照几百个文件也不拖死弹窗。
  - 分层：分组/统计在 `src/ui/restore-plan-view.ts`、双栏对齐在 `src/ui/diff-view.ts`（纯函数 + node 单测）；
    行级 diff 内核 `src/utils/line-diff.ts`（零依赖 Myers，超预算降级为整块替换）；
    组件 `src/client/snapshots/RestorePlanView.tsx` 只装配。
- **冲突解决**（ConflictList）：选边卡片模式——每项一张卡（kindTag 适配器 + 等宽描述），
  两个并排 `.choiceCard` 选边（radio 语义，选中高亮），**可见文案取字典**
  `import.conflicts.keepCurrent` / `useImported`（zh「保留当前 / 使用备份」、en「Keep current / Use backup」）；
  批量决策在顶部。
  安全：不做值级 diff。冲突明细里的 `current=…` / `imported=…` 是**宿主拼装的标记 + 配置值**
  （settings / providers 已在适配器侧按 `redactSecrets` 掩码，但 MCP 的 `env` / `headers` 等由
  `extractMcpServers` 原样给出）—— 标记本身**从不作为文案显示**，因此**不得**把这一行读成
  「冲突项不含当前值」，UI 侧仍必须逐点过 `redact()`（依据见 §7）。
- **配置更改明细**（`.conflictDetail`）：host 拼接的 `[prefix] current=… imported=…` 单行文本，
  在纯展示层用 `splitConflictDetail` 切成 prefix / current / imported 三段（切分只依赖 host 的
  `current=` / `imported=` 字面标记，两标记互不干扰），渲染为两行（`.conflictLine` +
  `.conflictLine + .conflictLine` 的 border-top 分隔），长 JSON 用 `overflow-wrap: anywhere` 折行。
  **可见的行内标签不是 host 标记**，而是字典文案：`import.conflicts.detailCurrent` / `detailImported`
  （zh「当前 / 备份」、en「Current / Backup」）—— 与代码一致（`ConflictList.tsx` 直接 `t(...)` 渲染，
  host 的 `current=` / `imported=` 永不显示），改文案只改字典。
  **不再用 `<pre>`**：`white-space: pre` 会让长配置横向溢出、出现左右滚动条。
  注意 `.conflictDetail` 亦被 `SyncConfirmView` 的 `<details>` 复用（该处非 pre，不受影响）。
- **路径映射**（`PathMappingForm`）：每条 issue 一块 `.pathRow`，**纵向**堆叠 ——
  「原路径」块（标题 + 等宽路径 + kind）在上、「新路径」块（标题 + input）在下，各自整宽。
  两个块内的标题用块级元素（`.fieldLabel` 无 display 时是行内元素，会与 input 挤同一行）；
  `.pathValue` 须 `white-space: pre-wrap`（长路径折行）。
- **迁移前咨询卡**（`ConsultCard`）：`.consultSection` 包裹「将应用 / 评分维度」两个小节
  （小节间距 10px）；「建议依据」用 `.reasonList`（`flex-basis: 100%`，在 `.banner` 的
  flex+wrap 中独占整行）+ `.reasonLine`（每条一行，重复项以 `×N` 徽章标注，去重见
  `consultReasonGroups`）。`.consultScroll` 带左右 6px 内边距 —— **评分维度行的徽章胶囊
  原本紧贴容器左边框**（实测 inset 仅 1px，即边框本身），必须留内边距。
  - **咨询是独立一页（2026-09，用户要求）**：导入预览拆成两页 —— 第 1 页「迁移前咨询」
    （`ConsultCard` + 「下一步：选择要导入的内容」），第 2 页才是内容选择面板（`ContentPicker`）。
    结论徽章旁恒显示**硬阻断 N 项 / 需处理 N 项**两个计数（`consult.blockers` / `consult.attention`），
    让「为什么是 review / block」可直接核对，而不是只有一个分数 —— 用户实测抱怨过
    「健康评分 89 / 建议：阻止执行」这种自相矛盾的展示（根因：结论曾由分数阈值决定，
    现在只由证据决定，见 `src/core/migration-consult.ts` 的 `HARD_BLOCKER_CODES`）。
- **导出页（Export）**：工具栏 → 模式提示 → **安全选项**（`.groupLabel` = `export.security`）→
  **命名行**（`.groupLabel` = `export.naming`）→ 进度/报告 → **「本次将导出」构成卡**
  （最后一个数据块，`Card.fillViewport` + `.compositionViewport` 内滚；合计口径与选择器 footer
  同源 = 同一个 `pickerSummary`，构成行只列真正会导出的分区）。
  - **分组标题（UI-11）**：两组输入区（安全选项 / 文件名与备注）外观相同，必须各有分组标题，
    否则读不出边界；文件名与备注各带 **常驻** `.hint` 规则说明（UI-12，
    `export.fileNameHint` / `export.noteHint`，先说明规则后报错）。
  - **并排字段间距（UI-21）**：`.secretFields` 双列栅格内的 `.field` 归零下边距
    （`.secretFields .field { margin-bottom: 0 }`），分组说明行用 `.groupHintRow`（10px）
    —— 不得用内联 `style` 覆盖（AGENTS.md：style 属性只允许极小修补）。
  - 该卡承担 Canvas 纪律（消灭底部空洞），且**恒常渲染**：无勾选时块内显示
    `export.compositionEmpty`（「无内容可导出」本身就是需要用户看到的状态，整块消失 = 空洞回归）。
  - **未读取的分区不显示 0**（F-03）：`SectionComposition` 的行带 `state`（loading / failed），
    未读到的行显示 `读取中…` / `读取失败 · 将整体导出` + 体积 `—`；只要存在未读取分区，
    合计改用 `export.compositionPartial`（「已读取 … 约 …（含未读取分区，实际不少于该值）」）。
    勾选状态是唯一事实（无「快速/自定义」第二套流程）。
- **导入向导**：6 阶段 Stepper + 分步页面；导入执行页含命令日志面板（`.logPanel`，
  智能贴底滚动 + 「↓ 新输出」提示）。稀疏步骤（选择 ZIP）用 `.sparseFill` **顶部对齐**
  （`justify-content: flex-start`）：内容贴顶、紧跟步骤条，不再垂直居中悬在页面中段。
  - **步骤条的阶段输入（2026-09 修复）**：向导 `step` 一旦进入 `importing`/`result`，它就压过
    `phase`（规则 = `ui/import-stepper.ts` 的 `importStepperSource`）。原因：`phase` 会**停在最后一道
    闸门 `confirm`**（向导流程不回退，也没有「执行/完成」这两个 `FlowPhase`），只看 `phase` 会让
    步骤条在执行中与导入完成后都卡在「4 确认」——用户报告的原始现场。
  - **执行日志面板（.logPanel，2026-09 可读性改造）**：宿主 `RunRegistry.log` 是扁平行流水
    （`▶ item` / `$ dsh plugin …` / `✓|⚠|✗|–|⏭ item`），由纯函数 `ui/import-log.ts`
    （`buildImportLogModel` / `filterImportLogEntries`）**按 itemId 合并成一条记录**：状态行
    按级别着色（`.logLine[data-level='fail'|'warn'|'ok'|'skip'|'running']`），命令与说明缩进为
    `.logDetail`（`data-kind='command'|'text'`），表头显示计数（`.logCounts`：
    成功/跳过/警告/失败）并提供 `.logFilterButton`「只看问题」（警告+失败+进行中）。
    组件在 `import/ImportLogPanel.tsx`；两条脱敏登记点随之指向该文件
    （`plan-text-redaction.test.ts` 的 `import-log-*`）。
  - **结果页布局纪律（用户报告「导入完成后没有完成按钮」）**：结果正文（报告卡 + 收尾清单）
    独占一个滚动区 `.resultScroll`（`flex: 1 1 auto; min-height: 0; overflow-y: auto`），
    收尾操作栏 `.resultFooter`（`flex: none`）固定在底部。**不得**把报告卡与操作按钮放在同一个
    受挤压的 flex 列里：`.reportView` 是 `overflow: hidden` 的 flex 项（自动最小尺寸为 0），
    被压缩后会把底部的动作行**整行裁掉** —— 特征现象是「内容都在、按钮凭空消失」。
    同类清单（收尾清单 `.nextStepsList`）按 §第 8 条限高内滚，避免把结果页撑成长页。
  - **导入结果报告（2026-09 结构化）**：`ReportView` 的 import 分支渲染
    总览徽章（`importTotals`：✓/≈/⚠/✗ 四个数）+「需要你关注」清单（`importProblems`：
    分区 + 计划项 id + 原因，限高内滚）+ 分区明细（`importSectionStats` + `sectionLabeler(t)`，
    不再让用户看见 `pluginFiles` 这类适配器 id）+ 回滚块 + **完整文本报告**（`<details>` 渐进披露，
    仍走 `renderImportReport` 过 `redact()`）。分区显示名走 `report.other` 兜底未知前缀。
    **动作按钮不在报告卡里**：导入的收尾动作（完成/重试）属于向导的 `.resultFooter`。
  - **空选择守卫（UI-05）**：预览步勾选被清空时，`Banner kind="warn"`（`import.nothingSelected`）
    就地提示并禁用「下一步」，确认页的「确认导入」同样禁用 —— 与导出侧 `nothingSelected`
    同一套语义（空选择不推进、也不允许执行成一次「成功但什么都没做」的导入）。
  - **补录密钥页是受控表单（UI-06）**：输入值直接来自 store 的 `secretInputs`（组件不持有输入
    状态），单字段改动经 `mergeSecretInput`（`src/ui/import-wizard.ts`）合并 ——
    该页可来回切换、组件会卸载重挂，**看到什么就提交什么**；否则会出现「回到该页输入框全空
    但旧值仍被提交」与「编辑一个字段丢掉其它 ref 的值」。
  - **确认页（UI-13/UI-14）**：提示语随「失败时整体回滚」勾选状态切换
    （`import.confirm.warning` / `import.confirm.warningNoRollback`）—— 复选框可取消，
    取消后仍承诺「失败时整体回滚」是自相矛盾的文案。确认页同时给出一行
    「将导入 N 个分区 · M 个条目」（`picker.summaryImport`，与预览步选择器**同源**）
    + 被取消项数（`import.excludedByUser`）：最后一道闸门必须能核对。
  - **路径映射页是中性提示（UI-18）**：留空 = 跳过该路径是合法操作且不拦截「下一步」，
    因此计数横幅用 `Banner kind="info"`（文案含「留空将跳过」），**不用 warn** ——
    黄色横幅在首屏会被读成「出错了」（§9 anti-pattern 3），与相邻「解决冲突」页的
    「未决策则禁用下一步」行为刻意不同。
- **配置市场 · 条目导入审阅（MarketImportReview，2026-09）**：浏览条目详情 与「我的配置 → 装回本地」
  **共用同一个组件**（两处此前各写一套平铺分区批准表 + 导入执行 —— 即 AGENTS.md 明确要消灭的
  「同样的勾选框不一样的行为」）。
  - **页面级分步向导（P1 分步 + P2 换载体，2026-09 用户要求）**：`预览 → 选择内容 →（冲突）→ 确认 → 结果`，
    步骤条复用 `Stepper`（`.wizardStepperRow`），步骤序列由纯函数 `marketReviewSteps(hasConflicts)` 给出
    （**有冲突才有「冲突」步**），`nextMarketStep` / `prevMarketStep` 负责前后移动（首尾夹紧）。
    起因是实测 3 分区 / 61 个计划项：「警示 + 级联树 + 逐项摘要 + 冲突 + 按钮」同屏会出现
    **三重滚动**（弹窗自身 + 树内滚 320px + 摘要内滚 380px）。
    **载体是页面，不是弹窗（P2）**：市场侧「列表 → 点「查看详情」→ 免责确认 → 进入向导页」，
    我的配置侧「已上传列表 → 装回本地 → 进入向导页」；两侧都由父页给出**页头 = 标题 + 返回列表**
    （`.headRow` + `Button`），列表视图整块让位（我的配置侧用提前 return 实现，所有 hooks 仍在
    提前 return 之前声明）。Tab 栏（浏览市场 / 我的配置）保留，随时可切走。
  - **步内内容区的高度（2026-09 用户要求，自适应版）**：`.marketReviewPage`（`flex: 1 1 auto;
    min-height: 200px`）吃满 `.viewBody` 的剩余高度；**所有步骤的内容区共用同一条高度规则** ——
    `flex: 1 1 auto; min-height: 200px; max-height: 800px; overflow: auto`，适用对象是
    「预览 / 冲突 / 结果 / 确认」的 `.marketReviewScroll` 与「选择内容」的
    `.marketReviewPage .pickerList`（**不改导出页选择器弹窗与导入页的既有规则**）。
    要点：① 高度**随可用空间自适应**，200px 是硬下限（选择步的树曾因纯 flex 收缩压到 ~85px）、
    800px 是上限（超长内容不把步骤撑爆）；② 外层 `.marketReviewPage .pickerRoot` 保持
    `flex: 1 1 auto` 且**不写 `min-height: 0`** —— 保留 flex 项的自动最小尺寸（= 内容），
    否则空间不足时树会溢出根盒、把底部按钮顶到重叠位置；③ 空间不足时**整页由 `.shellMain` 滚动**
    （溢出的后代内容仍可达，不会被裁掉）。
  - **分区小结的行间节奏**：小结卡片复用冲突卡的 `.conflictItem` + `.conflictHead`，**必须**包在
    `.conflictList` 容器里 —— 间距由容器的 `gap: 8px` 提供，`.conflictItem` 自己不带上外边距，
    直接并排会贴在一起（2026-09 实测反馈）。
  - **逐项摘要降维（同一批条目只渲染一遍）**：摘要不再铺 61 行，而是`marketSectionSummaries` 的
    **分区级小结**（一行一个分区：分区名 + 已选 n/m 个条目 + 将改动 / 已一致 + 高风险徽章）；
    逐项信息回到树上 —— `ContentPicker.unitBadge(section, unitId)` 在单元行渲染
    「将改动 / 已一致 / 不导入」。三处判定同源：`marketUnitIndex` / 筛选 / 执行都读同一个
    `isPlanItemExcluded`。
  - **选择步筛选**：复用 `Segmented`（全部 / 将改动 / 高风险 / 未勾选，带计数）。
    **筛选只影响渲染**，不改变勾选语义：`selectAll` 本来就作用于当前可见集合；
    不可细分分区（`units: []`）在任何筛选下都保留 —— 它没有单元可判断，藏起来只会让人以为分区消失。
  - **风险默认态与导入页一致（用户 2026-09 决策）**：默认**全选**（含 plugins / mcp / agentPresets /
    agentInstructions 等高风险分区），原「高风险分区默认不勾、须逐项批准」（`MarketApprovals` 布尔批准表）
    已删除。风险改由三层承担：**就地警示**（已勾选的高风险分区名 + 后果，`review.highRiskHint`）、
    进入向导页前的**免责确认**、以及**导入前快照 + 导入后一键回滚**。
  - **冲突决策**：决策变化后由**宿主重算计划**（`createImportPlan`，与导入向导 `execute()` 同一路径），
    **不在前端改 `planItem.kind`** —— 那等于把 `analyzer.applyItemResolution` 抄一份进 UI。
    未决策的冲突按「保留本机」处理（引擎记为 skipped，不覆盖）。
  - **回滚入口**：`ImportResult.snapshotId`（引擎在导入第一步创建）非空时给 `variant="danger"` 按钮，
    `ConfirmDialog danger` 二次确认后调 `restoreSnapshot(id, false)`，结果列恢复/卸载/失败计数；
    **没有快照就如实说明「无法回滚」，不给假入口**（结果步里呈现）。
  - 状态归属：勾选（`selectionState`，绑 `zipPath` 失效）与冲突决策（`conflictResolutions`）进
    run-store 市场切片（切 tab / 刷新不丢）；旧持久化载荷缺这两个字段时回落默认（全选 / 无决策）。
    **步骤与筛选是纯瞬态**（组件自持，刷新回到第一步 —— 勾选与决策不丢）。
- **事故恢复**：仅在 `recoveryRequired === true` 时显示红色 SAFE MODE 横幅；
  正常态（无待处理事项）不渲染任何横幅——「已恢复正常，可继续操作」绿灯提示已移除
  （恢复成功后的确认由操作结果本身承载，常驻绿灯属冗余噪音）。
- **档案（Profiles，2026-09 语义替换）**：页面 = **DSH 自带 profile** 的管理器
  （`$DSH_HOME/profiles/<name>`），不再是插件自有的「配置快照」。四段垂直结构：
  ①**当前运行 / 下次启动卡**（`.kvRow` 显示当前 profile；按 `selectionState` 分四种呈现：
  none→`.hint` 规则说明、current→`Banner kind="ok"`、missing→`Banner kind="warn"` + 清除按钮、
  pending→`.actionRow` 内给等宽重启命令 `dsh --profile <name>` + 复制 + 清除）；
  ②**新建卡**（name `.input` + 模板 `.select` + primary 按钮，非空即内联 `.formError` 校验）；
  ③**列表**（`.listHeaderRow` = 标题 + 统计 + 刷新，下接一行 `.hint` 说明「点击行看完整详情」；
  行 = `.profileRow` 内 `.profileRowHeader`：左为**整块可点信息区** `button.profileRowMain`（两行：
  `.profileRowTitle` = 档案名 `.profileRowName` + `.badgeRow` 徽章组（当前运行 / 下次启动 / 形态 / 损坏），
  `.profileRowMeta` = **计数摘要**「N 个层 · patch M 条 · 依赖 K」+ node_modules + patchReload + 更新时间），
  右为 `.actionRow[data-inline]` 操作组（设为下次启动 / 重命名 / danger 删除）。
  **行内绝不铺开包名清单**：web 档案 13 个 bundle 名的实测回归会把元信息挤成窄列；
  完整清单只在详情弹窗展开（`profileRowFacts` 只给计数）。
  ④**详情弹窗**（`.detailLines` 逐行列 bundle 层（带序号 = patch 应用顺序）与依赖（按包名排序），
  概览徽章组给形态 / 层数 / patch 条目与体积 / patchReload / node_modules / 更新时间 + 目录 kv +
  损坏告警；其后是只读原文：`package.json` 与 `cordis.patch.yml` 进 `.reportScroll` + `<pre class="reportText">`，
  **两处原文均先过 `redact()`**，见 §7）。
  - 新增原语类：`.listHeaderRow`（表头行：`.groupLabel` 归零下边距、`.cellMeta` 占余宽）、
    `.badgeRow`（`inline-flex; flex: none`，徽章不与档案名抢宽）、`.actionRow[data-inline]`（同排操作组，去块级外边距）、
    `.profileRowTitle` / `.profileRowName`（名字省略，徽章不压缩）、`.profileRowMeta`（单行省略的计数摘要）、
    `.detailLines`（详情弹窗内清单：flex column + 等宽）。
  - 删除 = **物理删除目录**（含 node_modules，不可恢复）→ `ConfirmDialog danger`；目标为当前运行中的
    profile 时额外渲染 `Checkbox`（`profiles.deleteCurrentConfirm`），未勾选点确认只就地报错、不执行。
  - 旧的「切换预览」弹窗（计划项 diff + 咨询卡）随该功能一并移除；
    `ConsultCard` 仍在导入向导使用。

---

## 7. 文案与安全呈现

- 全部用户可见文案走 i18n 字典（zh 源 / en 镜像；`ConfigManagerKey` 编译校验）。
  - **两套字典各管一段**：React 壳（`src/client/`）走 `t()`（`config-manager` namespace，
    `ConfigManagerKey`）；`src/ui/*` 与 `src/client/common/*` 的渲染器走 `UiT`
    （`src/ui/i18n.ts`，`UiTextKey`）。报告/错误/进度文本属于后者 —— 传给渲染器的
    `t` 必须一路带下去（`renderExportReport(report, t)`），否则英文界面里报告正文会是中文。
  - **动作 id 不是文案**：`suggestedActions()` 之类返回的是动作 id（`done`/`fixIssues`），
    渲染前必须映射到字典键（导入结果页的收尾按钮走 `import.done`），禁止把 id 直接渲染进按钮。
  - **分区显示名**：`SectionId → 文案` 的单一映射是 `common/section-labels.ts`
    （`SECTION_LABEL_KEY` / `sectionLabel(id, t)` / `sectionLabeler(t)`，`Record<SectionId, …>`
    全量覆盖 ⇒ 新增分区忘配文案会编译失败）。导出选择器、导入选择器、兼容性页分区网格、
    分区构成卡一律传同一个 `sectionLabeler(t)`；`ExportFlow.categories[].label` 保留给
    报告/日志等非 UI 场合，**不再**作为界面显示名（同屏术语漂移见 §9 anti-pattern 8）。
    配套：`ExportFlow.validateSelection()` 返回**结构化结果**（`{ valid, unknown, deviceSpecific }`），
    不再拼中文警告文本 —— 纯逻辑层只说「哪些分区有问题」，文案与分区名由展示层走 i18n 组装。
- 错误/报告/历史摘要渲染前 `redact()`；历史条目中的 `[REDACTED]` 在展示层
  可读化为「（文件名已脱敏）」。
- **计划 / 分析文本同样是「展示文本」**（t6 评审登记的 high）：宿主把 `analyzeImport` /
  `export-preview` 的结果直接回传浏览器，`PlanItem.description` / `detail` 可能含**未脱敏的本地明文值**
  （实测 MCP 的 env / headers，如 `env.MCP_TOKEN`、`headers.Authorization`），全仓没有 plan 级脱敏
  —— UI 是最后一道闸门。渲染点必须逐个过 `redact()`：`ConflictList`（description + detail，
  先整体脱敏再 `splitConflictDetail` 切分）、`ImportWizardView` 收尾清单、`ProfilesPanel` 档案原文
  （`package.json` / `cordis.patch.yml` 文本，patch 里可能内联字面量密钥）、
  `SnapshotsPanel` 恢复计划 / 差异查看、`SyncConfirmView`（description / detail / diff）、
  `ContentPicker` 单元副标题（`u.detail`）、市场条目导入审阅面板（`MarketImportReview`：
  逐项摘要的条目名与明细，两处调用点共用该组件故只需登记一处）。
  `ContentPicker` 的**单元名**同样要过 `redact()`：**先脱敏、后中段省略**（顺序不可反 —— 先截断会让
  被切掉的密钥不再匹配值形状模式而漏网），`title` 用脱敏后的值；`ProgressBar` 的 `view.label` /
  `view.detail` / 徽章 label 亦按同一规则处理（评审 G-01 / G-03 登记后已落地）。
  该组渲染点由源码守卫 `src/client/common/plan-text-redaction.test.ts` 钉死，且已按评审 G-09 升级为
  **按渲染点断言**（原先是文件级 `contains`：同文件里去掉某一处 `redact()` 仍会绿灯 —— 例如只断言
  `description`、`detail`/`diff` 裸渲染照样通过）。现在 `RENDER_POINTS` 表里每个渲染点两条断言
  （已脱敏写法**恰好出现 1 次** + 裸写法**不得出现**），并校验每个登记文件都真的 import 了 `redact`
  ⟹ **去掉任意一处 `redact()` 都会红灯**（24/24 逐点变异验证通过，恢复后全绿）。
  维护约定：新增「宿主文本 → JSX」的渲染点**必须**登记进 `RENDER_POINTS`（该表是这类渲染点的单一登记表）；
  本守卫仍是源码级（组件无测试框架），不覆盖运行时行为，也不覆盖未登记的新渲染点。
- 备注等自由文本若编码损坏（全问号）显示「（备注不可读）」。
- 密码/凭据绝不落 sessionStorage、绝不回显（run-store 白名单单一出口）。
  - **导出/备份密码**：仅内存传入，用完即弃。
  - **同步通道的加密/解密密码**（product requirement）：勾选「加密备份」后保存到 DSH credentials
    的独立槽位（值永不进 sync-*.json / 响应 / 日志 / 备份），取消勾选即删除；解密密码只在
    拉取的快照**确实加密**时被使用。UI 只拿得到 `configured` 布尔，据此显示
    「密码已保存到本机 / 留空即沿用」与危险语义的「删除已保存密码」按钮（`variant="danger"`）。
- **字典不留死键**（UI-24）：描述**已不存在交互**的键必须删除或接线；确认死键后再删，
  zh / en 两侧同时删（`Record<keyof typeof zh, string>` 保证键集合一致，漏删一侧即编译失败）。
  刻意例外：`import.conflicts.review` 保留无引用态（`ConflictList` 有注释说明：
  Review 会被收集器计为 unresolved → 「下一步」永久禁用，属死路，故不提供该选项）。
  **`overview.*` 死键清理（评审 G-08，2026-09 已完成）**：删除 16 个零引用键
  （`overview.subtitle` / `overview.loading` / `overview.running` / `overview.quick.{title,export,import,
  exportHint,importHint,syncHint,backupHint,backupFailed}` / `overview.suggest.{title,schedule,sync}` /
  `overview.activity.viewAll` / `overview.location.scheduleOn`，zh/en 同步删）。
  **动态键族必须保留**（复核方法：逐个模板串 + 键类型联合）：`overview.${health.textKey}`
  （`overview.health.*`，4 个）、`overview.kind.${e.kind}`（`KNOWN_KINDS` 的 13 个 + `kind.other`）、
  `overview.metric.<OverviewMetricKey>`、`overview.meta.<OverviewMetaKey>`、`overview.state.on/off`
  —— 这些键在源码里没有 `'overview.x'` 字面量，**不是**死键。
  配套已清理（t15）：`overviewSuggestions()` 及其类型（`src/ui/overview-view.ts`）曾无 UI 消费者，
  随 `overview.suggest.*` 死键一并删除（全仓 grep 确认零引用，含字符串/动态引用；对应单测同步移除），
  `src/ui/overview-view.ts` 不再产出 `overview.suggest.*` 键。

---

## 8. Responsive

- 弹窗收缩（视口 <900px，弹窗变 100vw-48px）：`.ovGrid` 单列、统计/快捷网格 2 列、
  `.secretFields` 单列、`.pagePad` padding 12px、抽屉全屏。
- 表格列宽用 th 显式宽度 + `table-layout: fixed` + 内容 ellipsis；先压缩次级列，
  最后主列；固定开销（时间/操作列）优先于内容列。

---

## 9. Anti-patterns（禁止）

1. 零值/纯状态装饰卡（为填格子而存在的 KPI 卡）。
2. 与一级导航重复的第二套入口卡。
3. warn/error 语义色用于建议性/营销性内容。
4. 无标签的 utility 图标混在导航行（图标按钮必须 aria-label + title）。
5. 尾部截断文件名/时间戳（区分信息在后缀时用中段省略）。
6. 固定高度容器内容不满（空黑块）——用 fit-content 或真实内容填充。
7. 全同徽章列（同一状态重复 n 次）——降级为状态点。
8. 同屏术语漂移（同一概念多个名字）。
9. 手写文本符号图标（▣⇥⇤⟳◷⭳⌕✕⧉→ 等）——统一用 `common/Icon.tsx`（lucide-react）。
10. 新建弹窗用手写 `dialogMask+dialogCard` 而无 focus trap——统一用 `common/Modal.tsx`（Radix Dialog）。
